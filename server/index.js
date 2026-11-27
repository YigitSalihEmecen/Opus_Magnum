import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

/*
  Opus Magnum match server. Rooms by code; two teams (a, b). Gun-game rounds: every round all players get the
  same random weapon; a round ends when one team has nobody left standing (the dead wait it out), and after
  ROUND_PAUSE everyone is back at their base with a new weapon. Rounds won are the score. First team to LIMIT round wins (or the higher score when the clock runs out) takes the match,
  then the room restarts on its own.
  Clients own their movement and hit detection (friends-only trust model); the server owns HP, armour, kills,
  score, rounds, the clock and who got which pickup, and relays poses at TICK Hz.
  Pickups: map items are named by the clients ('m<index>' in the map's item list, the same on every client); the
  first to claim one gets it, and it comes back ITEM_RESPAWN s later (or at the next round). Dropped guns get
  ids here ('d<n>').
  Poses are relayed the moment they arrive (no server tick in between), stamped with the sender's own clock
  (q[12]); each receiver lines that clock up with its own and plays the poses back on an even timeline.
  After a match everyone votes for the next map among the builtin maps the room's opener listed (hello.maps).
  2v2: every team has TEAM_SIZE slots, and a slot without a person in it holds a bot. A player who joins takes
  a bot's place on the team with fewer people; one who leaves is replaced by a bot. The bots are players here
  like anyone (health, kills, rounds), but their brains run in one player's browser, the room's host (the AI
  needs the level, which only the clients load): the host sends their poses in batches (sb), their shots
  (fire with as) and their hits (hit with as), and hears how they're hurt (bhurt). When the host leaves, the
  next player takes the bots over (host).

  client → server   hello { v, name, room, char, mapId, map?, maps, weapons } · fire { o, d, w, sup, as? } · hit { id, zone, dmg, as? }
                    sb { b: [[botId, q], …] }  (host only: its bots' poses; as: the bot a host's fire / hit is for)
                    s { q: [px, py, pz, vx, vy, vz, yaw, pitch, weapon, state, flags, lean (-1 left … 1 right), clientMs] }
                    hit { id, zone, dmg, w? }  (w: what did it — arsenal id, 'fist', 'grenade', 'fall')
                    take { id } · drop { w, p, ammo, reserve } · vit { op: heal|wear|charge, v } · nade { p, v, f }
                    door { id, open, dir } · vote { map } · ping { c }
                    act { a, i? }  what the free hand does, for the others to see (a: ACTS; i: the item used)
  server → client   welcome { v, id, team, host, mapId, map, players (bots: bot true), score, limit, time, round, items, vote? }
                    host { id } (the bots' brains move to that player) · bhurt { id, hp, by?, dmg? } (to the host)
                    join { player } · leave { id } · s { id, al, q } · fire { id, ... } · hurt { hp, ar, am, by?, dmg? }
                    kill { k, v, head, w, score } · took { id, by } · back { id } · dropped { id, w, p, ammo, reserve }
                    door { id, open, dir } (doors: welcome.doors [[id, open, dir]], all shut each round)
                    nade { id, p, v, f } · round { n, weapon, score } · end { score, vote } · votes { tally }
                    restart { score, time, mapId } · pong { c } · error { msg }
                    act { id, a, i? } · struck { id }  (someone else was hit: their body flinches)
*/

export const PROTOCOL = 5;
const ACTS = new Set(['cross', 'hook', 'throw', 'use', 'stop']);

const PORT = Number(process.env.PORT ?? 8787);
// only the Funnel proxy (and this machine) should reach the server; nothing else on the LAN
const HOST = process.env.HOST ?? '127.0.0.1';
// browsers send Origin: refuse pages that aren't the game (non-browser clients can fake it — the limits below still apply)
const ORIGINS = (process.env.ALLOW_ORIGINS ?? 'https://yigitsalihemecen.github.io').split(',');
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const MAX_CONNECTIONS = 40, MAX_ROOMS = 20, MAX_MSGS_PER_SEC = 120, HELLO_TIMEOUT = 5000;
const TICK = 30;
const REGEN_DELAY = 8, REGEN_RATE = 10; // mirrors src/player/vitals.js
const CHAR_HP = { rivet: 125, kite: 100 }; // mirrors src/character/characters.js hp
const maxHp = (char) => CHAR_HP[char] ?? CHAR_HP.rivet; // the client falls back to Rivet too
// mirrors src/items/items.js: what a heal can restore and which vests exist
const HEALS = [40, 150], ARMOUR_CAPS = [25, 50, 75], MAX_DROPS = 24;
const SHIELD = 1.5, ROUND_PAUSE = 2.2;
const LIMIT = Number(process.env.LIMIT ?? 10), MATCH_TIME = 600, END_PAUSE = Number(process.env.END_PAUSE ?? 14), ITEM_RESPAWN = 30;
const TEAM_SIZE = 2; // 2v2: people first, bots in the empty slots
const BOT_NAMES = ['Wren', 'Okafor', 'Vesper', 'Kade', 'Ruiz', 'Halloran', 'Mata', 'Ishikawa', 'Lindqvist', 'Sato'];
const HOST_MSGS = 4; // the host speaks for its bots too: a bigger message budget

