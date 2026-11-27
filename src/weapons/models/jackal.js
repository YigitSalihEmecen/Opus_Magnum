import * as THREE from 'three';
import { MATS, profile, rbox, tube, gunKit, ovalSweep } from './parts.js';

/*
  "Jackal" heavy revolver — procedural model. Same gun space and grip origin as the other guns, and the same
  vocabulary as the Lynx: a few large, softly rounded forms and an oval, raked grip with stipple bands.
  One rounded steel frame with a window the bright fluted cylinder sits in (the cylinder is wider than the
  frame, so it bulges out of both sides), a heavy round barrel over a full-length underlug, a skeletonised rib on
  top, a short optics rail on the top strap, a rounded hammer, a curved grip; greige grip bands, clay accents.
  Moving parts (see the viewmodel's hinge / cylinder / hammer mechanics):
    crane    swings the cylinder out to the left (rotation about +Z at the crane pin) for the reload
    cylinder turns a sixth per shot (rotation about its own axis); `rounds` are the cartridge heads in it
    hammer   falls on the shot and comes back cocked
    loader   a speedloader (not attached: the viewmodel puts it in the left hand, seated at `loadPoint`)

   grip ┬ hammer ┬ frame ┬ window + cylinder ┬ barrel + underlug ──────┬ crown
  -0.07  -0.05    -0.05   0.014–0.092         0.1                     0.262   (f, metres, before SCALE)
*/

