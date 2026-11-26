import * as THREE from 'three';
import { ZONE } from './weapons.js';

/*
  Quick melee on V: the gun drops, the knife comes up and the gun comes back. With nobody in reach the
  knife sweeps in one continuous arc, right to left, then left to right on the next press. With someone
  right in front of you it stabs instead. Each move is a few keyed hand poses played through a Catmull-Rom
  curve; in its strike window a fan of short rays covers the arc and the first body in reach is hit.
  The pose drives the knife hand in items/handheld.js (kind 'melee').
*/

export const MELEE = { range: 2.4, head: 1.4, cooldown: 0.1 };

// hand frame poses in the viewmodel camera: [x, y, z, rx, ry, rz] (degrees). The knife sits in the fist
// blade-forward, so +rx tips it up, +ry swings the tip left, +rz rolls the hand anticlockwise
const REST = [0.17, -0.13, -0.56, 6, -8, -4];
const RIGHT = [0.27, -0.02, -0.58, 14, -48, -34], LEFT = [-0.17, -0.06, -0.58, 12, 46, 50];
const SWINGS = {
  // one arc: in from the side, across the middle without stopping, out the other side, back to rest
  slashLeft: {
    time: 0.44, strike: [0.07, 0.2], sweep: [40, -40], pitch: -4, damage: 65, punch: [-0.6, 2.2, 3],
    keys: [[0, REST], [0.06, RIGHT], [0.13, [0.04, -0.07, -0.68, -4, 2, 8]], [0.2, [-0.2, -0.17, -0.57, -14, 50, 48]], [0.44, REST]],
  },
  slashRight: {
    time: 0.44, strike: [0.07, 0.2], sweep: [-40, 40], pitch: -4, damage: 65, punch: [-0.6, -2.2, -3],
    keys: [[0, REST], [0.06, LEFT], [0.13, [0.06, -0.08, -0.68, -4, -2, -8]], [0.2, [0.31, -0.13, -0.56, -10, -52, -46]], [0.44, REST]],
  },
  stab: {
    time: 0.46, strike: [0.12, 0.2], sweep: [-7, 7], pitch: -3, damage: 80, punch: [-1.6, 0, 0],
    keys: [[0, REST], [0.08, [0.2, -0.16, -0.42, 14, -6, -4]], [0.15, [0.06, -0.09, -0.82, -10, 6, -6]], [0.22, [0.07, -0.1, -0.78, -8, 6, -6]], [0.46, REST]],
  },
};

const D2R = Math.PI / 180;
const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _ray = new THREE.Raycaster();

/** Catmull-Rom through the keys (each a pose array), at time t. */
function sample(keys, t) {
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
  const [t1, p1] = keys[i], [t2, p2] = keys[i + 1];
  const p0 = keys[Math.max(0, i - 1)][1], p3 = keys[Math.min(keys.length - 1, i + 2)][1];
  const u = THREE.MathUtils.clamp((t - t1) / (t2 - t1), 0, 1), u2 = u * u, u3 = u2 * u;
  return p1.map((v, k) => 0.5 * (2 * v + (-p0[k] + p2[k]) * u + (2 * p0[k] - 5 * v + 4 * p2[k] - p3[k]) * u2 + (-p0[k] + 3 * v - 3 * p2[k] + p3[k]) * u3));
}

export class Melee {
  constructor({ audio, hud, fx, rig }) {
    Object.assign(this, { audio, hud, fx, rig });
    this.action = null; // { id: 'knife', kind: 'melee', t, time, pose }
    this.side = 0; // which way the next slash goes
    this.wait = 0;
  }

  get busy() { return !!this.action; }

