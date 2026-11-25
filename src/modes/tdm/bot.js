import * as THREE from 'three';
import { PALETTE as P } from '../../core/toon.js';
import { FX_LAYER } from '../../core/renderer.js';
import { gripGun, bakeFlat } from '../../character/robot.js';
import { buildCharacter } from '../../character/characters.js';
import { WEAPONS } from '../../weapons/weapons.js';

/*
  TDM bot: a stylised pilot body plus a small state machine. What makes it feel human:
    · perception is periodic and needs line of sight inside a view cone (or a noise / a hit)
    · a reaction delay before it starts turning onto a new target
    · aim error that starts wide, settles over ~half a second, and grows when the target strafes
    · burst fire with pauses, real reloads, ADAD strafing while shooting
    · it backs off to cover when hurt, regenerates, then pushes back in
  Combatant interface (shared with the player proxy in tdm.js):
    team · alive · name · pos (feet) · vel · eye(out) · aimPoint(head, out) · hitTest(ray) · takeDamage(...)
*/

export const MAX_HP = 150;
const REGEN_DELAY = 5, REGEN_RATE = 30;
const EYE = 1.62;
const D2R = Math.PI / 180;
const NO_POSE = {};
const STANCE = -0.5; // torso bladed (left shoulder forward) behind the rifle

export const BOT_GUNS = {
  rifle: { label: 'Carbine', model: 'panther', rpm: 600, dmg: 15, head: 1.6, mag: 30, reload: 2.3, spread: 1.0, burst: [5, 11], range: [10, 30], sample: 'fire' },
  smg: { label: 'SMG', model: 'snake', rpm: 860, dmg: 11, head: 1.5, mag: 32, reload: 1.9, spread: 1.7, burst: [8, 16], range: [4, 15], sample: 'smgFire' },
};

const G = {
  flash: new THREE.PlaneGeometry(0.34, 0.34),
  marker: new THREE.OctahedronGeometry(0.1, 0),
};

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _dir = new THREE.Vector3();
const _ray = new THREE.Ray();
const _segA = new THREE.Vector3(), _segB = new THREE.Vector3(), _hv = new THREE.Vector3();
const _sph = new THREE.Sphere();
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const randn = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const rr = (a, b) => a + Math.random() * (b - a);

/** Shortest distance between a ray and a segment [a, b]; returns { dist, t (along ray) }. */
export function raySegment(ray, a, b) {
  const u = ray.direction, v = _v2.subVectors(b, a), w = _v.subVectors(ray.origin, a);
  const A = u.dot(u), B = u.dot(v), C = v.dot(v), Dd = u.dot(w), E = v.dot(w);
  const den = A * C - B * B;
  let s = den > 1e-8 ? (B * E - C * Dd) / den : 0;
  let t = den > 1e-8 ? (A * E - B * Dd) / den : E / C;
  t = THREE.MathUtils.clamp(t, 0, 1);
  s = Math.max(0, (B * t - Dd) / A);
  const px = ray.origin.x + u.x * s - (a.x + v.x * t), py = ray.origin.y + u.y * s - (a.y + v.y * t), pz = ray.origin.z + u.z * s - (a.z + v.z * t);
  return { dist: Math.hypot(px, py, pz), t: s };
}

export class Bot {
  constructor(world, { team, name, gun, skill, char = 'rivet' }) {
    Object.assign(this, { world, team, name, skill, char });
    this.gun = BOT_GUNS[gun];
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.alive = false;
    this.#build();
  }

  // ── combatant interface ──

  eye(out = new THREE.Vector3()) { return out.copy(this.pos).setY(this.pos.y + EYE * this.crouchK()); }
  aimPoint(head, out = new THREE.Vector3()) { return out.copy(this.pos).setY(this.pos.y + (head ? 1.62 : 1.15) * this.crouchK() + this.hopY); }
  crouchK() { return 1; }

