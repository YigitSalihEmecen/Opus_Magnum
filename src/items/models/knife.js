import * as THREE from 'three';
import { ITEM_MATS as M, rbox, add } from './kit.js';

/*
  "Talon" combat knife — clip-point blade, blackened flats with a bright ground edge, a clay-tipped
  guard, a ringed rubber grip with a clay backstrap, and a steel pommel with a lanyard loop. 31 cm.
  Held in the fist: origin at the middle of the grip, the handle runs along Y with the blade above it
  (+Y), the edge facing -Z. Built in the same chunky style as the guns.
*/

/** Flat blade piece: a (z, y) outline extruded `t` thick along X, centred, with a small bevel. */
function plate(points, t, bevel = 0.0012) {
  const s = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(-z, y)));
  const geo = new THREE.ExtrudeGeometry(s, { depth: t - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 6 });
  geo.translate(0, 0, -(t - bevel * 2) / 2);
  return geo.rotateY(Math.PI / 2); // shape x → -Z
}

// blade outline (z, y): straight spine at +Z, clip down to the tip, a long belly back to the ricasso
const EDGE = [[-0.004, 0.252], [-0.013, 0.232], [-0.018, 0.205], [-0.02, 0.16], [-0.02, 0.1], [-0.018, 0.068], [-0.015, 0.058]];
const BLADE = [[0.012, 0.058], [0.012, 0.19], [0.009, 0.205], ...EDGE];
// the blackened flats stop short of the edge, leaving a bright bevel along it
const FLAT = [[0.0115, 0.06], [0.0115, 0.188], [0.007, 0.204], [-0.001, 0.236], [-0.008, 0.22], [-0.012, 0.195], [-0.0135, 0.155], [-0.0135, 0.1], [-0.0115, 0.07], [-0.009, 0.06]];

export function buildKnife() {
  const g = new THREE.Group();

  // blade: bright steel core, blackened flats over it, a fuller groove and a spine swedge
  add(g, plate(BLADE, 0.0036), M.alloy);
  add(g, plate(FLAT, 0.0058), M.ink);
  add(g, rbox(0.0062, 0.085, 0.0035, 0.0012), M.steel, 0, 0.125, 0.004);
  add(g, rbox(0.0042, 0.03, 0.004, 0.0012), M.alloy, 0, 0.196, 0.0095).rotation.x = -0.35;

  // guard: a steel bar with clay tips, swept a little toward the edge
  add(g, rbox(0.017, 0.011, 0.062, 0.004), M.steel, 0, 0.05, -0.004);
  for (const z of [-0.036, 0.028]) add(g, rbox(0.019, 0.013, 0.012, 0.004), M.clay, 0, 0.05, z);

  // grip: rubber core, ink rings, a clay backstrap along the spine side
  add(g, rbox(0.024, 0.1, 0.03, 0.009), M.poly, 0, -0.006, 0);
  for (const y of [-0.04, -0.012, 0.016]) add(g, rbox(0.026, 0.006, 0.032, 0.003), M.ink, 0, y, 0);
  add(g, rbox(0.016, 0.082, 0.006, 0.003), M.clay, 0, -0.006, 0.0155);

  // pommel and lanyard loop
  add(g, rbox(0.026, 0.018, 0.034, 0.006), M.steel, 0, -0.064, 0);
  const loop = add(g, new THREE.TorusGeometry(0.009, 0.0025, 6, 14), M.alloy, 0, -0.078, 0.008);
  loop.rotation.y = Math.PI / 2;

  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}
