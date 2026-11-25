import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

/*
  Opus Magnum match server. Rooms by code; two teams (a, b). Gun-game rounds: every round all players get the
  same random weapon; the first kill ends the round, and after ROUND_PAUSE everyone is back at their base with
  a new weapon. First team to LIMIT round wins (or the higher score when the clock runs out) takes the match,
  then the room restarts on its own.
  Clients own their movement and hit detection (friends-only trust model); the server owns HP, kills, score,
  rounds and the clock, and relays poses at TICK Hz.

  client → server   hello { name, room, char, mapId, map?, weapons } · fire { o, d, w, sup } · hit { id, zone, dmg }
                    s { p, v, y, pi, w, st, cr, ws, ads, rl }  (pose + crouch, wall side, aiming, reloading flags)
                    ping { c }
  server → client   welcome { id, team, mapId, map, players, score, limit, time, round } · join { player } · leave { id }
                    snap { ps } · fire { id, ... } · hurt { hp, by, dmg } · kill { k, v, head, score }
                    round { n, weapon, score } · end { score } · restart { score, time } · pong { c } · error { msg }
*/

const PORT = Number(process.env.PORT ?? 8787);
// only the Funnel proxy (and this machine) should reach the server; nothing else on the LAN
const HOST = process.env.HOST ?? '127.0.0.1';
// browsers send Origin: refuse pages that aren't the game (non-browser clients can fake it — the limits below still apply)
const ORIGINS = (process.env.ALLOW_ORIGINS ?? 'https://yigitsalihemecen.github.io').split(',');
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const MAX_CONNECTIONS = 40, MAX_ROOMS = 20, MAX_MSGS_PER_SEC = 120, HELLO_TIMEOUT = 5000;
const TICK = 30;
const MAX_HP = 150, REGEN_DELAY = 5, REGEN_RATE = 30;
const SHIELD = 1.5, ROUND_PAUSE = 2.2;
const LIMIT = 10, MATCH_TIME = 600, END_PAUSE = 8;
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
  const code = clean(msg.room, 16).toLowerCase() || 'duel';
  let room = rooms.get(code);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', msg: 'Server is busy' }), null;
    room = { code, players: new Map(), score: { a: 0, b: 0 }, mapId: String(msg.mapId ?? ''), map: msg.map && typeof msg.map === 'object' && Array.isArray(msg.map.pieces) && msg.map.pieces.length < 20000 ? msg.map : null, time: MATCH_TIME, ended: false, endT: 0, pauseT: 0, weapons: Math.min(16, Math.max(1, msg.weapons | 0)) || 5, round: null };
    room.round = { n: 1, weapon: pickWeapon(room) };
    rooms.set(code, room);
  }
  if (room.players.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'Room is full' }), null;
  const count = (t) => [...room.players.values()].filter((p) => p.team === t).length;
  const p = {
    ws, room, id: nextId++, name: clean(msg.name, 16) || 'Player', char: clean(msg.char, 12).toLowerCase() || 'rivet', team: count('a') <= count('b') ? 'a' : 'b',
    alive: room.pauseT <= 0, kills: 0, deaths: 0, hp: MAX_HP, lastHurt: -99, shieldUntil: now() + SHIELD, state: null,
  };
  room.players.set(p.id, p);
  send(ws, { t: 'welcome', id: p.id, team: p.team, mapId: room.mapId, map: room.map, players: [...room.players.values()].map(pub), score: room.score, limit: LIMIT, time: room.time, ended: room.ended, round: room.round });
  broadcast(room, { t: 'join', player: pub(p) }, p);
  console.log(`${p.name} joined ${code} (${room.players.size})`);
  return p;
}

function leave(p) {
  const room = p.room;
  room.players.delete(p.id);
  broadcast(room, { t: 'leave', id: p.id });
  if (!room.players.size) rooms.delete(room.code);
  console.log(`${p.name} left ${room.code} (${room.players.size})`);
}

function hit(p, msg) {
  const room = p.room, v = room.players.get(msg.id), t = now();
  if (room.ended || room.pauseT > 0 || !p.alive || !v || !v.alive || v.team === p.team || t < v.shieldUntil) return;
  const dmg = Math.min(300, Math.max(0.1, Math.round((Number(msg.dmg) || 0) * 10) / 10)); // pellets can be fractional
  v.hp -= dmg;
  v.lastHurt = t;
  send(v.ws, { t: 'hurt', hp: Math.max(0, v.hp), by: p.id, dmg });
  if (v.hp > 0) return;
  v.alive = false;
  p.kills++;
  v.deaths++;
  room.score[p.team]++;
  broadcast(room, { t: 'kill', k: p.id, v: v.id, head: msg.zone === 'head', score: room.score });
  if (room.score[p.team] >= LIMIT) end(room);
  else room.pauseT = ROUND_PAUSE; // the round is over: a short beat, then everyone resets
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
  for (const p of room.players.values()) Object.assign(p, { alive: true, hp: MAX_HP, lastHurt: -99, shieldUntil: now() + SHIELD });
  broadcast(room, { t: 'round', ...room.round, score: room.score });
}

function end(room) {
  room.ended = true;
  room.endT = END_PAUSE;
  broadcast(room, { t: 'end', score: room.score });
}

function restart(room) {
  Object.assign(room, { ended: false, score: { a: 0, b: 0 }, time: MATCH_TIME, round: { n: 0, weapon: room.round?.weapon } });
  for (const p of room.players.values()) { p.kills = 0; p.deaths = 0; }
  broadcast(room, { t: 'restart', score: room.score, time: room.time });
  nextRound(room);
}

function tick(dt) {
  const t = now();
  for (const room of rooms.values()) {
    if (room.ended) { if ((room.endT -= dt) <= 0) restart(room); }
    else if ((room.time -= dt) <= 0) { room.time = 0; end(room); }
    else if (room.pauseT > 0 && (room.pauseT -= dt) <= 0) nextRound(room);
    const ps = [];
    for (const p of room.players.values()) {
      if (p.alive && p.hp < MAX_HP && t - p.lastHurt > REGEN_DELAY) {
        p.hp = Math.min(MAX_HP, p.hp + REGEN_RATE * dt);
        send(p.ws, { t: 'hurt', hp: p.hp });
      }
      if (p.state) ps.push({ id: p.id, al: p.alive, ...p.state });
    }
    if (ps.length) broadcast(room, { t: 'snap', ps });
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
      case 's': {
        const pos = vec(msg.p);
        if (pos) p.state = { p: pos, v: vec(msg.v) ?? [0, 0, 0], y: +msg.y || 0, pi: +msg.pi || 0, w: msg.w | 0, st: clean(msg.st, 10), cr: msg.cr ? 1 : 0, ws: Math.sign(+msg.ws || 0), ads: msg.ads ? 1 : 0, rl: msg.rl ? 1 : 0 };
        break;
      }
      case 'fire':
        if (p.alive && vec(msg.o) && vec(msg.d)) broadcast(p.room, { t: 'fire', id: p.id, o: msg.o, d: msg.d, w: msg.w | 0, sup: !!msg.sup }, p);
        break;
      case 'hit': hit(p, msg); break;
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