  /** Analytic hit volumes (head sphere + body capsule) for shots fired by other bots. */
  hitTest(ray) {
    if (!this.alive) return null;
    _sph.center.copy(this.pos).setY(this.pos.y + 1.7 + this.hopY);
    _sph.radius = 0.17;
    const h = ray.intersectSphere(_sph, _hv);
    if (h) return { dist: h.distanceTo(ray.origin), zone: 'head' };
    _segA.copy(this.pos).setY(this.pos.y + 0.25 + this.hopY);
    _segB.copy(this.pos).setY(this.pos.y + 1.42 + this.hopY);
    const r = raySegment(ray, _segA, _segB);
    return r.dist < 0.3 ? { dist: r.t, zone: 'body' } : null;
  }

  takeDamage(dmg, zone, attacker, dir) {
    if (!this.alive) return false;
    const now = this.world.now;
    this.hp -= dmg;
    this.lastHurt = now;
    this.flash = 0.08;
    // flinch: hits knock the aim off a little
    this.err.x += randn() * 1.5 * D2R;
    this.err.y += Math.abs(randn()) * 1.2 * D2R;
    if (attacker && attacker.alive) {
      // being shot gives away the shooter, even from behind
      this.#notice(attacker, true);
    }
    if (this.hp <= 0) {
      this.#die(attacker, zone === 'head', dir);
      return true;
    }
    return false;
  }

  /** Gunplay (the player's guns) talks to hitboxes through this; allies take no friendly fire. */
  get dead() { return !this.alive; }
  damage(amount, zone, point, dir) {
    if (!this.alive || this.team === 'ally') return null;
    return { killed: this.takeDamage(amount, zone, this.world.player, dir) };
  }

  // ── lifecycle ──

  spawn(at) {
    this.pos.copy(at.position);
    this.pos.y = this.world.nav.heightAt(this.pos.x, this.pos.z, at.position.y);
    this.vel.set(0, 0, 0);
    this.yaw = this.aimYaw = at.yaw;
    this.aimPitch = 0;
    this.hp = MAX_HP;
    this.alive = true;
    this.lastHurt = -99;
    this.flash = 0;
    this.deathT = 0;
    this.target = null;
    this.lastSeen = new THREE.Vector3();
    this.lastSeenT = -99;
    this.heard = null;
    this.visible = false;
    this.state = 'roam';
    this.path = null;
    this.goal = null;
    this.repathT = 0;
    this.waitT = rr(0, 1.2);
    this.thinkT = Math.random() * 0.15;
    this.reactT = 0;
    this.err = new THREE.Vector2();
    this.noise = new THREE.Vector2();
    this.ammo = this.gun.mag;
    this.reloadT = 0;
    this.cooldown = 0;
    this.burstLeft = 0;
    this.pauseT = 0;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeT = 0;
    this.hopY = 0;
    this.hopV = 0;
    this.glanceT = 0;
    this.glance = 0;
    this.stuckT = 0;
    this.lastProgress = this.pos.clone();
    this.phase = 0;
    this.retreatUntil = 0;
    this.root.visible = true;
    this.root.rotation.set(0, this.yaw, 0);
    this.body.rotation.set(0, 0, 0);
    this.body.position.y = 0;
  }

