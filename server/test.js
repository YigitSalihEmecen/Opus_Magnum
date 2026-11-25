import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const PORT = 8899;
const srv = spawn('node', ['index.js'], { cwd: import.meta.dirname, env: { ...process.env, PORT } });
await new Promise((r) => srv.stdout.once('data', r));

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
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
  return new Promise((r) => ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', name, room: 'test', mapId: 'builtin-duel' })); r({ ws, next, inbox, send: (m) => ws.send(JSON.stringify(m)) }); }));
}

const a = await client('A');
const wa = await a.next('welcome');
const b = await client('B');
const wb = await b.next('welcome');
assert.equal(wb.players.length, 2);
assert.notEqual(wa.team, wb.team);
assert.equal((await a.next('join')).player.name, 'B');

await new Promise((r) => setTimeout(r, 1600)); // spawn shield
b.send({ t: 's', p: [1, 2, 3], v: [0, 0, 0], y: 0, pi: 0, w: 0, st: 'ground' });
const snap = await a.next('snap');
assert.deepEqual(snap.ps.find((p) => p.id === wb.id).p, [1, 2, 3]);

a.send({ t: 'hit', id: wb.id, zone: 'body', dmg: 100 });
assert.equal((await b.next('hurt')).hp, 50);
a.send({ t: 'hit', id: wb.id, zone: 'head', dmg: 100 });
const kill = await a.next('kill');
assert.equal(kill.v, wb.id);
assert.equal(kill.head, true);
assert.equal(kill.score[wa.team], 1);
a.send({ t: 'hit', id: wb.id, zone: 'body', dmg: 100 }); // dead targets take no damage
await b.next('respawn');

a.ws.close(); b.ws.close(); srv.kill();
console.log('server ok');