const rooms = new Map();
let nextId = 1;
const now = () => performance.now() / 1000;
const send = (ws, msg) => { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); };
const clean = (s, n) => String(s ?? '').replace(/[^\w\- ]/g, '').trim().slice(0, n);
const vec = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) ? a : null;

function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) if (p !== except && p.ws?.readyState === 1) p.ws.send(data);
}

const pub = (p) => ({ id: p.id, name: p.name, char: p.char, team: p.team, alive: p.alive, kills: p.kills, deaths: p.deaths, bot: p.bot || undefined });
const people = (room, team) => [...room.players.values()].filter((p) => !p.bot && (!team || p.team === team));
const fresh = (room, char) => ({ char, alive: room.pauseT <= 0 && !room.ended, kills: 0, deaths: 0, hp: maxHp(char), armour: 0, armourMax: 0, lastHurt: -99, shieldUntil: now() + SHIELD, sentHp: maxHp(char) });

/** A bot into an empty slot on `team`; one filling in mid-round sits it out (the round's dead wait too). */
function addBot(room, team, { live = false, except } = {}) {
  const used = new Set([...room.players.values()].map((p) => p.name));
  const name = BOT_NAMES.find((n) => !used.has(n)) ?? `Bot ${nextId}`;
  const b = { ws: null, bot: true, room, id: nextId++, name, team, ...fresh(room, room.players.size % 2 ? 'kite' : 'rivet') };
  if (!live) b.alive = false;
  room.players.set(b.id, b);
  broadcast(room, { t: 'join', player: pub(b) }, except);
  return b;
}

/** Every team back up to TEAM_SIZE with bots. */
function fill(room, opts) {
  for (const team of ['a', 'b']) while ([...room.players.values()].filter((p) => p.team === team).length < TEAM_SIZE) addBot(room, team, opts);
}

function join(ws, msg) {
  if (msg.v !== PROTOCOL) return send(ws, { t: 'error', msg: msg.v > PROTOCOL ? 'The match server is out of date: restart it with the latest code' : 'The game is out of date: reload the page' }), null;
  const code = clean(msg.room, 16).toLowerCase() || 'duel';
  let room = rooms.get(code);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', msg: 'Server is busy' }), null;
    room = { code, players: new Map(), score: { a: 0, b: 0 }, mapId: String(msg.mapId ?? ''), map: msg.map && typeof msg.map === 'object' && Array.isArray(msg.map.pieces) && msg.map.pieces.length < 20000 ? msg.map : null, time: MATCH_TIME, ended: false, endT: 0, pauseT: 0, weapons: Math.min(16, Math.max(1, msg.weapons | 0)) || 5, maps: (Array.isArray(msg.maps) ? msg.maps : []).slice(0, 8).map((m) => clean(m, 32)).filter(Boolean), round: null, taken: new Map(), drops: new Map(), dropN: 0, votes: new Map(), doors: new Map() };
    room.round = { n: 1, weapon: pickWeapon(room) };
    rooms.set(code, room);
  }
  if (people(room).length >= TEAM_SIZE * 2) return send(ws, { t: 'error', msg: 'Room is full (2v2)' }), null;
  // the side with fewer people; a bot there gives up its slot
  const team = people(room, 'a').length <= people(room, 'b').length ? 'a' : 'b';
  const bot = [...room.players.values()].find((q) => q.bot && q.team === team);
  if (bot) { room.players.delete(bot.id); broadcast(room, { t: 'leave', id: bot.id }); }
  const p = { ws, room, id: nextId++, name: clean(msg.name, 16) || 'Player', team, ...fresh(room, clean(msg.char, 12).toLowerCase() || 'rivet') };
  room.players.set(p.id, p);
  if (!room.host || !room.players.has(room.host)) room.host = p.id;
  fill(room, { live: room.players.size === 1, except: p }); // a new room starts with its bots in play; the welcome lists them
  send(ws, { t: 'welcome', v: PROTOCOL, id: p.id, team: p.team, host: room.host, mapId: room.mapId, map: room.map, players: [...room.players.values()].map(pub), score: room.score, limit: LIMIT, time: room.time, ended: room.ended, vote: room.ended ? voteState(room) : undefined, round: room.round, items: { taken: [...room.taken.keys()], drops: [...room.drops].map(([id, d]) => ({ id, ...d })) }, doors: [...room.doors].map(([id, d]) => [id, d.open, d.dir]) });
  broadcast(room, { t: 'join', player: pub(p) }, p);
  console.log(`${p.name} joined ${code} (${room.players.size})`);
  return p;
}

