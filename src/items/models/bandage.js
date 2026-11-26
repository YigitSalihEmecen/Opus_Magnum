import * as THREE from 'three';
import { ITEM_MATS as M, rbox, cyl, add } from './kit.js';

/*
  Bandage — an ivory roll lying on its side with a kraft core showing at both ends, a sage band holding it
  together and a loose tail unrolled along the floor. Roll ⌀ 11 cm × 9 cm.
*/

const R = 0.055, L = 0.09;

export function buildBandage() {
  const g = new THREE.Group();
  g.name = 'bandage';
  const roll = new THREE.Group();
  roll.rotation.z = Math.PI / 2; // axis along X
  roll.position.y = R;
  g.add(roll);
  add(roll, cyl(R, -L / 2, L / 2, 28), M.ivory);
  add(roll, cyl(0.022, -L / 2 - 0.003, L / 2 + 0.003, 18), M.kraft); // core
  add(roll, cyl(R + 0.0025, -0.013, 0.013, 28), M.sage); // band
  // metal clip on the band
  add(g, rbox(0.026, 0.008, 0.028, 0.003), M.steel, 0, R * 2 + 0.003, -0.004);

  // tail: peels off the underside of the roll and lies flat in front of it, its end lifting
  add(g, rbox(L - 0.012, 0.005, 0.08, 0.002), M.ivory, 0, 0.0025, -0.036);
  const tip = add(g, rbox(L - 0.012, 0.005, 0.024, 0.002), M.ivory, 0, 0.007, -0.084);
  tip.rotation.x = -0.45;
  return g;
}
