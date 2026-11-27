import * as THREE from 'three';
import { Avatar, raySegment } from '../character/avatar.js';
import { Bot } from '../modes/tdm/bot.js';
import { NavGrid } from '../modes/tdm/nav.js';
import { Tactics } from '../modes/tdm/tactics.js';
import { MatchHud } from '../ui/matchHud.js';
import { WorldFX } from '../weapons/effects.js';
import { WEAPONS } from '../weapons/weapons.js';
import { Pickups } from '../items/pickups.js';
import { soakArmour, armourTier } from '../items/items.js';

/*
  Online match against other players through the match server (server/index.js). Same level interface as TDM:
    octree · spawn · targets · playerAlive · ended · update(dt, { camera, gun }) · dispose()
  This client owns its movement and hit detection; the server owns HP, armour, kills, score, the clock and who
  got which pickup (claims go up as take/drop, answers come back as took/dropped). Grenades are simulated on
  every client; only the thrower's client reports what its blast hit.
  Poses go out SEND_HZ times a second stamped with the sender's clock, and the server relays them at once.
  Each remote keeps the smallest (arrival - sender time) it has seen as its clock offset, so its poses are
  replayed on the sender's own even timeline, INTERP ms behind, instead of on bunched-up arrival times; when
  the stream stalls it coasts on the last velocity for a moment rather than freezing.
  After a match the server runs a map vote; a new map is swapped in place (onMap lets main.js rebind).
  2v2 with bots: the server fills empty slots with bots. One client, the host, runs their brains (the TDM bot,
  src/modes/tdm/, on a nav grid it builds for the map): it sends their poses in batches, their shots and hits
  (as the bot), and the server tells it how they're hurt. Everyone else sees them as Remotes like any player.
  If the host leaves the server names another, which takes the bots over where they stand.
  Delete src/net/ and its MODES entry in main.js to remove multiplayer (it uses the TDM bot, not the reverse).
*/

export const PROTOCOL = 6; // server/index.js PROTOCOL
const SEND_HZ = 30;
const INTERP = 80;
const COAST = 120; // ms of extrapolation past the newest pose
const STATES = ['ground', 'air', 'slide', 'wallrun', 'mantle', 'vault']; // 'wallrun' is retired; kept so indices don't shift

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _ray = new THREE.Ray();
const lerpAngle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const round = (v) => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];

/** Opens the socket, says hello and resolves with the welcome; later messages queue until a handler is set. */
function connect(url, hello) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(url); } catch { reject(new Error(`Bad server address: ${url}`)); return; }
    const queue = [];
    const timer = setTimeout(() => { ws.close(); reject(new Error(`Couldn't reach the server at ${url}`)); }, 7000);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', ...hello }));
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`Couldn't reach the server at ${url}`)); };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.t === 'error') { clearTimeout(timer); ws.close(); reject(new Error(msg.msg)); return; }
      if (msg.t !== 'welcome') { queue.push(msg); return; }
      clearTimeout(timer);
      // an older server half-works (no pickups, no vote): say so instead of playing on it
      if (msg.v !== PROTOCOL) { ws.close(); reject(new Error('The match server is out of date: update and restart it (git pull, then node server/index.js)')); return; }
      resolve({ ws, welcome: msg, queue });
    };
  });
}

export async function createOnline({ opts, getMap, buildWorld, ...ctx }) {
  const local = getMap(opts.mapId);
  const hello = { v: PROTOCOL, name: opts.name, room: opts.room, char: opts.char, weapons: WEAPONS.length, mapId: opts.mapId, maps: opts.maps, map: local && !local.builtin ? local : undefined };
  const { ws, welcome, queue } = await connect(opts.server, hello);
  const map = welcome.map ?? getMap(welcome.mapId) ?? local;
  const arena = await buildWorld(map);
  return new Online({ ...ctx, ws, welcome, queue, arena, getMap, buildWorld, mapId: welcome.mapId });
}

/** Another player: an Avatar posed from their poses on the wire; hits on it are reported to the server. */
class Remote extends Avatar {
  constructor(net, info) {
    super({ team: info.team === net.team ? 'ally' : 'enemy', name: info.name, char: info.char });
    Object.assign(this, { world: net, id: info.id, bot: !!info.bot, buf: [], lastStep: 0, poseTarget: {}, off: null, rlWas: false });
    this.alive = info.alive;
    this.armour = this.armourMax = 0; // what we last heard (struck / ar); our own hits take it down until the server answers
    this.root.visible = false; // until the first snapshot places it
  }

  /** Pellets and same-frame hits add up here; Online sends them as one hit per frame. */
  damage(amount, zone, point, dir, now, weapon) {
    if (!this.alive || this.team === 'ally') return null;
    const h = (this.pending ??= { dmg: 0, head: false });
    h.dmg += amount;
    h.head ||= zone === 'head';
    h.w = weapon;
    this.world.noteDealt(this.id, amount);
    return { killed: false, armour: soakArmour(this, amount).armour };
  }

  flushHits() {
    if (!this.pending) return;
    this.world.send({ t: 'hit', id: this.id, zone: this.pending.head ? 'head' : 'body', dmg: Math.round(this.pending.dmg * 10) / 10, w: this.pending.w });
    this.pending = null;
  }

