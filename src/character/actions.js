import * as THREE from 'three';
import { buildKnife } from '../items/models/knife.js';
import { ITEMS } from '../items/items.js';
import { THROW } from '../items/inventory.js';
import { Spring } from './smooth.js';

/*
  What a body's free (left) hand does besides holding the gun, so other players see it: knife swings, a grenade
  throw, using a heal or a charger. Each is a path for the hand (keys: time → place from the chest, in the
  body's facing: left, up, ahead) that the hand eases onto from the gun and back off, holding the item, while
  the gun dips out of the way.
    act(name, item?)        start one (names: ACTS; item: an ITEMS id, for 'use')
    stop()                  end an open-ended one (using an item, or cancelled); clear() drops it at once
    update(dt, chest, yaw)  → this: { k (0 on the gun … 1 on the path), matrix (the hand's world target), dip }
*/

export const ACTS = {
  // the knife: one arc across the front (from the right, or from the left), or a thrust
  slashLeft: { time: 0.44, item: 'knife', dip: 0.3, fade: 0.05, keys: [[0.06, [-0.3, 0.22, 0.3]], [0.13, [0.02, 0.06, 0.62]], [0.22, [0.4, -0.1, 0.42]]] },
  slashRight: { time: 0.44, item: 'knife', dip: 0.3, fade: 0.05, keys: [[0.06, [0.42, 0.24, 0.26]], [0.13, [0.1, 0.06, 0.62]], [0.22, [-0.28, -0.08, 0.46]]] },
  stab: { time: 0.46, item: 'knife', dip: 0.3, fade: 0.05, keys: [[0.08, [0.2, 0.0, 0.18]], [0.15, [0.06, 0.05, 0.74]], [0.24, [0.06, 0.03, 0.7]]] },
  // a grenade, overhand on the free (left) side: held low while the pin comes out, swung back and up beside the
  // head, over and forward to let go high in front, then down and across in the follow-through
  throw: { time: THROW.time, item: 'grenade', release: THROW.release, dip: 0.45, fade: 0.1, keys: [[0.12, [0.18, -0.12, 0.3]], [THROW.pin, [0.2, -0.06, 0.3]], [THROW.release - 0.12, [0.34, 0.48, -0.3]], [THROW.release, [0.24, 0.6, 0.38]], [THROW.release + 0.12, [0.08, 0.18, 0.62]], [0.8, [0.0, -0.14, 0.45]]] },
  // a heal or a charger, worked at the chest until it's done (stop)
  use: { time: Infinity, dip: 0.55, fade: 0.2, keys: [[0.25, [0.06, -0.08, 0.3]]] },
};
const FOLLOW = 0.025; // the hand chases its path on a spring this tight (s), so one action cut by the next never jumps

const ss = THREE.MathUtils.smoothstep;
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _y = new THREE.Vector3(0, 1, 0), ONE = new THREE.Vector3(1, 1, 1);

/** Catmull-Rom through the keys at time t (held at the ends). */
function along(keys, t, out) {
  if (t <= keys[0][0]) return out.fromArray(keys[0][1]);
  const n = keys.length;
  if (t >= keys[n - 1][0]) return out.fromArray(keys[n - 1][1]);
  let i = 0;
  while (keys[i + 1][0] < t) i++;
  const P = (j) => keys[Math.max(0, Math.min(n - 1, j))][1];
  const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
  const u = (t - keys[i][0]) / (keys[i + 1][0] - keys[i][0]), u2 = u * u, u3 = u2 * u;
  return out.set(...[0, 1, 2].map((c) => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * u + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * u2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * u3)));
}

export class HandActs {
  /** hand: the left hand bone, which carries the item. */
  constructor(hand) {
    this.hand = hand;
    this.cur = null; // { def, t, item, stopT }
    this.models = new Map();
    this.matrix = new THREE.Matrix4();
    this.k = 0;
    this.dip = 0;
    this.rot = false; // the hand keeps the gun grip's turn, only its place follows the path
    this.kS = new Spring();
    this.pS = [new Spring(), new Spring(), new Spring()];
    this.fresh = true; // no place to chase from yet
  }

  act(name, item) {
    const def = ACTS[name];
    if (!def) return;
    this.cur = { def, t: 0, item: def.item ?? item, stopT: null };
  }

  stop() { if (this.cur && this.cur.stopT === null) this.cur.stopT = this.cur.t; }

  /** Drop it all at once (death). */
  clear() { this.cur = null; this.k = this.dip = 0; this.kS.snap(0); this.fresh = true; this.#item(null); }

  update(dt, chest, yaw) {
    const c = this.cur;
    let goal = 0;
    if (c) {
      c.t += dt;
      const { def, t } = c;
      // onto the path and off it again over def.fade (s): a knife is quick, a heal unhurried
      const F = def.fade;
      let k = ss(t, 0, F);
      if (def.time !== Infinity) k *= 1 - ss(t, def.time - F, def.time);
      if (c.stopT !== null) k *= 1 - ss(t - c.stopT, 0, F);
      if (k <= 0 && t > F) this.cur = null;
      else {
        goal = k;
        along(def.keys, t, _p).applyQuaternion(_q.setFromAxisAngle(_y, yaw)).add(chest);
        if (def === ACTS.use) _p.y += Math.sin(t * 13) * 0.008; // working the bandage, the charger
        if (this.fresh) { this.pS.forEach((s, i) => s.snap(_p.getComponent(i))); this.fresh = false; }
        this.pS.forEach((s, i) => _p.setComponent(i, s.to(_p.getComponent(i), FOLLOW, dt)));
        this.matrix.compose(_p, _q, ONE);
        this.dip = k * def.dip;
      }
    }
    this.k = this.kS.to(goal, FOLLOW, dt);
    if (this.k < 0.002 && !this.cur) { this.k = 0; this.dip = 0; this.fresh = true; }
    this.#item(c && this.k > 0.05 && (!c.def.release || c.t < c.def.release) ? c.item : null);
    return this;
  }

  /** The item in the hand (built once per kind). */
  #item(id) {
    if (id === this.shown) return;
    if (this.shown) this.models.get(this.shown).visible = false;
    this.shown = id;
    if (!id) return;
    let m = this.models.get(id);
    if (!m) {
      const g = id === 'knife' ? buildKnife() : ITEMS[id]?.build();
      if (!g) return;
      m = new THREE.Group();
      m.add(g);
      // in the fist: the knife blade-forward, everything else held in the palm
      if (id === 'knife') g.rotation.set(Math.PI / 2, 0, 0);
      else g.position.set(0, -0.03, 0.05);
      this.hand.add(m);
      this.models.set(id, m);
    }
    m.visible = true;
  }
}
