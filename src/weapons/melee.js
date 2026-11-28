import * as THREE from 'three';
import { ZONE } from './weapons.js';

/*
  Quick melee on V: the gun drops and the right fist throws a punch, a straight cross, then a hook on the next
  press. Each punch is a few keyed hand poses played through a Catmull-Rom curve: chambered back by the
  shoulder, snapped out, held a beat at full extension, pulled back down. In its strike window a fan of short
  rays covers the line of the punch; the first body in reach takes it. A landed punch freezes the fist for a
  few frames (hit-stop) and jolts the view, so the contact reads; a wall gets a shorter, drier stop.
  The pose drives the hand in items/handheld.js (kind 'melee').
*/

export const MELEE = { range: 2.1, head: 1.4, cooldown: 0.12, stop: 0.075, wallStop: 0.045, wallReach: 1.05 };

// fist poses in the viewmodel camera: [x, y, z, rx, ry, rz] (degrees), in the hand frame of items/handheld.js.
// Each is turned so the forearm runs straight back from the fist toward the punching shoulder (handheld.js
// ANCHOR_PUNCH, low and out to the right) with the back of the fist up: the arm comes in from the side
const LOW = [0.211, -0.614, -0.429, -32, 36, 124]; // below the view, where a punch starts and ends
const SWINGS = {
  // straight right: chambered low, driven in from the side onto the centre, held a beat, pulled back down
  cross: {
    time: 0.5, strike: [0.12, 0.17], sweep: [-9, 9], pitch: -3, damage: 50, punch: [-1.4, 1.2, 2.5],
    keys: [[0, LOW], [0.08, [0.221, -0.275, -0.489, -8, 28, 124]], [0.14, [-0.088, -0.085, -0.674, -8, 36, 124]], [0.2, [-0.078, -0.091, -0.664, -8, 36, 124]], [0.27, [0.032, -0.175, -0.574, -8, 36, 124]], [0.5, LOW]],
  },
  // right hook: wound out wide right, the fist comes round across the front rolled knuckles-first, stops past the middle
  hook: {
    time: 0.52, strike: [0.13, 0.18], sweep: [24, -14], pitch: -2, damage: 50, punch: [-1, 3.2, 4.5],
    keys: [[0, LOW], [0.09, [0.378, -0.107, -0.472, 4, 36, 84]], [0.15, [-0.106, -0.089, -0.693, -4, 20, 152]], [0.21, [-0.116, -0.095, -0.683, -4, 20, 152]], [0.28, [-0.003, -0.186, -0.552, -12, 36, 128]], [0.52, LOW]],
  },
};

const D2R = Math.PI / 180;
const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _ray = new THREE.Raycaster();

/** Catmull-Rom through the keys (each a pose array), at time t. */
export function sample(keys, t) {
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
    this.action = null; // { id: 'fist', kind: 'melee', name (the punch), t, time, pose }
    this.side = 0; // which punch comes next
    this.wait = 0;
  }

  get busy() { return !!this.action; }

  start() {
    if (this.action || this.wait > 0) return false;
    const name = (this.side ^= 1) ? 'cross' : 'hook';
    const s = SWINGS[name];
    this.action = { id: 'fist', kind: 'melee', name, t: 0, time: s.time, swing: s, pose: LOW, struck: false, stopT: 0 };
    this.audio.play('cloth', { volume: 0.3, rate: 1.2 });
    return true;
  }

  cancel() { this.action = null; }

  /** ctx: { camera, targets, octree, now } */
  update(dt, ctx) {
    this.wait = Math.max(0, this.wait - dt);
    const a = this.action;
    if (!a) return;
    const s = a.swing, prev = a.t;
    // hit-stop: the fist stays where it landed for a moment
    if (a.stopT > 0) { a.stopT -= dt; return; }
    a.t += dt;
    a.pose = sample(s.keys, Math.min(a.t, s.time));
    if (prev < s.strike[0] - 0.05 && a.t >= s.strike[0] - 0.05) this.audio.play('cloth', { volume: 0.6, rate: 1.7 + Math.random() * 0.3 }); // the whoosh
    if (!a.struck && a.t >= s.strike[0] && a.t <= s.strike[1] + dt) a.struck = this.#strike(a, ctx);
    if (prev < s.strike[1] && a.t >= s.strike[1] && !a.struck && !a.clanged) this.rig.punch(...s.punch.map((v) => v * 0.4)); // a whiff: a little follow-through
    if (a.t >= s.time) { this.action = null; this.wait = MELEE.cooldown; }
  }

  /** The nearest body a fan of rays across the punch's line finds within reach (walls in front block it). */
  #fan(s, { camera, targets, octree }, range = MELEE.range) {
    const dummies = targets.filter((t) => t.userData.dummy);
    let best = null;
    this.wall = null;
    // two rows of rays every ~5° across the line: nothing body-sized in reach slips between them
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

  /** The strike: the body the fan finds takes the punch; a wall in the way stops the fist. */
  #strike(a, ctx) {
    const s = a.swing, best = this.#fan(s, ctx), wall = this.wall, { now } = ctx;
    if (best) {
      const who = best.object.userData.dummy, zone = best.object.userData.zone, head = zone === 'head';
      const dmg = s.damage * (head ? MELEE.head : ZONE[zone] ?? 1);
      const res = who.damage(dmg, zone, best.point, best.dir, now, 'fist');
      if (!res) return false;
      this.hud.hitmarker(res.killed ? 'kill' : 'hit', head);
      this.hud.damageNumber(best.point, Math.round(dmg), head, res.armour);
      if (res.armour?.broke) this.audio.armourBreak(res.armour.tier);
      this.audio.punch();
      this.audio.hit(res.killed ? 'kill' : 'body', head);
      this.fx.impact(best.point, best.dir.clone().negate(), { flesh: true });
      this.rig.punch(...s.punch.map((v) => v * 1.6));
      a.stopT = MELEE.stop * (res.killed ? 1.6 : 1);
      return true;
    }
    // knuckles on a wall: once a punch, and the rest of the window can still find a body
    if (wall && wall.distance < MELEE.wallReach && !a.clanged) {
      a.clanged = true;
      this.fx.impact(wall.position, wall.triangle.getNormal(new THREE.Vector3()));
      this.audio.punch({ wall: true });
      this.rig.punch(...s.punch.map((v) => v * 0.8));
      a.stopT = MELEE.wallStop;
    }
    return false;
  }
}
