import * as THREE from 'three';
import { ITEM_MATS as M, rbox, cyl, add } from './kit.js';

/*
  Ammo box — an open-topped olive crate packed with two rows of brass cartridges standing proud of the
  rim, an ivory stencil band on the front and rope handles on the ends. 26 × 12 × 15 cm.
*/

const W = 0.26, H = 0.12, D = 0.15, WALL = 0.014;

export function buildAmmo() {
  const g = new THREE.Group();
  g.name = 'ammo';
  // tray: floor + four walls, so the cartridges stand inside it
  add(g, rbox(W, 0.02, D, 0.008), M.olive, 0, 0.01);
  for (const s of [-1, 1]) {
    add(g, rbox(W, H, WALL, 0.006), M.olive, 0, H / 2, s * (D / 2 - WALL / 2));
    add(g, rbox(WALL, H, D - WALL * 2 + 0.002, 0.006), M.olive, s * (W / 2 - WALL / 2), H / 2, 0);
    // end handles
    add(g, rbox(0.012, 0.022, 0.07, 0.008), M.ink, s * (W / 2 + 0.006), H * 0.62, 0);
  }
  add(g, rbox(W * 0.62, 0.034, 0.006, 0.002), M.ivory, 0, H * 0.55, -(D / 2 + 0.003)); // stencil band
  add(g, rbox(0.014, 0.014, 0.006, 0.002), M.ink, -W * 0.22, H * 0.55, -(D / 2 + 0.0065));
  add(g, rbox(0.014, 0.014, 0.006, 0.002), M.ink, W * 0.22, H * 0.55, -(D / 2 + 0.0065));

  const caseGeo = cyl(0.0125, 0.02, 0.135, 14), tipGeo = cyl(0.0125, 0.135, 0.165, 14, 0.004);
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 5; i++) {
      const x = (i - 2) * 0.042, z = (row - 0.5) * 0.05, lift = ((i + row) % 2) * 0.008;
      add(g, caseGeo, M.brass, x, lift, z);
      add(g, tipGeo, M.copper, x, lift, z);
    }
  }
  return g;
}
