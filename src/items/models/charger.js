import * as THREE from 'three';
import { ITEM_MATS as M, rbox, cyl, glow, add } from './kit.js';

/*
  Armour charger — an upright slate cell with heavy black end caps, a glowing cyan core band showing
  through four guard ribs, brass contacts and a carry bail on top. ⌀ 10 cm × 20 cm.
*/

export const CHARGE_GLOW = 0x5fd0ff;

export function buildCharger() {
  const g = new THREE.Group();
  g.name = 'charger';
  add(g, cyl(0.042, 0.03, 0.17, 24), M.steel);
  add(g, cyl(0.05, 0, 0.04, 24), M.ink);
  add(g, cyl(0.05, 0.16, 0.2, 24, 0.046), M.ink);
  add(g, cyl(0.044, 0.065, 0.135, 24), glow(CHARGE_GLOW)); // core band
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const rib = add(g, rbox(0.014, 0.13, 0.012, 0.004), M.ink, Math.sin(a) * 0.046, 0.1, Math.cos(a) * 0.046);
    rib.rotation.y = a;
  }
  // carry bail arching over the top cap
  const bail = add(g, new THREE.TorusGeometry(0.032, 0.0055, 8, 20, Math.PI), M.ink, 0, 0.198, 0);
  bail.rotation.y = Math.PI / 2;
  add(g, cyl(0.016, 0.2, 0.212, 16), M.brass);
  add(g, rbox(0.05, 0.008, 0.01, 0.003), M.brass, 0, 0.204, 0);
  return g;
}