function leave(p) {
  const room = p.room;
  room.players.delete(p.id);
  room.votes.delete(p.id);
  broadcast(room, { t: 'leave', id: p.id });
  if (!people(room).length) { rooms.delete(room.code); console.log(`${p.name} left ${room.code} (closed)`); return; }
  // the bots' brains move to someone still here, and a bot takes the empty slot
  if (room.host === p.id) { room.host = people(room)[0].id; broadcast(room, { t: 'host', id: room.host }); }
  fill(room);
  // the last one standing on a team walking out ends the round too
  const winner = !room.ended && room.pauseT <= 0 && roundWinner(room);
  if (winner) { room.score[winner]++; broadcast(room, { t: 'roundWon', team: winner, score: room.score }); closeRound(room, winner); }
  console.log(`${p.name} left ${room.code} (${people(room).length} people)`);
}

const vitals = (p) => ({ hp: Math.max(0, p.hp), ar: p.armour, am: p.armourMax });

function hit(sender, msg) {
  const room = sender.room, v = room.players.get(msg.id), t = now();
  const p = msg.as === undefined ? sender : botOf(sender, msg.as); // the host reports its bots' hits
  if (!p) return;
  const self = v === p && (msg.zone === 'blast' || msg.zone === 'fall'); // your own grenade, or into the water
  if (room.ended || room.pauseT > 0 || !p.alive || !v || !v.alive || (v.team === p.team && !self) || (t < v.shieldUntil && !self)) return;
  const dmg = Math.min(300, Math.max(0.1, Math.round((Number(msg.dmg) || 0) * 10) / 10)); // pellets can be fractional
  const soak = Math.min(v.armour, dmg);
  v.armour -= soak;
  v.hp -= dmg - soak;
  v.lastHurt = t;
  v.sentHp = v.hp;
  if (v.bot) send(room.players.get(room.host)?.ws, { t: 'bhurt', id: v.id, hp: Math.max(0, v.hp), by: p.id, dmg });
  else send(v.ws, { t: 'hurt', ...vitals(v), by: p.id, dmg });
  broadcast(room, { t: 'struck', id: v.id }, v);
  if (v.hp > 0) return;
  v.alive = false;
  if (!self) p.kills++;
  v.deaths++;
  const winner = roundWinner(room);
  if (winner) room.score[winner]++;
  broadcast(room, { t: 'kill', k: p.id, v: v.id, head: msg.zone === 'head', w: clean(msg.w, 12) || undefined, score: room.score });
  if (winner) closeRound(room, winner);
}

/** The bot `id` if `sender` is the room's host (only it speaks for bots). */
function botOf(sender, id) {
  const b = sender.room.players.get(id | 0);
  return b?.bot && sender.room.host === sender.id ? b : null;
}

/** The team still standing once the other has nobody alive (both sides must have players). */
function roundWinner(room) {
  const up = { a: 0, b: 0 }, all = { a: 0, b: 0 };
  for (const q of room.players.values()) { all[q.team]++; if (q.alive) up[q.team]++; }
  if (!all.a || !all.b) return null;
  if (!up.a && up.b) return 'b';
  if (!up.b && up.a) return 'a';
  return null;
}

function closeRound(room, winner) {
  if (room.score[winner] >= LIMIT) end(room);
  else room.pauseT = ROUND_PAUSE; // a short beat, then everyone resets
}

/** First claim wins: a map item comes back after ITEM_RESPAWN s (or next round), a dropped gun is gone. */
function take(p, msg) {
  const room = p.room, id = clean(msg.id, 12);
  if (!p.alive || !id || room.taken.has(id) || (id.startsWith('d') && !room.drops.has(id)) || !/^[md]\d+$/.test(id)) return;
  if (id.startsWith('d')) room.drops.delete(id); else room.taken.set(id, now());
  broadcast(room, { t: 'took', id, by: p.id });
}

