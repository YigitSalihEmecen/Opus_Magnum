import * as THREE from 'three';
import { Bot, MAX_HP } from '../modes/tdm/bot.js';
import { TdmHud } from '../modes/tdm/tdm.js';
import { WorldFX } from '../weapons/effects.js';
import { WEAPONS } from '../weapons/weapons.js';
import { MOVE } from '../player/movement.js';

/*
  Online match against other players through the match server (server/index.js). Same level interface as TDM:
    octree · spawn · targets · playerAlive · ended · update(dt, { camera, gun }) · dispose()
  This client owns its movement and hit detection; the server owns HP, kills, score and the clock.
  Other players are drawn INTERP ms in the past, between the two snapshots around that moment.
  Delete src/net/ and its MODES entry in main.js to remove multiplayer.
*/

const SEND_HZ = 30;
const INTERP = 100;
const STAND = MOVE.standHeight;

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
      resolve({ ws, welcome: msg, queue });
    };
  });
}

export async function createOnline({ opts, getMap, buildWorld, ...ctx }) {
  const local = getMap(opts.mapId);
  const hello = { name: opts.name, room: opts.room, mapId: opts.mapId, map: local && !local.builtin ? local : undefined };
  const { ws, welcome, queue } = await connect(opts.server, hello);
  const map = welcome.map ?? getMap(welcome.mapId) ?? local;
  const arena = await buildWorld(map);
  return new Online({ ...ctx, ws, welcome, queue, arena });
}

/** Another player: the TDM bot body, posed from snapshots; hits on it are reported to the server. */
class Remote extends Bot {
  constructor(net, info) {
    super(net, { team: info.team === net.team ? 'ally' : 'enemy', name: info.name, gun: 'rifle', skill: 0 });
    Object.assign(this, { id: info.id, hopY: 0, phase: 0, reloadT: 0, buf: [], h: STAND });
    this.alive = info.alive;
    this.root.visible = false; // until the first snapshot places it
  }

  damage(amount, zone) {
    if (!this.alive || this.team === 'ally') return null;
    this.world.send({ t: 'hit', id: this.id, zone, dmg: amount });
    return { killed: false };
  }

  push(s, t) {
    if (s.al && !this.alive) this.revive();
    this.buf.push({ t, p: new THREE.Vector3(...s.p), v: new THREE.Vector3(...s.v), y: s.y, pi: s.pi, h: s.h ?? STAND });
    if (this.buf.length > 30) this.buf.shift();
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

  update(dt, t) {
    const buf = this.buf;
    if (buf.length && this.alive) {
      let i = buf.length - 1;
      while (i > 0 && buf[i - 1].t > t) i--;
      const a = buf[Math.max(0, i - 1)], b = buf[i];
      const k = b.t > a.t ? THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1) : 1;
      this.pos.lerpVectors(a.p, b.p, k);
      this.vel.lerpVectors(a.v, b.v, k);
      this.aimYaw = lerpAngle(a.y, b.y, k);
      this.aimPitch = a.pi + (b.pi - a.pi) * k;
      this.h = THREE.MathUtils.damp(this.h, b.h, 14, dt);
      this.root.scale.y = this.h / STAND; // crouch / slide squash keeps the hitboxes honest
    }
    this.pose(dt);
  }
}

