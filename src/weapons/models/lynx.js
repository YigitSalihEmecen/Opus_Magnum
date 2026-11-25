import * as THREE from 'three';
import { MATS, profile, rbox, tube, gunKit } from './parts.js';
import { PALETTE as P, toon } from '../../core/toon.js';

/*
  "Lynx" pistol — procedural model. Same gun space and grip origin as the long guns, so the
  right hand and trigger line up. A steel slide (the `chargingHandle` part: it recoils on every
  shot and locks back on empty) runs on a dark polymer frame and disappears into a sand-coloured
  front shroud with notched skirts; the barrel (the `bolt` part) tilts back a few millimetres.

   beavertail ┬ slide ──────────┬ shroud ┬ crown
   -0.08     -0.077            0.114    0.188 0.193  (f, metres, before SCALE)
*/

const BORE = 0.022;
// Authored at a comfortable modelling size, then shrunk so it reads as a handgun in the glove
// (≈ 21 cm long, 14 cm tall). Mounts and parts live inside the scaled body; the viewmodel
// works in root space, so only the iron-sight point needs the factor.
const SCALE = 0.78;
const SAND = toon(P.manilla, { rim: 0.15 });

export function buildLynx() {
  const root = new THREE.Group();
  root.name = 'lynx';
  const body = new THREE.Group();
  body.scale.setScalar(SCALE);
  root.add(body);
  const k = gunKit(body);
  const { add, at } = k;

  // ── slide (recoils): wide base block + narrower, deeply rounded top block, raised side cheeks ──
  const slide = k.group('slide', 0, 0, 0);
  add(profile([[-0.077, 0.003], [0.152, 0.003], [0.152, 0.028], [-0.077, 0.028]], 0.05, { bevel: 0.004 }), MATS.steel, slide);
  add(profile([[-0.077, 0.022], [0.152, 0.022], [0.152, 0.038], [0.142, 0.048], [-0.066, 0.048], [-0.077, 0.038]], 0.04, { bevel: 0.009, segments: 3, inset: true }), MATS.steel, slide);
  add(profile([[-0.04, 0.008], [0.022, 0.008], [0.028, 0.016], [0.022, 0.024], [-0.04, 0.024]], 0.054, { bevel: 0.002 }), MATS.black, slide);
  for (const f of [-0.066, -0.056, -0.046]) at(add(rbox(0.0525, 0.018, 0.005, 0.002), MATS.vent, slide), 0, 0.015, f);
  at(add(rbox(0.046, 0.04, 0.01, 0.004), MATS.black, slide), 0, 0.024, -0.077);
  at(add(rbox(0.047, 0.008, 0.011, 0.002), MATS.accent, slide), 0, 0.01, -0.077);
  at(add(rbox(0.02, 0.004, 0.05, 0.0015), MATS.vent, slide), 0, 0.0478, 0.06);
  // ejection port (right) with the barrel hood showing
  at(add(rbox(0.004, 0.018, 0.042, 0.0015), MATS.vent, slide), 0.0252, 0.015, 0.055);
  at(add(rbox(0.004, 0.012, 0.03, 0.0015), MATS.accent, slide), 0.026, 0.016, 0.057);
  const ejectPort = k.group('ejectPort', 0.029, 0.017, 0.055, slide);
  // rear sight rides the slide; front sight sits on the shroud
  const ironRear = k.group('ironRear', 0, 0.048, -0.064, slide);
  at(add(rbox(0.034, 0.008, 0.014, 0.003), MATS.black, ironRear), 0, 0.004, 0);
  for (const x of [-0.0085, 0.0085]) at(add(rbox(0.01, 0.011, 0.012, 0.002), MATS.black, ironRear), x, 0.01, 0);

  // ── barrel (tilts back a little with each shot) ──
  const bolt = k.group('barrel', 0, 0, 0);
  add(tube(0.0078, 0.0078, 0.13, 0.193, 16), MATS.steel, bolt).position.y = BORE;
  add(tube(0.0088, 0.0088, 0.185, 0.193, 16), MATS.black, bolt).position.y = BORE;

  // ── frame and fire controls ──
  add(profile([[-0.06, 0.003], [0.114, 0.003], [0.114, -0.026], [0.104, -0.034], [-0.012, -0.034], [-0.05, -0.026]], 0.046, { bevel: 0.006, segments: 3, inset: true }), MATS.poly);
  const { trigger, selector } = k.fireControls();
  selector.position.x = -0.025;
  at(add(rbox(0.005, 0.009, 0.034, 0.003), MATS.steel), -0.0245, -0.002, 0.03);

  // ── front shroud (sand): notched lower block, rounded upper block, recessed black side panels ──
  const notch = (f) => [[f + 0.012, -0.036], [f + 0.012, -0.022], [f + 0.003, -0.022], [f, -0.036]];
  add(profile([
    [0.188, -0.036], ...notch(0.164), ...notch(0.14), [0.1, -0.036], [0.1, 0.004], [0.114, 0.004],
    [0.114, 0.03], [0.188, 0.03],
  ], 0.058, { bevel: 0.005 }), SAND);
  add(profile([[0.114, 0.024], [0.188, 0.024], [0.188, 0.042], [0.178, 0.054], [0.124, 0.054], [0.114, 0.042]], 0.048, { bevel: 0.01, segments: 3, inset: true }), SAND);
  add(profile([[0.124, -0.014], [0.176, -0.014], [0.182, -0.006], [0.182, 0.018], [0.124, 0.018]], 0.0605, { bevel: 0.002 }), MATS.black);
  at(add(rbox(0.059, 0.012, 0.012, 0.004), MATS.accent), 0, 0.012, 0.117);
  add(new THREE.CircleGeometry(0.0135, 24).rotateY(Math.PI), MATS.vent).position.set(0, BORE, -0.1882);
  const ironFront = k.group('ironFront', 0, 0.05, 0.172);
  at(add(rbox(0.007, 0.011, 0.009, 0.002), MATS.black, ironFront), 0, 0.005, 0);
  at(add(rbox(0.0072, 0.004, 0.0094, 0.0012), MATS.accent, ironFront), 0, 0.0095, 0);

  // ── grip: oval tube sized for the glove (≈ 3 × 4.4 × 9 cm in the hand), raked like the magazine ──
  // axis from just inside the frame (f -0.023, y -0.005) down/back to the base (f -0.043, y -0.116)
  const RAKE = -0.178, GRIP_H = 0.113, GX = 0.0195, GZ = 0.028;
  const gripMid = (y) => [-0.023 - 0.02 * y, -0.005 - 0.111 * y]; // y: 0 top → 1 base
  const oval = (rx, rz, h, t, mat, open = false, theta = [0, Math.PI * 2]) => {
    const m = add(new THREE.CylinderGeometry(1, 1, h, 32, 1, open, theta[0], theta[1]), mat);
    const [f, y] = gripMid(t);
    at(m, 0, y, f);
    m.scale.set(rx, 1, rz);
    m.rotation.x = RAKE;
    return m;
  };
  oval(GX, GZ, GRIP_H, 0.5, MATS.poly);
  for (const c of [Math.PI / 2, -Math.PI / 2]) oval(GX + 0.0012, GZ + 0.0012, 0.066, 0.56, MATS.black, true, [c - 0.85, 1.7]); // stipple bands
  oval(GX + 0.0012, GZ + 0.0012, 0.016, 0.2, MATS.accent, true, [-0.55, 1.1]); // backstrap insert
  oval(GX + 0.004, GZ + 0.004, 0.01, 0.97, MATS.black); // flared base
  // beavertail over the web of the hand
  add(profile([[-0.044, -0.014], [-0.064, -0.012], [-0.079, -0.003], [-0.078, 0.003], [-0.04, 0.003]], 0.036, { bevel: 0.007, segments: 3, inset: true }), MATS.poly);


  const magSocket = k.group('magSocket', 0, -0.028, -0.022);
  magSocket.rotation.x = -0.2;

  return {
    root,
    parts: {
      magSocket,
      muzzleMount: k.group('muzzleMount', 0, BORE, 0.193),
      // optic plate on the frame just over the slide top, so the slide cycles under a still sight
      scopeMount: k.group('scopeMount', 0, 0.049, 0.035),
      stockMount: k.group('stockMount', 0, 0, 0),
      bolt, chargingHandle: slide, trigger, selector, ejectPort,
      ironRear, ironFront, ironSight: new THREE.Vector3(0, 0.0585, 0.064).multiplyScalar(SCALE),
    },
  };
}
