import * as THREE from 'three';
import { MATS, profile, rbox, tube, gunKit } from './parts.js';

/*
  "Kestrel" bolt-action sniper — procedural model. Same gun space as the other guns (trigger at f 0.036).
  Long and slim: stepped dark receiver, slate handguard that tapers to a wedge nose with slanted
  see-through windows, swept skeleton stock; blue accents (this gun's colour). The bolt is the `bolt`
  part: its origin sits on the bolt axis, the viewmodel lifts it (rotation about +Z) and pulls it
  back (+Z) from the clip's ch track.

   butt ┬ swept stock ┬ receiver ┬ handguard (deep → slim) ───────┬ barrel ┬ brake (muzzle slot)
  -0.47              -0.09      0.24                             0.9     1.06     (f, metres)
                    bolt handle at f -0.01, right side
*/

const BORE = 0.03;
const BOLT_Y = 0.045;

export function buildKestrel() {
  const root = new THREE.Group();
  root.name = 'kestrel';
  const k = gunKit(root);
  const { add, at } = k;
  const round = (bevel, segments = 3) => ({ bevel, segments, inset: true });

  // ── receiver: stepped dark block, angled steel side panel, blue light strip, bolt slot + port on the right ──
  add(profile([[-0.09, -0.026], [0.24, -0.026], [0.24, 0.056], [0.222, 0.07], [0.05, 0.07], [0.03, 0.08], [-0.065, 0.08], [-0.09, 0.06]], 0.054, round(0.007)), MATS.poly);
  add(profile([[-0.05, -0.014], [0.19, -0.014], [0.215, 0.01], [0.198, 0.034], [-0.032, 0.034], [-0.05, 0.022]], 0.0575, { bevel: 0.002 }), MATS.steel);
  at(add(rbox(0.058, 0.004, 0.1, 0.0015), MATS.blue), 0, -0.004, 0.11);
  at(add(rbox(0.003, 0.011, 0.11, 0.002), MATS.vent), 0.028, BOLT_Y, -0.045); // handle slot
  at(add(rbox(0.003, 0.02, 0.07, 0.002), MATS.vent), 0.028, BOLT_Y, 0.08); // ejection port
  const ejectPort = k.group('ejectPort', 0.033, BOLT_Y, 0.08);

  // ── bolt: carrier showing in the port, handle + blue knob on the right ──
  const bolt = k.group('bolt', 0, BOLT_Y, -0.01);
  at(add(rbox(0.006, 0.014, 0.06, 0.002), MATS.steel, bolt), 0.026, 0, 0.09);
  at(add(rbox(0.006, 0.006, 0.1, 0.002), MATS.steel, bolt), 0.026, 0, -0.03);
  at(add(new THREE.CylinderGeometry(0.005, 0.005, 0.04, 12).rotateZ(Math.PI / 2), MATS.steel, bolt), 0.045, 0, 0);
  const knob = at(add(new THREE.SphereGeometry(0.011, 18, 12), MATS.blue, bolt), 0.068, -0.004, 0);
  knob.scale.set(1, 1, 0.85);
  at(add(rbox(0.008, 0.011, 0.011, 0.003), MATS.black, bolt), 0.057, -0.002, 0);

  // ── lower: trigger housing, fire controls, pistol grip ──
  add(profile([[-0.07, -0.022], [0.21, -0.022], [0.21, -0.042], [0.17, -0.052], [0.07, -0.052], [0.058, -0.036], [-0.05, -0.032]], 0.046, round(0.005)), MATS.black);
  const { trigger, selector } = k.fireControls();
  k.pistolGrip();
  at(add(rbox(0.047, 0.005, 0.09, 0.002), MATS.blue), 0, -0.05, 0.12);

  // ── swept skeleton stock: slate frame with a long tapered slot and a butt window, cheek riser, rubber butt ──
  add(profile(
    [[-0.085, 0.07], [-0.2, 0.062], [-0.43, 0.056], [-0.46, 0.046], [-0.46, -0.11], [-0.445, -0.122], [-0.39, -0.122], [-0.31, -0.08], [-0.17, -0.05], [-0.085, -0.034]],
    0.042,
    { ...round(0.007), holes: [
      [[-0.12, 0.03], [-0.12, -0.02], [-0.3, -0.058], [-0.33, -0.04], [-0.33, 0.03]],
      [[-0.375, 0.026], [-0.375, -0.07], [-0.43, -0.098], [-0.435, 0.026]],
    ] },
  ), MATS.slate);
  add(profile([[-0.15, 0.058], [-0.185, 0.09], [-0.37, 0.093], [-0.4, 0.078], [-0.4, 0.054]], 0.044, round(0.007)), MATS.poly);
  at(add(rbox(0.045, 0.005, 0.13, 0.002), MATS.blue), 0, 0.078, -0.28);
  at(add(rbox(0.046, 0.18, 0.016, 0.006), MATS.rubber), 0, -0.032, -0.468);

  // ── handguard: deep at the receiver, slim forward, wedge nose; slanted windows show the barrel ──
  const windows = [0.34, 0.44, 0.54, 0.64, 0.74].map((f) => [[f, 0.016], [f + 0.06, 0.016], [f + 0.075, 0.042], [f + 0.015, 0.042]]);
  add(profile([[0.24, -0.028], [0.42, -0.028], [0.5, -0.016], [0.84, -0.016], [0.9, 0.004], [0.9, 0.048], [0.875, 0.06], [0.24, 0.06]], 0.048, { ...round(0.006), holes: windows }), MATS.slate);
  add(profile([[0.245, -0.024], [0.415, -0.024], [0.47, -0.014], [0.47, -0.004], [0.245, -0.004]], 0.0505, { bevel: 0.0015 }), MATS.black);
  at(add(rbox(0.026, 0.01, 0.6, 0.003), MATS.poly), 0, 0.062, 0.56);
  at(add(rbox(0.0495, 0.004, 0.42, 0.0015), MATS.blue), 0, 0.006, 0.66);
  const slash = at(add(rbox(0.0495, 0.004, 0.06, 0.0015), MATS.blue), 0, 0.022, 0.42);
  slash.rotation.x = -0.45;
  at(add(rbox(0.056, 0.074, 0.012, 0.004), MATS.black), 0, 0.016, 0.245);
  add(profile([[0.8, -0.014], [0.87, -0.008], [0.85, -0.046], [0.83, -0.046]], 0.012, round(0.003)), MATS.black); // hand-stop fin

  // ── barrel and rail ──
  add(tube(0.014, 0.012, 0.24, 1.06), MATS.steel).position.y = BORE;
  add(tube(0.0155, 0.0155, 0.9, 0.915), MATS.black).position.y = BORE;
  k.topRail(-0.06, 0.22, 0.0845);
  const irons = k.ironSights(-0.04, 0.21, 0.0945);

  return {
    root,
    parts: {
      magSocket: k.group('magSocket', 0, -0.046, 0.12),
      muzzleMount: k.group('muzzleMount', 0, BORE, 1.06),
      scopeMount: k.group('scopeMount', 0, 0.0945, 0.08),
      chargingHandle: k.group('chargingHandle', 0, 0, 0),
      bolt, trigger, selector, ejectPort, ...irons,
    },
  };
}