class Online {
  constructor({ scene, camera, audio, mv, rig, arsenal, ws, welcome, queue, arena }) {
    Object.assign(this, { scene, camera, audio, mv, rig, arsenal, ws, arena });
    this.id = welcome.id;
    this.team = welcome.team;
    this.foe = this.team === 'a' ? 'b' : 'a';
    this.mapName = arena.name ?? 'Online';
    this.octree = arena.octree;
    this.fx = new WorldFX(scene);
    this.limit = welcome.limit;
    this.score = welcome.score;
    this.time = welcome.time;
    this.ended = false;
    this.alive = true;
    this.hp = MAX_HP;
    this.deathT = 0;
    this.sendT = 0;
    this.pingT = 0;
    this.rtt = null;
    this.names = new Map([[this.id, 'You']]);
    this.remotes = new Map();
    this.ui = new TdmHud({ ally: 'You', enemy: 'Them', limit: this.limit });
    this.mid = this.ui.root.querySelector('.mid .label');
    for (const p of welcome.players) if (p.id !== this.id) this.#add(p);
    this.spawn = this.#pickSpawn();
    this.#refreshTargets();
    this.#score();
    if (welcome.ended) this.#end(this.score);

    ws.onmessage = (e) => this.#on(JSON.parse(e.data));
    ws.onclose = () => this.#lost();
    for (const m of queue) this.#on(m);
  }

  get playerAlive() { return this.alive; }

