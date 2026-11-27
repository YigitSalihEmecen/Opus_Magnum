import * as THREE from 'three';
import { MATS, profile, rbox, tube, gunKit } from './parts.js';

/*
  "Hornet" SMG — procedural model. Same gun space and grip origin as the other guns. A long flat upper with a
  full-length rail sits over the low-slung front: the barrel runs under the upper in its own short shroud (with a
  rail underneath for a grip), and the big slanted lower housing drops from it to a straight magwell in front of
  the trigger. Amber is this gun's accent.

   stock ┬ upper (flat, railed) ────────────────────────────┬
  -0.13  -0.1                                               0.32
                  pistol grip ╲   ╱ slanted housing ┬ low shroud ── barrel
                               ╲_╱ magwell 0.07–0.15 0.2–0.38    0.41   (f, metres)
*/

const SCALE = 0.85;
const BORE = -0.026;

export function buildHornet() {
  const root = new THREE.Group();
  root.name = 'hornet';
  const body = new THREE.Group();
  body.scale.setScalar(SCALE);
  root.add(body);
  const k = gunKit(body);
  const { add, at } = k;
  const round = (bevel, segments = 3) => ({ bevel, segments, inset: true });

  // ── upper: long flat block with a chamfered nose, amber pinstripe, port + bolt, charging handle ──
  add(profile([[-0.1, 0], [0.32, 0], [0.32, 0.046], [0.306, 0.058], [-0.088, 0.058], [-0.1, 0.048]], 0.046, round(0.005)), MATS.poly);
  for (const s of [-1, 1]) at(add(rbox(0.002, 0.004, 0.32, 0.001), MATS.amber), s * 0.0232, 0.034, 0.12);
  for (const f of [0.2, 0.235, 0.27]) for (const s of [-1, 1]) at(add(rbox(0.002, 0.014, 0.018, 0.002), MATS.vent), s * 0.0232, 0.017, f);
  const { bolt, ejectPort } = k.boltAndPort(0.08, 0.026, 0.05, 0.0235);
  const chargingHandle = k.chargingHandle(0.29, 0.046, 0.11, -0.023);

  // ── low front: barrel shroud under the upper, a rail on its belly, the barrel ──
  add(profile([[0.19, -0.066], [0.37, -0.066], [0.382, -0.054], [0.382, 0.002], [0.19, 0.002]], 0.04, round(0.005)), MATS.black);
  for (const f of [0.26, 0.3, 0.34]) for (const s of [-1, 1]) at(add(rbox(0.002, 0.026, 0.022, 0.003), MATS.vent), s * 0.0202, -0.028, f);
  at(add(rbox(0.041, 0.006, 0.012, 0.002), MATS.amber), 0, -0.004, 0.375);
  const rail = [];
  for (let f = 0.25; f <= 0.36; f += 0.01) rail.push(f);
  at(add(rbox(0.022, 0.006, 0.12, 0.0015), MATS.black), 0, -0.069, 0.305);
  for (const f of rail) at(add(new THREE.BoxGeometry(0.025, 0.004, 0.0055), MATS.black), 0, -0.073, f);
  add(tube(0.0085, 0.0085, 0.38, 0.41), MATS.steel).position.y = BORE;

  // ── slanted lower housing: the gun's signature wedge from the shroud down to the magwell ──
  add(profile([[-0.04, 0.002], [0.2, 0.002], [0.2, -0.03], [0.156, -0.128], [0.068, -0.128], [0.05, -0.098], [0.042, -0.04], [-0.01, -0.034], [-0.04, -0.022]], 0.05, round(0.006)), MATS.poly);
  // side inlays on the housing's flat faces (kept inside its rounded edges): a dark panel and an amber stripe
  // running parallel to the slanted front
  for (const s of [-1, 1]) {
    add(profile([[0.118, -0.036], [0.174, -0.036], [0.14, -0.11], [0.096, -0.11], [0.09, -0.098]], 0.002, { bevel: 0.0006, segments: 1 }), MATS.black).position.x = s * 0.0251;
    add(profile([[0.182, -0.036], [0.19, -0.036], [0.154, -0.114], [0.146, -0.114]], 0.002, { bevel: 0.0006, segments: 1 }), MATS.amber).position.x = s * 0.0251;
  }
  for (const [y, f] of [[-0.012, -0.025], [-0.012, 0.17], [-0.1, 0.09]]) for (const s of [-1, 1]) at(add(new THREE.CylinderGeometry(0.0034, 0.0034, 0.002, 12).rotateZ(Math.PI / 2), MATS.steel), s * 0.0258, y, f);
  // magwell lip
  at(add(rbox(0.054, 0.014, 0.094, 0.004), MATS.black), 0, -0.133, 0.112);
  at(add(rbox(0.055, 0.005, 0.03, 0.002), MATS.amber), 0, -0.136, 0.145);

  // ── fire controls, pistol grip, a big guard loop from the housing to the grip's foot ──
  const { trigger, selector } = k.fireControls();
  k.pistolGrip(MATS.poly, MATS.black);
  add(profile([[0.05, -0.1], [0.06, -0.106], [-0.04, -0.15], [-0.05, -0.142]], 0.016, round(0.004)), MATS.poly);

  // ── rear cap + stock adapter, sling loop ──
  at(add(rbox(0.046, 0.05, 0.03, 0.006), MATS.black), 0, 0.028, -0.113);
  at(add(rbox(0.0465, 0.006, 0.026, 0.002), MATS.amber), 0, 0.01, -0.113);
  at(add(new THREE.TorusGeometry(0.007, 0.002, 8, 16).rotateY(Math.PI / 2), MATS.steel), -0.026, 0.014, -0.1);

  k.topRail(-0.09, 0.31, 0.0645);
  const irons = k.ironSights(-0.08, 0.29, 0.0745);
  irons.ironSight.multiplyScalar(SCALE);

  const muzzleMount = k.group('muzzleMount', 0, BORE, 0.41);
  muzzleMount.scale.setScalar(0.75);
  const scopeMount = k.group('scopeMount', 0, 0.0745, 0.04);
  scopeMount.scale.setScalar(0.92);
  // rifle stocks are authored from f -0.12 back: scaled down and butted against the rear cap
  const STOCK_SCALE = 0.72;
  const stockMount = k.group('stockMount', 0, 0.01, -0.128 + 0.12 * STOCK_SCALE);
  stockMount.scale.setScalar(STOCK_SCALE);
  const gripMount = k.group('gripMount', 0, -0.07, 0.31);
  gripMount.scale.setScalar(0.85);

  return {
    root,
    parts: {
      magSocket: k.group('magSocket', 0, -0.126, 0.112),
      muzzleMount, scopeMount, stockMount, gripMount,
      bolt, chargingHandle, trigger, selector, ejectPort, ...irons,
    },
  };
}
