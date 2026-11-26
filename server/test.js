import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const PORT = 8899;
const srv = spawn('node', ['index.js'], { cwd: import.meta.dirname, env: { ...process.env, PORT, LIMIT: 3, END_PAUSE: 1 } });
await new Promise((r) => srv.stdout.once('data', r));

function client(name, room = 'test') {
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
  return new Promise((r) => ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', v: 3, name, room, mapId: 'builtin-duel', maps: ['builtin-duel', 'builtin-lido', 'builtin-sluice'], weapons: 5 })); r({ ws, next, inbox, send: (m) => ws.send(JSON.stringify(m)) }); }));
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
const q = [1, 2, 3, 0, 0, 0, 0.5, 0, 0, 2, 3, 0, 12345];
b.send({ t: 's', q });
const pose = await a.next('s');
assert.equal(pose.id, wb.id);
assert.deepEqual(pose.q, q); // relayed as sent, stamped with the sender's clock
b.send({ t: 's', q: [1, 2, 'x'] }); // malformed: dropped
await new Promise((r) => setTimeout(r, 100));
assert.equal(a.inbox.filter((m) => m.t === 's').length, 0);

a.send({ t: 'hit', id: wb.id, zone: 'body', dmg: 100 });
assert.equal((await b.next('hurt')).hp, 50);
a.send({ t: 'hit', id: wb.id, zone: 'head', dmg: 100, w: 'panther' });
const kill = await a.next('kill');
assert.equal(kill.v, wb.id);
assert.equal(kill.head, true);
assert.equal(kill.w, 'panther'); // the kill feed shows what did it
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

// falling into the water kills you; the other side gets the point
b.send({ t: 'hit', id: wb.id, zone: 'fall', dmg: 999 });
const selfKill = await a.next('kill');
assert.equal(selfKill.v, wb.id);
assert.equal(selfKill.score[wa.team], 2);

// the third point ends the match: a ballot of the room's maps, most votes picks the next one
await b.next('round');
await new Promise((r) => setTimeout(r, 1600));
a.send({ t: 'hit', id: wb.id, zone: 'head', dmg: 300 });
const end = await b.next('end');
assert.deepEqual(end.vote.options, ['builtin-duel', 'builtin-lido', 'builtin-sluice']);
a.send({ t: 'vote', map: 'builtin-sluice' });
b.send({ t: 'vote', map: 'builtin-sluice' });
b.send({ t: 'vote', map: 'nowhere' }); // not on the ballot: ignored
assert.equal((await a.next('votes')).tally['builtin-sluice'], 1);
assert.equal((await a.next('votes')).tally['builtin-sluice'], 2);
const restart = await b.next('restart');
assert.equal(restart.mapId, 'builtin-sluice');
assert.deepEqual(restart.score, { a: 0, b: 0 });

// doors: a push is relayed to the others and kept for whoever joins later
a.send({ t: 'door', id: 'o3', open: true, dir: -1 });
const door = await b.next('door');
assert.deepEqual([door.id, door.open, door.dir], ['o3', true, -1]);
b.send({ t: 'door', id: 'nope', open: true }); // not a door id: ignored
await new Promise((r) => setTimeout(r, 100));
assert.equal(a.inbox.filter((m) => m.t === 'door').length, 0);

// a client on another protocol is told why
const old = new WebSocket(`ws://localhost:${PORT}`, { origin: 'http://localhost:5173' });
const err = await new Promise((r) => { old.on('open', () => old.send(JSON.stringify({ t: 'hello', v: 2, name: 'Old', room: 'test' }))); old.on('message', (d) => r(JSON.parse(d))); });
assert.equal(err.t, 'error');
assert.match(err.msg, /reload/);

// three players: the round only ends when a whole team is down
const t1 = await client('T1', 'teams'), w1 = await t1.next('welcome');
const t2 = await client('T2', 'teams'), w2 = await t2.next('welcome');
const t3 = await client('T3', 'teams'), w3 = await t3.next('welcome');
assert.deepEqual([w1.team, w2.team, w3.team], ['a', 'b', 'a']);
await new Promise((r) => setTimeout(r, 1600)); // spawn shield
t2.send({ t: 'hit', id: w1.id, zone: 'body', dmg: 300 });
const k1 = await t3.next('kill');
assert.equal(k1.v, w1.id);
assert.deepEqual(k1.score, { a: 0, b: 0 }); // T3 is still up: no round yet
await new Promise((r) => setTimeout(r, 300));
assert.equal(t3.inbox.filter((m) => m.t === 'round').length, 0);
t2.send({ t: 'hit', id: w3.id, zone: 'body', dmg: 300 });
await t1.next('kill'); // its own death
assert.deepEqual((await t1.next('kill')).score, { a: 0, b: 1 }); // team a wiped: b takes the round
assert.equal((await t1.next('round')).n, 2);
for (const c of [t1, t2, t3]) c.ws.close();

a.ws.close(); b.ws.close();
// a page on another site is refused
await new Promise((res, rej) => { const bad = new WebSocket(`ws://localhost:${PORT}`, { origin: 'https://evil.example' }); bad.on('open', () => rej(new Error('foreign origin accepted'))); bad.on('error', res); });
// a flood gets the socket dropped
const f = await client('F'); await f.next('welcome');
await new Promise((res) => { f.ws.on('close', res); for (let i = 0; i < 400; i++) f.send({ t: 'ping', c: i }); });
console.log('server ok');
srv.kill();
