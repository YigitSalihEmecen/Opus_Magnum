import * as THREE from 'three';
import { MATS, profile, rbox, tube, gunKit, shotShell } from './parts.js';

/*
  "Bison" double-barrel shotgun — procedural model. Same gun space as the other guns (trigger at f 0.036) and,
  like the Grizzly, no pistol grip: the right hand holds the stock's wrist. A wide receiver with ivory slats
  and a red top lever, an angular stock with a grooved red wrist panel and a rubber butt; the two barrels sit
  side by side in a big shroud with a finned top and slotted nose, and a caddy of four spare shells rides on
  its right side. Red is this gun's accent.
  The barrels, shroud and caddy are the `hinge` part: it pivots at the front of the receiver and the
  viewmodel breaks it open for the reload (rotation about +X, muzzle down). `rounds` are the two shell heads
  in the breech.

   butt ┬ stock ── wrist ┬ receiver ┬ hinge ─ shroud + caddy ──────────────┬ nose
  -0.38                -0.03       0.15                                    0.6  0.64   (f, metres)
*/

const BORE = 0.028;
const HINGE = { f: 0.152, y: -0.014 };
const GAP = 0.0125; // barrel centres at x = ±GAP

export function buildBison() {
  const root = new THREE.Group();
  root.name = 'bison';
  const k = gunKit(root);
  const { add, at } = k;
  const round = (bevel, segments = 3) => ({ bevel, segments, inset: true });

  // ── receiver: wide block, red trim, five ivory slats a side, top lever, trigger housing ──
  add(profile([[-0.03, -0.022], [0.152, -0.022], [0.152, 0.052], [0.14, 0.062], [-0.012, 0.062], [-0.03, 0.05]], 0.064, round(0.007)), MATS.black);
  add(profile([[-0.022, 0.044], [0.144, 0.044], [0.144, 0.048], [-0.022, 0.048]], 0.0655, { bevel: 0.001 }), MATS.red);
  for (let i = 0; i < 5; i++) {
    for (const s of [-1, 1]) {
      const slat = at(add(rbox(0.003, 0.03, 0.009, 0.0015), MATS.ivory), s * 0.0325, 0.012, 0.03 + i * 0.022);
      slat.rotation.x = 0.45;
    }
  }
  at(add(rbox(0.06, 0.008, 0.11, 0.003), MATS.poly), 0, -0.022, 0.07);
  const { trigger, selector } = k.fireControls();
  selector.visible = false;
  const lever = k.group('lever', 0, 0.064, -0.01);
  at(add(rbox(0.014, 0.006, 0.05, 0.002), MATS.steel, lever), 0, 0, -0.01);
  at(add(rbox(0.012, 0.01, 0.014, 0.003), MATS.red, lever), 0, 0.004, -0.03);
  for (const [y, f] of [[0.03, 0.0], [-0.008, 0.13]]) for (const s of [-1, 1]) at(add(new THREE.CylinderGeometry(0.003, 0.003, 0.002, 10).rotateZ(Math.PI / 2), MATS.steel), s * 0.0325, y, f);

  // ── stock: angular body with a straight comb, grooved red wrist panels inlaid on its flat faces, rubber butt ──
  add(profile([
    [-0.028, 0.052], [-0.07, 0.042], [-0.12, 0.036], [-0.36, 0.04], [-0.372, 0.034], [-0.372, -0.088], [-0.36, -0.096],
    [-0.25, -0.074], [-0.14, -0.058], [-0.085, -0.046], [-0.04, -0.036], [-0.016, -0.036], [-0.016, -0.02], [-0.028, -0.02],
  ], 0.046, round(0.008, 4)), MATS.poly);
  const inlay = (points, mat, x) => add(profile(points, 0.002, { bevel: 0.0006, segments: 1 }), mat).position.x = x;
  for (const s of [-1, 1]) {
    inlay([[-0.04, -0.026], [-0.13, -0.046], [-0.14, 0.024], [-0.05, 0.028]], MATS.red, s * 0.0232);
    for (let i = 0; i < 4; i++) {
      const fc = -0.064 - i * 0.02;
      inlay([[fc + 0.012, -0.022], [fc + 0.017, -0.022], [fc - 0.001, 0.016], [fc - 0.006, 0.016]], MATS.black, s * 0.0244);
    }
  }
  at(add(rbox(0.048, 0.134, 0.014, 0.005), MATS.rubber), 0, -0.028, -0.378);
  at(add(rbox(0.0485, 0.01, 0.0145, 0.003), MATS.red), 0, 0.022, -0.378);

  // ── the hinge: everything forward of the receiver, authored in gun space inside an offset group ──
  const hinge = k.group('hinge', 0, HINGE.y, HINGE.f);
  const inner = new THREE.Group();
  inner.position.set(0, -HINGE.y, -hinge.position.z);
  hinge.add(inner);
  const h = gunKit(inner);

  // barrels side by side, breech face with the two shell heads
  for (const s of [-1, 1]) {
    h.at(h.add(tube(0.0115, 0.0105, HINGE.f, 0.62, 18), MATS.steel), s * GAP, BORE, 0);
    h.add(new THREE.CircleGeometry(0.0085, 16).rotateY(Math.PI), MATS.vent).position.set(s * GAP, BORE, -0.6405);
  }
  h.at(h.add(rbox(0.054, 0.05, 0.012, 0.004), MATS.steel), 0, BORE, HINGE.f + 0.006); // breech block
  const rounds = h.group('rounds', 0, BORE, HINGE.f);
  for (const s of [-1, 1]) {
    const head = h.add(tube(0.0098, 0.0098, -0.002, 0.003, 16), MATS.brass, rounds);
    head.position.x = s * GAP;
    h.add(new THREE.CircleGeometry(0.003, 12), MATS.copper, rounds).position.set(s * GAP, 0, 0.0031);
  }

  // shroud: big block with a finned top, long recessed side vents, a slotted nose and a front spike
  h.add(profile([[0.158, -0.02], [0.6, -0.02], [0.64, 0.002], [0.64, 0.058], [0.62, 0.072], [0.158, 0.072]], 0.066, round(0.007)), MATS.black);
  for (const f of [0.34, 0.46]) for (const s of [-1, 1]) {
    h.at(h.add(rbox(0.003, 0.03, 0.1, 0.006), MATS.vent), s * 0.0331, 0.02, f);
    for (let i = 0; i < 4; i++) h.at(h.add(rbox(0.004, 0.026, 0.006, 0.0015), MATS.steel), s * 0.0332, 0.02, f - 0.036 + i * 0.024);
  }
  for (let f = 0.2; f < 0.5; f += 0.016) h.at(h.add(rbox(0.05, 0.008, 0.005, 0.0015), MATS.steel), 0, 0.075, f);
  h.at(h.add(rbox(0.06, 0.005, 0.32, 0.002), MATS.poly), 0, 0.071, 0.35);
  for (const s of [-1, 1]) {
    h.at(h.add(rbox(0.002, 0.004, 0.42, 0.0015), MATS.red), s * 0.0332, 0.058, 0.38);
    for (let i = 0; i < 4; i++) h.at(h.add(rbox(0.003, 0.04, 0.007, 0.0015), MATS.vent), s * 0.0335, 0.026, 0.548 + i * 0.016);
  }
  h.at(h.add(rbox(0.068, 0.01, 0.016, 0.003), MATS.red), 0, 0.068, 0.172);
  const spike = h.add(new THREE.ConeGeometry(0.008, 0.03, 4), MATS.steel);
  h.at(spike, 0, 0.088, 0.6).rotation.x = -0.5;

  // caddy on the right flank: a holder block the four spare shells sit in, only their brass heads showing,
  // red bands between the loops
  h.at(h.add(rbox(0.03, 0.03, 0.112, 0.005), MATS.poly), 0.047, 0.012, 0.25);
  for (let i = 0; i < 4; i++) {
    const sh = shotShell();
    sh.rotation.y = Math.PI / 2; // brass head toward +x, hull buried in the holder
    h.at(sh, 0.036, 0.012, 0.211 + i * 0.026);
    inner.add(sh);
    if (i) h.at(h.add(rbox(0.031, 0.031, 0.003, 0.001), MATS.red), 0.047, 0.012, 0.198 + i * 0.026);
  }

  // ── rail on the receiver (stays put when the gun breaks open), irons ──
  k.topRail(-0.02, 0.14, 0.0625);
  const irons = k.ironSights(-0.012, 0.13, 0.0725);

  const bolt = k.group('bolt', 0, 0, 0), chargingHandle = k.group('chargingHandle', 0, 0, 0);
  return {
    root,
    parts: {
      muzzleMount: h.group('muzzleMount', 0, BORE, 0.64),
      scopeMount: k.group('scopeMount', 0, 0.0725, 0.06),
      ejectPort: h.group('ejectPort', 0, BORE, HINGE.f + 0.01),
      hinge, rounds, lever,
      bolt, chargingHandle, trigger, selector, ...irons,
    },
  };
}
