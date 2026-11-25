import * as THREE from 'three';
import { MATS, profile, rbox, tube, gunKit } from './parts.js';

/*
  "Snake" SMG — procedural model. Same gun space and grip origin as the Panther (so the
  right hand, trigger and selector line up), but a slimmer, shorter frame: it should read
  small in the hand. Built in layers: dark core → olive armour plates with cut-through
  windows → raised inner slabs, top cover, bolt housing, screws.

   stock ┬ core + plates ─────────┬ shroud ┬ barrel
  -0.155 -0.125                   0.2     0.305  0.335   (f, metres)
             pistol grip ╲    ╱ raked foregrip = magwell
                          ╲__╱  brace closes the frame loop
*/

const RAKE = 0.165; // forward rake of the foregrip / magazine (radians)
const slot = (f, y0, y1, w = 0.008, lean = 0.008) => [[f, y0], [f + w, y0], [f + w + lean, y1], [f + lean, y1]];

const SCALE = 0.8;

export function buildSnake() {
  const root = new THREE.Group();
  root.name = 'snake';
  // authored at modelling size, shown 20% smaller so it sits well under the rifle
  const body = new THREE.Group();
  body.scale.setScalar(SCALE);
  root.add(body);
  const k = gunKit(body);
  const { add, at } = k;
  /** Mirrored side plates (outer surface at ±x). */
  const plates = (points, x, mat, opts = {}) => {
    const geo = profile(points, opts.thick ?? 0.006, { bevel: 0.0012, segments: 1, ...opts });
    for (const s of [-1, 1]) add(geo, mat).position.x = s * (x - (opts.thick ?? 0.006) / 2);
  };
  const screws = (list, x) => {
    for (const [y, f] of list) for (const s of [-1, 1]) at(add(new THREE.CylinderGeometry(0.0024, 0.0024, 0.0016, 10).rotateZ(Math.PI / 2), MATS.steel), s * x, y, f);
  };

  // ── receiver: core, top cover, armour plates with windows, inner slabs ──
  add(profile([[-0.15, 0], [0.205, 0], [0.205, 0.05], [0.19, 0.06], [-0.135, 0.06], [-0.15, 0.046]], 0.04, { bevel: 0.003 }), MATS.poly);
  add(profile([[-0.13, 0.057], [0.19, 0.057], [0.184, 0.0645], [-0.124, 0.0645]], 0.03, { bevel: 0.0015 }), MATS.black);
  plates([[-0.125, 0.005], [0.165, 0.005], [0.195, 0.022], [0.195, 0.044], [0.18, 0.055], [-0.1, 0.055], [-0.125, 0.038]], 0.0255, MATS.olive, {
    holes: [
      [[0.05, 0.017], [0.125, 0.017], [0.14, 0.03], [0.125, 0.043], [0.05, 0.043]],
      [[-0.095, 0.016], [-0.05, 0.016], [-0.05, 0.037], [-0.085, 0.037], [-0.095, 0.028]],
    ],
  });
  at(add(rbox(0.0462, 0.02, 0.07, 0.003), MATS.black), 0, 0.03, 0.09);
  at(add(rbox(0.0462, 0.014, 0.036, 0.003), MATS.black), 0, 0.0265, -0.072);
  for (const f of [0.068, 0.084, 0.1]) at(add(rbox(0.0468, 0.012, 0.004, 0.001), MATS.vent), 0, 0.03, f);
  screws([[0.012, -0.112], [0.047, -0.112], [0.012, 0.172], [0.047, 0.165]], 0.0258);

  // bolt housing bulge (right) + port, charging handle (left)
  at(add(rbox(0.009, 0.03, 0.072, 0.003), MATS.black), 0.0285, 0.029, 0.005);
  const { bolt, ejectPort } = k.boltAndPort(0.005, 0.03, 0.05, 0.0335);
  const chargingHandle = k.chargingHandle(0.16, 0.045, 0.08, -0.0265);

  // ── lower frame, fire controls, pistol grip ──
  add(profile([[-0.06, 0.002], [0.2, 0.002], [0.2, -0.024], [0.15, -0.03], [-0.02, -0.032], [-0.06, -0.018]], 0.036, { bevel: 0.003 }), MATS.poly);
  const { trigger, selector } = k.fireControls();
  k.pistolGrip(MATS.poly, MATS.olive);
  at(add(rbox(0.014, 0.012, 0.005, 0.002), MATS.black), 0, -0.034, 0.108); // mag release

  // ── raked foregrip / magwell: core + olive plates with groove cut-outs ──
  add(profile([[0.112, -0.022], [0.19, -0.022], [0.195, -0.04], [0.192, -0.052], [0.199, -0.064], [0.196, -0.076], [0.203, -0.088], [0.2, -0.1], [0.207, -0.112], [0.209, -0.132], [0.15, -0.132], [0.14, -0.09], [0.13, -0.055]], 0.03, { bevel: 0.004 }), MATS.poly);
  const groove = (y) => { const f = 0.15 + (-y - 0.03) * Math.tan(RAKE); return [[f, y], [f + 0.026, y], [f + 0.026, y - 0.0055], [f, y - 0.0055]]; };
  plates([[0.124, -0.03], [0.182, -0.03], [0.19, -0.06], [0.199, -0.122], [0.158, -0.126], [0.146, -0.085], [0.135, -0.05]], 0.0195, MATS.olive, {
    thick: 0.005,
    holes: [-0.058, -0.072, -0.086, -0.1].map(groove),
  });
  const lip = at(add(rbox(0.036, 0.009, 0.064, 0.003), MATS.black), 0, -0.133, 0.18);
  lip.rotation.x = RAKE;
  at(add(rbox(0.037, 0.005, 0.016, 0.002), MATS.accent), 0, -0.134, 0.205);
  // brace closing the frame loop
  add(profile([[-0.044, -0.142], [0.14, -0.108], [0.142, -0.12], [-0.038, -0.158]], 0.018, { bevel: 0.003 }), MATS.poly);

  // ── shroud: core + slotted plates, barrel ──
  add(profile([[0.2, -0.016], [0.29, -0.012], [0.305, 0.004], [0.305, 0.036], [0.29, 0.048], [0.2, 0.052]], 0.03, { bevel: 0.003 }), MATS.poly);
  plates([[0.205, -0.01], [0.286, -0.007], [0.298, 0.006], [0.298, 0.034], [0.286, 0.044], [0.205, 0.047]], 0.0195, MATS.olive, {
    thick: 0.005,
    holes: [0.218, 0.238, 0.258].map((f) => slot(f, 0.004, 0.034)),
  });
  at(add(rbox(0.034, 0.05, 0.007, 0.0025), MATS.black), 0, 0.018, 0.307);
  add(tube(0.0075, 0.0075, 0.3, 0.335), MATS.steel);
  add(tube(0.0095, 0.0095, 0.314, 0.32), MATS.accent);

  // ── rear cap, sling point ──
  at(add(rbox(0.044, 0.056, 0.01, 0.003), MATS.black), 0, 0.028, -0.154);
  at(add(new THREE.TorusGeometry(0.007, 0.002, 8, 16).rotateY(Math.PI / 2), MATS.steel), -0.024, 0.012, -0.14);

  // rail only over the receiver (no overhang past the top cover)
  k.topRail(-0.12, 0.19, 0.0685);
  const irons = k.ironSights(-0.1, 0.175, 0.0785);
  irons.ironSight.multiplyScalar(SCALE); // the viewmodel reads it in root space


  const magSocket = k.group('magSocket', 0, -0.032, 0.158);
  magSocket.rotation.x = RAKE;
  const muzzleMount = k.group('muzzleMount', 0, 0, 0.335);
  muzzleMount.scale.setScalar(0.72);
  const scopeMount = k.group('scopeMount', 0, 0.0785, 0.03);
  scopeMount.scale.setScalar(0.9);
  // rifle stocks are authored from f -0.12 back; scale them down and butt them against the rear cap
  const STOCK_SCALE = 0.72;
  const stockMount = k.group('stockMount', 0, 0.006, -0.155 + 0.12 * STOCK_SCALE);
  stockMount.scale.setScalar(STOCK_SCALE);

  return {
    root,
    parts: {
      magSocket, muzzleMount, scopeMount, stockMount,
      bolt, chargingHandle, trigger, selector, ejectPort, ...irons,
    },
  };
}