  /** A pose from the wire (see PROTOCOL in server/index.js); arrival is our clock when it landed. */
  push(q, al, arrival) {
    if (al && !this.alive) this.revive();
    const t = q[12], last = this.buf.at(-1);
    if (last && t <= last.t) return; // late or repeated
    const off = arrival - t;
    if (this.off === null || off < this.off) this.off = off;
    this.buf.push({ t, p: new THREE.Vector3(q[0], q[1], q[2]), v: new THREE.Vector3(q[3], q[4], q[5]), y: q[6], pi: q[7], w: q[8], st: STATES[q[9]] ?? 'ground', cr: q[10] & 1, ads: (q[10] >> 1) & 1, rl: (q[10] >> 2) & 1, side: q[11] });
    if (this.buf.length > 40) this.buf.shift();
    this.root.visible ||= this.alive;
  }

  revive() {
    this.alive = true;
    this.buf.length = 0; // respawn is a teleport: don't slide from the body to the spawn
    this.body.rotation.set(0, 0, 0);
    this.body.position.y = 0;
    this.showMarker();
  }

  kill(dir) {
    this.alive = false;
    this.deathT = 0;
    this.fallDir = dir ? Math.atan2(dir.x, dir.z) - this.aimYaw : Math.PI;
  }

  update(dt, now) {
    const buf = this.buf;
    // the offset creeps up slowly so a route that got slower is followed; any faster pose pulls it back down
    if (this.off !== null) this.off += dt * 2;
    if (buf.length && this.alive) {
      const t = now - this.off - INTERP;
      let i = buf.length - 1;
      while (i > 0 && buf[i - 1].t > t) i--;
      const a = buf[Math.max(0, i - 1)], b = buf[i];
      const k = b.t > a.t ? THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1) : 1;
      if (t > b.t) {
        // stream behind: coast along the last velocity for a moment
        this.pos.copy(b.p).addScaledVector(b.v, Math.min(t - b.t, COAST) / 1000);
        this.vel.copy(b.v);
      } else {
        // a jump of metres between poses is a respawn or a teleport: snap, don't slide
        const kp = a.p.distanceToSquared(b.p) < 16 ? k : 1;
        this.pos.lerpVectors(a.p, b.p, kp);
        this.vel.lerpVectors(a.v, b.v, kp);
      }
      this.aimYaw = lerpAngle(a.y, b.y, k);
      this.aimPitch = a.pi + (b.pi - a.pi) * k;
      this.side = a.side + (b.side - a.side) * k;
      if (WEAPONS[b.w]) this.holdWeapon(WEAPONS[b.w]);
      // mirror the movement state: the body poses (and so the hitboxes) follow what the player is doing
      const p = this.poseTarget;
      p.crouch = b.cr && b.st !== 'slide' ? 1 : 0;
      p.slide = b.st === 'slide' ? 1 : 0;
      p.air = b.st === 'air' ? 1 : 0;
      p.mantle = b.st === 'mantle' ? 1 : 0;
      p.vault = b.st === 'vault' ? 1 : 0;
      p.ads = b.ads ? 1 : 0;
      // a reload plays through from when it began (the body eases out if it's cut short)
      if (b.rl && !this.rlWas) this.reloadT = this.reloadTime;
      else if (!b.rl) this.reloadT = 0;
      else this.reloadT = Math.max(0.05, this.reloadT - dt);
      this.rlWas = !!b.rl;
      // footsteps on the gait, only while running on something
      const step = Math.floor(this.phase / Math.PI);
      if (step !== this.lastStep) {
        this.lastStep = step;
        if (b.st === 'ground' && this.vel.lengthSq() > 1) this.world.footstep(this.pos);
      }
    }
    this.pose(dt);
  }
}

class Online {
  constructor({ scene, camera, audio, hud, mv, rig, arsenal, inv, melee, vitals, ws, welcome, queue, arena, getMap, buildWorld, mapId }) {
    Object.assign(this, { scene, camera, audio, hud, mv, rig, arsenal, inv, melee, vitals, ws, getMap, buildWorld });
    this.lastAct = null;
    vitals.serverOwned = true;
    vitals.sync = (op, v) => this.send({ t: 'vit', op, v });
    this.onMap = () => {};
    this.#setArena(arena, mapId);
    for (const id of welcome.items?.taken ?? []) this.pickups.take(this.pickups.byId(id));
    for (const d of welcome.items?.drops ?? []) this.pickups.drop({ gun: d.w, ammo: d.ammo, reserve: d.reserve }, new THREE.Vector3(...d.p), d.id);
    for (const [id, open, dir] of welcome.doors ?? []) this.doors.set(id, open, dir, true);
    this.id = welcome.id;
    this.team = welcome.team;
    this.host = welcome.host === this.id;
    this.brains = new Map(); // bots this client runs (host only), by id
    this.botList = [];
    this.infos = new Map();
    this.hits = new Map();
    this.foe = this.team === 'a' ? 'b' : 'a';
    this.fx = new WorldFX(scene);
    this.limit = welcome.limit;
    this.score = welcome.score;
    this.time = welcome.time;
    this.round = welcome.round;
    this.ended = false;
    this.alive = true;
    this.deathT = 0;
    this.sendT = 0;
    this.pingT = 0;
    this.rtt = null;
    this.names = new Map([[this.id, 'You']]);
    this.stats = new Map(welcome.players.map((p) => [p.id, { kills: p.kills ?? 0, deaths: p.deaths ?? 0 }]));
    this.ledger = new Map(); // this life: player id → { dealt, taken, hits }
    this.remotes = new Map();
    this.ui = new MatchHud({ ally: 'You', enemy: 'Them', limit: this.limit });
    this.mid = this.ui.root.querySelector('.mid .label');
    for (const p of welcome.players) if (p.id !== this.id) this.#add(p);
    this.spawn = this.#pickSpawn();
    this.#refreshTargets();
    this.#score();
    if (welcome.ended) this.#end(this.score, welcome.vote);

    this.inbox = null; // set while a new map loads: messages wait in it
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (this.inbox) this.inbox.push(m); else this.#on(m); };
    ws.onclose = () => this.#lost();
    for (const m of queue) this.#on(m);
    this.onKey = (e) => {
      const n = Number(e.code.match(/^Digit(\d)$/)?.[1]);
      if (this.ended && this.vote && n >= 1) this.#vote(this.vote.options[n - 1]);
    };
    addEventListener('keydown', this.onKey);
  }

