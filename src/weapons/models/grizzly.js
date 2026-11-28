import * as THREE from 'three';
import { MATS, profile, rbox, tube, gunKit } from './parts.js';
import { PALETTE as P, toon } from '../../core/toon.js';

/*
  "Grizzly" pump shotgun — procedural model. Same gun space as the other guns (trigger at f 0.036).
  Built from a few large, rounded blocks (like the Lynx): low receiver with one big steel side
  panel, classic stock with a wrist, barrel stacked over a magazine tube, a grooved pump, three
  shell caddies per side with red shell-cap ends (red is this gun's accent), and a boxy twin-bore hood. The pump is the
  `chargingHandle` part (the viewmodel racks it); shells load through the port underneath.

   butt ┬ stock ── wrist ┬ receiver ┬ shroud + caddies ──┬ clamp ┬ hood
  -0.4                 -0.03       0.17                0.5     0.52   0.56–0.672   (f, metres)
                                      pump 0.26–0.40 (rides back 0.06)
*/

const BORE = 0.03; // barrel axis
const TUBE = -0.006; // magazine tube axis
const SR = 0.024; // shroud radius
const SAND = toon(P.manilla, { rim: 0.15 });

export function buildGrizzly() {
  const root = new THREE.Group();
  root.name = 'grizzly';
  const k = gunKit(root);
  const { add, at } = k;
  const round = (bevel, segments = 3) => ({ bevel, segments, inset: true });

  // ── receiver: rounded block, one big steel panel across both sides, port right, loading port under ──
  add(profile([[-0.03, -0.018], [0.17, -0.018], [0.17, 0.046], [0.158, 0.056], [-0.012, 0.056], [-0.03, 0.048]], 0.05, round(0.008)), MATS.poly);
  add(profile([[0.0, -0.006], [0.15, -0.006], [0.15, 0.04], [0.012, 0.04], [0.0, 0.03]], 0.053, { bevel: 0.002 }), MATS.steel);
  at(add(rbox(0.0535, 0.008, 0.12, 0.003), MATS.red), 0, -0.012, 0.08);
  const { bolt, ejectPort } = k.boltAndPort(0.085, 0.022, 0.05, 0.0275);
  at(add(rbox(0.044, 0.008, 0.06, 0.003), MATS.black), 0, -0.018, 0.14); // loading port
  add(profile([[-0.028, -0.014], [0.076, -0.014], [0.076, -0.036], [-0.016, -0.036]], 0.038, { bevel: 0.003 }), MATS.black);
  const { trigger, selector } = k.fireControls();
  selector.position.x = -0.022;

  // ── classic stock: rounded body, a wrist panel each side, one accent band, thick butt pad ──
  add(profile([
    [-0.028, 0.05], [-0.06, 0.036], [-0.11, 0.027], [-0.25, 0.032], [-0.388, 0.04], [-0.395, 0.032], [-0.395, -0.1],
    [-0.385, -0.108], [-0.25, -0.084], [-0.14, -0.06], [-0.085, -0.044], [-0.04, -0.036], [-0.016, -0.036], [-0.016, -0.014], [-0.028, -0.014],
  ], 0.044, round(0.011, 4)), MATS.poly);
  // wrist panels: inlaid flush in the flat faces, kept inside the stock's rounded edges
  const wrist = profile([[-0.04, -0.022], [-0.112, -0.036], [-0.112, 0.013], [-0.045, 0.022]], 0.002, { bevel: 0.0006, segments: 1 });
  for (const s of [-1, 1]) add(wrist, MATS.black).position.x = s * 0.0226;
  at(add(rbox(0.046, 0.1, 0.014, 0.004), MATS.red), 0, -0.03, -0.335);
  at(add(rbox(0.048, 0.15, 0.018, 0.008), MATS.rubber), 0, -0.034, -0.402);

  // ── barrel over magazine tube, octagonal shroud with a top rib and two wide straps, clamp ──
  add(tube(0.017, 0.017, 0.17, 0.6), MATS.steel).position.y = BORE;
  add(tube(0.0145, 0.0145, 0.17, 0.57, 18), MATS.black).position.y = TUBE;
  const oct = (r, f0, f1, mat) => at(add(tube(r, r, f0, f1, 8).rotateZ(Math.PI / 8), mat), 0, BORE, 0);
  oct(SR, 0.175, 0.5, MATS.poly);
  for (const f of [0.29, 0.37]) oct(SR + 0.003, f - 0.007, f + 0.007, MATS.black);
  at(add(rbox(0.016, 0.006, 0.3, 0.002), MATS.black), 0, BORE + SR, 0.335);
  at(add(rbox(0.052, 0.072, 0.022, 0.007), MATS.black), 0, 0.012, 0.52);

  // ── shell caddies: three per side on the upper flanks — black block, sand label, red shell-cap end ──
  const caddy = (f, s) => {
    const g = k.group('caddy', 0, BORE, f);
    g.rotation.z = s * 0.52;
    const r = SR + 0.015;
    at(add(rbox(0.028, 0.046, 0.058, 0.008), MATS.black, g), s * r, 0, -0.004);
    at(add(rbox(0.004, 0.032, 0.036, 0.003), SAND, g), s * (r + 0.014), 0, -0.006);
    at(add(rbox(0.03, 0.048, 0.01, 0.004), MATS.red, g), s * r, 0, 0.027);
  };
  for (const s of [-1, 1]) for (const f of [0.25, 0.33, 0.41]) caddy(f, s);

  // ── twin-bore hood: rounded block, accent collar, recessed sides ──
  add(profile([[0.56, -0.026], [0.66, -0.026], [0.672, -0.016], [0.672, 0.046], [0.662, 0.054], [0.56, 0.054]], 0.058, round(0.009)), MATS.poly);
  at(add(rbox(0.06, 0.086, 0.012, 0.004), MATS.red), 0, 0.014, 0.568);
  for (const s of [-1, 1]) at(add(rbox(0.003, 0.05, 0.072, 0.0015), MATS.black), s * 0.029, 0.014, 0.614);
  at(add(rbox(0.032, 0.004, 0.05, 0.002), MATS.vent), 0, 0.0545, 0.61);
  for (const [r, y] of [[0.0135, BORE], [0.0115, TUBE]]) {
    add(new THREE.RingGeometry(r, r + 0.004, 28).rotateY(Math.PI), MATS.steel).position.set(0, y, -0.6724);
    add(new THREE.CircleGeometry(r, 28).rotateY(Math.PI), MATS.vent).position.set(0, y, -0.6722);
  }

  // ── pump on the magazine tube: rounded block, three wide grooves, front lip, accent band ──
  const pump = k.group('pump', 0, 0, 0.33);
  add(profile([[-0.07, -0.03], [0.058, -0.03], [0.068, -0.022], [0.068, 0.016], [-0.07, 0.016], [-0.075, -0.016]], 0.054, round(0.008)), MATS.poly, pump);
  for (const f of [-0.04, 0.0, 0.04]) at(add(rbox(0.056, 0.03, 0.012, 0.004), MATS.black, pump), 0, -0.006, f);
  at(add(rbox(0.052, 0.018, 0.018, 0.006), MATS.poly, pump), 0, -0.034, 0.06);
  at(add(rbox(0.056, 0.01, 0.01, 0.003), MATS.red, pump), 0, 0.002, -0.068);

  // ── rail, irons ──
  k.topRail(-0.02, 0.15, 0.0605);
  const irons = k.ironSights(-0.01, 0.14, 0.0705);

  return {
    root,
    parts: {
      muzzleMount: k.group('muzzleMount', 0, BORE, 0.672),
      scopeMount: k.group('scopeMount', 0, 0.0705, 0.04),
      bolt, chargingHandle: pump, trigger, selector, ejectPort, ...irons,
    },
  };
}
