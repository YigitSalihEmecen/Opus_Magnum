import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const PORT = 8899;
const V = 5;
const srv = spawn('node', ['index.js'], { cwd: import.meta.dirname, env: { ...process.env, PORT, LIMIT: 3, END_PAUSE: 1 } });
await new Promise((r) => srv.stdout.once('data', r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name, room = 'test') {
  const ws = new WebSocket(`ws://localhost:${PORT}`, { origin: 'http://localhost:5173' });
  const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d)));
  const next = (t, pred = () => true) => new Promise((res, rej) => {
    const end = Date.now() + 3000;
    (function poll() {
      const i = inbox.findIndex((m) => m.t === t && pred(m));
      if (i >= 0) return res(inbox.splice(i, 1)[0]);
      if (Date.now() > end) return rej(new Error(`${name}: no ${t}`));
      setTimeout(poll, 10);
    })();
  });
  return new Promise((r) => ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', v: V, name, room, mapId: 'builtin-duel', maps: ['builtin-duel', 'builtin-lido', 'builtin-sluice'], weapons: 5 })); r({ ws, next, inbox, send: (m) => ws.send(JSON.stringify(m)) }); }));
}

// 2v2: the first player gets a room with three bots and runs their brains (host)
const a = await client('A');
const wa = await a.next('welcome');
assert.equal(wa.host, wa.id);
assert.equal(wa.players.length, 4);
assert.equal(wa.players.filter((p) => p.bot).length, 3);
assert.ok(wa.players.every((p) => p.alive));
assert.equal(a.inbox.filter((m) => m.t === 'join').length, 0); // the welcome already lists the bots

// a second player takes a bot's slot on the other side
const b = await client('B');
const wb = await b.next('welcome');
assert.notEqual(wa.team, wb.team);
assert.equal(wb.host, wa.id);
assert.equal(wb.players.length, 4);
const gone = await a.next('leave');
assert.ok(wa.players.find((p) => p.id === gone.id).bot);
assert.equal((await a.next('join')).player.name, 'B');
assert.equal(wa.round.n, 1);
assert.ok(wa.round.weapon >= 0 && wa.round.weapon < 5);
const bots = wb.players.filter((p) => p.bot);
const botA = bots.find((p) => p.team === wa.team), botB = bots.find((p) => p.team === wb.team);
assert.ok(botA && botB);

await wait(1600); // spawn shield
const q = [1, 2, 3, 0, 0, 0, 0.5, 0, 0, 2, 3, 0, 12345];
b.send({ t: 's', q });
const pose = await a.next('s');
assert.equal(pose.id, wb.id);
assert.deepEqual(pose.q, q); // relayed as sent, stamped with the sender's clock
b.send({ t: 's', q: [1, 2, 'x'] }); // malformed: dropped
await wait(100);
assert.equal(a.inbox.filter((m) => m.t === 's').length, 0);

// the host speaks for its bots: poses in a batch, shots; nobody else can
a.send({ t: 'sb', b: [[botA.id, q], [botB.id, q], [wb.id, q]] });
const bp = [await b.next('s'), await b.next('s')].map((m) => m.id).sort();
assert.deepEqual(bp, [botA.id, botB.id].sort());
await wait(100);
assert.equal(b.inbox.filter((m) => m.t === 's').length, 0); // not a bot: ignored
b.send({ t: 'sb', b: [[botB.id, q]] }); // not the host: ignored
a.send({ t: 'fire', as: botA.id, o: [0, 1, 0], d: [1, 0, 0], w: 0 });
assert.equal((await b.next('fire')).id, botA.id);
await wait(100);
assert.equal(a.inbox.filter((m) => m.t === 's').length, 0);

// what a free hand does is relayed to the others (unknown actions are not)
b.send({ t: 'act', a: 'cross' });
b.send({ t: 'act', a: 'dance' });
const act = await a.next('act');
assert.deepEqual([act.id, act.a, act.i], [wb.id, 'cross', undefined]);
await wait(100);
assert.equal(a.inbox.filter((m) => m.t === 'act').length, 0);

// a bot's hit on a player comes from the host; the player hears who did it
a.send({ t: 'hit', as: botA.id, id: wb.id, zone: 'body', dmg: 30 });
let h = await b.next('hurt');
assert.deepEqual([h.hp, h.by], [95, botA.id]);
b.send({ t: 'hit', as: botB.id, id: wa.id, zone: 'body', dmg: 30 }); // not the host: ignored
await wait(100);
assert.equal(a.inbox.filter((m) => m.t === 'hurt').length, 0);
// hurting a bot: its health is told to the host
b.send({ t: 'hit', id: botA.id, zone: 'body', dmg: 50 });
const bh = await a.next('bhurt');
assert.deepEqual([bh.id, bh.hp, bh.by], [botA.id, 50, wb.id]);

// a round needs the whole team down, bots too
a.send({ t: 'hit', id: wb.id, zone: 'head', dmg: 200, w: 'panther' });
const kill = await a.next('kill');
assert.equal(kill.v, wb.id);
assert.equal(kill.head, true);
assert.equal(kill.w, 'panther'); // the kill feed shows what did it
assert.deepEqual(kill.score, { a: 0, b: 0 }); // B's bot is still up
a.send({ t: 'hit', id: botB.id, zone: 'body', dmg: 300 });
const kill2 = await b.next('kill', (m) => m.v === botB.id);
assert.equal(kill2.score[wa.team], 1);
a.send({ t: 'hit', id: wb.id, zone: 'body', dmg: 100 }); // round over: no more damage
const round = await b.next('round');
assert.equal(round.n, 2);
assert.notEqual(round.weapon, wa.round.weapon);
assert.equal(round.score[wa.team], 1);
await wait(1600); // spawn shield
b.inbox.length = 0;
a.send({ t: 'hit', id: wb.id, zone: 'body', dmg: 40 });
assert.equal((await b.next('hurt')).hp, 85); // fresh round: full health again (Rivet: 125)

