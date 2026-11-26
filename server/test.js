import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const PORT = 8899;
const srv = spawn('node', ['index.js'], { cwd: import.meta.dirname, env: { ...process.env, PORT } });
await new Promise((r) => srv.stdout.once('data', r));

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}`, { origin: 'http://localhost:5173' });
  const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d)));
  const next = (t) => new Promise((res, rej) => {
    const end = Date.now() + 3000;
    (function poll() {
      const i = inbox.findIndex((m) => m.t === t);
      if (i >= 0) return res(inbox.splice(i, 1)[0]);
      if (Date.now() > end) return rej(new Error(`${name}: no ${t}`));
      setTimeout(poll, 10);
    })();
  });
  return new Promise((r) => ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', name, room: 'test', mapId: 'builtin-duel', weapons: 5 })); r({ ws, next, inbox, send: (m) => ws.send(JSON.stringify(m)) }); }));
}

const a = await client('A');
const wa = await a.next('welcome');
const b = await client('B');
const wb = await b.next('welcome');
assert.equal(wb.players.length, 2);
assert.notEqual(wa.team, wb.team);
assert.equal(wa.round.n, 1);
assert.ok(wa.round.weapon >= 0 && wa.round.weapon < 5);
assert.equal((await a.next('join')).player.name, 'B');

await new Promise((r) => setTimeout(r, 1600)); // spawn shield
b.send({ t: 's', p: [1, 2, 3], v: [0, 0, 0], y: 0, pi: 0, w: 0, st: 'slide', cr: 1, ads: 1 });
const snap = await a.next('snap');
const sb = snap.ps.find((p) => p.id === wb.id);
assert.deepEqual(sb.p, [1, 2, 3]);
assert.equal(sb.st, 'slide');
assert.equal(sb.cr, 1);
assert.equal(sb.ads, 1);

a.send({ t: 'hit', id: wb.id, zone: 'body', dmg: 100 });
assert.equal((await b.next('hurt')).hp, 50);
a.send({ t: 'hit', id: wb.id, zone: 'head', dmg: 100 });
const kill = await a.next('kill');
assert.equal(kill.v, wb.id);
assert.equal(kill.head, true);
assert.equal(kill.score[wa.team], 1);
assert.equal((await b.next('hurt')).hp, 0);
a.send({ t: 'hit', id: wb.id, zone: 'body', dmg: 100 }); // round over: no more damage
const round = await b.next('round');
assert.equal(round.n, 2);
assert.notEqual(round.weapon, wa.round.weapon);
assert.equal(round.score[wa.team], 1);
await new Promise((r) => setTimeout(r, 1600)); // spawn shield
a.send({ t: 'hit', id: wb.id, zone: 'body', dmg: 40 });
assert.equal((await b.next('hurt')).hp, 110); // fresh round: full health again

// armour soaks damage first; heals only restore what an item can
b.send({ t: 'vit', op: 'wear', v: 50 });
let h = await b.next('hurt');
assert.deepEqual([h.ar, h.am], [50, 50]);
a.send({ t: 'hit', id: wb.id, zone: 'body', dmg: 60 });
h = await b.next('hurt');
assert.deepEqual([h.ar, h.hp], [0, 100]);
b.send({ t: 'vit', op: 'heal', v: 999 }); // not an item: ignored
b.send({ t: 'vit', op: 'heal', v: 40 });
assert.equal((await b.next('hurt')).hp, 140);

// pickups: the first claim wins, once
a.send({ t: 'take', id: 'm3' });
b.send({ t: 'take', id: 'm3' });
assert.equal((await b.next('took')).by, wa.id);
assert.equal((await a.next('took')).by, wa.id);
await new Promise((r) => setTimeout(r, 150));
assert.equal(b.inbox.filter((m) => m.t === 'took').length, 0);
b.send({ t: 'drop', w: 2, p: [1, 0, 1], ammo: 5, reserve: 10 });
const dropped = await a.next('dropped');
assert.deepEqual([dropped.w, dropped.ammo], [2, 5]);
a.send({ t: 'take', id: dropped.id });
assert.equal((await b.next('took')).id, dropped.id);

// your own grenade can kill you; the other side gets the point
b.send({ t: 'hit', id: wb.id, zone: 'blast', dmg: 300 });
const selfKill = await a.next('kill');
assert.equal(selfKill.v, wb.id);
assert.equal(selfKill.score[wa.team], 2);

a.ws.close(); b.ws.close();
// a page on another site is refused
await new Promise((res, rej) => { const bad = new WebSocket(`ws://localhost:${PORT}`, { origin: 'https://evil.example' }); bad.on('open', () => rej(new Error('foreign origin accepted'))); bad.on('error', res); });
// a flood gets the socket dropped
const f = await client('F'); await f.next('welcome');
await new Promise((res) => { f.ws.on('close', res); for (let i = 0; i < 400; i++) f.send({ t: 'ping', c: i }); });
console.log('server ok');
srv.kill();
