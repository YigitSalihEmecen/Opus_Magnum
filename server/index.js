import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

/*
  Opus Magnum match server. Rooms by code; two teams (a, b). Gun-game rounds: every round all players get the
  same random weapon; the first kill ends the round, and after ROUND_PAUSE everyone is back at their base with
  a new weapon. First team to LIMIT round wins (or the higher score when the clock runs out) takes the match,
  then the room restarts on its own.
  Clients own their movement and hit detection (friends-only trust model); the server owns HP, armour, kills,
  score, rounds, the clock and who got which pickup, and relays poses at TICK Hz.
  Pickups: map items are named by the clients ('m<index>' in the map's item list, the same on every client); the
  first to claim one gets it, and it comes back ITEM_RESPAWN s later (or at the next round). Dropped guns get
  ids here ('d<n>').
  Poses are relayed the moment they arrive (no server tick in between), stamped with the sender's own clock
  (q[12]); each receiver lines that clock up with its own and plays the poses back on an even timeline.
  After a match everyone votes for the next map among the builtin maps the room's opener listed (hello.maps).

  client → server   hello { v, name, room, char, mapId, map?, maps, weapons } · fire { o, d, w, sup } · hit { id, zone, dmg }
                    s { q: [px, py, pz, vx, vy, vz, yaw, pitch, weapon, state, flags, wallSide, clientMs] }
                    take { id } · drop { w, p, ammo, reserve } · vit { op: heal|wear|charge, v } · nade { p, v, f }
                    vote { map } · ping { c }
  server → client   welcome { v, id, team, mapId, map, players, score, limit, time, round, items, vote? }
                    join { player } · leave { id } · s { id, al, q } · fire { id, ... } · hurt { hp, ar, am, by?, dmg? }
                    kill { k, v, head, score } · took { id, by } · back { id } · dropped { id, w, p, ammo, reserve }
                    nade { id, p, v, f } · round { n, weapon, score } · end { score, vote } · votes { tally }
                    restart { score, time, mapId } · pong { c } · error { msg }
*/

export const PROTOCOL = 2;

const PORT = Number(process.env.PORT ?? 8787);
// only the Funnel proxy (and this machine) should reach the server; nothing else on the LAN
const HOST = process.env.HOST ?? '127.0.0.1';
// browsers send Origin: refuse pages that aren't the game (non-browser clients can fake it — the limits below still apply)
const ORIGINS = (process.env.ALLOW_ORIGINS ?? 'https://yigitsalihemecen.github.io').split(',');
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const MAX_CONNECTIONS = 40, MAX_ROOMS = 20, MAX_MSGS_PER_SEC = 120, HELLO_TIMEOUT = 5000;
const TICK = 30;
const MAX_HP = 150, REGEN_DELAY = 8, REGEN_RATE = 10; // mirrors src/player/vitals.js
// mirrors src/items/items.js: what a heal can restore and which vests exist
const HEALS = [40, 150], ARMOUR_CAPS = [25, 50, 75], MAX_DROPS = 24;
const SHIELD = 1.5, ROUND_PAUSE = 2.2;
const LIMIT = Number(process.env.LIMIT ?? 10), MATCH_TIME = 600, END_PAUSE = Number(process.env.END_PAUSE ?? 14), ITEM_RESPAWN = 30;
const MAX_PLAYERS = 8;

const rooms = new Map();
let nextId = 1;
const now = () => performance.now() / 1000;
const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const clean = (s, n) => String(s ?? '').replace(/[^\w\- ]/g, '').trim().slice(0, n);
const vec = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) ? a : null;

function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(data);
}

const pub = (p) => ({ id: p.id, name: p.name, char: p.char, team: p.team, alive: p.alive, kills: p.kills, deaths: p.deaths });

