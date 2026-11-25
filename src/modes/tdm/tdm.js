import * as THREE from 'three';
import { Arena } from './arena.js';
import { NavGrid } from './nav.js';
import { Bot, MAX_HP, raySegment } from './bot.js';
import { WorldFX } from '../../weapons/effects.js';
import './tdm.css';

/*
  Team Deathmatch: you + 4 allied bots (sky) vs 5 enemy bots (clay) in the Kiln arena.
  First team to SCORE_LIMIT kills, or the higher score when the clock runs out, wins.

  Self-contained: main.js only sees the level interface returned by createTDM():
    octree · spawn · targets · playerAlive · ended · update(dt, { camera, now, gun }) · dispose()
  Delete src/modes/tdm/ and its entry in main.js's MODES to remove the mode entirely.
*/

const SCORE_LIMIT = 40;
const MATCH_TIME = 600;
const PLAYER_HP = MAX_HP;
const RESPAWN_BOT = 5;
const RESPAWN_PLAYER = 4;
const SPAWN_SHIELD = 1.5;

const ROSTER = {
  ally: [
    ['Wren', 'rifle', 0.55], ['Okafor', 'smg', 0.5], ['Lindqvist', 'rifle', 0.45], ['Mata', 'smg', 0.6],
  ],
  enemy: [
    ['Vesper', 'rifle', 0.6], ['Kade', 'smg', 0.5], ['Ruiz', 'rifle', 0.45], ['Halloran', 'smg', 0.55], ['Ishikawa', 'rifle', 0.65],
  ],
};

const _ray = new THREE.Ray();
const _sph = new THREE.Sphere();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

export function createTDM(ctx) { return new TDM(ctx); }

class TDM {
  /** arena: optional prebuilt world (e.g. a custom map) with octree · raycastTargets · spawns · bounds · dispose. */
  constructor({ scene, camera, audio, mv, rig, arsenal, arena }) {
    Object.assign(this, { scene, camera, audio, mv, rig, arsenal });
    this.arena = arena ?? new Arena(scene);
    this.mapName = this.arena.name ?? 'Kiln';
    this.octree = this.arena.octree;
    this.nav = this.arena.nav ??= new NavGrid(this.octree, this.arena.bounds);
    this.#prepareArena();
    this.fx = new WorldFX(scene); // bot tracers/impacts get their own pools
    this.now = 0;
    this.time = MATCH_TIME;
    this.score = { ally: 0, enemy: 0 };
    this.ended = false;
    this.intelByTeam = { ally: null, enemy: null };
    this.respawns = [];
    this.soundsThisFrame = 0;

    this.player = this.#playerProxy();
    this.bots = [];
    for (const team of ['ally', 'enemy']) {
      for (const [name, gun, skill] of ROSTER[team]) {
        const b = new Bot(this, { team, name, gun, skill, char: this.bots.length % 2 ? 'kite' : 'rivet' });
        scene.add(b.root);
        this.bots.push(b);
      }
    }
    this.allies = this.bots.filter((b) => b.team === 'ally');
    this.enemies = this.bots.filter((b) => b.team === 'enemy');
    // stagger the opening spawns so the teams don't move as one blob
    this.bots.forEach((b, i) => this.respawns.push({ bot: b, t: 0.2 + (i % 5) * 0.35 }));

    this.targets = [...this.arena.raycastTargets, ...this.bots.flatMap((b) => b.hitboxes)];
    this.spawn = this.#pickSpawn('ally');
    this.ui = new TdmHud();
    this.ui.score(this.score, this.time);
  }

  get playerAlive() { return this.player.alive; }

