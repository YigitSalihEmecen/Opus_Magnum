import * as THREE from 'three';
import { MATS, profile, rbox, tube, gunKit, f2z } from './parts.js';

/*
  "Jackal" heavy revolver — procedural model. Same gun space and grip origin as the other guns. Low, wide and
  heavy, laid out like a real double-action revolver: the bore sits low over the hand (the web of the hand just
  under the hammer), the cylinder sits forward and low right over the trigger guard, and the barrel runs long.
  One rounded steel frame with a window the big cylinder sits in (the cylinder is wider than the frame,
  so it bulges out of both sides), black side plates with screws, a thick round barrel over a full-length
  underlug, a skeletonised rib on top, a short optics rail on the top strap, a wide hammer, and a short version
  of the standard angular grip; greige grip panels, clay accents.
  The cylinder is extruded from its outline: six chambers bored right through it (bullet tips sit a little way
  back inside them) and six flutes cut into its rim.
  Moving parts (see the viewmodel's hinge / cylinder / hammer mechanics):
    crane    swings the cylinder out to the left (rotation about +Z at the crane pin) for the reload
    cylinder turns a sixth per shot (rotation about its own axis); `rounds` are the cartridges in it
    hammer   falls on the shot and comes back cocked
    loader   a speedloader (not attached: the viewmodel puts it in the left hand, seated at `loadPoint`)

   grip ┬ hammer ┬ frame ┬ window + cylinder ┬ barrel + underlug ────────────┬ crown
  -0.08  -0.05    -0.05   0.022–0.11          0.118                          0.414   (f, metres, before SCALE)
*/

const SCALE = 0.84;
const MUZZLE = 0.414; // a long barrel: the crown sits this far forward
const CYL = { y: 0.005, r: 0.031, f0: 0.03, f1: 0.102, chamber: 0.019, hole: 0.0074 };
const BORE = CYL.y + CYL.chamber; // the top chamber lines up with the barrel
const PIN = [-0.013, -0.021]; // crane pivot (x, y), below-left of the cylinder
const FRAME_W = 0.048; // narrower than the cylinder (0.062): it shows on both sides
const SAND = MATS.greige;
const chamberAt = (i) => { const a = (i / 6) * Math.PI * 2 + Math.PI / 6; return [Math.sin(a) * CYL.chamber, Math.cos(a) * CYL.chamber]; };

/** The cylinder body: its outline with a flute notched into the rim between each pair of chambers, chambers bored through. */
function cylinderGeometry() {
  const shape = new THREE.Shape(), N = 96;
  for (let k = 0; k <= N; k++) {
    const a = (k / N) * Math.PI * 2;
    const u = (a / (Math.PI / 3)) % 1, d = Math.min(u, 1 - u); // 0 on a flute's centre line, 0.5 over a chamber
    const r = CYL.r - 0.0045 * Math.sqrt(Math.max(0, 1 - d / 0.13));
    const p = [Math.sin(a) * r, Math.cos(a) * r];
    if (k === 0) shape.moveTo(...p); else shape.lineTo(...p);
  }
  for (let i = 0; i < 6; i++) {
    const [x, y] = chamberAt(i), h = new THREE.Path();
    h.absarc(x, y, CYL.hole, 0, Math.PI * 2, true);
    shape.holes.push(h);
  }
  const L = CYL.f1 - CYL.f0, b = 0.0018;
  const g = new THREE.ExtrudeGeometry(shape, { depth: L - b * 2, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 2, curveSegments: 14 });
  return g.translate(0, 0, f2z(CYL.f1) + b); // from the rear face (f0) forward to the front face (f1)
}

