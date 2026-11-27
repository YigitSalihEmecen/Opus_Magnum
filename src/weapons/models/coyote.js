import * as THREE from 'three';
import { MATS, profile, rbox, tube, gunKit } from './parts.js';

/*
  "Coyote" bolt-action scout rifle — procedural model. Same gun space as the other guns (trigger at f 0.036).
  Shorter and lighter than the Kestrel: a round steel receiver bedded in a one-piece flat-dark-earth sporter stock
  (a grip swept down out of the wrist, comb riser, forend) with black inlays, a long one-piece scout rail running out
  over the barrel, a short heavy barrel with a brake. The bolt is the `bolt` part, worked like the Kestrel's.

   butt ┬ stock ┬ receiver ┬ forend ─────────┬ barrel ┬ (muzzle slot)
  -0.4         -0.08       0.2              0.53     0.7    (f, metres)
                        scout rail -0.06 ─ 0.42
*/

const BORE = 0.036;
const BOLT_Y = 0.046;

export function buildCoyote() {
  const root = new THREE.Group();
  root.name = 'coyote';
  const k = gunKit(root);
  const { add, at } = k;
  const round = (bevel, segments = 3) => ({ bevel, segments, inset: true });

  // ── receiver: round steel action in the stock, bolt slot and port on the right ──
  at(add(tube(0.029, 0.029, -0.08, 0.2, 24), MATS.steel), 0, 0.036, 0);
  add(new THREE.CircleGeometry(0.029, 24), MATS.steel).position.set(0, 0.036, 0.08);
  // slot and port sit on the tube's surface at the bolt's height (x = √(r² − dy²)), not out at the equator
  const skin = Math.sqrt(0.029 ** 2 - (BOLT_Y - 0.036) ** 2) - 0.0008;
  at(add(rbox(0.003, 0.011, 0.1, 0.002), MATS.vent), skin, BOLT_Y, -0.04); // handle slot
  at(add(rbox(0.003, 0.016, 0.064, 0.002), MATS.vent), skin, BOLT_Y, 0.08); // ejection port
  const ejectPort = k.group('ejectPort', 0.033, BOLT_Y, 0.08);

  // ── bolt: carrier in the port, a handle swept out and down, a big black knob ──
  const bolt = k.group('bolt', 0, BOLT_Y, -0.012);
  at(add(rbox(0.006, 0.013, 0.056, 0.002), MATS.steel, bolt), 0.026, 0, 0.09);
  const stem = at(add(new THREE.CylinderGeometry(0.0045, 0.004, 0.046, 12).rotateZ(Math.PI / 2), MATS.steel, bolt), 0.048, -0.005, 0);
  stem.rotation.z = -0.25;
  const knob = at(add(new THREE.SphereGeometry(0.012, 18, 12), MATS.black, bolt), 0.072, -0.011, 0);
  knob.scale.set(1, 1, 0.85);

  // ── one-piece stock: butt, comb, wrist, action bed and forend; a narrower grip swept down out of the wrist ──
  add(profile([
    [0.52, 0.03], [0.53, 0.016], [0.52, -0.01], [0.48, -0.026], [0.2, -0.04], [0.17, -0.046], [0.05, -0.046], [0.03, -0.036],
    [-0.012, -0.034], [-0.06, -0.034], [-0.11, -0.05], [-0.2, -0.072], [-0.38, -0.106], [-0.396, -0.1], [-0.396, 0.054], [-0.38, 0.062],
    [-0.16, 0.058], [-0.1, 0.052], [-0.07, 0.03], [0.2, 0.018], [0.48, 0.03],
  ], 0.05, round(0.009, 4)), MATS.tan);
  add(profile([
    [0.012, -0.026], [0.004, -0.06], [-0.004, -0.096], [-0.014, -0.128], [-0.026, -0.148], [-0.05, -0.156], [-0.074, -0.148],
    [-0.07, -0.12], [-0.066, -0.09], [-0.074, -0.062], [-0.11, -0.046], [-0.06, -0.03], [-0.02, -0.03],
  ], 0.036, round(0.01, 4)), MATS.tan);
  const { trigger, selector } = k.fireControls(MATS.black);
  // black inlays on the flat faces (kept inside the rounded edges): grip stipple panels, forend panels
  const inlay = (points, x) => add(profile(points, 0.002, { bevel: 0.0006, segments: 1 }), MATS.black).position.x = x;
  for (const s of [-1, 1]) {
    inlay([[-0.012, -0.056], [-0.02, -0.11], [-0.032, -0.13], [-0.056, -0.134], [-0.058, -0.1], [-0.054, -0.07], [-0.03, -0.054]], s * 0.0182);
    inlay([[0.24, -0.026], [0.46, -0.016], [0.46, 0.012], [0.24, 0.006]], s * 0.0252);
  }
  // adjustable comb riser, rubber butt pad, sling swivel under the forend
  add(profile([[-0.12, 0.054], [-0.15, 0.072], [-0.33, 0.074], [-0.35, 0.062], [-0.35, 0.05], [-0.12, 0.046]], 0.044, round(0.006)), MATS.black);
  at(add(rbox(0.05, 0.156, 0.016, 0.006), MATS.rubber), 0, -0.023, -0.404);
  at(add(new THREE.TorusGeometry(0.008, 0.0024, 8, 16).rotateY(Math.PI / 2), MATS.steel), 0, -0.04, 0.44).rotation.z = Math.PI / 2;

  // ── barrel, brake shoulder, long scout rail ──
  add(tube(0.0145, 0.0128, 0.2, 0.7), MATS.steel).position.y = BORE;
  at(add(tube(0.0155, 0.0155, 0.664, 0.68), MATS.black), 0, BORE, 0);
  add(profile([[-0.06, 0.058], [0.42, 0.058], [0.42, 0.068], [-0.06, 0.068]], 0.02, { bevel: 0.0015 }), MATS.black); // rail riser
  k.topRail(-0.06, 0.42, 0.0705);
  const irons = k.ironSights(-0.045, 0.4, 0.0805);

  return {
    root,
    parts: {
      magSocket: k.group('magSocket', 0, -0.044, 0.11),
      muzzleMount: k.group('muzzleMount', 0, BORE, 0.7),
      scopeMount: k.group('scopeMount', 0, 0.0805, 0.07),
      chargingHandle: k.group('chargingHandle', 0, 0, 0),
      bolt, trigger, selector, ejectPort, ...irons,
    },
  };
}
