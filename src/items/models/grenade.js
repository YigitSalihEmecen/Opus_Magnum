import * as THREE from 'three';
import { ITEM_MATS as M, rbox, cyl, add } from './kit.js';

/*
  Frag grenade — a lathed body (flat foot, full belly, sloping shoulders, neck) in olive drab, cut into
  segments by two ink grooves with a clay band at the waist; a steel fuse head, the spoon lying along the
  shoulder and belly, and a brass pull ring. 10 cm tall. Origin at the bottom; parts.pin / parts.spoon come
  off when it's thrown.
*/

// body profile [radius, height]
const PROFILE = [[0, 0], [0.021, 0], [0.029, 0.005], [0.034, 0.016], [0.036, 0.032], [0.0355, 0.046], [0.033, 0.06], [0.027, 0.071], [0.018, 0.079], [0.012, 0.083], [0, 0.083]];
const radiusAt = (y) => {
  for (let i = 1; i < PROFILE.length; i++) {
    const [r0, y0] = PROFILE[i - 1], [r1, y1] = PROFILE[i];
    if (y <= y1 && y1 > y0) return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
  }
  return 0;
};

/** A box laid from point a to point b in the YZ plane (x = 0), sitting just off the body. */
function strip(g, [ya, za], [yb, zb], w, t, mat) {
  const len = Math.hypot(yb - ya, zb - za);
  const m = add(g, rbox(w, len, t, Math.min(0.003, t / 2)), mat, 0, (ya + yb) / 2, (za + zb) / 2);
  m.rotation.x = Math.atan2(zb - za, yb - ya); // +Y of the box runs from a to b
  return m;
}

export function buildGrenade() {
  const g = new THREE.Group();
  g.name = 'grenade';
  add(g, new THREE.LatheGeometry(PROFILE.map(([r, y]) => new THREE.Vector2(r, y)), 28), M.drab);
  // segment grooves and the waist band
  for (const y of [0.018, 0.062]) {
    const groove = add(g, new THREE.TorusGeometry(radiusAt(y), 0.0016, 6, 32), M.ink, 0, y, 0);
    groove.rotation.x = Math.PI / 2;
  }
  add(g, cyl(0.0372, 0.034, 0.046, 28), M.clay);
  const top = 0.083;
  add(g, cyl(0.013, top - 0.004, top + 0.013, 16), M.steel);

  // spoon: a cap over the fuse head, then two flat segments following the shoulder and belly
  const spoon = new THREE.Group();
  g.add(spoon);
  add(spoon, rbox(0.016, 0.007, 0.03, 0.003), M.alloy, 0, top + 0.015, -0.008);
  const off = 0.0045; // gap between the spoon's centre line and the body surface
  const p0 = [top + 0.012, -0.022], p1 = [0.06, -(radiusAt(0.06) + off)], p2 = [0.03, -(radiusAt(0.03) + off)];
  strip(spoon, p0, p1, 0.014, 0.005, M.alloy);
  strip(spoon, p1, p2, 0.014, 0.005, M.alloy);

  const pin = new THREE.Group();
  pin.position.set(0.016, top + 0.006, 0);
  g.add(pin);
  const ring = add(pin, new THREE.TorusGeometry(0.011, 0.0025, 8, 20), M.brass, 0.012, 0, 0);
  ring.rotation.y = Math.PI / 2;
  g.userData.parts = { pin, spoon };
  return g;
}
