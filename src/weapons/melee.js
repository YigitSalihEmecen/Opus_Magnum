import * as THREE from 'three';

/*
  Quick melee on V: the gun drops, the knife comes up and swings, the gun comes back. Three swings (a
  forehand slash, a backhand, a straight stab), never the same one twice running, so it doesn't read as
  one canned move. Each swing is a few keyed hand poses played through a Catmull-Rom curve; at its strike
  window a fan of short rays sweeps the arc and the first damageable thing in reach takes the hit.
  The pose drives the knife hand in items/handheld.js (kind 'melee').
*/

export const MELEE = { range: 2.4, damage: 70, head: 1.4, cooldown: 0.12 };

// hand frame poses in the viewmodel camera: [x, y, z, rx, ry, rz] (degrees). The knife sits in the fist
// blade-forward, so +rx tips it up, +ry swings the tip left, +rz rolls the hand anticlockwise
const REST = [0.17, -0.13, -0.56, 6, -8, -4];
const SWINGS = [
  {
    name: 'slash', time: 0.52, strike: [0.15, 0.25], sweep: [30, -36], pitch: -5, punch: [-0.8, 2.4, 4],
    keys: [[0, REST], [0.12, [0.2, -0.02, -0.62, 22, -38, -28]], [0.2, [0, -0.12, -0.66, -6, 20, 34]], [0.28, [-0.16, -0.24, -0.56, -18, 48, 52]], [0.52, REST]],
  },
  {
    name: 'backhand', time: 0.54, strike: [0.17, 0.27], sweep: [-32, 32], pitch: -3, punch: [-0.7, -2.4, -4],
    keys: [[0, REST], [0.13, [-0.12, -0.08, -0.6, 16, 46, 52]], [0.22, [0.06, -0.1, -0.66, -4, -14, -24]], [0.3, [0.27, -0.09, -0.58, 2, -50, -46]], [0.54, REST]],
  },
  {
    name: 'stab', time: 0.46, strike: [0.13, 0.22], sweep: [-6, 6], pitch: -2, punch: [-1.6, 0, 0],
    keys: [[0, REST], [0.1, [0.2, -0.16, -0.44, 14, -6, -4]], [0.18, [0.06, -0.09, -0.8, -10, 6, -6]], [0.24, [0.07, -0.1, -0.76, -8, 6, -6]], [0.46, REST]],
  },
];

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
    this.last = -1;
    this.wait = 0;
  }

  get busy() { return !!this.action; }

  start() {
    if (this.action || this.wait > 0) return false;
    let k = (Math.random() * SWINGS.length) | 0;
    if (k === this.last) k = (k + 1 + ((Math.random() * (SWINGS.length - 1)) | 0)) % SWINGS.length;
    this.last = k;
    const s = SWINGS[k];
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

  /** Sweep a fan of rays across the swing's arc; the nearest damageable hit in reach (not behind a wall) is struck. */
  #strike(a, { camera, targets, octree, now }) {
    const s = a.swing;
    const dummies = targets.filter((t) => t.userData.dummy);
    let best = null, wall = null;
    // two rows of rays every ~5° across the arc: nothing body-sized in reach slips between them
    const n = Math.max(2, Math.ceil(Math.abs(s.sweep[1] - s.sweep[0]) / 5));
    for (let i = 0; i <= n * 2 + 1; i++) {
      const yaw = THREE.MathUtils.lerp(s.sweep[0], s.sweep[1], (i >> 1) / n) * D2R;
      _e.set((s.pitch + (i & 1 ? 6 : 0)) * D2R, yaw, 0);
      _d.set(0, 0, -1).applyEuler(_e).applyQuaternion(camera.quaternion);
      _o.copy(camera.position);
      _ray.set(_o, _d);
      _ray.far = MELEE.range;
      const block = octree?.rayIntersect(_ray.ray);
      // a body's own collision sits at its hitbox surface: only a wall clearly in front of it blocks
      const reach = block && block.distance < MELEE.range ? block.distance + 0.35 : MELEE.range;
      if (block && block.distance < MELEE.range && (!wall || block.distance < wall.distance)) wall = block;
      const hit = _ray.intersectObjects(dummies, false).find((h) => h.distance < reach && !h.object.userData.dummy.dead);
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
    if (best) {
      const who = best.object.userData.dummy, head = best.object.userData.zone === 'head';
      const dmg = MELEE.damage * (head ? MELEE.head : 1);
      const res = who.damage(dmg, best.object.userData.zone, best.point, _d.clone(), now);
      if (!res) return false;
      this.hud.hitmarker(res.killed ? 'kill' : 'hit', head);
      this.hud.damageNumber(best.point, Math.round(dmg), head);
      this.audio.hit(res.killed ? 'kill' : 'body', head);
      this.audio.play('land', { volume: 0.5, rate: 1.7 });
      this.fx.impact(best.point, _d.clone().negate(), { flesh: true });
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