function drop(p, msg) {
  const room = p.room, pos = vec(msg.p), w = msg.w | 0;
  if (!pos || w < 0 || w >= room.weapons) return;
  const id = `d${++room.dropN}`;
  const d = { w, p: pos, ammo: Math.max(0, Math.min(200, msg.ammo | 0)), reserve: Math.max(0, Math.min(500, msg.reserve | 0)) };
  room.drops.set(id, d);
  if (room.drops.size > MAX_DROPS) room.drops.delete(room.drops.keys().next().value);
  broadcast(room, { t: 'dropped', id, ...d });
}

/** Heals and armour, within what the items can do; the answer is the player's new vitals. */
function vital(p, msg) {
  if (!p.alive) return;
  const v = Number(msg.v);
  if (msg.op === 'heal' && HEALS.includes(v)) p.hp = Math.min(maxHp(p.char), p.hp + v);
  else if (msg.op === 'wear' && ARMOUR_CAPS.includes(v)) { p.armourMax = v; p.armour = v; }
  else if (msg.op === 'charge') p.armour = p.armourMax;
  else return;
  send(p.ws, { t: 'hurt', ...vitals(p) });
}

/** A random weapon index, never the same twice in a row. */
function pickWeapon(room) {
  const prev = room.round?.weapon ?? -1;
  let w = (Math.random() * room.weapons) | 0;
  if (room.weapons > 1 && w === prev) w = (w + 1 + ((Math.random() * (room.weapons - 1)) | 0)) % room.weapons;
  return w;
}

/** Everyone back to full health at their base with a fresh random weapon. */
function nextRound(room) {
  room.pauseT = 0;
  room.round = { n: (room.round?.n ?? 0) + 1, weapon: pickWeapon(room) };
  for (const p of room.players.values()) Object.assign(p, { alive: true, hp: maxHp(p.char), armour: 0, armourMax: 0, lastHurt: -99, shieldUntil: now() + SHIELD });
  room.taken.clear(); // every map item back in place, dropped guns gone, doors shut
  room.doors.clear();
  room.drops.clear();
  broadcast(room, { t: 'round', ...room.round, score: room.score });
}

/** The maps on the ballot (the current one included) and the votes so far. */
function voteState(room) {
  const options = room.maps.includes(room.mapId) || !room.mapId ? room.maps : [room.mapId, ...room.maps];
  const tally = {};
  for (const m of room.votes.values()) tally[m] = (tally[m] ?? 0) + 1;
  return { options, tally, time: Math.max(0, room.endT) };
}

function end(room) {
  room.ended = true;
  room.endT = END_PAUSE;
  room.votes.clear();
  broadcast(room, { t: 'end', score: room.score, vote: voteState(room) });
}

function vote(p, msg) {
  const room = p.room, map = clean(msg.map, 32);
  if (!room.ended || !voteState(room).options.includes(map)) return;
  room.votes.set(p.id, map);
  broadcast(room, { t: 'votes', tally: voteState(room).tally });
}

/** Most votes wins, ties drawn at random; nobody voted: the next map in the rotation. */
function nextMap(room) {
  const { options, tally } = voteState(room);
  if (!options.length) return room.mapId;
  const top = Math.max(0, ...Object.values(tally));
  if (!top) return options[(options.indexOf(room.mapId) + 1) % options.length];
  const best = options.filter((m) => tally[m] === top);
  return best[(Math.random() * best.length) | 0];
}

function restart(room) {
  const mapId = nextMap(room);
  if (mapId !== room.mapId) { room.mapId = mapId; room.map = null; } // a custom map only lives until the vote moves on
  Object.assign(room, { ended: false, score: { a: 0, b: 0 }, time: MATCH_TIME, round: { n: 0, weapon: room.round?.weapon } });
  room.votes.clear();
  for (const p of room.players.values()) { p.kills = 0; p.deaths = 0; }
  broadcast(room, { t: 'restart', score: room.score, time: room.time, mapId: room.mapId });
  nextRound(room);
}