  send(msg) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); }

  dispose() {
    this.ws.onclose = null;
    this.ws.close();
    this.arena.dispose();
    for (const r of this.remotes.values()) this.scene.remove(r.root);
    this.ui.root.remove();
  }

  #add(info) {
    const r = new Remote(this, info);
    this.remotes.set(info.id, r);
    this.names.set(info.id, info.name);
    this.scene.add(r.root);
  }

  /** In place: main.js holds on to this array. */
  #refreshTargets() {
    this.targets ??= [];
    this.targets.length = 0;
    this.targets.push(...this.arena.raycastTargets, ...[...this.remotes.values()].flatMap((r) => r.hitboxes));
  }

  #who(id) {
    if (id === this.id) return { name: 'You', team: 'ally' };
    return { name: this.names.get(id) ?? '?', team: this.remotes.get(id)?.team ?? 'enemy' };
  }

  #score() { this.ui.score({ ally: this.score[this.team], enemy: this.score[this.foe] }, this.time); }

  #on(m) {
    const now = performance.now();
    switch (m.t) {
      case 'snap':
        for (const s of m.ps) this.remotes.get(s.id)?.push(s, now);
        break;
      case 'join':
        this.#add(m.player);
        this.#refreshTargets();
        this.ui.toast(`${m.player.name} joined`);
        break;
      case 'leave': {
        const r = this.remotes.get(m.id);
        if (!r) break;
        this.scene.remove(r.root);
        this.remotes.delete(m.id);
        this.#refreshTargets();
        this.ui.toast(`${this.names.get(m.id)} left`);
        break;
      }
      case 'fire': this.#remoteFire(m); break;
      case 'hurt': {
        const hit = m.dmg && m.hp < this.hp;
        this.hp = m.hp;
        const by = this.remotes.get(m.by);
        this.ui.hurt(this.hp / MAX_HP, hit && by ? this.#bearing(by.pos) : null);
        if (hit) {
          this.audio.play('land', { volume: 0.25, rate: 1.5 });
          this.rig.punch(-0.6 - Math.random() * 0.4, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 1.2);
        }
        break;
      }
      case 'kill': {
        this.score = m.score;
        this.#score();
        const killer = this.#who(m.k), victim = this.#who(m.v);
        this.ui.feed(killer, victim, m.head);
        if (m.v === this.id) {
          this.alive = false;
          this.hp = 0;
          this.killer = killer.name;
          this.deathT = 0;
        } else {
          const r = this.remotes.get(m.v);
          const from = m.k === this.id ? this.camera.position : this.remotes.get(m.k)?.pos;
          r?.kill(from ? _a.subVectors(r.pos, from).setY(0).normalize() : null);
          if (m.k === this.id) this.ui.toast(`Eliminated ${victim.name}`, m.head);
        }
        break;
      }
      case 'respawn': this.#respawn(); break;
      case 'end': this.#end(m.score); break;
      case 'restart':
        this.ended = false;
        this.score = m.score;
        this.time = m.time;
        this.ui.el.end.hidden = true;
        this.#score();
        break;
      case 'pong': this.rtt = performance.now() - m.c; break;
    }
  }

  #remoteFire(m) {
    const r = this.remotes.get(m.id);
    if (!r) return;
    _ray.origin.fromArray(m.o);
    _ray.direction.fromArray(m.d).normalize();
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

  #bearing(p) {
    _a.subVectors(p, this.camera.position).setY(0);
    const fwd = this.camera.getWorldDirection(_b).setY(0).normalize();
    return Math.atan2(_a.dot(_c.set(-fwd.z, 0, fwd.x)), _a.dot(fwd));
  }

  /** Our team's spawns (team a uses the map's ally spawns), picking among the ones farthest from live enemies. */
  #pickSpawn() {
    const list = this.arena.spawns[this.team === 'a' ? 'ally' : 'enemy'];
    const foes = [...this.remotes.values()].filter((r) => r.alive && r.team === 'enemy');
    const scored = list.map((s) => ({ s, d: Math.min(Infinity, ...foes.map((f) => f.pos.distanceTo(s.position))) })).sort((a, b) => b.d - a.d);
    return scored[(Math.random() * Math.min(2, scored.length)) | 0].s;
  }

  #respawn() {
    const s = (this.spawn = this.#pickSpawn());
    this.mv.respawn(s);
    this.rig.yaw = s.yaw;
    this.rig.pitch = 0;
    for (const { gun } of this.arsenal) gun.ammo = gun.magSize;
    this.alive = true;
    this.hp = MAX_HP;
    this.ui.death(null);
    this.ui.hurt(1, null);
  }

  #end(score) {
    this.ended = true;
    this.score = score;
    const me = score[this.team], them = score[this.foe];
    this.ui.end(me > them ? 'win' : me < them ? 'loss' : 'draw', { ally: me, enemy: them }, this.mapName);
    this.ui.el.end.querySelector('.label.end-map').textContent = `Match over · ${this.mapName} · next round in a few seconds`;
  }

  #lost() {
    this.ended = true;
    this.ui.end('draw', { ally: this.score[this.team], enemy: this.score[this.foe] }, this.mapName);
    this.ui.el.end.querySelector('.verdict').textContent = 'Disconnected';
    if (document.pointerLockElement) document.exitPointerLock();
  }

  update(dt, { camera, gun }) {
    this.camera = camera;
    this.ui.root.hidden = document.getElementById('hud')?.hidden ?? false;
    if (!this.ended) this.time = Math.max(0, this.time - dt);

    const mv = this.mv;
    if (this.alive) {
      if (mv.feet.y < -20) { mv.respawn(this.spawn); this.rig.yaw = this.spawn.yaw; }
      if (gun && gun.sinceShot === 0) {
        camera.getWorldDirection(_a);
        this.send({ t: 'fire', o: round(camera.position), d: round(_a), w: this.arsenal.findIndex((x) => x.gun === gun), sup: !!gun.stats.suppressed });
      }
    } else {
      this.deathT += dt;
      this.ui.death(this.killer, Math.max(0, 3 - this.deathT));
    }

    if ((this.sendT -= dt) <= 0) {
      this.sendT = 1 / SEND_HZ;
      const w = this.arsenal.findIndex((x) => x.gun === gun);
      this.send({ t: 's', p: round(mv.feet), v: round(mv.vel), y: +(this.rig.yaw + Math.PI).toFixed(3), pi: +this.rig.pitch.toFixed(3), w, st: mv.state, h: +mv.height.toFixed(2) });
    }
    if ((this.pingT -= dt) <= 0) { this.pingT = 2; this.send({ t: 'ping', c: performance.now() }); }

    const t = performance.now() - INTERP;
    for (const r of this.remotes.values()) r.update(dt, t);
    this.fx.update(dt, camera);
    this.ui.update(dt, { ally: 0, enemy: 0 }, this.time);
    this.mid.textContent = `First to ${this.limit}${this.rtt === null ? '' : ` · ${Math.round(this.rtt)} ms`}`;
  }
}
