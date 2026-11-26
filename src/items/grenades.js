import * as THREE from 'three';
import { buildGrenade } from './models/grenade.js';
import { Explosions } from './explosion.js';

/*
  Thrown grenades: ballistic flight with bounces off the level (ray-cast so fast throws can't tunnel through
  thin walls), a fuse, then a blast. Damage falls off from FULL m to RADIUS m and needs a clear line from the
  blast to the target. Only grenades we threw deal damage (online, each thrower's client reports its hits).
    damage(pos) → onBlast(pos, hits) where hits = [{ target, dmg, point, dir }] for every damageable in reach
*/

export const BLAST = { radius: 6.5, full: 1.4, damage: 135, self: 0.6 };
const FUSE = 2.4, R = 0.05, GRAVITY = 21, REST = 0.38, THROW_SPEED = 17;
const _n = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Vector3();
const _ray = new THREE.Ray(), _sph = new THREE.Sphere(), _box = new THREE.Box3();

let template = null;
function grenadeMesh() {
  if (!template) {
    template = buildGrenade();
    template.userData.parts.pin.visible = false; // the pin stays in the hand
    for (const c of template.children) c.position.y -= 0.042; // spin about the body's centre
  }
  return template.clone();
}

export class Grenades {
  constructor(scene, { octree, audio, camera, onBlast }) {
    Object.assign(this, { scene, octree, audio, camera, onBlast });
    this.fx = new Explosions(scene);
    this.live = [];
  }

  dispose() {
    for (const g of this.live) this.scene.remove(g.mesh);
    this.fx.dispose();
  }

  /** Throw from the eye along `dir`, inheriting some of the thrower's velocity. mine: we deal its damage. */
  throw(origin, dir, inherit, { mine = true, fuse = FUSE } = {}) {
    const vel = _d.copy(dir).multiplyScalar(THROW_SPEED).add(_n.set(0, 3.2, 0)).addScaledVector(inherit, 0.6).clone();
    return this.spawn(origin, vel, { mine, fuse });
  }

  spawn(pos, vel, { mine = false, fuse = FUSE } = {}) {
    const mesh = grenadeMesh();
    mesh.position.copy(pos);
    this.scene.add(mesh);
    const g = { mesh, pos: pos.clone(), vel: vel.clone(), fuse, mine, spin: new THREE.Vector3(8 + Math.random() * 6, Math.random() * 4, 2), lastNormal: new THREE.Vector3(0, 1, 0), clink: 0 };
    this.live.push(g);
    return g;
  }

  #step(g, dt) {
    g.vel.y -= GRAVITY * dt;
    const speed = g.vel.length();
    const travel = speed * dt;
    if (speed > 1e-4) {
      _ray.origin.copy(g.pos);
      _ray.direction.copy(g.vel).divideScalar(speed);
      const hit = this.octree.rayIntersect(_ray);
      if (hit && hit.distance < travel + R) {
        hit.triangle.getNormal(_n);
        if (_n.dot(g.vel) > 0) _n.negate();
        g.pos.copy(hit.position).addScaledVector(_n, R + 0.002);
        const vn = g.vel.dot(_n);
        g.vel.addScaledVector(_n, -(1 + REST) * vn).multiplyScalar(0.78);
        g.spin.multiplyScalar(0.6);
        g.lastNormal.copy(_n);
        if (-vn > 2.2 && g.clink <= 0) this.#clink(g.pos, Math.min(1, -vn / 12));
      } else g.pos.addScaledVector(g.vel, dt);
    }
    // resting contact: push out of anything we sank into and roll to a stop on floors
    _sph.set(g.pos, R);
    const c = this.octree.sphereIntersect(_sph);
    if (c) {
      g.pos.addScaledVector(c.normal, c.depth);
      const vn = g.vel.dot(c.normal);
      if (vn < 0) g.vel.addScaledVector(c.normal, -vn);
      if (c.normal.y > 0.6) { g.vel.multiplyScalar(Math.exp(-5 * dt)); g.spin.multiplyScalar(Math.exp(-4 * dt)); g.lastNormal.copy(c.normal); }
    }
  }

  #clink(pos, k) {
    if (!this.camera) return;
    const d = pos.distanceTo(this.camera.position);
    const vol = 0.5 * k * Math.max(0, 1 - d / 30);
    if (vol > 0.02) this.audio.play('click', { volume: vol, rate: 0.55 + Math.random() * 0.15 });
  }

  update(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const g = this.live[i];
      g.clink -= dt;
      // sub-steps keep bounces clean at throw speed
      const n = Math.ceil((g.vel.length() * dt) / 0.25) || 1;
      for (let s = 0; s < n; s++) this.#step(g, dt / n);
      g.mesh.position.copy(g.pos);
      g.mesh.rotation.x += g.spin.x * dt;
      g.mesh.rotation.y += g.spin.y * dt;
      g.mesh.rotation.z += g.spin.z * dt;
      if ((g.fuse -= dt) > 0 && g.pos.y > -60) continue;
      this.scene.remove(g.mesh);
      this.live.splice(i, 1);
      this.#explode(g);
    }
    this.fx.update(dt, this.camera);
  }

  #explode(g) {
    // sit the blast on the surface it rests on (or in the air if it went off mid-flight)
    const onFloor = g.vel.lengthSq() < 4;
    this.fx.spawn(g.pos, onFloor ? g.lastNormal : _n.set(0, 1, 0));
    this.audio.explosion?.(this.#loudness(g.pos));
    this.onBlast?.(g.pos.clone(), g.mine);
  }

  #loudness(pos) {
    const cam = this.camera.position, d = pos.distanceTo(cam);
    _c.subVectors(pos, cam).normalize();
    _d.setFromMatrixColumn(this.camera.matrixWorld, 0);
    return { volume: Math.max(0.08, 1 - d / 90), pan: THREE.MathUtils.clamp(_c.dot(_d), -1, 1) * 0.7, near: Math.max(0, 1 - d / 14) };
  }

  /**
   * Who a blast at `pos` reaches among `targets` (meshes whose userData.dummy is damageable), one entry per
   * damageable at its nearest hitbox, with line of sight from the blast.
   */
  reach(pos, targets) {
    const best = new Map();
    for (const m of targets) {
      const who = m.userData.dummy;
      if (!who || who.dead || who.alive === false) continue;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      _box.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
      _box.clampPoint(pos, _p);
      const d = _p.distanceTo(pos);
      if (d > BLAST.radius) continue;
      const prev = best.get(who);
      if (!prev || d < prev.d) best.set(who, { d, point: _box.getCenter(new THREE.Vector3()), zone: m.userData.zone === 'head' ? 'head' : 'body' });
    }
    const hits = [];
    for (const [target, h] of best) {
      if (!this.clear(pos, h.point)) continue;
      hits.push({ target, dmg: falloff(h.d), point: h.point, dir: h.point.clone().sub(pos).normalize() });
    }
    return hits;
  }

  /** Line of sight from a blast to a point (the blast sits a hair off its surface). */
  clear(from, to) {
    _ray.origin.copy(from);
    _ray.direction.subVectors(to, from);
    const len = _ray.direction.length();
    if (len < 0.05) return true;
    _ray.direction.divideScalar(len);
    _ray.origin.addScaledVector(_ray.direction, 0.08);
    const hit = this.octree.rayIntersect(_ray);
    return !hit || hit.distance > len - 0.35;
  }
}

export function falloff(d) {
  return Math.round(BLAST.damage * (1 - THREE.MathUtils.smoothstep(d, BLAST.full, BLAST.radius)));
}
