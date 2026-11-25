import * as THREE from 'three';
import { MATS, profile, rbox, tube, gunKit } from './parts.js';

/*
  "Panther" carbine — procedural model.
  Gun space: +X right, +Y up, barrel toward -Z. Helpers take `f` = distance forward (z = -f).
  Origin: top-front of the pistol grip, bottom of the upper receiver.

    stock ─────┬─ upper ──────┬── handguard ──────┬─ barrel ─ brake
   -0.41     -0.11   0        0.23              0.52      0.62   0.71   (f, metres)
*/


/**
 * Builds the base rifle (no attachments). Returns { root, parts }: animated parts, iron sights,
 * and the five attachment mounts (muzzle / scope / mag / grip / stock).
 */
const SCALE = 1.1;

export function buildPanther() {
  const root = new THREE.Group();
  root.name = 'panther';
  // authored at modelling size, shown 10% larger so the rifle reads bigger than the SMG
  const body = new THREE.Group();
  body.scale.setScalar(SCALE);
  root.add(body);
  const k = gunKit(body);
  const { add, at } = k;

  // ── upper receiver ──
  add(profile([[-0.11, 0], [0.23, 0], [0.23, 0.056], [0.214, 0.07], [-0.094, 0.07], [-0.11, 0.054]], 0.054, { bevel: 0.004 }), MATS.steel);
  for (const x of [-0.0285, 0.0285]) {
    at(add(rbox(0.002, 0.003, 0.3), MATS.vent), x, 0.012, 0.06);
    at(add(rbox(0.002, 0.003, 0.12), MATS.vent), x, 0.058, 0.15);
  }
  const { bolt, ejectPort } = k.boltAndPort(0.07, 0.032);
  at(add(rbox(0.004, 0.006, 0.09, 0.001), MATS.black), 0.028, 0.0135, 0.07);
  const chargingHandle = k.chargingHandle(0.205, 0.046);

  // ── lower receiver ──
  add(profile([[-0.072, 0.002], [0.2, 0.002], [0.2, -0.02], [0.17, -0.044], [0.17, -0.07], [0.072, -0.07], [0.072, -0.044], [0.04, -0.034], [-0.02, -0.034], [-0.072, -0.02]], 0.05, { bevel: 0.0035 }), MATS.poly);
  at(add(rbox(0.058, 0.02, 0.108, 0.004), MATS.black), 0, -0.07, 0.121);
  for (const [f, y] of [[0.03, -0.018], [0.13, -0.012], [-0.04, -0.008]]) at(add(new THREE.CylinderGeometry(0.0035, 0.0035, 0.056, 10).rotateZ(Math.PI / 2), MATS.steel), 0, y, f);
  at(add(rbox(0.018, 0.016, 0.006, 0.002), MATS.black), 0, -0.047, 0.067);
  const { trigger, selector } = k.fireControls();
  k.pistolGrip();
  at(add(rbox(0.05, 0.056, 0.036, 0.006), MATS.black), 0, 0.032, -0.118); // stock adapter

  // ── handguard ──
  // monolithic top: handguard rises flush with the receiver so the rail sits on it
  add(profile([[0.225, -0.031], [0.5, -0.031], [0.522, -0.016], [0.522, 0.058], [0.506, 0.07], [0.225, 0.07]], 0.058, { bevel: 0.004 }), MATS.poly);
  for (let i = 0; i < 5; i++) {
    const f = 0.27 + i * 0.052;
    for (const x of [-0.0296, 0.0296]) {
      at(add(rbox(0.002, 0.012, 0.036, 0.003), MATS.vent), x, 0.012, f);
      if (i % 2 === 0) at(add(rbox(0.002, 0.005, 0.014, 0.002), MATS.vent), x, 0.037, f + 0.01);
    }
    at(add(rbox(0.03, 0.002, 0.03, 0.003), MATS.vent), 0, -0.0325, f);
  }
  at(add(rbox(0.06, 0.06, 0.012, 0.004), MATS.black), 0, 0.012, 0.524);
  at(add(rbox(0.061, 0.006, 0.02, 0.002), MATS.accent), 0, -0.022, 0.24);
  at(add(rbox(0.02, 0.008, 0.17, 0.0015), MATS.black), 0, -0.036, 0.415);
  at(add(new THREE.TorusGeometry(0.009, 0.0025, 8, 16).rotateY(Math.PI / 2), MATS.steel), -0.034, -0.012, 0.49);

  k.topRail(-0.085, 0.5, 0.0745);
  add(tube(0.0105, 0.0105, 0.52, 0.625), MATS.steel);
  at(add(rbox(0.03, 0.03, 0.026, 0.003), MATS.black), 0, 0.005, 0.548);
  const irons = k.ironSights(-0.075, 0.485, 0.0845);
  irons.ironSight.multiplyScalar(SCALE); // the viewmodel reads it in root space


  return {
    root,
    parts: {
      magSocket: k.group('magSocket', 0, -0.045, 0.12),
      muzzleMount: k.group('muzzleMount', 0, 0, 0.625),
      scopeMount: k.group('scopeMount', 0, 0.0845, 0.06),
      gripMount: k.group('gripMount', 0, -0.04, 0.41),
      stockMount: k.group('stockMount', 0, 0, 0),
      bolt, chargingHandle, trigger, selector, ejectPort, ...irons,
    },
  };
}
