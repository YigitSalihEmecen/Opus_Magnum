import * as THREE from 'three';
import { ITEM_MATS as M, rbox, slab, add } from './kit.js';
import { toon } from '../../core/toon.js';

/*
  Armour vest — front and back plates in the tier's colour, joined by shoulder straps and side
  cummerbunds, a row of dark pouches along the bottom and 1–3 ivory bars on the chest telling the tier by
  shape as well as colour. Stands upright, 38 × 36 × 15 cm.
*/

const PLATE = [[-0.16, 0], [0.16, 0], [0.165, 0.19], [0.105, 0.315], [0.062, 0.3], [-0.062, 0.3], [-0.105, 0.315], [-0.165, 0.19]];
const GAP = 0.06; // plate centre to vest centre (front/back)
const mats = new Map();

export function buildArmour(tier, color) {
  const plate = mats.get(color) ?? mats.set(color, toon(color, { rim: 0.28, rimColor: 0xfff3e8 })).get(color);
  const g = new THREE.Group();
  g.name = `armour${tier}`;
  add(g, slab(PLATE, 0.04, 0.012), plate, 0, 0.012, -GAP);
  add(g, slab(PLATE, 0.034, 0.01), plate, 0, 0.012, GAP);
  for (const s of [-1, 1]) {
    add(g, rbox(0.046, 0.026, GAP * 2 + 0.02, 0.01), M.poly, s * 0.083, 0.322, 0); // shoulder strap
    add(g, rbox(0.03, 0.12, GAP * 2 - 0.012, 0.012), M.poly, s * 0.155, 0.085, 0); // cummerbund
  }
  // pouch row, and the tier badge: 1–3 ivory bars on a dark plaque
  for (const x of [-0.1, 0, 0.1]) add(g, rbox(0.088, 0.085, 0.036, 0.012), M.poly, x, 0.072, -GAP - 0.034);
  add(g, rbox(0.15, 0.115, 0.012, 0.01), M.ink, 0, 0.205, -GAP - 0.022);
  for (let i = 0; i < 3; i++) add(g, rbox(0.11, 0.024, 0.01, 0.005), i < tier ? M.ivory : M.poly, 0, 0.17 + i * 0.034, -GAP - 0.026);
  return g;
}
