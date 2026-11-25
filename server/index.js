import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

/*
  Opus Magnum match server. Rooms by code; two teams (a, b); first team to LIMIT kills or the higher score at
  the end of the clock wins, then the room restarts on its own.
  Clients own their movement and hit detection (friends-only trust model); the server owns HP, kills, score,
  respawns and the clock, and relays poses at TICK Hz.

  client → server   hello { name, room, mapId, map? } · s { p, v, y, pi, w, st, h } · fire { o, d, w, sup }
                    hit { id, zone, dmg } · ping { c }
  server → client   welcome { id, team, mapId, map, players, score, limit, time } · join { player } · leave { id }
                    snap { ps } · fire { id, ... } · hurt { hp, by, dmg } · kill { k, v, head, score }
                    respawn · end { score } · restart { score, time } · pong { c } · error { msg }
*/

const PORT = Number(process.env.PORT ?? 8787);
const TICK = 30;
const MAX_HP = 150, REGEN_DELAY = 5, REGEN_RATE = 30;
const RESPAWN = 3, SHIELD = 1.5;
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

const pub = (p) => ({ id: p.id, name: p.name, team: p.team, alive: p.alive });

function join(ws, msg) {
  const code = clean(msg.room, 16).toLowerCase() || 'duel';
  let room = rooms.get(code);
  if (!room) {
    room = { code, players: new Map(), score: { a: 0, b: 0 }, mapId: String(msg.mapId ?? ''), map: msg.map ?? null, time: MATCH_TIME, ended: false, endT: 0 };
    rooms.set(code, room);
  }
  if (room.players.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'Room is full' }), null;
  const count = (t) => [...room.players.values()].filter((p) => p.team === t).length;
  const p = {
    ws, room, id: nextId++, name: clean(msg.name, 16) || 'Player', team: count('a') <= count('b') ? 'a' : 'b',
    alive: true, hp: MAX_HP, lastHurt: -99, shieldUntil: now() + SHIELD, respawnAt: 0, state: null,
  };
  room.players.set(p.id, p);
  send(ws, { t: 'welcome', id: p.id, team: p.team, mapId: room.mapId, map: room.map, players: [...room.players.values()].map(pub), score: room.score, limit: LIMIT, time: room.time, ended: room.ended });
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
  if (room.ended || !p.alive || !v || !v.alive || v.team === p.team || t < v.shieldUntil) return;
  const dmg = Math.min(300, Math.max(1, Math.round(Number(msg.dmg) || 0)));
  v.hp -= dmg;
  v.lastHurt = t;
  send(v.ws, { t: 'hurt', hp: Math.max(0, v.hp), by: p.id, dmg });
  if (v.hp > 0) return;
  v.alive = false;
  v.respawnAt = t + RESPAWN;
  room.score[p.team]++;
  broadcast(room, { t: 'kill', k: p.id, v: v.id, head: msg.zone === 'head', score: room.score });
  if (room.score[p.team] >= LIMIT) end(room);
}

function end(room) {
  room.ended = true;
  room.endT = END_PAUSE;
  broadcast(room, { t: 'end', score: room.score });
}

function restart(room) {
  Object.assign(room, { ended: false, score: { a: 0, b: 0 }, time: MATCH_TIME });
  for (const p of room.players.values()) respawn(p);
  broadcast(room, { t: 'restart', score: room.score, time: room.time });
}

function respawn(p) {
  Object.assign(p, { alive: true, hp: MAX_HP, lastHurt: -99, shieldUntil: now() + SHIELD, respawnAt: 0 });
  send(p.ws, { t: 'respawn' });
}

function tick(dt) {
  const t = now();
  for (const room of rooms.values()) {
    if (room.ended) { if ((room.endT -= dt) <= 0) restart(room); }
    else if ((room.time -= dt) <= 0) { room.time = 0; end(room); }
    const ps = [];
    for (const p of room.players.values()) {
      if (!p.alive && p.respawnAt && t >= p.respawnAt && !room.ended) respawn(p);
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
const wss = new WebSocketServer({ server: http, maxPayload: 4 << 20 });

wss.on('connection', (ws) => {
  let p = null;
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!p) { if (msg.t === 'hello') p = join(ws, msg); return; }
    switch (msg.t) {
      case 's': {
        const pos = vec(msg.p);
        if (pos) p.state = { p: pos, v: vec(msg.v) ?? [0, 0, 0], y: +msg.y || 0, pi: +msg.pi || 0, w: msg.w | 0, st: clean(msg.st, 10), h: Math.min(2, Math.max(0.5, +msg.h || 1.8)) };
        break;
      }
      case 'fire':
        if (p.alive && vec(msg.o) && vec(msg.d)) broadcast(p.room, { t: 'fire', id: p.id, o: msg.o, d: msg.d, w: msg.w | 0, sup: !!msg.sup }, p);
        break;
      case 'hit': hit(p, msg); break;
      case 'ping': send(ws, { t: 'pong', c: msg.c }); break;
    }
  });
  ws.on('close', () => { if (p) leave(p); });
});

let last = now();
setInterval(() => { const t = now(); tick(t - last); last = t; }, 1000 / TICK);
http.listen(PORT, () => console.log(`listening on :${PORT}`));