// armour soaks damage first; heals only restore what an item can
b.send({ t: 'vit', op: 'wear', v: 50 });
h = await b.next('hurt');
assert.deepEqual([h.ar, h.am], [50, 50]);
h = await a.next('ar', (m) => m.id === wb.id); // the others hear about the vest (damage-number colours)
assert.deepEqual([h.ar, h.am], [50, 50]);
a.inbox.length = 0;
a.send({ t: 'hit', id: wb.id, zone: 'body', dmg: 60 });
h = await b.next('hurt');
assert.deepEqual([h.ar, h.hp], [0, 75]);
h = await a.next('struck', (m) => m.id === wb.id);
assert.deepEqual([h.ar, h.am], [0, 50]);

// a smoke grenade is relayed as one
b.send({ t: 'nade', p: [0, 1, 0], v: [1, 2, 3], f: 1.4, k: 'smoke' });
assert.equal((await a.next('nade')).k, 'smoke');
b.send({ t: 'vit', op: 'heal', v: 999 }); // not an item: ignored
b.send({ t: 'vit', op: 'heal', v: 40 });
assert.equal((await b.next('hurt')).hp, 115);

// pickups: the first claim wins, once
a.send({ t: 'take', id: 'm3' });
b.send({ t: 'take', id: 'm3' });
assert.equal((await b.next('took')).by, wa.id);
assert.equal((await a.next('took')).by, wa.id);
await wait(150);
assert.equal(b.inbox.filter((m) => m.t === 'took').length, 0);
b.send({ t: 'drop', w: 2, p: [1, 0, 1], ammo: 5, reserve: 10 });
const dropped = await a.next('dropped');
assert.deepEqual([dropped.w, dropped.ammo], [2, 5]);
a.send({ t: 'take', id: dropped.id });
assert.equal((await b.next('took')).id, dropped.id);

// falling into the water kills you; with your bot gone too, the other side gets the point
a.inbox.length = 0; // last round's kills
b.send({ t: 'hit', id: wb.id, zone: 'fall', dmg: 999 });
assert.equal((await a.next('kill', (m) => m.v === wb.id)).v, wb.id);
a.send({ t: 'hit', id: botB.id, zone: 'body', dmg: 300 });
assert.equal((await a.next('kill', (m) => m.v === botB.id)).score[wa.team], 2);

// the third point ends the match: a ballot of the room's maps, most votes picks the next one
await b.next('round');
await wait(1600);
a.send({ t: 'hit', id: wb.id, zone: 'head', dmg: 300 });
a.send({ t: 'hit', id: botB.id, zone: 'head', dmg: 300 });
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
await wait(100);
assert.equal(a.inbox.filter((m) => m.t === 'door').length, 0);

// the host leaves: B takes the bots over, and a bot fills A's slot (out until the next round)
b.inbox.length = 0;
a.ws.close();
assert.equal((await b.next('leave')).id, wa.id);
assert.equal((await b.next('host')).id, wb.id);
const filler = (await b.next('join')).player;
assert.deepEqual([filler.bot, filler.team, filler.alive], [true, wa.team, false]);

// a client on another protocol is told why
const old = new WebSocket(`ws://localhost:${PORT}`, { origin: 'http://localhost:5173' });
const err = await new Promise((r) => { old.on('open', () => old.send(JSON.stringify({ t: 'hello', v: 2, name: 'Old', room: 'test' }))); old.on('message', (d) => r(JSON.parse(d))); });
assert.equal(err.t, 'error');
assert.match(err.msg, /reload/);

// four people fill a room; a fifth is turned away
const ts = [];
for (const n of ['T1', 'T2', 'T3', 'T4']) { const c = await client(n, 'full'); ts.push([c, await c.next('welcome')]); }
assert.deepEqual(ts.map(([, w]) => w.team), ['a', 'b', 'a', 'b']);
assert.equal(ts[3][1].players.filter((p) => p.bot).length, 0);
const t5 = new WebSocket(`ws://localhost:${PORT}`, { origin: 'http://localhost:5173' });
const full = await new Promise((r) => { t5.on('open', () => t5.send(JSON.stringify({ t: 'hello', v: V, name: 'T5', room: 'full' }))); t5.on('message', (d) => r(JSON.parse(d))); });
assert.match(full.msg, /full/);
for (const [c] of ts) c.ws.close();

b.ws.close();
// a page on another site is refused
await new Promise((res, rej) => { const bad = new WebSocket(`ws://localhost:${PORT}`, { origin: 'https://evil.example' }); bad.on('open', () => rej(new Error('foreign origin accepted'))); bad.on('error', res); });
// a flood gets the socket dropped (the host's budget is bigger, so flood a second player's)
const f1 = await client('F1', 'flood'); await f1.next('welcome');
const f = await client('F', 'flood'); await f.next('welcome');
await new Promise((res) => { f.ws.on('close', res); for (let i = 0; i < 400; i++) f.send({ t: 'ping', c: i }); });
f1.ws.close();
console.log('server ok');
srv.kill();
