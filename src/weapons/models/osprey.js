import * as THREE from 'three';
import { MATS, profile, rbox, tube, gunKit } from './parts.js';

/*
  "Osprey" marksman rifle (DMR) — procedural model. Same gun space and grip origin as the Panther, but read as
  a different animal: two-tone (steel upper, black lower, sage furniture), a tall billet upper with a forward
  assist and a recessed side panel, a flared sage magwell, a slim chamfered sage handguard set narrower than
  the receiver, a heavy fluted barrel with its gas block showing, and a bipod folded forward under the barrel.

    stock ─────┬─ upper ───────┬── chamfered handguard ──────────┬ gas ─ fluted barrel ┬ (muzzle slot)
   -0.42     -0.12   0         0.24                              0.64  0.67           0.9   (f, metres)
                                         bipod folded 0.56 ─ 0.8
*/

const SCALE = 1.1;
const BORE = 0.034;

export function buildOsprey() {
  const root = new THREE.Group();
  root.name = 'osprey';
  const body = new THREE.Group();
  body.scale.setScalar(SCALE);
  root.add(body);
  const k = gunKit(body);
  const { add, at } = k;
  const chamfer = (bevel) => ({ bevel, segments: 1, inset: true }); // flat 45° edges: the gun's faceted look

  // ── upper receiver: tall billet slab, recessed side panel, forward assist, deflector, port + bolt ──
  add(profile([[-0.12, 0], [0.24, 0], [0.24, 0.066], [0.228, 0.078], [-0.1, 0.078], [-0.12, 0.062]], 0.056, chamfer(0.005)), MATS.steel);
  for (const s of [-1, 1]) {
    at(add(rbox(0.002, 0.02, 0.15, 0.004), MATS.poly), s * 0.0282, 0.05, 0.16);
    at(add(rbox(0.0022, 0.003, 0.15, 0.001), MATS.sage), s * 0.0283, 0.038, 0.16);
  }
  at(add(rbox(0.014, 0.024, 0.05, 0.006), MATS.steel), 0.031, 0.05, -0.03); // forward assist housing
  at(add(new THREE.CylinderGeometry(0.008, 0.008, 0.012, 16).rotateX(Math.PI / 2), MATS.black), 0.034, 0.05, -0.06);
  at(add(rbox(0.012, 0.018, 0.02, 0.004), MATS.steel), 0.033, 0.036, -0.004); // brass deflector
  const { bolt, ejectPort } = k.boltAndPort(0.08, 0.026, 0.09, 0.0285);
  const chargingHandle = k.chargingHandle(0.215, 0.056);

  // ── lower receiver: black slab, flared sage magwell, sage release, pins, oversized guard ──
  add(profile([[-0.075, 0.002], [0.215, 0.002], [0.215, -0.022], [0.19, -0.044], [0.19, -0.072], [0.07, -0.072], [0.07, -0.046], [0.042, -0.034], [-0.02, -0.034], [-0.075, -0.02]], 0.052, chamfer(0.004)), MATS.poly);
  add(profile([[0.064, -0.064], [0.198, -0.064], [0.204, -0.086], [0.058, -0.086]], 0.064, chamfer(0.005)), MATS.sage); // magwell flare
  at(add(rbox(0.004, 0.012, 0.014, 0.002), MATS.sage), 0.027, -0.036, 0.08);
  for (const [f, y] of [[0.03, -0.018], [0.15, -0.012], [-0.045, -0.008]]) at(add(new THREE.CylinderGeometry(0.0035, 0.0035, 0.058, 10).rotateZ(Math.PI / 2), MATS.steel), 0, y, f);
  const { trigger, selector } = k.fireControls(MATS.black);
  k.pistolGrip(MATS.poly, MATS.sage);
  at(add(rbox(0.052, 0.06, 0.036, 0.006), MATS.black), 0, 0.034, -0.128); // stock adapter

  // ── handguard: slim chamfered sage tube under a full-length rail, recessed M-LOK slots, hand stop ──
  add(profile([[0.236, -0.022], [0.63, -0.022], [0.645, -0.008], [0.645, 0.06], [0.635, 0.07], [0.236, 0.07]], 0.046, chamfer(0.008)), MATS.sage);
  at(add(rbox(0.05, 0.088, 0.014, 0.005), MATS.black), 0, 0.026, 0.238); // barrel nut collar
  for (let i = 0; i < 5; i++) {
    const f = 0.29 + i * 0.07;
    for (const s of [-1, 1]) at(add(rbox(0.002, 0.012, 0.046, 0.005), MATS.vent), s * 0.0231, 0.024, f);
    at(add(rbox(0.016, 0.002, 0.04, 0.005), MATS.vent), 0, -0.0221, f);
  }
  add(profile([[0.47, -0.022], [0.5, -0.022], [0.494, -0.04], [0.484, -0.042]], 0.024, chamfer(0.003)), MATS.black); // hand stop
  at(add(new THREE.TorusGeometry(0.008, 0.0024, 8, 16).rotateY(Math.PI / 2), MATS.steel), -0.025, 0.004, 0.6);

  // ── gas block and heavy fluted barrel ──
  at(add(rbox(0.032, 0.034, 0.03, 0.005), MATS.black), 0, BORE, 0.662);
  add(tube(0.0125, 0.0115, 0.645, 0.9, 20), MATS.steel).position.y = BORE;
  for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const fl = at(add(rbox(0.0026, 0.0045, 0.17, 0.0012), MATS.vent), Math.sin(a) * 0.0119, BORE + Math.cos(a) * 0.0119, 0.78);
    fl.rotation.z = -a;
  }

  // ── bipod, folded forward under the barrel: hub on the handguard, flat splayed legs (black upper, steel
  //    extension) angling down to chunky rubber feet ──
  at(add(rbox(0.042, 0.016, 0.034, 0.005), MATS.black), 0, -0.03, 0.598);
  at(add(new THREE.CylinderGeometry(0.0055, 0.0055, 0.05, 12).rotateZ(Math.PI / 2), MATS.steel), 0, -0.034, 0.606);
  for (const s of [-1, 1]) {
    const leg = k.group('bipodLeg', s * 0.014, -0.034, 0.606);
    leg.rotation.set(-0.06, s * 0.05, 0); // tips down a touch and splays out toward the feet
    at(add(rbox(0.007, 0.014, 0.12, 0.003), MATS.black, leg), 0, 0, 0.062);
    at(add(rbox(0.005, 0.009, 0.09, 0.002), MATS.steel, leg), 0, -0.001, 0.16);
    at(add(rbox(0.014, 0.02, 0.02, 0.006), MATS.rubber, leg), 0, -0.003, 0.212);
  }

  k.topRail(-0.1, 0.64, 0.0825);
  const irons = k.ironSights(-0.09, 0.62, 0.0925);
  irons.ironSight.multiplyScalar(SCALE); // the viewmodel reads it in root space

  return {
    root,
    parts: {
      magSocket: k.group('magSocket', 0, -0.05, 0.13),
      muzzleMount: k.group('muzzleMount', 0, BORE, 0.9),
      scopeMount: k.group('scopeMount', 0, 0.0925, 0.06),
      gripMount: k.group('gripMount', 0, -0.022, 0.42),
      stockMount: k.group('stockMount', 0, 0.002, -0.01),
      bolt, chargingHandle, trigger, selector, ejectPort, ...irons,
    },
  };
}