function tick(dt) {
  const t = now();
  for (const room of rooms.values()) {
    if (room.ended) { if ((room.endT -= dt) <= 0) restart(room); }
    else if ((room.time -= dt) <= 0) { room.time = 0; end(room); }
    else if (room.pauseT > 0 && (room.pauseT -= dt) <= 0) nextRound(room);
    for (const [id, at] of room.taken) if (t - at > ITEM_RESPAWN) { room.taken.delete(id); broadcast(room, { t: 'back', id }); }
    for (const p of room.players.values()) {
      const max = maxHp(p.char);
      if (!p.alive || p.hp >= max || t - p.lastHurt <= REGEN_DELAY) continue;
      p.hp = Math.min(max, p.hp + REGEN_RATE * dt);
      // a few updates a second is plenty for a health bar
      if (p.hp === max || p.hp - p.sentHp >= 3) {
        p.sentHp = p.hp;
        if (p.bot) send(room.players.get(room.host)?.ws, { t: 'bhurt', id: p.id, hp: p.hp });
        else send(p.ws, { t: 'hurt', ...vitals(p) });
      }
    }
  }
}

const http = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  res.end(`opus magnum server · ${rooms.size} rooms · ${[...rooms.values()].reduce((n, r) => n + r.players.size, 0)} players\n`);
});
const wss = new WebSocketServer({
  server: http,
  maxPayload: 1 << 20, // a custom map rides in hello; everything else is tiny
  verifyClient: ({ origin }) => wss.clients.size < MAX_CONNECTIONS && (ORIGINS.includes(origin) || LOCAL_ORIGIN.test(origin ?? '')),
});

wss.on('connection', (ws) => {
  let p = null;
  // must say hello quickly; a token bucket caps message rate (snapshots are 30/s); dead sockets are reaped
  const helloTimer = setTimeout(() => { if (!p) ws.terminate(); }, HELLO_TIMEOUT);
  let tokens = MAX_MSGS_PER_SEC, last = Date.now();
  const cap = () => MAX_MSGS_PER_SEC * (p && p.room.host === p.id ? HOST_MSGS : 1);
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (data) => {
    const t = Date.now();
    tokens = Math.min(cap(), tokens + ((t - last) / 1000) * cap());
    last = t;
    if (--tokens < 0) { ws.terminate(); return; }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (!p) { if (msg.t === 'hello') { clearTimeout(helloTimer); p = join(ws, msg); if (!p) ws.close(); } return; }
    switch (msg.t) {
      case 's':
        if (Array.isArray(msg.q) && msg.q.length === 13 && msg.q.every(Number.isFinite)) broadcast(p.room, { t: 's', id: p.id, al: p.alive ? 1 : 0, q: msg.q }, p);
        break;
      case 'sb':
        if (Array.isArray(msg.b) && p.room.host === p.id) {
          for (const [id, q] of msg.b.slice(0, TEAM_SIZE * 2)) {
            const b = botOf(p, id);
            if (b && Array.isArray(q) && q.length === 13 && q.every(Number.isFinite)) broadcast(p.room, { t: 's', id: b.id, al: b.alive ? 1 : 0, q }, p);
          }
        }
        break;
      case 'vote': vote(p, msg); break;
      case 'door': {
        const id = clean(msg.id, 8);
        if (!/^o\d{1,4}$/.test(id) || (!p.room.doors.has(id) && p.room.doors.size >= 512)) break;
        const d = { open: !!msg.open, dir: Math.sign(+msg.dir || 1) };
        p.room.doors.set(id, d);
        broadcast(p.room, { t: 'door', id, ...d }, p);
        break;
      }
      case 'fire': {
        const by = msg.as === undefined ? p : botOf(p, msg.as);
        if (by?.alive && vec(msg.o) && vec(msg.d)) broadcast(p.room, { t: 'fire', id: by.id, o: msg.o, d: msg.d, w: msg.w | 0, sup: !!msg.sup }, p);
        break;
      }
      case 'hit': hit(p, msg); break;
      case 'take': take(p, msg); break;
      case 'drop': drop(p, msg); break;
      case 'vit': vital(p, msg); break;
      case 'nade':
        if (p.alive && vec(msg.p) && vec(msg.v)) broadcast(p.room, { t: 'nade', id: p.id, p: msg.p, v: msg.v, f: Math.min(5, Math.max(0, +msg.f || 2.4)) }, p);
        break;
      case 'act':
        if ((p.alive || msg.a === 'stop') && ACTS.has(msg.a)) broadcast(p.room, { t: 'act', id: p.id, a: msg.a, i: clean(msg.i, 12) || undefined }, p);
        break;
      case 'ping': send(ws, { t: 'pong', c: msg.c }); break;
    }
  });
  ws.on('close', () => { clearTimeout(helloTimer); if (p) leave(p); });
  ws.on('error', () => {});
});
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
}, 15000);

let last = now();
setInterval(() => { const t = now(); tick(t - last); last = t; }, 1000 / TICK);
http.listen(PORT, HOST, () => console.log(`listening on ${HOST}:${PORT}`));
