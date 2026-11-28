import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { PALETTE as P, toon } from '../../core/toon.js';

/*
  Shared materials and helpers for item models. Item space: origin on the floor at the item's centre,
  +Y up, front faces -Z, sizes in metres. Same language as the guns: a few chunky rounded forms, one
  identifying colour per item, ink outlines from the renderer.
*/

const t = (color, rim = 0.25) => toon(color, { rim, rimColor: 0xfff3e8 });

export const ITEM_MATS = {
  ink: t(0x202124, 0.2),
  poly: t(0x34363b, 0.3),
  steel: t(0x5a5d63, 0.4),
  ivory: t(P.ivory, 0.1),
  oat: t(P.oat, 0.12),
  kraft: t(P.kraft, 0.18),
  clay: t(P.clay, 0.25),
  red: t(0xc23a2e, 0.28),
  olive: t(0x6f7a4c, 0.3),
  drab: t(0x4a5236, 0.3), // grenade body: darker than the ammo box's olive
  alloy: t(0x8b8f95, 0.45), // bright steel for small parts on dark bodies
  sage: t(P.sage, 0.25),
  brass: t(0xc9a04e, 0.5),
  copper: t(0xb8673e, 0.4),
};

/** Unlit glow (charger cells, armour cores): flat bright colour that still gets an ink outline. */
export const glow = (color) => new THREE.MeshBasicMaterial({ color });

export function rbox(w, h, d, r = 0.004) {
  return new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
}

/** Vertical cylinder from y0 to y1. */
export function cyl(r, y0, y1, seg = 24, rTop = r) {
  return new THREE.CylinderGeometry(rTop, r, y1 - y0, seg).translate(0, (y0 + y1) / 2, 0);
}

/** Flat outline [[x, y], …] extruded `depth` along Z (centred), with a rounded bevel. */
export function slab(points, depth, bevel = 0.006) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.001, depth - bevel * 2), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 3, curveSegments: 8 });
  return geo.translate(0, 0, -(depth - bevel * 2) / 2);
}

/** Mesh helper: add(group, geo, mat, x, y, z) → mesh. */
export function add(g, geo, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  g.add(m);
  return m;
}