  /** Custom maps only give a few spawn markers and no roam points: fill both in from the nav grid. */
  #prepareArena() {
    const a = this.arena, nav = this.nav;
    for (const team of ['ally', 'enemy']) {
      const list = a.spawns[team];
      for (const s of [...list]) {
        const m = nav.node(s.position.x, s.position.z, s.position.y);
        if (m >= 0) s.position.y = nav.h[m];
        else {
          const k = nav.nearestNode(s.position.x, s.position.z, s.position.y, 8);
          if (k >= 0) nav.nodePos(k, s.position);
        }
      }
      for (let i = 0; list.length < 6 && i < 40; i++) {
        const base = list[i % list.length];
        const p = nav.randomPoint(Math.random, base.position.x, base.position.z, 4);
        if (p) list.push({ position: p, yaw: base.yaw });
      }
    }
    if (!a.hotspots) {
      a.hotspots = [];
      for (let i = 0; i < 14; i++) { const p = nav.randomPoint(); if (p) a.hotspots.push(p); }
    }
  }

  dispose() {
    this.arena.dispose();
    for (const b of this.bots) this.scene.remove(b.root);
    this.ui.root.remove();
  }

  // ── world services used by bots ──

  enemiesOf(team) { return team === 'ally' ? this.enemies : this.#allySide; }
  get #allySide() { return (this._allySide ??= [this.player, ...this.allies]); }

  los(from, to) {
    const d = from.distanceTo(to);
    _ray.origin.copy(from);
    _ray.direction.subVectors(to, from).divideScalar(d || 1);
    const hit = this.octree.rayIntersect(_ray);
    return !hit || hit.distance >= d - 0.25;
  }

  share(team, pos, now) { this.intelByTeam[team] = { pos: pos.clone(), t: now }; }
  intel(team) { const i = this.intelByTeam[team]; return i && this.now - i.t < 8 ? i.pos : null; }

  /** A bot fired: play it in 3D-ish and let nearby enemies hear it. */
  gunshot(bot, muzzle) {
    this.#noise(muzzle, 42, bot);
    if (this.soundsThisFrame >= 4) return;
    this.soundsThisFrame++;
    const cam = this.camera.position;
    const d = muzzle.distanceTo(cam);
    const vol = 0.42 * Math.pow(THREE.MathUtils.clamp(1 - d / 95, 0, 1), 1.6);
    if (vol < 0.01) return;
    _a.subVectors(muzzle, cam).normalize();
    _b.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this.audio.play(bot.gun.sample, { volume: vol, pan: THREE.MathUtils.clamp(_a.dot(_b), -1, 1) * 0.8, rate: 0.96 + Math.random() * 0.08 });
  }

  #noise(pos, radius, source) {
    for (const b of this.bots) {
      if (b.team === source.team || !b.alive) continue;
      if (b.pos.distanceTo(pos) < radius) b.hear(pos, source);
    }
  }

  onKill(killer, victim, head) {
    if (this.ended) return;
    const team = victim.team === 'ally' ? 'enemy' : 'ally';
    this.score[team]++;
    this.ui.feed(killer, victim, head);
    if (killer === this.player) this.ui.toast(`Eliminated ${victim.name}`, head);
    if (victim !== this.player) this.respawns.push({ bot: victim, t: RESPAWN_BOT });
    this.ui.score(this.score, this.time);
    if (this.score[team] >= SCORE_LIMIT) this.#end();
  }

  // ── player ──

  #playerProxy() {
    const tdm = this, mv = this.mv;
    return {
      team: 'ally', name: 'You', alive: true, hp: PLAYER_HP, shield: 0, deathT: 0, killer: null,
      get pos() { return mv.feet; },
      get vel() { return mv.vel; },
      eye(out = new THREE.Vector3()) { return out.copy(tdm.camera.position); },
      aimPoint(head, out = new THREE.Vector3()) { return out.copy(mv.feet).setY(mv.feet.y + (head ? mv.height - 0.17 : mv.height * 0.62)); },
      hitTest(ray) {
        if (!this.alive) return null;
        _sph.center.copy(mv.feet).setY(mv.feet.y + mv.height - 0.17);
        _sph.radius = 0.18;
        const h = ray.intersectSphere(_sph, _c);
        if (h) return { dist: h.distanceTo(ray.origin), zone: 'head' };
        _a.copy(mv.feet).setY(mv.feet.y + 0.3);
        _b.copy(mv.feet).setY(mv.feet.y + mv.height - 0.4);
        const r = raySegment(ray, _a, _b);
        return r.dist < 0.34 ? { dist: r.t, zone: 'body' } : null;
      },
      takeDamage(dmg, zone, attacker) {
        if (!this.alive || this.shield > 0 || tdm.ended) return false;
        this.hp -= dmg;
        this.lastHurt = tdm.now;
        tdm.ui.hurt(this.hp / PLAYER_HP, tdm.#bearing(attacker.pos));
        tdm.audio.play('land', { volume: 0.25, rate: 1.5 });
        tdm.rig.punch(-0.6 - Math.random() * 0.4, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 1.2);
        if (this.hp <= 0) {
          this.alive = false;
          this.deathT = 0;
          this.killer = attacker;
          tdm.onKill(attacker, this, zone === 'head');
          tdm.ui.death(attacker.name, RESPAWN_PLAYER);
          return true;
        }
        return false;
      },
    };
  }

  /** Screen-space bearing (radians, 0 = ahead, clockwise) from the camera to a world point. */
  #bearing(p) {
    _a.subVectors(p, this.camera.position).setY(0);
    const fwd = this.camera.getWorldDirection(_b).setY(0).normalize();
    const right = _c.set(-fwd.z, 0, fwd.x);
    return Math.atan2(_a.dot(right), _a.dot(fwd));
  }

  #respawnPlayer() {
    const p = this.player;
    const s = this.#pickSpawn('ally');
    this.spawn = s;
    this.mv.respawn(s);
    this.rig.yaw = s.yaw;
    this.rig.pitch = 0;
    for (const { gun } of this.arsenal) gun.ammo = gun.magSize;
    p.alive = true;
    p.hp = PLAYER_HP;
    p.shield = SPAWN_SHIELD;
    this.ui.death(null);
    this.ui.hurt(1, null);
  }

  #pickSpawn(team) {
    const foes = team === 'ally' ? this.enemies : this.#allySide;
    const scored = this.arena.spawns[team].map((s) => {
      let min = Infinity;
      for (const f of foes) if (f.alive) min = Math.min(min, f.pos.distanceTo(s.position));
      return { s, min };
    }).sort((a, b) => b.min - a.min);
    return scored[(Math.random() * Math.min(3, scored.length)) | 0].s;
  }

  #end() {
    this.ended = true;
    const win = this.score.ally > this.score.enemy ? 'win' : this.score.ally < this.score.enemy ? 'loss' : 'draw';
    this.ui.end(win, this.score, this.mapName);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // ── frame ──

  update(dt, { camera, gun }) {
    this.now += dt;
    this.camera = camera;
    this.soundsThisFrame = 0;
    this.ui.root.hidden = document.getElementById('hud')?.hidden ?? false;

    if (!this.ended) {
      this.time = Math.max(0, this.time - dt);
      if (this.time === 0) this.#end();
    }

    // player fired → enemies nearby hear it (much less when suppressed)
    if (gun && gun.sinceShot === 0 && this.player.alive) this.#noise(this.camera.position, gun.stats.suppressed ? 12 : 48, this.player);

    const p = this.player;
    if (p.alive) {
      p.shield = Math.max(0, p.shield - dt);
      if (this.now - (p.lastHurt ?? -99) > 5 && p.hp < PLAYER_HP) { p.hp = Math.min(PLAYER_HP, p.hp + 30 * dt); this.ui.hurt(p.hp / PLAYER_HP, null); }
      if (this.mv.feet.y < -20) this.#respawnPlayer();
    } else if (!this.ended) {
      p.deathT += dt;
      this.ui.death(p.killer?.name, Math.max(0, RESPAWN_PLAYER - p.deathT));
      if (p.deathT >= RESPAWN_PLAYER) this.#respawnPlayer();
    }

    for (let i = this.respawns.length - 1; i >= 0; i--) {
      const r = this.respawns[i];
      r.t -= dt;
      if (r.t <= 0 && !this.ended) { r.bot.spawn(this.#pickSpawn(r.bot.team)); r.bot.showMarker(); this.respawns.splice(i, 1); }
    }

    if (!this.ended) for (const b of this.bots) b.update(dt);
    this.fx.update(dt, camera);
    this.ui.update(dt, this.score, this.time);
  }
}

// ───────────────────────────── HUD overlay ─────────────────────────────

const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class TdmHud {
  constructor({ ally = 'Allies', enemy = 'Enemy', limit = SCORE_LIMIT } = {}) {
    const root = (this.root = document.createElement('div'));
    root.className = 'tdm';
    root.innerHTML = `
      <div class="tdm-score card">
        <div class="side ally"><span class="label">${esc(ally)}</span><b class="a">0</b></div>
        <div class="mid"><span class="clock">10:00</span><span class="label">First to ${limit}</span></div>
        <div class="side enemy"><b class="e">0</b><span class="label">${esc(enemy)}</span></div>
      </div>
      <div class="tdm-feed"></div>
      <div class="tdm-hp card"><div class="row"><span class="label">Health</span><span class="num">150</span></div><div class="bar"><b></b><i></i></div></div>
      <div class="tdm-vignette"></div>
      <div class="tdm-dirs"></div>
      <div class="tdm-toast"></div>
      <div class="tdm-death card" hidden><span class="label">Eliminated by</span><b class="who"></b><span class="label cd"></span></div>
      <div class="tdm-end" hidden>
        <section class="card">
          <div class="label end-map">Match over</div>
          <h2 class="verdict"></h2>
          <div class="final"></div>
          <div class="actions"><button class="btn again" type="button">Play again →</button><button class="btn ghost title" type="button">Main menu</button></div>
        </section>
      </div>`;
    document.body.appendChild(root);
    const $ = (s) => root.querySelector(s);
    this.el = {
      a: $('.a'), e: $('.e'), clock: $('.clock'), feed: $('.tdm-feed'), hpNum: $('.tdm-hp .num'), hpBar: $('.tdm-hp .bar b'), hpGhost: $('.tdm-hp .bar i'),
      vig: $('.tdm-vignette'), dirs: $('.tdm-dirs'), toast: $('.tdm-toast'), death: $('.tdm-death'), who: $('.tdm-death .who'), cd: $('.tdm-death .cd'), end: $('.tdm-end'),
    };
    $('.again').addEventListener('click', () => location.reload());
    $('.title').addEventListener('click', () => { location.href = location.pathname; });
    this.hp = 1;
    this.ghost = 1;
    this.vig = 0;
  }

  score(s, time) {
    this.el.a.textContent = s.ally;
    this.el.e.textContent = s.enemy;
    this.el.clock.textContent = fmtTime(time);
  }

  feed(killer, victim, head) {
    const row = document.createElement('div');
    row.className = 'card';
    row.innerHTML = `<span class="${killer.team}">${esc(killer.name)}</span><em>${head ? '◆' : '▸'}</em><span class="${victim.team}">${esc(victim.name)}</span>`;
    this.el.feed.prepend(row);
    setTimeout(() => row.classList.add('out'), 5000);
    setTimeout(() => row.remove(), 5600);
    while (this.el.feed.children.length > 5) this.el.feed.lastChild.remove();
  }

  toast(text, head) {
    const t = this.el.toast;
    t.textContent = text;
    t.classList.toggle('head', !!head);
    t.classList.remove('show');
    void t.offsetWidth;
    t.classList.add('show');
  }

  hurt(frac, bearing) {
    this.hp = Math.max(0, frac);
    if (bearing !== null && bearing !== undefined) {
      this.vig = Math.min(1, this.vig + 0.45);
      const d = document.createElement('i');
      d.style.transform = `rotate(${bearing}rad)`;
      this.el.dirs.appendChild(d);
      setTimeout(() => d.remove(), 1100);
    }
  }

  death(name, t) {
    this.el.death.hidden = !name;
    if (name) {
      this.el.who.textContent = name;
      this.el.cd.textContent = t > 0 ? `Redeploy in ${Math.ceil(t)}` : 'Redeploying';
    }
  }

  end(result, s, map) {
    this.el.end.hidden = false;
    this.el.end.querySelector('.end-map').textContent = `Match over · ${map}`;
    this.el.end.dataset.r = result;
    this.el.end.querySelector('.verdict').textContent = result === 'win' ? 'Victory' : result === 'loss' ? 'Defeat' : 'Draw';
    this.el.end.querySelector('.final').innerHTML = `<span class="ally">${s.ally}</span><span class="dash">—</span><span class="enemy">${s.enemy}</span>`;
  }

  update(dt, s, time) {
    this.el.clock.textContent = fmtTime(time);
    this.ghost = Math.max(this.hp, this.ghost - dt * 0.5);
    this.el.hpBar.style.width = `${this.hp * 100}%`;
    this.el.hpGhost.style.width = `${this.ghost * 100}%`;
    this.el.hpNum.textContent = Math.ceil(this.hp * PLAYER_HP);
    this.el.hpBar.parentElement.classList.toggle('low', this.hp < 0.35);
    this.vig = Math.max(0, this.vig - dt * 1.6);
    this.el.vig.style.opacity = Math.max(this.vig, (1 - this.hp) * 0.55).toFixed(3);
  }
}