  #setArena(arena, mapId) {
    this.arena = arena;
    this.mapId = mapId;
    this.mapName = arena.name ?? this.getMap(mapId)?.name ?? 'Online';
    this.octree = arena.octree;
    this.pickups = new Pickups(this.scene, { octree: arena.octree, spots: arena.pickups, net: this });
    this.pickups.onTaken = (p) => this.#heard(p.pos, 'magIn', 0.35);
    this.doors = arena.doors;
    this.doors.onToggle = (id, open, dir) => this.send({ t: 'door', id, open, dir });
  }

  /** The vote moved the room to another map: tear this one down and build that one where we stand. */
  async #changeMap(mapId) {
    this.inbox = [];
    const map = this.getMap(mapId);
    if (map) {
      const onGrant = this.pickups.onGrant;
      this.arena.dispose();
      this.pickups.dispose();
      this.doors.dispose();
      this.#setArena(await this.buildWorld(map), mapId);
      this.pickups.onGrant = onGrant;
      // our bots move to the new map's nav grid (they're placed when the next round starts)
      if (this.bw) { this.bw = null; const w = this.#brains(); for (const b of this.botList) { b.world = w; b.alive = false; b.root.visible = false; } }
      for (const r of this.remotes.values()) r.buf.length = 0;
      this.#refreshTargets();
      this.onMap();
    } else this.ui.toast('Unknown map: reload to update the game');
    const waiting = this.inbox;
    this.inbox = null;
    for (const m of waiting) this.#on(m);
  }

  get playerAlive() { return this.alive; }
  /** Who the camera follows while you're out: your killer, then (once they're down too) a teammate still up. */
  get watch() {
    if (this.alive) return null;
    const k = this.killerRef;
    return k?.alive ? k : this.#others().find((r) => r.alive && r.team === 'ally') ?? k ?? null;
  }

  /** Damage traded with player `id` this life: { dealt, taken, hits }. */
  #trade(id, key, amount) {
    const e = this.ledger.get(id) ?? { dealt: 0, taken: 0, hits: 0 };
    e[key] += amount;
    if (key === 'taken') e.hits++;
    this.ledger.set(id, e);
  }
  noteDealt(id, amount) { this.#trade(id, 'dealt', amount); }
  /** Everyone doors open for on their own: bots, ours and the ones others run. */
  get bots() { return [...this.botList, ...[...this.remotes.values()].filter((r) => r.bot)]; }
  /** Gun-game: every round starts with the round's weapon; one more can be picked up off the map. */
  get loadout() { return { guns: [this.round?.weapon ?? 0], maxGuns: 2, mags: 3, items: {} }; }

  /** Our grenade left the hand: everyone else simulates the same throw. */
  onThrow(g) { this.send({ t: 'nade', p: round(g.pos), v: round(g.vel), f: +g.fuse.toFixed(2), k: g.kind === 'smoke' ? 'smoke' : undefined }); }

  /** Our own grenade caught us: the server takes it off our health like any hit. */
  hurtSelf(dmg) { this.send({ t: 'hit', id: this.id, zone: 'blast', dmg, w: 'grenade' }); }

  send(msg) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); }

  dispose() {
    removeEventListener('keydown', this.onKey);
    this.ws.onclose = null;
    this.ws.close();
    this.arena.dispose();
    this.pickups.dispose();
    this.vitals.serverOwned = false;
    this.vitals.sync = null;
    for (const r of this.remotes.values()) this.scene.remove(r.root);
    for (const b of this.botList) this.scene.remove(b.root);
    this.ui.root.remove();
    this.ui.fx.remove();
  }

  /** Hold-Tab scoreboard rows (your side, then theirs). */
  scoreRows() {
    const st = (id) => this.stats.get(id) ?? { kills: 0, deaths: 0 };
    const me = { name: 'You', ...st(this.id), you: true, dead: !this.alive };
    const rows = (enemy) => this.#others().filter((r) => (r.team === 'enemy') === enemy).map((r) => ({ name: r.name, ...st(r.id), dead: !r.alive }));
    const wpn = WEAPONS[this.round?.weapon]?.name;
    return {
      title: `Multiplayer · ${this.mapName}${this.round ? ` · Round ${this.round.n}${wpn ? ` · ${wpn}` : ''}` : ''}`,
      teams: [
        { label: 'You', team: 'ally', score: this.score[this.team], rows: [me, ...rows(false)] },
        { label: 'Them', team: 'enemy', score: this.score[this.foe], rows: rows(true) },
      ],
    };
  }

  /** Everyone else in the match: remote players (and remote bots), and the bots we run. */
  #others() { return [...this.remotes.values(), ...this.botList]; }

  #add(info) {
    this.stats.set(info.id, { kills: info.kills ?? 0, deaths: info.deaths ?? 0 });
    this.infos.set(info.id, info);
    this.names.set(info.id, info.name);
    if (info.bot && this.host) { this.#addBot(info); return; }
    const r = new Remote(this, info);
    this.remotes.set(info.id, r);
    this.scene.add(r.root);
  }

  // ── the bots we run (host) ──

  /** The bots' world: the map's nav grid and tactics, built the first time we host on this map. */
  #brains() {
    if (this.bw) return this.bw;
    const arena = this.arena, net = this, mv = this.mv;
    const nav = (arena.nav ??= new NavGrid(arena.octree, arena.bounds));
    if (!arena.hotspots) {
      arena.hotspots = [];
      for (let i = 0; i < 14; i++) { const p = nav.randomPoint(); if (p) arena.hotspots.push(p); }
    }
    const mine = this.team === 'a' ? 'ally' : 'enemy', theirs = mine === 'ally' ? 'enemy' : 'ally';
    // us, as the bots see us (the same shape as the TDM player proxy)
    this.me ??= {
      id: this.id, team: 'ally', name: 'You',
      get alive() { return net.alive && !net.ended; },
      get pos() { return mv.feet; },
      get vel() { return mv.vel; },
      get hp() { return net.vitals.hp; },
      get maxHp() { return net.vitals.max; },
      get facing() { return net.rig.yaw + Math.PI; },
      eye(out = new THREE.Vector3()) { return out.copy(net.camera.position); },
      aimPoint(head, out = new THREE.Vector3()) { return out.copy(mv.feet).setY(mv.feet.y + (head ? mv.height - 0.17 : mv.height * 0.62)); },
      hitTest(ray) {
        if (!this.alive) return null;
        const sph = new THREE.Sphere(_c.copy(mv.feet).setY(mv.feet.y + mv.height - 0.17), 0.18);
        const h = ray.intersectSphere(sph, _b);
        if (h) return { dist: h.distanceTo(ray.origin), zone: 'head' };
        const r = raySegment(ray, _a.copy(mv.feet).setY(mv.feet.y + 0.3), _b.copy(mv.feet).setY(mv.feet.y + mv.height - 0.4));
        if (r.dist >= 0.34) return null;
        return { dist: r.t, zone: ray.origin.y + ray.direction.y * r.t - mv.feet.y < mv.height * 0.47 ? 'legs' : 'body' };
      },
    };
    this.foes = [];
    this.friends = [];
    const w = (this.bw = {
      now: 0, nav, octree: arena.octree, fx: this.fx, pathBudget: 0, player: this.me,
      arena: { hotspots: arena.hotspots, spawns: { ally: arena.spawns[mine], enemy: arena.spawns[theirs] } },
      get bots() { return net.botList; },
      enemiesOf: (team) => (team === 'ally' ? this.foes : this.friends),
      los(from, to) {
        if (net.grenades?.smoke.blocks(from, to)) return false;
        const d = from.distanceTo(to);
        _ray.origin.copy(from);
        _ray.direction.subVectors(to, from).divideScalar(d || 1);
        const hit = arena.octree.rayIntersect(_ray);
        return !hit || hit.distance >= d - 0.25;
      },
      gunshot: (bot, muzzle, dir) => this.#botShot(bot, muzzle, dir),
      onKill() {}, // the server decides who dies
      hitTarget: (target, dmg, zone, bot, weapon) => this.#queueHit(target === this.me ? this.id : target.id, dmg, zone, weapon, bot.id),
      netHit: (bot, dmg, zone, weapon) => { this.#queueHit(bot.id, dmg, zone, weapon); this.noteDealt(bot.id, dmg); return { killed: false }; },
    });
    w.tactics = new Tactics(nav, arena.octree, w);
    return w;
  }

  /** A bot we'll run; `from` (a Remote) when taking one over mid-round: it carries on from there. */
  #addBot(info, from) {
    const world = this.#brains();
    const b = new Bot(world, { team: info.team === this.team ? 'ally' : 'enemy', name: info.name, weapon: WEAPONS[this.round?.weapon ?? 0] ?? WEAPONS[0], skill: 0.4 + Math.random() * 0.25, char: info.char });
    b.id = info.id;
    this.brains.set(b.id, b);
    this.botList.push(b);
    this.scene.add(b.root);
    if (info.alive) {
      b.spawn(this.#botSpawn(b));
      if (from) { b.pos.copy(from.pos); b.aimYaw = b.yaw = from.aimYaw; }
      b.showMarker();
    }
  }

  #dropBot(id) {
    const b = this.brains.get(id);
    if (!b) return false;
    this.scene.remove(b.root);
    this.brains.delete(id);
    this.botList.splice(this.botList.indexOf(b), 1);
    return true;
  }

  #botSpawn(b) {
    const list = this.bw.arena.spawns[b.team];
    return list[(Math.random() * list.length) | 0];
  }

  /** The server made us host: the bots others ran become ours, where they stand. */
  #takeOver() {
    this.host = true;
    for (const r of [...this.remotes.values()]) {
      if (!r.bot) continue;
      this.scene.remove(r.root);
      this.remotes.delete(r.id);
      this.#addBot({ ...this.infos.get(r.id), alive: r.alive }, r);
    }
    this.#refreshTargets();
  }

  /** Hits add up per shooter and target over a frame (pellets) and go out as one message each. */
  #queueHit(id, dmg, zone, w, as) {
    const k = `${as ?? ''}>${id}`;
    const h = this.hits.get(k) ?? { id, as, dmg: 0, head: false, legs: true, w };
    h.dmg += dmg;
    h.head ||= zone === 'head';
    h.legs &&= zone === 'legs';
    this.hits.set(k, h);
  }

  #flushHits() {
    for (const h of this.hits.values()) this.send({ t: 'hit', id: h.id, as: h.as, zone: h.head ? 'head' : h.legs ? 'legs' : 'body', dmg: Math.round(h.dmg * 10) / 10, w: h.w });
    this.hits.clear();
  }

  /** One of our bots fired: the others draw it, and enemy bots hear it. */
  #botShot(bot, muzzle, dir) {
    this.send({ t: 'fire', as: bot.id, o: round(muzzle), d: round(dir), w: WEAPONS.indexOf(bot.weapon) });
    this.#heard(muzzle, bot.gun.sample ?? 'fire', 0.45, 110);
    this.#noise(muzzle, bot);
  }

  /** Gunfire at pos by `who`: the bots we run on the other side hear it. */
  #noise(pos, who) {
    for (const b of this.botList) if (b.alive && b.team !== who.team && b.pos.distanceTo(pos) < 48) b.hear(pos, who);
  }

  #combatant(id) { return id === this.id ? this.me : this.remotes.get(id) ?? this.brains.get(id); }

  /** Our bots' poses, one message for all of them. */
  #sendBots() {
    const r2 = (x) => Math.round(x * 100) / 100, r3 = (x) => Math.round(x * 1000) / 1000, t = Math.round(performance.now());
    const b = [];
    for (const bot of this.botList) {
      if (!bot.alive) continue;
      const p = bot.poseTarget, st = bot.climb ? (bot.climb.up ? 4 : 1) : bot.slideT > 0 ? 2 : 0;
      const f = (p.crouch ? 1 : 0) | (p.ads ? 2 : 0) | (bot.reloadT > 0 ? 4 : 0);
      b.push([bot.id, [r3(bot.pos.x), r3(bot.pos.y), r3(bot.pos.z), r2(bot.vel.x), 0, r2(bot.vel.z), r3(bot.aimYaw), r3(bot.aimPitch), Math.max(0, WEAPONS.indexOf(bot.weapon)), st, f, r2(bot.side), t]]);
    }
    if (b.length) this.send({ t: 'sb', b });
  }

  #runBots(dt) {
    const w = this.bw;
    w.now += dt;
    w.pathBudget = 4;
    this.foes.length = this.friends.length = 0;
    this.friends.push(this.me);
    for (const o of this.#others()) (o.team === 'enemy' ? this.foes : this.friends).push(o);
    w.tactics.update(dt, w.now);
    for (const b of this.botList) b.update(dt);
  }

  /** In place: main.js holds on to this array. */
  #refreshTargets() {
    this.targets ??= [];
    this.targets.length = 0;
    this.targets.push(...this.arena.raycastTargets, ...this.#others().flatMap((r) => r.hitboxes));
  }

  #who(id) {
    if (id === this.id) return { name: 'You', team: 'ally' };
    return { name: this.names.get(id) ?? '?', team: (this.remotes.get(id) ?? this.brains.get(id))?.team ?? 'enemy' };
  }

  #score() { this.ui.score({ ally: this.score[this.team], enemy: this.score[this.foe] }, this.time); }

  #on(m) {
    const now = performance.now();
    switch (m.t) {
      case 's': this.remotes.get(m.id)?.push(m.q, m.al, now); break;
      case 'join':
        this.#add(m.player);
        this.#refreshTargets();
        if (!m.player.bot) this.ui.toast(`${m.player.name} joined`);
        break;
      case 'host': if (m.id === this.id && !this.host) this.#takeOver(); break;
      case 'bhurt': {
        const b = this.brains.get(m.id);
        if (!b) break;
        b.hp = m.hp;
        if (m.dmg) b.hurt(m.dmg, this.#combatant(m.by));
        break;
      }
      case 'leave': {
        const bot = this.infos.get(m.id)?.bot;
        if (this.#dropBot(m.id)) { this.#refreshTargets(); break; }
        const r = this.remotes.get(m.id);
        if (!r) break;
        this.scene.remove(r.root);
        this.remotes.delete(m.id);
        this.#refreshTargets();
        if (!bot) this.ui.toast(`${this.names.get(m.id)} left`);
        break;
      }
      case 'fire': this.#remoteFire(m); break;
      case 'act': {
        const r = this.remotes.get(m.id);
        if (m.a === 'stop') r?.stopAct(); else r?.act(m.a, m.i);
        break;
      }
      case 'struck': { const r = this.remotes.get(m.id) ?? this.brains.get(m.id); if (r?.alive) r.flash = 0.08; if (r && m.ar !== undefined) Object.assign(r, { armour: m.ar, armourMax: m.am }); break; }
      case 'ar': { const r = this.remotes.get(m.id); if (r) Object.assign(r, { armour: m.ar, armourMax: m.am }); break; }
      case 'hurt': {
        const v = this.vitals;
        const lost = m.dmg ? v.hp + v.armour - m.hp - (m.ar ?? 0) : 0;
        const broke = lost > 0 && v.armour > 0 && !m.ar, tier = armourTier(v.armourMax);
        if (m.dmg) v.quiet = 0;
        v.set({ hp: m.hp, armour: m.ar, armourMax: m.am });
        const by = m.by !== this.id ? this.remotes.get(m.by) ?? this.brains.get(m.by) : null;
        this.ui.hurt(v.hp / this.vitals.max, lost > 0 ? by : null, lost);
        if (lost > 0) {
          const k = Math.min(1, lost / 35);
          if (by) this.#trade(m.by, 'taken', lost);
          this.rig.flinch(k, by ? Math.sin(this.#bearing(by.pos)) : 0);
          this.audio.hurt(k);
          this.audio.play('land', { volume: 0.2, rate: 1.5 });
          if (broke) this.audio.armourBreak(tier, { volume: 0.6 });
        }
        break;
      }
      case 'kill': {
        const won = ['a', 'b'].find((t) => m.score[t] > this.score[t]); // this kill finished a team off
        this.score = m.score;
        this.#score();
        const killer = this.#who(m.k), victim = this.#who(m.v);
        for (const [id, k] of [[m.k, 'kills'], [m.v, 'deaths']]) {
          if (k === 'kills' && m.k === m.v) continue;
          const s = this.stats.get(id) ?? { kills: 0, deaths: 0 };
          s[k]++;
          this.stats.set(id, s);
        }
        this.ui.feed(killer, victim, m.head, m.w);
        if (m.v === this.id) {
          this.alive = false;
          this.vitals.set({ hp: 0 });
          this.killer = killer.name;
          this.killerRef = m.k !== this.id ? this.remotes.get(m.k) ?? this.brains.get(m.k) ?? null : null;
          const e = this.ledger.get(m.k);
          this.ui.death(killer.name, 'Out until the round ends', m.k !== this.id ? { dealt: e?.dealt ?? 0, taken: e?.taken ?? 0, hits: e?.hits ?? 0 } : null);
          this.deathT = 0;
        } else {
          const r = this.remotes.get(m.v), b = this.brains.get(m.v), who = r ?? b;
          const from = m.k === this.id ? this.camera.position : (this.remotes.get(m.k) ?? this.brains.get(m.k))?.pos;
          const dir = who && from ? _a.subVectors(who.pos, from).setY(0).normalize() : null;
          r?.kill(dir);
          b?.fall(dir);
          if (m.k === this.id) {
            this.ui.toast(`Eliminated ${victim.name}`, m.head);
            this.hud?.hitmarker('kill', m.head);
            this.audio.hit('kill', m.head);
          }
        }
        if (won) this.ui.toast(won === this.team ? 'Round won' : 'Round lost');
        break;
      }
      case 'roundWon':
        this.score = m.score;
        this.#score();
        this.ui.toast(m.team === this.team ? 'Round won' : 'Round lost');
        break;
      case 'round':
        this.round = m;
        this.score = m.score;
        this.#score();
        this.#respawn();
        for (const r of this.remotes.values()) r.armour = r.armourMax = 0;
        // our bots: everyone's up again, at their base, with the round's gun
        for (const b of this.botList) { b.setWeapon(WEAPONS[m.weapon] ?? WEAPONS[0]); b.spawn(this.#botSpawn(b)); b.showMarker(); }
        this.ui.toast(`Round ${m.n} · ${WEAPONS[m.weapon]?.name ?? ''}`);
        break;
      case 'end': this.#end(m.score, m.vote); break;
      case 'votes':
        if (this.vote) { this.vote.tally = m.tally; this.#drawVote(); }
        break;
      case 'restart':
        for (const s of this.stats.values()) { s.kills = 0; s.deaths = 0; }
        this.ended = false;
        this.vote = null;
        this.score = m.score;
        this.time = m.time;
        this.ui.el.end.hidden = true;
        this.#score();
        if (!document.pointerLockElement) this.ui.toast('Click to play');
        if (m.mapId && m.mapId !== this.mapId) this.#changeMap(m.mapId);
        break;
      case 'took': this.pickups.grant(m.id, m.by === this.id); break;
      case 'back': this.pickups.restore(m.id); break;
      case 'door': this.doors.set(m.id, m.open, m.dir); break;
      case 'dropped': this.pickups.drop({ gun: m.w, ammo: m.ammo, reserve: m.reserve }, new THREE.Vector3(...m.p), m.id); break;
      case 'nade': this.grenades?.spawn(new THREE.Vector3(...m.p), new THREE.Vector3(...m.v), { mine: false, fuse: m.f, kind: m.k === 'smoke' ? 'smoke' : 'grenade' }); break;
      case 'pong': this.rtt = performance.now() - m.c; break;
    }
  }

  #remoteFire(m) {
    const r = this.remotes.get(m.id);
    if (!r) return;
    _ray.origin.fromArray(m.o);
    _ray.direction.fromArray(m.d).normalize();
    this.#noise(_ray.origin, r);
    const hit = this.octree.rayIntersect(_ray);
    const end = _b.copy(_ray.origin).addScaledVector(_ray.direction, hit ? hit.distance : 150);
    r.muzzle.getWorldPosition(_a);
    this.fx.tracer(_a, end);
    if (hit) this.fx.impact(end, hit.triangle.getNormal(_c));
    r.flashT = 0.045;
    r.flashMesh.rotation.z = Math.random() * Math.PI;

    const cam = this.camera.position, d = _a.distanceTo(cam);
    const vol = (m.sup ? 0.18 : 0.5) * Math.pow(THREE.MathUtils.clamp(1 - d / (m.sup ? 40 : 110), 0, 1), 1.5);
    if (vol < 0.01) return;
    _c.subVectors(_a, cam).normalize();
    _b.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this.audio.play(WEAPONS[m.w]?.sound ?? 'fire', { volume: vol, pan: THREE.MathUtils.clamp(_c.dot(_b), -1, 1) * 0.8, rate: 0.96 + Math.random() * 0.08 });
  }

  /** A sound at a world position, quieter with distance and panned. */
  #heard(pos, name, volume, range = 24) {
    const cam = this.camera.position, d = pos.distanceTo(cam);
    const vol = volume * Math.pow(THREE.MathUtils.clamp(1 - d / range, 0, 1), 1.6);
    if (vol < 0.01) return;
    _c.subVectors(pos, cam).normalize();
    _b.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this.audio.play(name, { volume: vol, pan: THREE.MathUtils.clamp(_c.dot(_b), -1, 1) * 0.7 });
  }

  /** A remote player's footstep, quieter with distance and panned. */
  footstep(pos) {
    const cam = this.camera.position, d = pos.distanceTo(cam);
    const vol = 0.12 * Math.pow(THREE.MathUtils.clamp(1 - d / 28, 0, 1), 1.6);
    if (vol < 0.01) return;
    _c.subVectors(pos, cam).normalize();
    _b.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this.audio.play('step', { volume: vol, pan: THREE.MathUtils.clamp(_c.dot(_b), -1, 1) * 0.7 });
  }

  #bearing(p) {
    _a.subVectors(p, this.camera.position).setY(0);
    const fwd = this.camera.getWorldDirection(_b).setY(0).normalize();
    return Math.atan2(_a.dot(_c.set(-fwd.z, 0, fwd.x)), _a.dot(fwd));
  }

  /** Our team's spawns (team a uses the map's ally spawns), picking among the ones farthest from live enemies. */
  #pickSpawn() {
    const list = this.arena.spawns[this.team === 'a' ? 'ally' : 'enemy'];
    const foes = this.#others().filter((r) => r.alive && r.team === 'enemy');
    const scored = list.map((s) => ({ s, d: Math.min(Infinity, ...foes.map((f) => f.pos.distanceTo(s.position))) })).sort((a, b) => b.d - a.d);
    return scored[(Math.random() * Math.min(2, scored.length)) | 0].s;
  }

  #respawn() {
    const s = (this.spawn = this.#pickSpawn());
    this.mv.respawn(s);
    this.rig.yaw = s.yaw;
    this.rig.pitch = 0;
    this.drowned = false;
    this.inv.reset(this.loadout);
    this.vitals.reset();
    this.pickups.reset();
    this.doors.reset();
    this.alive = true;
    this.ledger.clear();
    this.killerRef = null;
    this.ui.death(null);
    this.ui.hurt(1, null);
  }

  #end(score, vote) {
    this.ended = true;
    this.score = score;
    const me = score[this.team], them = score[this.foe];
    this.ui.end(me > them ? 'win' : me < them ? 'loss' : 'draw', { ally: me, enemy: them }, this.mapName);
    this.ui.el.end.querySelector('.again').hidden = true;
    this.vote = vote?.options?.length ? { ...vote, mine: null, endsAt: performance.now() + vote.time * 1000 } : null;
    this.#drawVote();
    if (document.pointerLockElement) document.exitPointerLock(); // free the mouse for the ballot
  }

  #vote(map) {
    if (!map || !this.vote) return;
    this.vote.mine = map;
    this.send({ t: 'vote', map });
    this.#drawVote();
  }

  /** The ballot on the end card: one button per map, its key, its votes; yours is marked. */
  #drawVote() {
    const sec = this.ui.el.end.querySelector('section');
    let box = sec.querySelector('.vote');
    if (!this.vote) { box?.remove(); return; }
    if (!box) {
      box = document.createElement('div');
      box.className = 'vote';
      box.addEventListener('click', (e) => this.#vote(e.target.closest('button')?.dataset.map));
      sec.insertBefore(box, sec.querySelector('.actions'));
    }
    const { options, tally, mine } = this.vote;
    box.innerHTML = `<div class="label">Vote for the next map <span class="vote-t"></span></div><div class="vote-maps">${options.map((id, i) => {
      const n = tally[id] ?? 0;
      const img = this.getMap(id)?.preview;
      return `<button type="button" data-map="${id}" class="${id === mine ? 'mine' : ''}">${img ? `<i style="background-image:url('${img}')"></i>` : ''}<kbd>${i + 1}</kbd><b>${this.getMap(id)?.name ?? id}</b><span>${id === this.mapId ? 'again' : ''}</span><em>${'●'.repeat(n) || '·'}</em></button>`;
    }).join('')}</div>`;
    this.#voteClock();
  }

  #voteClock() {
    const el = this.vote && this.ui.el.end.querySelector('.vote-t');
    if (el) el.textContent = `· ${Math.max(0, Math.ceil((this.vote.endsAt - performance.now()) / 1000))} s`;
  }

  #lost() {
    this.ended = true;
    this.ui.end('draw', { ally: this.score[this.team], enemy: this.score[this.foe] }, this.mapName);
    this.ui.el.end.querySelector('.verdict').textContent = 'Disconnected';
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** What our free hand starts doing (a punch, a throw, using an item), and when a use ends, for the others. */
  #sendAct() {
    const act = (this.alive && (this.inv.action ?? this.melee?.action)) || null;
    if (act === this.lastAct) return;
    if (act) this.send({ t: 'act', a: act.kind === 'melee' ? act.name : act.kind === 'throw' ? 'throw' : 'use', i: act.kind === 'melee' ? undefined : act.id });
    else if (this.lastAct.kind === 'heal' || this.lastAct.kind === 'charge') this.send({ t: 'act', a: 'stop' });
    this.lastAct = act;
  }

  update(dt, { camera, gun }) {
    this.camera = camera;
    this.ui.root.hidden = document.getElementById('hud')?.hidden ?? false;
    if (!this.ended) this.time = Math.max(0, this.time - dt);

    const mv = this.mv;
    if (this.alive) {
      if (this.arena.killY !== undefined && mv.feet.y < this.arena.killY) {
        // in the water: that's the round (once; the server's kill takes it from here)
        if (!this.drowned) { this.drowned = true; this.send({ t: 'hit', id: this.id, zone: 'fall', dmg: 999, w: 'fall' }); this.audio.play('land', { volume: 0.6, rate: 0.5 }); }
      } else if (mv.feet.y < -20) { mv.respawn(this.spawn); this.rig.yaw = this.spawn.yaw; }
      if (gun && gun.sinceShot === 0) {
        camera.getWorldDirection(_a);
        this.send({ t: 'fire', o: round(camera.position), d: round(_a), w: this.arsenal.findIndex((x) => x.gun === gun), sup: !!gun.stats.suppressed });
        if (this.host && !gun.stats.suppressed) this.#noise(camera.position, this.me);
      }
    } else {
      this.deathT += dt;
      this.ui.death(this.killer, 'Out until the round ends');
    }

    this.#sendAct();

    // a steady cadence: carry the remainder over instead of restarting the timer each send
    if ((this.sendT -= dt) <= 0) {
      this.sendT = Math.max(0, this.sendT + 1 / SEND_HZ);
      const w = this.arsenal.findIndex((x) => x.gun === gun);
      const g = this.arsenal[w];
      const f = (mv.crouched ? 1 : 0) | (g && g.gun.adsEased > 0.5 ? 2 : 0) | (g && g.vm.reloading ? 4 : 0);
      const r2 = (x) => Math.round(x * 100) / 100, r3 = (x) => Math.round(x * 1000) / 1000;
      this.send({ t: 's', q: [r3(mv.feet.x), r3(mv.feet.y), r3(mv.feet.z), r2(mv.vel.x), r2(mv.vel.y), r2(mv.vel.z), r3(this.rig.yaw + Math.PI), r3(this.rig.pitch), w, Math.max(0, STATES.indexOf(mv.state)), f, r2(this.rig.lean), Math.round(performance.now())] });
      if (this.host) this.#sendBots();
    }
    if (this.host && this.bw && !this.ended) this.#runBots(dt);
    if ((this.pingT -= dt) <= 0) { this.pingT = 2; this.send({ t: 'ping', c: performance.now() }); }

    const now = performance.now();
    for (const r of this.remotes.values()) { r.flushHits(); r.update(dt, now); }
    this.#flushHits();
    if (this.ended) this.#voteClock();
    this.fx.update(dt, camera);
    this.ui.update(dt, { ally: 0, enemy: 0 }, this.time, (p) => this.#bearing(p));
    const wpn = WEAPONS[this.round?.weapon]?.name;
    this.mid.textContent = `${this.round ? `Round ${this.round.n}${wpn ? ` · ${wpn}` : ''} · ` : ''}First to ${this.limit}${this.rtt === null ? '' : ` · ${Math.round(this.rtt)} ms`}`;
  }
}