  /** ctx: { camera, targets, octree } — someone close in front gets the stab. */
  start(ctx) {
    if (this.action || this.wait > 0) return false;
    let s;
    if (ctx && this.#fan(SWINGS.stab, ctx, MELEE.range - 0.3)) s = SWINGS.stab;
    else s = (this.side ^= 1) ? SWINGS.slashLeft : SWINGS.slashRight;
    this.action = { id: 'knife', kind: 'melee', t: 0, time: s.time, swing: s, pose: REST, struck: false };
    this.audio.play('cloth', { volume: 0.35, rate: 1.3 });
    return true;
  }

  cancel() { this.action = null; }

  /** ctx: { camera, targets, octree, now } */
  update(dt, ctx) {
    this.wait = Math.max(0, this.wait - dt);
    const a = this.action;
    if (!a) return;
    const s = a.swing, prev = a.t;
    a.t += dt;
    a.pose = sample(s.keys, Math.min(a.t, s.time));
    if (prev < s.strike[0] && a.t >= s.strike[0]) {
      this.audio.play('cloth', { volume: 0.7, rate: 1.9 + Math.random() * 0.3 }); // the swish
      this.rig.punch(...s.punch);
    }
    if (!a.struck && a.t >= s.strike[0] && a.t <= s.strike[1] + dt) a.struck = this.#strike(a, ctx);
    if (a.t >= s.time) { this.action = null; this.wait = MELEE.cooldown; }
  }

  /** The nearest body a fan of rays across the swing's arc finds within `range` (walls in front block it). */
  #fan(s, { camera, targets, octree }, range = MELEE.range) {
    const dummies = targets.filter((t) => t.userData.dummy);
    let best = null;
    this.wall = null;
    // two rows of rays every ~5° across the arc: nothing body-sized in reach slips between them
    const n = Math.max(2, Math.ceil(Math.abs(s.sweep[1] - s.sweep[0]) / 5));
    for (let i = 0; i <= n * 2 + 1; i++) {
      const yaw = THREE.MathUtils.lerp(s.sweep[0], s.sweep[1], (i >> 1) / n) * D2R;
      _e.set((s.pitch + (i & 1 ? 6 : 0)) * D2R, yaw, 0);
      _d.set(0, 0, -1).applyEuler(_e).applyQuaternion(camera.quaternion);
      _o.copy(camera.position);
      _ray.set(_o, _d);
      _ray.far = range;
      const block = octree?.rayIntersect(_ray.ray);
      // a body's own collision sits at its hitbox surface: only a wall clearly in front of it blocks
      const reach = block && block.distance < range ? block.distance + 0.35 : range;
      if (block && block.distance < range && (!this.wall || block.distance < this.wall.distance)) this.wall = block;
      const hit = _ray.intersectObjects(dummies, false).find((h) => h.distance < reach && !h.object.userData.dummy.dead);
      if (hit && (!best || hit.distance < best.distance)) best = { ...hit, dir: _d.clone() };
    }
    return best;
  }

  /** The strike: the body the arc finds takes the hit; a wall in the way gets a scrape. */
  #strike(a, ctx) {
    const s = a.swing, best = this.#fan(s, ctx), wall = this.wall, { now } = ctx;
    if (best) {
      const who = best.object.userData.dummy, zone = best.object.userData.zone, head = zone === 'head';
      const dmg = s.damage * (head ? MELEE.head : ZONE[zone] ?? 1);
      const res = who.damage(dmg, zone, best.point, best.dir, now, 'knife');
      if (!res) return false;
      this.hud.hitmarker(res.killed ? 'kill' : 'hit', head);
      this.hud.damageNumber(best.point, Math.round(dmg), head);
      this.audio.hit(res.killed ? 'kill' : 'body', head);
      this.audio.play('land', { volume: 0.5, rate: 1.7 });
      this.fx.impact(best.point, best.dir.clone().negate(), { flesh: true });
      this.rig.punch(-0.6, 0, 0);
      return true;
    }
    // the blade scrapes a wall: once a swing, and the rest of the window can still find a body
    if (wall && !a.clanged) {
      a.clanged = true;
      this.fx.impact(wall.position, wall.triangle.getNormal(new THREE.Vector3()));
      this.audio.play('click', { volume: 0.5, rate: 0.7 });
      this.rig.punch(-0.4, 0, 0);
    }
    return false;
  }
}