export function buildJackal() {
  const root = new THREE.Group();
  root.name = 'jackal';
  const body = new THREE.Group();
  body.scale.setScalar(SCALE);
  root.add(body);
  const k = gunKit(body);
  const { add, at } = k;
  const round = (bevel, segments = 3) => ({ bevel, segments, inset: true });

  // ── frame: one rounded piece — hammer hump, top strap, front post, bottom strap — with the cylinder window ──
  // the bottom strap runs right over the trigger guard, so the cylinder sits as low as it can
  const window = [[0.026, -0.03], [0.106, -0.03], [0.11, -0.026], [0.11, 0.037], [0.106, 0.041], [0.026, 0.041], [0.022, 0.037], [0.022, -0.026]];
  add(profile([
    [-0.05, 0.012], [-0.042, 0.034], [-0.026, 0.049], [0.118, 0.049], [0.118, -0.018], [0.104, -0.04], [-0.014, -0.04], [-0.03, -0.03], [-0.046, 0.0],
  ], FRAME_W, { ...round(0.006), holes: [window] }), MATS.steel);
  // recoil shield behind the cylinder, a clay line along the bottom strap
  at(add(rbox(0.04, 0.062, 0.006, 0.004), MATS.steel), 0, CYL.y, 0.02);
  at(add(rbox(FRAME_W + 0.0012, 0.004, 0.08, 0.002), MATS.accent), 0, -0.035, 0.066);
  // side plates on the frame's flat flanks behind the window, two screws each
  const plate = profile([[-0.032, -0.018], [0.012, -0.018], [0.012, 0.03], [-0.018, 0.036], [-0.036, 0.012]], 0.002, { bevel: 0.0006, segments: 1 });
  for (const s of [-1, 1]) {
    add(plate, MATS.black).position.x = s * (FRAME_W / 2 + 0.0006);
    for (const [y, f] of [[-0.008, 0.004], [0.022, -0.006]]) at(add(new THREE.CylinderGeometry(0.0026, 0.0026, 0.0016, 12).rotateZ(Math.PI / 2), MATS.steel), s * (FRAME_W / 2 + 0.0018), y, f);
  }
  const { trigger, selector } = k.fireControls(MATS.steel);
  selector.visible = false; // a revolver has no selector

  // ── hammer: wide rounded body and a short knurled spur, pivoting low in the frame ──
  const hammer = k.group('hammer', 0, -0.003, -0.036);
  add(profile([[0.01, 0], [0.01, 0.042], [0.0, 0.056], [-0.014, 0.064], [-0.022, 0.06], [-0.016, 0.048], [-0.008, 0]], 0.016, round(0.005)), MATS.black, hammer);
  for (const f of [-0.008, -0.014]) at(add(rbox(0.0175, 0.002, 0.003, 0.001), MATS.steel, hammer), 0, 0.058, f);

  // ── crane + cylinder: bored and fluted body, cartridges (brass heads behind, bullet tips inside), ejector rod ──
  const crane = k.group('crane', PIN[0], PIN[1], 0);
  const cylinder = k.group('cylinder', -PIN[0], CYL.y - PIN[1], 0, crane);
  add(cylinderGeometry(), MATS.gunmetal, cylinder);
  add(tube(0.009, 0.009, CYL.f0 - 0.005, CYL.f0, 18), MATS.black, cylinder); // ratchet star behind the rear face
  const rounds = k.group('rounds', 0, 0, CYL.f0 - 0.005, cylinder);
  for (let i = 0; i < 6; i++) {
    const [cx, cy] = chamberAt(i);
    add(tube(0.0082, 0.0082, 0.0, 0.0035, 18), MATS.brass, rounds).position.set(cx, cy, 0);
    add(new THREE.CircleGeometry(0.0026, 12), MATS.copper, rounds).position.set(cx, cy, 0.0002); // primer
    // the bullet's tip, set back inside the chamber so the bore reads as a hole with a round in it
    const tip = add(new THREE.SphereGeometry(CYL.hole * 0.92, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(-Math.PI / 2), MATS.copper, rounds);
    tip.position.set(cx, cy, f2z(CYL.f1 - CYL.f0 + 0.005 - 0.012));
  }
  add(tube(0.0034, 0.0034, CYL.f1, 0.138, 10), MATS.steel, cylinder); // ejector rod
  at(add(new THREE.CylinderGeometry(0.0055, 0.0055, 0.008, 14).rotateX(Math.PI / 2), MATS.accent, cylinder), 0, 0, 0.142);
  const ejectPort = k.group('ejectPort', 0, 0, CYL.f0 - 0.01, cylinder);
  const loadPoint = k.group('loadPoint', 0, 0, CYL.f0, cylinder);

  // ── barrel: a long, thick round barrel with a collar at each end over a slim full-length underlug that
  //    tapers toward the muzzle, clay crown, vent rib ──
  add(tube(0.0205, 0.0195, 0.118, MUZZLE, 32), MATS.poly).position.y = BORE;
  for (const [f0, f1] of [[0.118, 0.13], [MUZZLE - 0.014, MUZZLE]]) add(tube(0.0214, 0.0214, f0, f1, 32), MATS.steel).position.y = BORE;
  const lug = MUZZLE - 0.012;
  add(profile([[0.118, 0.018], [0.118, -0.018], [0.132, -0.018], [lug - 0.016, -0.008], [lug, 0.0], [lug, 0.018]], 0.028, round(0.008, 4)), MATS.steel);
  add(new THREE.CircleGeometry(0.0075, 20).rotateY(Math.PI), MATS.vent).position.set(0, BORE, f2z(MUZZLE) - 0.0002);
  add(new THREE.RingGeometry(0.0075, 0.0185, 28).rotateY(Math.PI), MATS.accent).position.set(0, BORE, f2z(MUZZLE) - 0.0001);
  const ribSlots = [0, 1, 2, 3, 4, 5].map((i) => 0.142 + i * 0.042).map((f) => [[f, 0.045], [f + 0.03, 0.045], [f + 0.03, 0.051], [f, 0.051]]);
  add(profile([[0.118, 0.04], [MUZZLE - 0.008, 0.04], [MUZZLE - 0.008, 0.056], [0.118, 0.056]], 0.018, { bevel: 0.0018, holes: ribSlots }), MATS.black);

  // the frame's hump flows into the grip's back
  add(profile([[-0.026, -0.03], [-0.048, -0.022], [-0.056, -0.004], [-0.05, 0.012], [-0.03, 0.0]], 0.04, round(0.008, 4)), MATS.steel);

  // ── optics rail on the top strap, fixed irons: notch at the back of the rail, blade on the rib ──
  k.topRail(-0.03, 0.112, 0.0535);
  const ironRear = k.group('ironRear', 0, 0.0635, -0.024);
  at(add(rbox(0.03, 0.006, 0.014, 0.002), MATS.black, ironRear), 0, 0.003, 0);
  for (const x of [-0.0095, 0.0095]) at(add(rbox(0.011, 0.011, 0.012, 0.002), MATS.black, ironRear), x, 0.0085, 0);
  const ironFront = k.group('ironFront', 0, 0.056, MUZZLE - 0.02);
  at(add(rbox(0.006, 0.0135, 0.014, 0.002), MATS.black, ironFront), 0, 0.00675, 0);
  at(add(rbox(0.0062, 0.004, 0.0142, 0.001), MATS.accent, ironFront), 0, 0.0115, 0);

  // ── grip: a short version of the standard angular grip, a little wider, at full size (outside the scaled
  //    body, so it fills the hand like every other gun's); greige panels, clay base cap ──
  gunKit(root).pistolGrip(MATS.black, SAND, MATS.accent, { width: 0.036, foot: -0.124 });

  // what the viewmodel's generic mechanics expect: a still "bolt" and "charging handle"
  const bolt = k.group('bolt', 0, 0, 0), chargingHandle = k.group('chargingHandle', 0, 0, 0);

  return {
    root,
    parts: {
      muzzleMount: k.group('muzzleMount', 0, BORE, MUZZLE),
      scopeMount: k.group('scopeMount', 0, 0.0635, 0.04),
      hinge: crane, cylinder, rounds, hammer, loadPoint, loader: buildSpeedloader(),
      bolt, chargingHandle, trigger, selector, ejectPort,
      ironRear, ironFront, ironSight: new THREE.Vector3(0, 0.0695, 0.024).multiplyScalar(SCALE),
    },
  };
}

/** Speedloader in loadPoint space (the cylinder's rear face): six rounds pointing into the chambers, black puck, clay knob. */
function buildSpeedloader() {
  const g = new THREE.Group();
  g.name = 'speedloader';
  const add = (geo, mat) => { const m = new THREE.Mesh(geo, mat); g.add(m); return m; };
  add(tube(0.027, 0.027, -0.017, -0.004, 28), MATS.black);
  add(tube(0.0095, 0.0095, -0.03, -0.017, 14), MATS.accent);
  for (let i = 0; i < 6; i++) {
    const [x, y] = chamberAt(i);
    add(tube(0.0066, 0.006, -0.004, 0.03, 12), MATS.brass).position.set(x, y, 0);
  }
  return g;
}