const SCALE = 0.78;
const BORE = 0.046;
const CYL = { y: 0.03, r: 0.027, f0: 0.02, f1: 0.086, chamber: 0.016 };
const PIN = [-0.01, 0.006]; // crane pivot (x, y), below-left of the cylinder
const FRAME_W = 0.036; // narrower than the cylinder (0.054): it shows on both sides
const SAND = MATS.greige;

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
  const window = [[0.016, 0.0], [0.088, 0.0], [0.092, 0.004], [0.092, 0.058], [0.088, 0.062], [0.016, 0.062], [0.012, 0.058], [0.012, 0.004]];
  add(profile([
    [-0.05, 0.03], [-0.04, 0.056], [-0.024, 0.07], [0.104, 0.07], [0.104, -0.012], [0.078, -0.012], [0.07, -0.034],
    [-0.014, -0.034], [-0.03, -0.024], [-0.046, 0.004],
  ], FRAME_W, { ...round(0.005), holes: [window] }), MATS.steel);
  // recoil shield behind the cylinder, a clay line along the bottom strap
  at(add(rbox(0.03, 0.05, 0.006, 0.004), MATS.steel), 0, 0.03, 0.012);
  at(add(rbox(FRAME_W + 0.0012, 0.004, 0.06, 0.002), MATS.accent), 0, -0.007, 0.052);
  const { trigger, selector } = k.fireControls(MATS.steel);
  selector.visible = false; // a revolver has no selector

  // ── hammer: rounded body and a short knurled spur, pivoting low in the frame ──
  const hammer = k.group('hammer', 0, 0.022, -0.036);
  add(profile([[0.01, 0], [0.01, 0.042], [0.0, 0.056], [-0.014, 0.064], [-0.022, 0.06], [-0.016, 0.048], [-0.008, 0]], 0.012, round(0.004)), MATS.black, hammer);
  for (const f of [-0.008, -0.014]) at(add(rbox(0.0135, 0.002, 0.003, 0.001), MATS.steel, hammer), 0, 0.058, f);

  // ── crane + cylinder: fluted body, chamber mouths, cartridge heads, ejector rod ──
  const crane = k.group('crane', PIN[0], PIN[1], 0);
  const cylinder = k.group('cylinder', -PIN[0], CYL.y - PIN[1], 0, crane);
  add(tube(CYL.r, CYL.r, CYL.f0, CYL.f1, 30), MATS.gunmetal, cylinder);
  add(tube(CYL.r - 0.004, CYL.r, CYL.f1, CYL.f1 + 0.004, 30), MATS.gunmetal, cylinder);
  add(tube(CYL.r - 0.004, CYL.r, CYL.f0 - 0.004, CYL.f0, 30), MATS.gunmetal, cylinder);
  const rounds = k.group('rounds', 0, 0, CYL.f0 - 0.005, cylinder);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2, x = Math.sin(a), y = Math.cos(a);
    // flutes: recessed grooves lying on the cylinder's surface between the chambers
    const flute = at(add(rbox(0.007, 0.004, 0.04, 0.0018), MATS.black, cylinder), x * (CYL.r - 0.0012), y * (CYL.r - 0.0012), 0.057);
    flute.rotation.z = -a;
    const cx = Math.sin(a + Math.PI / 6) * CYL.chamber, cy = Math.cos(a + Math.PI / 6) * CYL.chamber;
    add(new THREE.CircleGeometry(0.0062, 16).rotateY(Math.PI), MATS.vent, cylinder).position.set(cx, cy, -(CYL.f1 + 0.0042));
    add(tube(0.0068, 0.0068, 0.0, 0.003, 16), MATS.brass, rounds).position.set(cx, cy, 0);
    add(new THREE.CircleGeometry(0.0022, 10), MATS.copper, rounds).position.set(cx, cy, 0.0002);
  }
  add(tube(0.003, 0.003, CYL.f1, 0.118, 10), MATS.steel, cylinder); // ejector rod
  at(add(new THREE.CylinderGeometry(0.0048, 0.0048, 0.008, 14).rotateX(Math.PI / 2), MATS.accent, cylinder), 0, 0, 0.122);
  const ejectPort = k.group('ejectPort', 0, 0, CYL.f0 - 0.01, cylinder);
  const loadPoint = k.group('loadPoint', 0, 0, CYL.f0, cylinder);

  // ── barrel: a heavy round barrel over a full-length underlug, a clay crown, a skeletonised rib on top ──
  add(tube(0.0168, 0.0158, 0.1, 0.262, 28), MATS.poly).position.y = BORE;
  add(tube(0.0176, 0.0176, 0.1, 0.112, 28), MATS.steel).position.y = BORE; // collar at the frame
  add(profile([[0.1, 0.04], [0.1, -0.008], [0.112, -0.012], [0.236, 0.004], [0.254, 0.022], [0.254, 0.04]], 0.022, round(0.008, 4)), MATS.steel);
  add(new THREE.CircleGeometry(0.0062, 18).rotateY(Math.PI), MATS.vent).position.set(0, BORE, -0.2622);
  add(new THREE.RingGeometry(0.0062, 0.0156, 24).rotateY(Math.PI), MATS.accent).position.set(0, BORE, -0.2621);
  const ribSlots = [0.13, 0.165, 0.2].map((f) => [[f, 0.064], [f + 0.022, 0.064], [f + 0.022, 0.07], [f, 0.07]]);
  add(profile([[0.1, 0.058], [0.256, 0.058], [0.256, 0.074], [0.1, 0.074]], 0.012, { bevel: 0.0015, holes: ribSlots }), MATS.black);

  // ── grip: an oval swept down a curved spine — upright under the frame, bending back and flaring at the heel —
  //    with greige stipple bands on the sides, a clay backstrap insert and a clay ring at the heel ──
  const spine = [[-0.022, 0.004], [-0.026, -0.045], [-0.036, -0.092], [-0.054, -0.13]];
  const rx = (t) => 0.0172 + 0.003 * t, rz = (t) => 0.027 + 0.006 * t * t;
  add(ovalSweep(spine, { rx, rz }), MATS.black);
  const grow = (fn, d) => (t) => fn(t) + d;
  for (const c of [Math.PI / 2, -Math.PI / 2]) add(ovalSweep(spine, { rx: grow(rx, 0.0012), rz: grow(rz, 0.0012), t0: 0.28, t1: 0.86, v0: c - 0.62, v1: c + 0.62, rings: 12, seg: 10 }), SAND);
  add(ovalSweep(spine, { rx: grow(rx, 0.0012), rz: grow(rz, 0.0012), t0: 0.12, t1: 0.5, v0: -0.45, v1: 0.45, rings: 8, seg: 8 }), MATS.accent); // backstrap
  add(ovalSweep(spine, { rx: grow(rx, 0.0035), rz: grow(rz, 0.0035), t0: 0.92, t1: 1, rings: 2 }), MATS.accent); // heel ring
  // the frame's hump flows into the grip's back
  add(profile([[-0.026, -0.03], [-0.048, -0.022], [-0.056, -0.002], [-0.05, 0.03], [-0.03, 0.006]], 0.03, round(0.008, 4)), MATS.steel);

  // ── optics rail on the top strap, fixed irons: notch at the back of the rail, blade on the rib ──
  k.topRail(-0.03, 0.095, 0.0765);
  const ironRear = k.group('ironRear', 0, 0.0865, -0.024);
  at(add(rbox(0.026, 0.006, 0.014, 0.002), MATS.black, ironRear), 0, 0.003, 0);
  for (const x of [-0.008, 0.008]) at(add(rbox(0.009, 0.011, 0.012, 0.002), MATS.black, ironRear), x, 0.0085, 0);
  const ironFront = k.group('ironFront', 0, 0.074, 0.244);
  at(add(rbox(0.005, 0.019, 0.014, 0.002), MATS.black, ironFront), 0, 0.0095, 0);
  at(add(rbox(0.0052, 0.004, 0.0142, 0.001), MATS.accent, ironFront), 0, 0.0165, 0);

  // what the viewmodel's generic mechanics expect: a still "bolt" and "charging handle"
  const bolt = k.group('bolt', 0, 0, 0), chargingHandle = k.group('chargingHandle', 0, 0, 0);

  return {
    root,
    parts: {
      muzzleMount: k.group('muzzleMount', 0, BORE, 0.262),
      scopeMount: k.group('scopeMount', 0, 0.0865, 0.03),
      hinge: crane, cylinder, rounds, hammer, loadPoint, loader: buildSpeedloader(),
      bolt, chargingHandle, trigger, selector, ejectPort,
      ironRear, ironFront, ironSight: new THREE.Vector3(0, 0.093, 0.024).multiplyScalar(SCALE),
    },
  };
}

/** Speedloader in loadPoint space (the cylinder's rear face): six rounds pointing into the chambers, black puck, clay knob. */
function buildSpeedloader() {
  const g = new THREE.Group();
  g.name = 'speedloader';
  const add = (geo, mat) => { const m = new THREE.Mesh(geo, mat); g.add(m); return m; };
  add(tube(0.023, 0.023, -0.017, -0.004, 24), MATS.black);
  add(tube(0.0085, 0.0085, -0.03, -0.017, 14), MATS.accent);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    add(tube(0.0058, 0.0052, -0.004, 0.028, 12), MATS.brass).position.set(Math.sin(a) * CYL.chamber, Math.cos(a) * CYL.chamber, 0);
  }
  return g;
}