function join(ws, msg) {
  if (msg.v !== PROTOCOL) return send(ws, { t: 'error', msg: msg.v > PROTOCOL ? 'The match server is out of date: restart it with the latest code' : 'The game is out of date: reload the page' }), null;
  const code = clean(msg.room, 16).toLowerCase() || 'duel';
  let room = rooms.get(code);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', msg: 'Server is busy' }), null;
    room = { code, players: new Map(), score: { a: 0, b: 0 }, mapId: String(msg.mapId ?? ''), map: msg.map && typeof msg.map === 'object' && Array.isArray(msg.map.pieces) && msg.map.pieces.length < 20000 ? msg.map : null, time: MATCH_TIME, ended: false, endT: 0, pauseT: 0, weapons: Math.min(16, Math.max(1, msg.weapons | 0)) || 5, maps: (Array.isArray(msg.maps) ? msg.maps : []).slice(0, 8).map((m) => clean(m, 32)).filter(Boolean), round: null, taken: new Map(), drops: new Map(), dropN: 0, votes: new Map() };
    room.round = { n: 1, weapon: pickWeapon(room) };
    rooms.set(code, room);
  }
  if (room.players.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'Room is full' }), null;
  const count = (t) => [...room.players.values()].filter((p) => p.team === t).length;
  const p = {
    ws, room, id: nextId++, name: clean(msg.name, 16) || 'Player', char: clean(msg.char, 12).toLowerCase() || 'rivet', team: count('a') <= count('b') ? 'a' : 'b',
    alive: room.pauseT <= 0, kills: 0, deaths: 0, hp: MAX_HP, armour: 0, armourMax: 0, lastHurt: -99, shieldUntil: now() + SHIELD, sentHp: MAX_HP,
  };
  room.players.set(p.id, p);
  send(ws, { t: 'welcome', v: PROTOCOL, id: p.id, team: p.team, mapId: room.mapId, map: room.map, players: [...room.players.values()].map(pub), score: room.score, limit: LIMIT, time: room.time, ended: room.ended, vote: room.ended ? voteState(room) : undefined, round: room.round, items: { taken: [...room.taken.keys()], drops: [...room.drops].map(([id, d]) => ({ id, ...d })) } });
  broadcast(room, { t: 'join', player: pub(p) }, p);
  console.log(`${p.name} joined ${code} (${room.players.size})`);
  return p;
}

function leave(p) {
  const room = p.room;
  room.players.delete(p.id);
  room.votes.delete(p.id);
  broadcast(room, { t: 'leave', id: p.id });
  if (!room.players.size) rooms.delete(room.code);
  console.log(`${p.name} left ${room.code} (${room.players.size})`);
}

const vitals = (p) => ({ hp: Math.max(0, p.hp), ar: p.armour, am: p.armourMax });

function hit(p, msg) {
  const room = p.room, v = room.players.get(msg.id), t = now();
  const self = v === p && (msg.zone === 'blast' || msg.zone === 'fall'); // your own grenade, or into the water
  if (room.ended || room.pauseT > 0 || !p.alive || !v || !v.alive || (v.team === p.team && !self) || (t < v.shieldUntil && !self)) return;
  const dmg = Math.min(300, Math.max(0.1, Math.round((Number(msg.dmg) || 0) * 10) / 10)); // pellets can be fractional
  const soak = Math.min(v.armour, dmg);
  v.armour -= soak;
  v.hp -= dmg - soak;
  v.lastHurt = t;
  v.sentHp = v.hp;
  send(v.ws, { t: 'hurt', ...vitals(v), by: p.id, dmg });
  if (v.hp > 0) return;
  v.alive = false;
  if (!self) p.kills++;
  v.deaths++;
  const team = self ? (p.team === 'a' ? 'b' : 'a') : p.team;
  room.score[team]++;
  broadcast(room, { t: 'kill', k: p.id, v: v.id, head: msg.zone === 'head', score: room.score });
  if (room.score[team] >= LIMIT) end(room);
  else room.pauseT = ROUND_PAUSE; // the round is over: a short beat, then everyone resets
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
  if (msg.op === 'heal' && HEALS.includes(v)) p.hp = Math.min(MAX_HP, p.hp + v);
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
  for (const p of room.players.values()) Object.assign(p, { alive: true, hp: MAX_HP, armour: 0, armourMax: 0, lastHurt: -99, shieldUntil: now() + SHIELD });
  room.taken.clear(); // every map item back in place, dropped guns gone
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
      if (!p.alive || p.hp >= MAX_HP || t - p.lastHurt <= REGEN_DELAY) continue;
      p.hp = Math.min(MAX_HP, p.hp + REGEN_RATE * dt);
      // a few updates a second is plenty for a health bar
      if (p.hp === MAX_HP || p.hp - p.sentHp >= 3) { p.sentHp = p.hp; send(p.ws, { t: 'hurt', ...vitals(p) }); }
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
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (data) => {
    const t = Date.now();
    tokens = Math.min(MAX_MSGS_PER_SEC, tokens + ((t - last) / 1000) * MAX_MSGS_PER_SEC);
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
      case 'vote': vote(p, msg); break;
      case 'fire':
        if (p.alive && vec(msg.o) && vec(msg.d)) broadcast(p.room, { t: 'fire', id: p.id, o: msg.o, d: msg.d, w: msg.w | 0, sup: !!msg.sup }, p);
        break;
      case 'hit': hit(p, msg); break;
      case 'take': take(p, msg); break;
      case 'drop': drop(p, msg); break;
      case 'vit': vital(p, msg); break;
      case 'nade':
        if (p.alive && vec(msg.p) && vec(msg.v)) broadcast(p.room, { t: 'nade', id: p.id, p: msg.p, v: msg.v, f: Math.min(5, Math.max(0, +msg.f || 2.4)) }, p);
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
