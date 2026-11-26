import * as THREE from 'three';
import { ITEM_MATS as M, rbox, slab, add } from './kit.js';

/*
  Medkit — a red hard case with a raised ivory cross on both faces, a dark lid seam with two latches and
  back hinges, rubber feet and a carry handle on top. 34 × 22 × 11 cm.
*/

const W = 0.34, H = 0.22, D = 0.11, R = 0.024;
const ARM = 0.026, LEN = 0.068; // cross half-width / half-length

const CROSS = [[-ARM, LEN], [ARM, LEN], [ARM, ARM], [LEN, ARM], [LEN, -ARM], [ARM, -ARM], [ARM, -LEN], [-ARM, -LEN], [-ARM, -ARM], [-LEN, -ARM], [-LEN, ARM], [-ARM, ARM]];

export function buildMedkit() {
  const g = new THREE.Group();
  g.name = 'medkit';
  add(g, rbox(W, H, D, R), M.red, 0, H / 2);
  // lid seam: a band that follows the case's rounded corners, slightly proud of it
  add(g, rbox(W + 0.006, 0.014, D + 0.006, R + 0.003), M.ink, 0, H * 0.7);

  for (const s of [-1, 1]) {
    const cross = add(g, slab(CROSS, 0.012, 0.003), M.ivory, 0, H * 0.4, s * (D / 2 + 0.004));
    cross.rotation.y = s < 0 ? Math.PI : 0;
    // latches straddle the seam on the front
    add(g, rbox(0.03, 0.04, 0.014, 0.004), M.steel, s * 0.11, H * 0.7, -(D / 2 + 0.005));
  }

  // rubber feet under the corners and the lid hinges along the back
  for (const x of [-1, 1]) for (const z of [-1, 1]) add(g, rbox(0.04, 0.012, 0.03, 0.005), M.ink, x * (W / 2 - 0.035), -0.002, z * (D / 2 - 0.025));
  for (const x of [-0.09, 0.09]) {
    const hinge = add(g, new THREE.CylinderGeometry(0.008, 0.008, 0.05, 12), M.ink, x, H * 0.7, D / 2 + 0.004);
    hinge.rotation.z = Math.PI / 2;
  }

  // handle: two posts and a rounded grip
  for (const s of [-1, 1]) add(g, rbox(0.024, 0.05, 0.03, 0.006), M.ink, s * 0.065, H + 0.02);
  add(g, rbox(0.17, 0.024, 0.032, 0.011), M.ink, 0, H + 0.052);
  return g;
}
