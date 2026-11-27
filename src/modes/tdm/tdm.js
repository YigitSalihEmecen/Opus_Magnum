import * as THREE from 'three';
import { Arena } from './arena.js';
import { NavGrid } from './nav.js';
import { Bot, raySegment } from './bot.js';
import { Tactics } from './tactics.js';
import { WorldFX } from '../../weapons/effects.js';
import { WEAPONS } from '../../weapons/weapons.js';
import { Pickups } from '../../items/pickups.js';
import { pickupSpec } from '../../items/items.js';
import { MatchHud } from '../../ui/matchHud.js';

/*
  Team Deathmatch: you + 4 allied bots (sky) vs 5 enemy bots (clay) in the Kiln arena.
  First team to SCORE_LIMIT kills, or the higher score when the clock runs out, wins.

  Self-contained: main.js only sees the level interface returned by createTDM():
    octree · spawn · targets · playerAlive · ended · update(dt, { camera, now, gun }) · dispose()
  Delete src/modes/tdm/ and its entry in main.js's MODES to remove the mode entirely.
*/

const SCORE_LIMIT = 40;
const MATCH_TIME = 600;
const RESPAWN_BOT = 5;
const RESPAWN_PLAYER = 4;
const SPAWN_SHIELD = 1.5;
const ITEM_RESPAWN = 25;
const WEAPON_IDS = WEAPONS.map((w) => w.id);
// what you deploy with each life: carbine + sidearm, three spare mags, one grenade, two bandages
const LOADOUT = { guns: ['panther', 'lynx'].map((id) => WEAPON_IDS.indexOf(id)), maxGuns: 2, mags: 3, items: { grenade: 1, bandage: 2 } };
// handed out over the roam hotspots in order (Kiln: centre, then mirrored pairs), plus a starter pair by each base
const ITEM_PLAN = ['armour3', 'gun_kestrel', 'gun_grizzly', 'medkit', 'medkit', 'armour2', 'armour2', 'charger', 'charger', 'ammo', 'ammo', 'grenade', 'grenade', 'gun_snake'];
const BASE_ITEMS = ['bandage', 'armour1', 'ammo'];

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
  constructor({ scene, camera, audio, mv, rig, arsenal, arena, inv, vitals }) {
    Object.assign(this, { scene, camera, audio, mv, rig, arsenal, inv, vitals });
    this.loadout = LOADOUT;
    this.arena = arena ?? new Arena(scene);
    this.mapName = this.arena.name ?? 'Kiln';
    this.octree = this.arena.octree;
    const seeds = Object.values(this.arena.spawns ?? {}).flat().map((sp) => sp?.position).filter(Boolean);
    this.nav = this.arena.nav ??= new NavGrid(this.octree, { ...this.arena.bounds, seeds });
    this.#prepareArena();
    this.fx = new WorldFX(scene); // bot tracers/impacts get their own pools
    this.now = 0;
    this.time = MATCH_TIME;
    this.score = { ally: 0, enemy: 0 };
    this.ended = false;
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
    // built after the bots: position scoring reads them
    this.tactics = new Tactics(this.nav, this.octree, this);
    this.pathBudget = 0;
    this.stepT = 0;
    this.allies = this.bots.filter((b) => b.team === 'ally');
    this.enemies = this.bots.filter((b) => b.team === 'enemy');
    // stagger the opening spawns so the teams don't move as one blob
    this.bots.forEach((b, i) => this.respawns.push({ bot: b, t: 0.2 + (i % 5) * 0.35 }));

    this.targets = [...this.arena.raycastTargets, ...this.bots.flatMap((b) => b.hitboxes)];
    this.pickups = new Pickups(scene, { octree: this.octree, spots: this.#itemSpots(), respawn: ITEM_RESPAWN });
    this.spawn = this.#pickSpawn('ally');
    this.ui = new MatchHud({ limit: SCORE_LIMIT });
    this.ui.score(this.score, this.time);
  }

  get doors() { return this.arena.doors; }
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

  /** The map's own item spots, or a fixed plan over the hotspots (seeded, so every match lays out the same). */
  #itemSpots() {
    const a = this.arena;
    if (a.pickups?.length) return a.pickups;
    let seed = 7;
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const at = (x, z, r) => this.nav.randomPoint(rng, x, z, r);
    const spots = [];
    a.hotspots.forEach((h, i) => {
      const p = at(h.x, h.z, 1.5), spec = pickupSpec(ITEM_PLAN[i % ITEM_PLAN.length], WEAPON_IDS);
      if (p && spec) spots.push({ ...spec, position: p });
    });
    for (const team of ['ally', 'enemy']) {
      const base = a.spawns[team][0].position, inward = -Math.sign(base.x) || 1;
      BASE_ITEMS.forEach((type, i) => { const p = at(base.x + inward * 6, base.z + (i - 1) * 3, 1); if (p) spots.push({ type, position: p }); });
    }
    return spots;
  }

  /** A grenade of ours caught us. */
  hurtSelf(dmg) { this.player.takeDamage(dmg, 'body', this.player, null, 'grenade'); }

  dispose() {
    this.pickups.dispose();
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

  onKill(killer, victim, head, weapon) {
    if (this.ended) return;
    if (killer !== victim) killer.kills = (killer.kills ?? 0) + 1;
    victim.deaths = (victim.deaths ?? 0) + 1;
    const team = victim.team === 'ally' ? 'enemy' : 'ally';
    this.score[team]++;
    this.ui.feed(killer, victim, head, weapon);
    if (killer === this.player) this.ui.toast(`Eliminated ${victim.name}`, head);
    if (victim !== this.player) this.respawns.push({ bot: victim, t: RESPAWN_BOT });
    this.ui.score(this.score, this.time);
    if (this.score[team] >= SCORE_LIMIT) this.#end();
  }

  /** Hold-Tab scoreboard rows. */
  scoreRows() {
    const row = (c) => ({ name: c.name, kills: c.kills ?? 0, deaths: c.deaths ?? 0, you: c === this.player, dead: !c.alive });
    return {
      title: `Team Deathmatch · ${this.mapName}`,
      teams: [
        { label: 'Allies', team: 'ally', score: this.score.ally, rows: this.#allySide.map(row) },
        { label: 'Enemy', team: 'enemy', score: this.score.enemy, rows: this.enemies.map(row) },
      ],
    };
  }

  // ── player ──

  #playerProxy() {
    const tdm = this, mv = this.mv;
    return {
      team: 'ally', name: 'You', alive: true, shield: 0, deathT: 0, killer: null,
      get hp() { return tdm.vitals.hp; },
      get maxHp() { return tdm.vitals.max; },
      get pos() { return mv.feet; },
      get vel() { return mv.vel; },
      get facing() { return tdm.rig.yaw + Math.PI; }, // the camera looks down -z
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
        if (r.dist >= 0.34) return null;
        const y = ray.origin.y + ray.direction.y * r.t - mv.feet.y;
        return { dist: r.t, zone: y < mv.height * 0.47 ? 'legs' : 'body' };
      },
      takeDamage(dmg, zone, attacker, dir, weapon) {
        if (!this.alive || this.shield > 0 || tdm.ended) return false;
        tdm.vitals.damage(dmg);
        tdm.ui.hurt(tdm.vitals.hp / tdm.vitals.max, attacker === this ? null : tdm.#bearing(attacker.pos));
        tdm.audio.play('land', { volume: 0.25, rate: 1.5 });
        tdm.rig.punch(-0.6 - Math.random() * 0.4, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 1.2);
        if (tdm.vitals.dead) {
          this.alive = false;
          this.deathT = 0;
          this.killer = attacker;
          tdm.tactics.died('ally', mv.feet);
          tdm.onKill(attacker, this, zone === 'head', weapon);
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
    this.inv.reset(LOADOUT);
    this.vitals.reset();
    p.alive = true;
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
    // and footsteps: a sprint carries, a run a little, walking and crouching are silent
    this.stepT -= dt;
    const mv = this.mv, speed = Math.hypot(mv.vel.x, mv.vel.z);
    if (this.player.alive && mv.grounded && this.stepT <= 0 && speed > 3.2 && !mv.crouched) {
      this.stepT = 0.35;
      this.#noise(mv.feet, mv.sprinting ? 15 : 8, this.player);
    }
    this.pathBudget = 4;
    this.tactics.update(dt, this.now);

    const p = this.player;
    if (p.alive) {
      p.shield = Math.max(0, p.shield - dt);
      this.ui.hurt(this.vitals.hp / this.vitals.max, null); // vignette follows health (regen and heals happen in Vitals)
      if (this.mv.feet.y < (this.arena.killY ?? -20)) this.#respawnPlayer();
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