  #die(killer, head, dir) {
    this.alive = false;
    this.deathT = 0;
    this.fallDir = dir ? Math.atan2(dir.x, dir.z) - this.yaw : Math.PI;
    this.world.onKill(killer, this, head);
  }

  // ── per frame ──

  update(dt) {
    const now = this.world.now;
    if (!this.alive) { this.#animateDeath(dt); return; }

    if (now - this.lastHurt > REGEN_DELAY) this.hp = Math.min(MAX_HP, this.hp + REGEN_RATE * dt);

    this.thinkT -= dt;
    if (this.thinkT <= 0) { this.thinkT = rr(0.1, 0.16); this.#perceive(now); this.#decide(now); }

    this.#move(dt, now);
    this.#aim(dt, now);
    this.#shoot(dt, now);
    this.#animate(dt);
  }

  // ── brain ──

  #perceive(now) {
    const eye = this.eye(_v);
    const fwdYaw = this.aimYaw;
    let best = null, bestScore = Infinity;
    for (const e of this.world.enemiesOf(this.team)) {
      if (!e.alive) continue;
      const d = e.pos.distanceTo(this.pos);
      if (d > 75) continue;
      const toYaw = Math.atan2(e.pos.x - this.pos.x, e.pos.z - this.pos.z);
      const inCone = Math.abs(wrap(toYaw - fwdYaw)) < 62 * D2R || d < 4;
      const known = e === this.target && now - this.lastSeenT < 1.5;
      if (!inCone && !known) continue;
      if (!this.world.los(eye, e.aimPoint(false, _v2)) && !this.world.los(eye, e.aimPoint(true, _v2))) continue;
      const score = d - (e === this.target ? 10 : 0) - (now - this.lastHurt < 2 && e === this.hurtBy ? 8 : 0);
      if (score < bestScore) { bestScore = score; best = e; }
    }
    this.visible = !!best;
    if (best) {
      if (best !== this.target || now - this.lastSeenT > 1.5) this.#acquire(best, now);
      this.lastSeen.copy(best.pos);
      this.lastSeenT = now;
      this.world.share(this.team, best.pos, now);
    }
  }

  #acquire(target, now) {
    const fresh = now - this.lastSeenT > 3;
    this.target = target;
    const s = this.skill;
    // reaction: slower when caught off guard, faster when already fighting
    this.reactT = (0.4 - 0.18 * s) * (fresh ? 1 : 0.55) * rr(0.8, 1.25);
    const err = (9 - 4 * s) * D2R * rr(0.7, 1.2);
    const a = Math.random() * Math.PI * 2;
    this.err.set(Math.cos(a) * err, Math.sin(a) * err * 0.6 - err * 0.3);
    this.aimHead = Math.random() < 0.08 + 0.3 * s;
    this.burstLeft = 0;
    this.pauseT = rr(0, 0.12);
  }

  #notice(who, hurt) {
    if (hurt) this.hurtBy = who;
    if (this.visible && this.target && this.target !== who) return;
    if (this.target !== who) this.#acquire(who, this.world.now);
    this.lastSeen.copy(who.pos);
    this.lastSeenT = this.world.now - (hurt ? 0.2 : 0.8);
  }

  /** Something loud happened at `pos` (gunfire). */
  hear(pos, who) {
    if (!this.alive || this.visible) return;
    this.heard = { pos: pos.clone().add(_v.set(rr(-3, 3), 0, rr(-3, 3))), who, t: this.world.now };
  }

  #decide(now) {
    const hurt = this.hp < MAX_HP * 0.35;
    if (this.state === 'retreat' && now < this.retreatUntil && this.hp < MAX_HP * 0.85) return;
    if (hurt && this.visible && Math.random() < 0.55 && this.state !== 'retreat') {
      const cover = this.#findCover();
      if (cover) { this.state = 'retreat'; this.#goTo(cover); this.retreatUntil = now + rr(3.5, 6); return; }
    }
    if (this.visible) { this.state = 'engage'; return; }
    if (now - this.lastSeenT < 4 && this.target?.alive) {
      if (this.state !== 'search') { this.state = 'search'; this.#goTo(this.lastSeen); }
      return;
    }
    if (this.heard && now - this.heard.t < 5) {
      if (this.state !== 'investigate') { this.state = 'investigate'; this.#goTo(this.heard.pos); }
      return;
    }
    if (this.state !== 'roam') { this.state = 'roam'; this.goal = null; this.path = null; }
  }

  #pickObjective() {
    const intel = this.world.intel(this.team);
    if (intel && Math.random() < 0.6) return intel.clone().add(_v.set(rr(-4, 4), 0, rr(-4, 4)));
    const spots = this.world.arena.hotspots;
    return spots[(Math.random() * spots.length) | 0].clone().add(_v.set(rr(-3, 3), 0, rr(-3, 3)));
  }

  #findCover() {
    const threat = this.target;
    if (!threat) return null;
    const teye = threat.eye(new THREE.Vector3());
    let best = null, bestD = Infinity;
    for (let i = 0; i < 18; i++) {
      const p = this.world.nav.randomPoint(Math.random, this.pos.x, this.pos.z, 11);
      if (!p) continue;
      if (p.distanceTo(threat.pos) < this.pos.distanceTo(threat.pos) - 2) continue; // don't run at them
      if (this.world.los(teye, _v.copy(p).setY(p.y + 1.2))) continue;
      const d = p.distanceTo(this.pos);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  #goTo(p) {
    this.goal = p.clone();
    this.path = this.world.nav.path(this.pos.x, this.pos.z, p.x, p.z, this.pos.y, p.y);
    this.pathIdx = 1;
    this.repathT = 2;
  }

  // ── body ──

  #move(dt, now) {
    const nav = this.world.nav;
    let want = _dir.set(0, 0, 0), speed = 0;

    if (this.state === 'engage' && this.target) {
      // ADAD across the line of fire, closing or opening distance toward the gun's sweet spot
      this.strafeT -= dt;
      if (this.strafeT <= 0) {
        this.strafeDir = Math.random() < 0.7 ? -this.strafeDir : this.strafeDir;
        this.strafeT = rr(0.35, 1.1) * (1.3 - this.skill * 0.5);
        if (Math.random() < 0.12 * this.skill && this.hopY === 0) this.hopV = 3.6;
      }
      const to = _v.subVectors(this.target.pos, this.pos).setY(0);
      const d = to.length();
      to.normalize();
      want.set(-to.z, 0, to.x).multiplyScalar(this.strafeDir);
      const [near, far] = this.gun.range;
      if (d > far) want.addScaledVector(to, 0.8);
      else if (d < near) want.addScaledVector(to, -0.6);
      speed = this.reloadT > 0 ? 4.2 : 3.4;
    } else {
      if (this.state === 'roam') {
        if (!this.goal || !this.path) {
          this.waitT -= dt;
          if (this.waitT <= 0) { this.#goTo(this.#pickObjective()); this.waitT = rr(0.4, 2.2); }
        }
      }
      if (this.path) {
        const wp = this.path[Math.min(this.pathIdx, this.path.length - 1)];
        const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
        if (Math.hypot(dx, dz) < 0.7) {
          this.pathIdx++;
          if (this.pathIdx >= this.path.length) { this.path = null; this.goal = this.state === 'roam' ? null : this.goal; }
        } else want.set(dx, 0, dz);
        speed = this.state === 'retreat' ? 6.4 : this.state === 'search' ? 4.6 : this.state === 'investigate' ? 5 : 5.7;
      }
      // stuck: no progress for a while → repath / new goal
      this.stuckT += dt;
      if (this.stuckT > 1.4) {
        if (this.pos.distanceTo(this.lastProgress) < 0.6 && this.goal) this.#goTo(this.state === 'roam' ? this.#pickObjective() : this.goal);
        this.stuckT = 0;
        this.lastProgress.copy(this.pos);
      }
    }

    // keep a little space from teammates
    for (const o of this.world.bots) {
      if (o === this || !o.alive) continue;
      const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z, d2 = dx * dx + dz * dz;
      if (d2 < 1.6 && d2 > 1e-4) { const d = Math.sqrt(d2); want.x += (dx / d) * (1.3 - d) * 2; want.z += (dz / d) * (1.3 - d) * 2; speed = Math.max(speed, 2); }
    }

    if (want.lengthSq() > 1e-6) want.normalize().multiplyScalar(speed);
    this.vel.x = damp(this.vel.x, want.x, 9, dt);
    this.vel.z = damp(this.vel.z, want.z, 9, dt);

    // integrate, sliding along unwalkable cells one axis at a time
    const nx = this.pos.x + this.vel.x * dt, nz = this.pos.z + this.vel.z * dt;
    const h0 = this.pos.y;
    const ok = (x, z) => nav.walkable(x, z, h0) && Math.abs(nav.heightAt(x, z, h0) - h0) < 0.8;
    if (ok(nx, nz)) { this.pos.x = nx; this.pos.z = nz; }
    else if (ok(nx, this.pos.z)) { this.pos.x = nx; this.vel.z = 0; }
    else if (ok(this.pos.x, nz)) { this.pos.z = nz; this.vel.x = 0; }
    else { this.vel.set(0, 0, 0); if (this.state === 'engage') this.strafeDir *= -1; }
    this.pos.y = damp(this.pos.y, nav.heightAt(this.pos.x, this.pos.z, this.pos.y), 14, dt);

    // little hop
    if (this.hopV || this.hopY > 0) {
      this.hopV -= 18 * dt;
      this.hopY = Math.max(0, this.hopY + this.hopV * dt);
      if (this.hopY === 0) this.hopV = 0;
    }
  }

  #aim(dt, now) {
    let yaw, pitch;
    const t = this.target;
    const engaging = this.state === 'engage' && t?.alive;
    if (engaging && this.reactT <= 0) {
      const p = t.aimPoint(this.aimHead, _v);
      const e = this.eye(_v2);
      const dx = p.x - e.x, dy = p.y - e.y, dz = p.z - e.z;
      const d = Math.hypot(dx, dz);
      const ty = Math.atan2(dx, dz), tp = Math.atan2(dy, d);
      // tracking lag: when the target's bearing swings, the error swings with it
      if (this.prevTy !== undefined) {
        const w = wrap(ty - this.prevTy) / dt;
        this.err.x += w * dt * (0.4 - 0.2 * this.skill);
      }
      this.prevTy = ty;
      const tau = 0.55 - 0.25 * this.skill;
      this.err.multiplyScalar(Math.exp(-dt / tau));
      // steady-state wobble (OU noise), worse at range and while moving
      const sigma = (0.55 - 0.25 * this.skill) * D2R * (1 + d / 45) * (this.vel.lengthSq() > 4 ? 1.3 : 1);
      this.noise.x += -this.noise.x * 5 * dt + randn() * sigma * Math.sqrt(10 * dt);
      this.noise.y += -this.noise.y * 5 * dt + randn() * sigma * 0.7 * Math.sqrt(10 * dt);
      yaw = ty + this.err.x + this.noise.x;
      pitch = tp + this.err.y + this.noise.y;
      this.wantYaw = ty; this.wantPitch = tp; this.wantDist = d;
    } else {
      if (engaging) this.reactT -= dt;
      this.prevTy = undefined;
      // look where we're going, glancing around now and then; face noises / last seen
      const look = this.state === 'search' || this.state === 'investigate' || (engaging && this.reactT > 0)
        ? (engaging ? t.pos : this.state === 'search' ? this.lastSeen : this.heard?.pos) : null;
      if (look) yaw = Math.atan2(look.x - this.pos.x, look.z - this.pos.z);
      else if (this.vel.lengthSq() > 0.5) yaw = Math.atan2(this.vel.x, this.vel.z);
      else yaw = this.aimYaw;
      this.glanceT -= dt;
      if (this.glanceT <= 0) { this.glanceT = rr(1, 2.6); this.glance = Math.random() < 0.5 ? 0 : rr(-0.9, 0.9); }
      if (!look) yaw += this.glance;
      pitch = 0;
    }
    const turn = engaging && this.reactT <= 0 ? 16 : 7;
    this.aimYaw += wrap(yaw - this.aimYaw) * (1 - Math.exp(-turn * dt));
    this.aimPitch = damp(this.aimPitch, THREE.MathUtils.clamp(pitch, -0.9, 0.9), turn, dt);
  }

  #shoot(dt, now) {
    const g = this.gun;
    this.cooldown -= dt;
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) this.ammo = g.mag;
      return;
    }
    if (this.ammo <= 0) { this.reloadT = g.reload * rr(0.95, 1.15); return; }
    // top up between fights
    if (this.state !== 'engage' && this.ammo < g.mag * 0.5 && now - this.lastSeenT > 2) { this.reloadT = g.reload; return; }

    const t = this.target;
    if (this.state !== 'engage' || !t?.alive || this.reactT > 0 || !this.visible) { this.burstLeft = 0; return; }
    if (this.pauseT > 0) { this.pauseT -= dt; return; }

    // only pull the trigger once roughly on target
    const off = Math.hypot(wrap(this.aimYaw - this.wantYaw), this.aimPitch - this.wantPitch);
    const tol = Math.atan2(0.45, this.wantDist) + 2.5 * D2R;
    if (this.burstLeft <= 0) {
      if (off > tol) return;
      const far = this.wantDist > 35;
      this.burstLeft = far ? (2 + Math.random() * 3) | 0 : (g.burst[0] + Math.random() * (g.burst[1] - g.burst[0])) | 0;
    }
    while (this.cooldown <= 0 && this.burstLeft > 0 && this.ammo > 0) {
      this.cooldown += 60 / g.rpm;
      this.#fire(now);
      this.burstLeft--;
      this.ammo--;
      if (this.burstLeft === 0) this.pauseT = rr(0.12, 0.4) * (1 + this.wantDist / 40);
    }
    if (this.cooldown < -0.1) this.cooldown = 0;
  }

  #fire() {
    const g = this.gun;
    const eye = this.eye(new THREE.Vector3());
    const spread = g.spread * D2R * (this.vel.lengthSq() > 4 ? 1.4 : 1) * (this.hopY > 0 ? 2 : 1);
    const cp = Math.cos(this.aimPitch);
    _dir.set(Math.sin(this.aimYaw) * cp, Math.sin(this.aimPitch), Math.cos(this.aimYaw) * cp);
    const r = Math.tan(spread) * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
    const right = _v.set(Math.cos(this.aimYaw), 0, -Math.sin(this.aimYaw));
    const up = _v2.crossVectors(right, _dir);
    _dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
    _ray.set(eye, _dir);

    const worldHit = this.world.octree.rayIntersect(_ray);
    let best = null, bestD = worldHit ? worldHit.distance : 120;
    for (const e of this.world.enemiesOf(this.team)) {
      const h = e.hitTest(_ray);
      if (h && h.dist < bestD) { bestD = h.dist; best = { e, zone: h.zone }; }
    }
    const end = eye.clone().addScaledVector(_dir, bestD);
    if (best) {
      const falloff = THREE.MathUtils.clamp(1 - (bestD - 30) / 90, 0.65, 1);
      const dmg = Math.round(g.dmg * falloff * (best.zone === 'head' ? g.head : 1));
      best.e.takeDamage(dmg, best.zone, this, _dir.clone());
    } else if (worldHit) {
      this.world.fx.impact(end, worldHit.triangle.getNormal(new THREE.Vector3()));
    }

    this.muzzle.getWorldPosition(_v);
    this.world.fx.tracer(_v, end);
    this.flashT = 0.045;
    this.flashMesh.rotation.z = Math.random() * Math.PI;
    this.world.gunshot(this, _v);
  }

  // ── visuals ──

  #build() {
    const r = (this.robot = buildCharacter(this.char, this.team));
    this.mats = r.flashMats;
    this.root = new THREE.Group();
    this.body = new THREE.Group(); // tips over on death
    this.root.add(this.body);
    this.body.add(r.root);
    const b = r.bones;
    Object.assign(this, { hips: b.hips, spine: b.spine, neck: b.neck, hipsY: b.hips.position.y });
    this.legs = ['L', 'R'].map((s) => ({ thigh: r.legs[s].thigh, knee: r.legs[s].shin }));

    // the gun pitches with the aim from the right shoulder; both hands are solved onto its grips every frame
    this.arms = new THREE.Group();
    this.arms.position.set(-0.1, 0.24, 0.02);
    b.chest.add(this.arms);
    this.gunFrame = new THREE.Group();
    this.gunFrame.position.set(0.02, -0.04, 0.34);
    this.gunFrame.rotation.y = Math.PI - STANCE;
    this.arms.add(this.gunFrame);
    this.muzzle = new THREE.Object3D();
    this.flashMesh = new THREE.Mesh(G.flash, new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false }));
    this.flashMesh.layers.set(FX_LAYER);
    this.flashMesh.visible = false;
    this.muzzle.add(this.flashMesh);
    this.flashT = 0;
    this.guns = new Map();
    this.holdWeapon(WEAPONS.find((w) => w.id === this.gun.model) ?? WEAPONS[0]);

    if (this.team === 'ally') {
      const mk = new THREE.Mesh(G.marker, new THREE.MeshBasicMaterial({ color: P.sky, depthTest: false, transparent: true, opacity: 0.9, toneMapped: false }));
      mk.scale.y = 1.4;
      mk.position.y = 2.3;
      mk.renderOrder = 10;
      mk.layers.set(FX_LAYER);
      this.root.add(mk);
      this.marker = mk;
    }

    this.hitboxes = r.hitboxes;
    for (const h of this.hitboxes) h.userData.dummy = this;
    this.root.visible = false;
  }

  /** Swap the third-person gun model (built once per weapon, kept for later swaps). */
  holdWeapon(def) {
    if (this.weapon === def) return;
    if (this.weapon) this.guns.get(this.weapon.id).visible = false;
    let gun = this.guns.get(def.id);
    if (!gun) {
      const { root, parts } = def.build();
      bakeFlat(root); // one draw call; its moving parts never move in third person
      root.userData.muzzle = parts.muzzleMount;
      this.gunFrame.add(root);
      this.guns.set(def.id, (gun = root));
    }
    gun.visible = true;
    gun.userData.muzzle.add(this.muzzle);
    this.weapon = def;
  }

  #animate(dt) {
    this.root.position.copy(this.pos);
    this.root.position.y += this.hopY;
    this.root.rotation.y = this.aimYaw;

    // lower body turns toward travel; the legs run backwards when backpedalling; the torso stays bladed
    const sp = Math.hypot(this.vel.x, this.vel.z);
    let legYaw = 0, dirSign = 1;
    if (sp > 0.4) {
      legYaw = wrap(Math.atan2(this.vel.x, this.vel.z) - this.aimYaw);
      if (Math.abs(legYaw) > Math.PI / 2) { legYaw = wrap(legYaw + Math.PI); dirSign = -1; }
    }
    this.hips.rotation.y = damp(this.hips.rotation.y, THREE.MathUtils.clamp(legYaw, -1.2, 1.2), 10, dt);
    this.phase += sp * dt * 1.9 * dirSign;
    // movement poses (networked players set poseTarget; bots only hop): weights eased so state changes blend
    const w = (this.poseW ??= { crouch: 0, slide: 0, wall: 0, air: 0, ads: 0, mantle: 0 });
    const tgt = this.poseTarget ?? NO_POSE;
    for (const key in w) w[key] = damp(w[key], tgt[key] ?? 0, 12, dt);
    const air = Math.max(w.air, this.hopY > 0 ? 1 : 0, w.mantle);
    const low = Math.max(w.crouch, w.slide);
    const k = Math.min(1, sp / 4) * (1 - w.slide) * (1 - air * 0.7);
    this.legs.forEach((l, i) => {
      const ph = this.phase + i * Math.PI;
      let th = -Math.sin(ph) * 0.65 * k * (1 - w.crouch * 0.4) - 0.08 - air * 0.55 - w.crouch * 0.95;
      let kn = Math.max(0, Math.cos(ph)) * 0.9 * k + 0.14 + air * 0.95 + w.crouch * 1.55;
      // slide: lead leg stretched out front, the other folded under
      th += w.slide * (i === 0 ? -1.35 : -0.35);
      kn += w.slide * (i === 0 ? 0.15 : 1.85);
      l.thigh.rotation.x = th;
      l.knee.rotation.x = kn;
    });
    const bob = Math.abs(Math.sin(this.phase)) * 0.04 * k;
    this.hips.position.y = this.hipsY - 0.035 + bob - w.crouch * 0.3 - w.slide * 0.45 - air * 0.05;
    // wallrun: whole body leans into the wall; slide leans back; mantle/vault pitches forward
    this.body.rotation.set(0, 0, w.wall * 0.32);
    this.spine.rotation.set(-this.aimPitch * 0.35 + 0.08 * k - w.slide * 0.45 + w.mantle * 0.5 + w.crouch * 0.12, -this.hips.rotation.y + STANCE * (1 - w.ads * 0.3), 0, 'YXZ');
    this.arms.rotation.set(-this.aimPitch * 0.65 + w.slide * 0.3, 0, 0);
    // aiming: the gun comes up to the eye line and in toward the centre
    this.arms.position.set(-0.1 + w.ads * 0.05, 0.24 + w.ads * 0.1, 0.02 + w.ads * 0.04);
    this.neck.rotation.set(-this.aimPitch * 0.3 + w.slide * 0.3 + w.ads * 0.08, -STANCE * 0.8, w.ads * -0.12, 'YXZ');
    // reload: gun dips and rolls, the support hand goes to the magazine
    const rl = this.reloadT > 0 ? Math.sin(Math.min(1, this.reloadT / this.gun.reload) * Math.PI) : 0;
    this.arms.rotation.x += rl * 0.6;
    this.arms.rotation.z = rl * 0.5;
    const poses = this.weapon.poses;
    gripGun(this.robot, this.gunFrame, poses, { left: rl > 0.3 ? poses.lhMag ?? poses.lhRest : poses.lhRest });

    this.flashT -= dt;
    this.flashMesh.visible = this.flashT > 0;
    this.flash = Math.max(0, (this.flash ?? 0) - dt);
    const e = this.flash > 0 ? 0.5 : 0;
    for (const mt of this.mats) mt.emissive.setScalar(e);
  }

  #animateDeath(dt) {
    if (!this.root.visible) return;
    this.deathT += dt;
    const t = Math.min(1, this.deathT / 0.55);
    const ease = 1 - Math.pow(1 - t, 3);
    // topple away from the shot, knees buckle first
    this.body.rotation.set(-Math.cos(this.fallDir) * ease * 1.45, 0, Math.sin(this.fallDir) * ease * 1.45);
    this.legs.forEach((l) => { l.knee.rotation.x = damp(l.knee.rotation.x, 1.2, 8, dt); });
    this.arms.rotation.x = damp(this.arms.rotation.x, 0.8, 6, dt);
    gripGun(this.robot, this.gunFrame, this.weapon.poses);
    this.body.position.y = this.deathT > 2.6 ? -(this.deathT - 2.6) * 0.5 : 0;
    this.flashMesh.visible = false;
    if (this.marker) this.marker.visible = false;
    if (this.deathT > 3.6) this.root.visible = false;
    this.flash = 0;
    for (const mt of this.mats) mt.emissive.setScalar(0);
  }

  showMarker() { if (this.marker) this.marker.visible = true; }

  /** Animate from externally driven pos / vel / aimYaw / aimPitch (networked players). */
  pose(dt) { if (this.alive) this.#animate(dt); else this.#animateDeath(dt); }
}
