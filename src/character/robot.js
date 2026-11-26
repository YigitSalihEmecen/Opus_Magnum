import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PALETTE as P, toon } from '../core/toon.js';

/*
  Scrapyard robot — the player character. Chunky hard-surface parts, each rigidly bound to one bone of a
  real THREE.Skeleton, so AnimationClips / AnimationMixer can drive it by bone name.

  Character space: feet at the origin, facing +Z, its left is +X. Limb bones point down their segment
  along local -Y; hinge joints (elbow, knee) bend about local X.

    root ─ hips ─┬─ spine ─ chest ─┬─ neck ─ head
                 │                 ├─ shoulder_L ─ upperArm_L ─ forearm_L ─ hand_L ─ fingers / thumb
                 │                 └─ shoulder_R ─ …
                 ├─ thigh_L ─ shin_L ─ foot_L
                 └─ thigh_R ─ shin_R ─ foot_R

  The hand keeps the first-person grip frame every gun pose is authored in: wrist at the origin, fingers
  toward -Z, palm facing -Y, thumb toward -X (right hand; the left is mirrored). Its userData carries
  setCurl / setIndex / aimThumb.
*/

export const DIMS = { hips: 0.96, spine: 0.13, chest: 0.2, neck: 0.33, head: 0.07, shoulderX: 0.215, upper: 0.3, fore: 0.29, thigh: 0.43, shin: 0.43, hipX: 0.105 };

export const SCHEMES = {
  player: { shell: P.ivory, trim: P.clay, patch: P.kraft },
  ally: { shell: P.ivory, trim: P.sky, patch: P.oat },
  enemy: { shell: P.clay, trim: P.slate, patch: P.kraft },
};

export function robotMaterials(scheme = SCHEMES.player) {
  return {
    shell: toon(scheme.shell, { rim: 0.25 }),
    trim: toon(scheme.trim, { rim: 0.22 }),
    patch: toon(scheme.patch, { rim: 0.2 }),
    dark: toon(0x2f3033, { rim: 0.28, rimColor: 0xfff3e8 }),
    metal: toon(P.cloud, { rim: 0.3 }),
    rubber: toon(P.ink, { rim: 0.12 }),
    lens: new THREE.MeshBasicMaterial({ color: 0xffb36b, toneMapped: false }),
  };
}

export const rb = (w, h, d, r = 0.012) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2.01, h / 2.01, d / 2.01));
export const cyl = (r, h, seg = 16, axis = 'y') => { const g = new THREE.CylinderGeometry(r, r, h, seg); if (axis === 'x') g.rotateZ(Math.PI / 2); if (axis === 'z') g.rotateX(Math.PI / 2); return g; };
export const ball = (r) => new THREE.SphereGeometry(r, 18, 12);

/**
 * Shaped shell: a 2D outline (with optional holes) extruded `depth` thick with a soft chamfer.
 * axis 'x': outline drawn in the side view as [z, y], extruded across X (legs, torso).
 * axis 'z': outline drawn in the front view as [x, y], extruded along Z (arms, plates).
 */
export function ext(pts, depth, { bevel = 0.008, axis = 'x', holes = [] } = {}) {
  const v = (p) => p.map(([a, b]) => new THREE.Vector2(a, b));
  const shape = new THREE.Shape(v(pts));
  for (const h of holes) shape.holes.push(new THREE.Path(v(h)));
  const d = depth - 2 * bevel;
  const g = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 2, curveSegments: 8 });
  g.translate(0, 0, -d / 2);
  if (axis === 'x') g.rotateY(-Math.PI / 2);
  return g;
}

/** Rounded-end slot outline (for vents) from (a0, b) to (a1, b), half-height r. */
export const slot = (a0, a1, b, r) => {
  const out = [];
  for (let i = 0; i <= 6; i++) { const t = -Math.PI / 2 + (i / 6) * Math.PI; out.push([a1 + Math.cos(t) * r, b + Math.sin(t) * r]); }
  for (let i = 0; i <= 6; i++) { const t = Math.PI / 2 + (i / 6) * Math.PI; out.push([a0 + Math.cos(t) * r, b + Math.sin(t) * r]); }
  return out;
};

/** Rigid part on a bone. */
export function part(bone, geo, mat, [x = 0, y = 0, z = 0] = [], [rx = 0, ry = 0, rz = 0] = []) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  bone.add(m);
  return m;
}

export function bone(name, parent, x = 0, y = 0, z = 0) {
  const b = new THREE.Bone();
  b.name = name;
  b.position.set(x, y, z);
  parent?.add(b);
  return b;
}

// ───────────────────────────── hand ─────────────────────────────

const NEG_Z = new THREE.Vector3(0, 0, -1);
const _t = new THREE.Vector3();

/** Robot hand on a bone; see the frame notes above. Built the same size as a gloved hand so gun grips fit. */
export function buildHand(m, { left = false, name = left ? 'hand_L' : 'hand_R', skin = m.shell } = {}) {
  const hand = bone(name);
  const body = new THREE.Group(); // mirror lives here, so bone axes stay right-handed
  if (left) body.scale.x = -1;
  hand.add(body);

  part(body, ball(0.027), m.metal); // wrist ball
  part(body, rb(0.084, 0.032, 0.074, 0.01), m.dark, [0, 0, -0.06]);
  part(body, rb(0.078, 0.012, 0.056, 0.005), skin, [0, 0.02, -0.062]); // back plate
  part(body, rb(0.07, 0.012, 0.02, 0.004), m.trim, [0, 0.025, -0.094]); // knuckle bar
  part(body, cyl(0.0062, 0.064, 10, 'x'), m.metal, [0, 0.002, -0.094]); // knuckle axle

  const fingers = [];
  [-0.028, -0.0095, 0.0095, 0.028].forEach((x, i) => {
    const lens = [0.03, 0.022, 0.018].map((l) => l * (i === 3 ? 0.82 : i === 0 ? 0.95 : 1));
    let parent = body, z = -0.094;
    const joints = [];
    lens.forEach((len, j) => {
      const jt = bone(`finger${i}_${j}${left ? '_L' : '_R'}`, parent, j === 0 ? x : 0, j === 0 ? 0.002 : 0, z);
      part(jt, rb(0.019 - j * 0.0015, 0.019 - j * 0.0015, len + 0.004, 0.005), j === 2 ? skin : m.dark, [0, 0, -len / 2]);
      if (j < 2) part(jt, cyl(0.0058, 0.012, 8, 'x'), m.metal, [0, 0, -len - 0.003]); // pin, ends tucked inside the segment
      joints.push(jt);
      parent = jt;
      z = -len - 0.006;
    });
    fingers.push(joints);
  });

  const base = bone(`thumb0${left ? '_L' : '_R'}`, body, -0.04, -0.006, -0.03);
  base.rotation.set(0, 0.75, -0.4);
  part(base, rb(0.022, 0.021, 0.03, 0.006), m.dark, [0, 0, -0.014]);
  const tip = bone(`thumb1${left ? '_L' : '_R'}`, base, 0, 0, -0.031);
  part(tip, rb(0.019, 0.018, 0.022, 0.006), skin, [0, 0, -0.01]);
  const thumb = [base, tip];

  hand.userData.setCurl = (c, tc = 0.5) => {
    fingers.forEach((joints, i) => joints.forEach((j, k) => (j.rotation.x = -c * (k === 0 ? 0.85 : 1) * (1 - i * 0.03))));
    tip.rotation.set(-tc, 0, 0);
    base.rotation.set(-tc * 0.4, 0.75, -0.4);
  };
  hand.userData.setIndex = (c) => fingers[0].forEach((j, k) => (j.rotation.x = -c * (k === 0 ? 0.6 : 1)));
  /** Point the thumb's joints at world targets (knuckle, then tip). Needs current world matrices. */
  hand.userData.aimThumb = (knuckle, tipAt) => {
    for (const [joint, target] of [[base, knuckle], [tip, tipAt]]) {
      joint.parent.updateWorldMatrix(true, false);
      const d = joint.parent.worldToLocal(_t.copy(target)).sub(joint.position).normalize();
      joint.quaternion.setFromUnitVectors(NEG_Z, d);
      joint.updateWorldMatrix(false, false);
    }
  };
  hand.userData.setCurl(1.1);
  hand.userData.bones = [hand, ...fingers.flat(), ...thumb];
  return hand;
}

// ───────────────────────────── arm ─────────────────────────────

const UPV = new THREE.Vector3(0, 1, 0);
const _la = new THREE.Vector3();

/**
 * Hydraulic ram across a joint: the barrel pivots on bone A and always points at the rod's eye on bone B,
 * the rod pivots on B and points back into the barrel, so it telescopes as the joint moves.
 * Returns the per-frame update (needs current world matrices).
 */
/**
 * Size `len` (barrel) under the joint's shortest anchor spacing and `rodLen` + `len` over its longest, so the
 * rod never leaves the barrel and never pokes out of its far end.
 */
export function ram(m, a, pa, b, pb, { r = 0.015, len = 0.18, rodLen = len, lug = [0, 0] } = {}) {
  // mounting lugs bridge each pivot eye to the surface it's bolted to (dz toward that surface)
  [[a, pa, lug[0]], [b, pb, lug[1]]].forEach(([bn, p, l]) => {
    const [dx, dz] = Array.isArray(l) ? l : [0, l];
    if (dx) part(bn, rb(Math.abs(dx) + r * 0.4, r * 2.4, r * 1.6, 0.004), m.dark, [p[0] + dx / 2, p[1], p[2]]);
    if (dz) part(bn, rb(r * 1.6, r * 2.4, Math.abs(dz) + r * 0.4, 0.004), m.dark, [p[0], p[1], p[2] + dz / 2]);
  });
  const barrel = part(a, cyl(r, len, 14).translate(0, len / 2, 0), m.dark, pa);
  part(barrel, ball(r * 1.3), m.metal);
  part(barrel, cyl(r * 1.15, 0.016, 14), m.trim, [0, len - 0.005, 0]); // gland, standing proud of the barrel end
  const rod = part(b, cyl(r * 0.5, rodLen, 10).translate(0, rodLen / 2, 0), m.metal, pb);
  part(rod, ball(r * 1.2), m.metal);
  return () => {
    for (const [from, to, other, otherAt] of [[a, barrel, b, pb], [b, rod, a, pa]]) {
      other.localToWorld(_la.set(...otherAt));
      from.worldToLocal(_la).sub(to.position);
      if (_la.lengthSq() > 1e-8) to.quaternion.setFromUnitVectors(UPV, _la.normalize());
      to.updateMatrixWorld(true);
    }
  };
}

/** Upper arm → forearm → hand. `side` = +1 left, -1 right. Returns the bones (upper is the chain root) and rams. */
export function buildArm(m, side) {
  const s = side > 0 ? 'L' : 'R';
  const skin = side > 0 ? m.shell : m.patch; // scrapyard: the right upper arm is a salvaged spare
  const upper = bone(`upperArm_${s}`);
  part(upper, ball(0.058), m.metal); // shoulder ball, seated in the chest socket
  part(upper, ext([[-0.05, -0.035], [0.05, -0.035], [0.045, -0.225], [-0.045, -0.225]], 0.1, { axis: 'z', bevel: 0.012 }), skin);
  part(upper, ext([[-0.0505, -0.07], [0.0505, -0.07], [0.0495, -0.1], [-0.0495, -0.1]], 0.104, { axis: 'z', bevel: 0.005 }), m.trim);
  // elbow clevis: two cheek plates hang off the upper arm, the axle caps close them
  for (const x of [-1, 1]) {
    part(upper, rb(0.014, 0.1, 0.068, 0.006), m.dark, [x * 0.049, -0.255, 0]);
    part(upper, cyl(0.04, 0.018, 18, 'x'), m.trim, [x * 0.049, -DIMS.upper, 0]);
  }

  const fore = bone(`forearm_${s}`, upper, 0, -DIMS.upper, 0);
  part(fore, cyl(0.034, 0.082, 16, 'x'), m.dark); // knuckle between the cheeks
  part(fore, ext([[-0.038, -0.025], [0.038, -0.025], [0.056, -0.11], [0.05, -0.225], [-0.05, -0.225], [-0.056, -0.11]], 0.105, { axis: 'z', bevel: 0.014 }), m.shell);
  part(fore, rb(0.008, 0.11, 0.062, 0.003), m.trim, [side * 0.057, -0.13, 0]); // outer armour strip
  part(fore, cyl(0.036, 0.05, 16), m.dark, [0, -0.245, 0]); // wrist housing
  const links = [ram(m, upper, [0, -0.07, -0.068], fore, [0, -0.07, -0.07], { r: 0.014, len: 0.18, lug: [0.02, 0.02] })];

  const hand = buildHand(m, { left: side > 0 });
  hand.position.y = -DIMS.fore;
  hand.rotation.x = -Math.PI / 2;
  fore.add(hand);
  return { upper, fore, hand, links, dims: { upper: DIMS.upper, fore: DIMS.fore }, bones: [upper, fore, ...hand.userData.bones] };
}

// ───────────────────────────── IK ─────────────────────────────

const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _pq = new THREE.Quaternion();
const _S = new THREE.Vector3(), _E = new THREE.Vector3(), _d = new THREE.Vector3(), _u = new THREE.Vector3();
const _W = new THREE.Vector3(), _Wr = new THREE.Vector3(), _S2 = new THREE.Vector3(), _E2 = new THREE.Vector3(), _hq = new THREE.Quaternion();

/** World rotation for a limb bone running from a to b (its local -Y) that hinges about `hinge` (its local X). */
function limbQuat(a, b, hinge, out) {
  _y.subVectors(a, b).normalize();
  _x.copy(hinge).addScaledVector(_y, -hinge.dot(_y)).normalize();
  _z.crossVectors(_x, _y);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

/** Set a bone's local rotation from a world rotation. */
export function setWorldQuat(b, q) {
  b.parent.updateWorldMatrix(true, false);
  b.parent.getWorldQuaternion(_pq);
  b.quaternion.copy(_pq.invert().multiply(q));
  b.updateMatrixWorld(true);
}

/** Lay the chain shoulder → elbow → wrist through given world points (the hand gets `handQuat`). */
export function poseArm(arm, shoulder, elbow, wrist, handQuat, pole) {
  const hinge = _u.subVectors(elbow, shoulder).cross(_d.subVectors(wrist, elbow));
  if (hinge.lengthSq() < 1e-8) hinge.subVectors(pole, shoulder).cross(_d.subVectors(wrist, shoulder));
  hinge.normalize();
  arm.upper.parent.updateWorldMatrix(true, false);
  arm.upper.position.copy(arm.upper.parent.worldToLocal(_S.copy(shoulder)));
  setWorldQuat(arm.upper, limbQuat(shoulder, elbow, hinge, _q));
  setWorldQuat(arm.fore, limbQuat(elbow, wrist, hinge, _q));
  setWorldQuat(arm.hand, handQuat);
  for (const l of arm.links) l();
}

/**
 * Two-bone IK: shoulder stays on its socket, the wrist goes to `target` (world matrix of the hand frame),
 * the elbow bends toward `pole` (world point). Out-of-reach targets get a straight arm pointing at them.
 */
export function reachArm(arm, target, pole) {
  const a = arm.dims.upper, b = arm.dims.fore;
  arm.upper.getWorldPosition(_S);
  const W = _W.setFromMatrixPosition(target);
  const dir = _d.subVectors(W, _S);
  const dist = THREE.MathUtils.clamp(dir.length(), 0.05, a + b - 1e-4);
  dir.normalize();
  const cosA = (a * a + dist * dist - b * b) / (2 * a * dist);
  const u = _u.subVectors(pole, _S);
  u.addScaledVector(dir, -u.dot(dir)).normalize();
  _E.copy(_S).addScaledVector(dir, a * cosA).addScaledVector(u, a * Math.sqrt(Math.max(0, 1 - cosA * cosA)));
  const wrist = _Wr.copy(_S).addScaledVector(dir, dist);
  target.decompose(_x, _hq, _y);
  poseArm(arm, _S2.copy(_S), _E2.copy(_E), wrist, _hq, pole);
}

// ───────────────────────────── body ─────────────────────────────

/** Accordion boot around the spine column. */
function bellows(r0, r1, y0, y1, folds) {
  const pts = [new THREE.Vector2(0.055, y0)];
  for (let i = 0; i <= folds * 2; i++) pts.push(new THREE.Vector2(i % 2 ? r1 : r0, y0 + ((y1 - y0) * i) / (folds * 2)));
  pts.push(new THREE.Vector2(0.055, y1));
  return new THREE.LatheGeometry(pts, 28);
}

/** Rivet, the scrapyard bruiser. Returns { root, bones, skeleton, arms: { L, R }, legs, mats, hitboxes, update() }. */
export function buildRobot({ scheme = SCHEMES.player } = {}) {
  const m = robotMaterials(scheme);
  const D = DIMS;
  const root = bone('root');
  const hips = bone('hips', root, 0, D.hips, 0);
  const spine = bone('spine', hips, 0, D.spine, 0);
  const chest = bone('chest', spine, 0, D.chest, 0);
  const neck = bone('neck', chest, 0, D.neck, -0.01);
  const head = bone('head', neck, 0, D.head, 0);
  const links = [];

  // pelvis: chamfered block, waist turntable on top, a salvaged pouch bolted to the right hip
  part(hips, ext([[-0.1, 0.03], [0.09, 0.03], [0.105, -0.02], [0.07, -0.1], [-0.08, -0.1], [-0.105, -0.04]], 0.3, { bevel: 0.02 }), m.shell);
  part(hips, cyl(0.1, 0.05, 28), m.dark, [0, 0.055, 0]);
  part(hips, cyl(0.104, 0.014, 28), m.trim, [0, 0.043, 0]);
  part(hips, rb(0.05, 0.085, 0.13, 0.014), m.patch, [-0.172, -0.03, -0.01]);

  // abdomen: load column inside an accordion boot
  part(spine, cyl(0.055, 0.3, 16), m.metal, [0, 0.07, 0]);
  part(spine, bellows(0.082, 0.1, -0.02, 0.14, 4), m.dark);

  // chest: barrel shell, armour panel and chevron on the front, shoulder sockets, collar, back battery
  part(chest, ext([[0.12, -0.04], [0.145, 0.12], [0.135, 0.25], [0.1, 0.34], [-0.1, 0.34], [-0.13, 0.26], [-0.13, 0.02], [-0.1, -0.04]], 0.38, { bevel: 0.03 }), m.shell);
  part(chest, ext([[-0.12, -0.025], [0.12, -0.025], [0.1, 0.09], [-0.1, 0.09]], 0.03, { axis: 'z', bevel: 0.006 }), m.dark, [0, 0, 0.13]);
  part(chest, ext([[-0.09, 0], [0, 0.055], [0.09, 0], [0.09, 0.032], [0, 0.087], [-0.09, 0.032]], 0.02, { axis: 'z', bevel: 0.004 }), m.trim, [0, 0.16, 0.14]);
  for (const x of [-1, 1]) part(chest, cyl(0.062, 0.05, 20, 'x'), m.dark, [x * 0.19, 0.2, 0]);
  part(chest, cyl(0.075, 0.03, 20), m.dark, [0, 0.35, -0.01]);
  part(chest, rb(0.25, 0.27, 0.1, 0.025), m.patch, [0, 0.17, -0.17]);
  part(chest, rb(0.17, 0.035, 0.07, 0.01), m.dark, [0, 0.315, -0.17]);
  part(chest, cyl(0.008, 0.2, 8), m.metal, [0.08, 0.4, -0.2]);
  part(chest, ball(0.014), m.trim, [0.08, 0.5, -0.2]);

  // head: neck column, sensor block with a chin, one big eye, saucer on a hub with a whip antenna
  part(neck, cyl(0.038, 0.1, 16), m.metal, [0, 0.03, 0]);
  part(head, ext([[-0.065, 0], [0.075, 0], [0.088, 0.05], [0.072, 0.105], [-0.065, 0.105], [-0.078, 0.05]], 0.16, { bevel: 0.016 }), m.dark);
  part(head, cyl(0.03, 0.03, 20, 'z'), m.rubber, [0.03, 0.055, 0.08]);
  part(head, cyl(0.019, 0.012, 20, 'z'), m.lens, [0.03, 0.055, 0.096]);
  part(head, cyl(0.05, 0.02, 18), m.metal, [0, 0.112, 0]);
  const saucer = new THREE.LatheGeometry([[0, 0], [0.19, 0], [0.215, 0.018], [0.215, 0.04], [0.19, 0.06], [0, 0.064]].map(([x, y]) => new THREE.Vector2(x, y)), 36);
  part(head, saucer, m.shell, [0, 0.12, 0]);
  part(head, cyl(0.218, 0.016, 36), m.trim, [0, 0.149, 0]);
  part(head, cyl(0.007, 0.1, 6), m.rubber, [-0.08, 0.23, -0.05]);
  part(head, ball(0.014), m.trim, [-0.08, 0.28, -0.05]);

  // shoulders: an armoured cap over each ball joint, then the arm chain
  const arms = {};
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const sh = bone(`shoulder_${s}`, chest, side * D.shoulderX, 0.2, 0);
    part(sh, rb(0.15, 0.075, 0.17, 0.03), side > 0 ? m.shell : m.trim, [side * 0.05, 0.065, 0]);
    part(sh, rb(0.156, 0.02, 0.176, 0.008), m.dark, [side * 0.05, 0.03, 0]);
    const arm = buildArm(m, side);
    arm.upper.position.set(side * 0.05, -0.02, 0);
    sh.add(arm.upper);
    links.push(...arm.links);
    arms[s] = { ...arm, shoulder: sh };
  }

  // legs: hip ball → thigh (shell over a dark core, vent slots) → knee clevis + ram → shin with guard → ankle → foot
  const legs = {};
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const thigh = bone(`thigh_${s}`, hips, side * D.hipX, -0.07, 0);
    part(thigh, ball(0.058), m.metal);
    part(thigh, rb(0.1, 0.24, 0.11, 0.02), m.dark, [0, -0.2, 0]);
    part(thigh, ext([[-0.08, -0.05], [0.085, -0.05], [0.095, -0.2], [0.07, -0.34], [-0.06, -0.34], [-0.085, -0.2]], 0.13, {
      bevel: 0.016, holes: [slot(-0.03, 0.045, -0.235, 0.011), slot(-0.03, 0.045, -0.275, 0.011)],
    }), m.shell);
    if (side < 0) part(thigh, ext([[-0.083, -0.07], [0.088, -0.07], [0.091, -0.11], [-0.085, -0.11]], 0.134, { bevel: 0.005 }), m.trim);
    for (const x of [-1, 1]) {
      part(thigh, rb(0.014, 0.11, 0.085, 0.006), m.dark, [x * 0.058, -0.375, 0]);
      part(thigh, cyl(0.046, 0.018, 20, 'x'), m.trim, [x * 0.058, -D.thigh, 0]);
    }

    const shin = bone(`shin_${s}`, thigh, 0, -D.thigh, 0);
    part(shin, cyl(0.042, 0.096, 18, 'x'), m.dark);
    part(shin, ext([[-0.045, -0.03], [0.06, -0.03], [0.088, -0.12], [0.07, -0.25], [0.058, -0.35], [-0.042, -0.35], [-0.05, -0.2]], 0.096, { bevel: 0.014 }), side > 0 ? m.patch : m.shell);
    part(shin, cyl(0.04, 0.05, 16), m.dark, [0, -0.37, 0]);
    links.push(ram(m, thigh, [0, -0.13, -0.11], shin, [0, -0.13, -0.075], { r: 0.02, len: 0.22, rodLen: 0.22, lug: [0.028, 0.03] }));

    const foot = bone(`foot_${s}`, shin, 0, -D.shin, 0);
    part(foot, ball(0.038), m.metal);
    part(foot, ext([[-0.085, -0.02], [0.17, -0.02], [0.185, 0.004], [0.09, 0.033], [-0.07, 0.03], [-0.09, 0.01]], 0.13, { bevel: 0.012 }), m.shell);
    part(foot, ext([[0.115, -0.018], [0.176, -0.018], [0.192, 0.006], [0.13, 0.027]], 0.136, { bevel: 0.005 }), m.trim);
    part(foot, ext([[-0.09, -0.035], [0.18, -0.035], [0.19, -0.016], [-0.095, -0.016]], 0.14, { bevel: 0.005 }), m.rubber);
    legs[s] = { thigh, shin, foot };
  }

  return finishRobot({ root, arms, legs, links, mats: m, dims: D });
}

// ───────────────────────────── baking ─────────────────────────────

const _bm = new THREE.Matrix4();

/** Geometry in `space`'s frame with the material colour written per vertex (so differently coloured parts share one material). */
function coloured(mesh, matrix) {
  const g = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()).applyMatrix4(matrix);
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal'].includes(k)) g.deleteAttribute(k);
  const c = mesh.material.color, n = g.attributes.position.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * Draw-call reduction for a whole character: every rigid leaf mesh is merged into one mesh per parent (bone,
 * mirror group, or ram barrel/rod), coloured per vertex through one shared toon material. Same triangles in
 * the same places, so silhouettes and hitboxes are unchanged; only the draw count drops (~230 → ~80 a robot).
 * Glowing (unlit) parts are left as they are.
 */
export function bakeParts(root) {
  const mat = toon(0xffffff, { rim: 0.25, vertexColors: true });
  const nodes = [];
  root.traverse((o) => nodes.push(o));
  for (const node of nodes) {
    const leaves = node.children.filter((c) => c.isMesh && !c.children.length && c.material.isMeshToonMaterial && c.visible);
    const self = node.isMesh && node.material.isMeshToonMaterial;
    if (leaves.length + (self ? 1 : 0) < 2) continue;
    const geos = leaves.map((m) => { m.updateMatrix(); return coloured(m, m.matrix); });
    if (self) geos.unshift(coloured(node, _bm.identity()));
    const merged = mergeGeometries(geos);
    for (const m of leaves) node.remove(m);
    if (self) { node.geometry = merged; node.material = mat; }
    else { const m = new THREE.Mesh(merged, mat); m.castShadow = true; node.add(m); }
  }
  // every lit material still in use (for the hit flash)
  const mats = new Set();
  root.traverse((o) => { if (o.isMesh && o.material.emissive) mats.add(o.material); });
  return [...mats];
}

/**
 * Flatten a static model (a third-person gun) into one vertex-coloured mesh in `root`'s frame. Non-mesh nodes
 * (mounts, the muzzle socket) stay where they are; hidden, unlit and FX-layer meshes are left alone.
 */
export function bakeFlat(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const meshes = [];
  root.traverse((o) => { if (o.isMesh && o.material.isMeshToonMaterial && !o.material.transparent && o.layers.mask === 1 && o.visible && !o.children.length) meshes.push(o); });
  let vis = true;
  for (const m of meshes) { vis = true; for (let p = m; p && p !== root; p = p.parent) if (!p.visible) vis = false; m.userData.bakeVisible = vis; }
  const keep = meshes.filter((m) => m.userData.bakeVisible);
  if (keep.length < 2) return;
  const merged = mergeGeometries(keep.map((m) => coloured(m, _bm.multiplyMatrices(inv, m.matrixWorld))));
  for (const m of keep) m.parent.remove(m);
  const mesh = new THREE.Mesh(merged, toon(0xffffff, { rim: 0.3, rimColor: 0xfff3e8, vertexColors: true }));
  mesh.castShadow = true;
  root.add(mesh);
}

/** Common tail of every character builder: bake, bone map, skeleton, hit zones (head = neck and above), rams. */
export function finishRobot({ root, links, ...rest }) {
  const baked = bakeParts(root);
  const bones = {};
  root.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  const skeleton = new THREE.Skeleton(Object.values(bones));
  const update = () => { root.updateMatrixWorld(true); for (const l of links) l(); };
  update();
  return { root, bones, skeleton, hitboxes: hitProxies(root, bones), update, flashMats: baked, ...rest };
}

// one rough box per body segment, a little bigger than the plating; hands and feet ride with their limb
const SEGMENTS = ['head', 'chest', 'spine', 'hips', 'shoulder_L', 'shoulder_R', 'upperArm_L', 'upperArm_R', 'forearm_L', 'forearm_R', 'thigh_L', 'thigh_R', 'shin_L', 'shin_R'];
const HIT_PAD = 0.045;
const hitMat = new THREE.MeshBasicMaterial();

/**
 * Invisible box hit volumes on the bones, sized from the model's own parts in the build pose. Shots and
 * blasts test these instead of the detailed mesh: cheaper to raycast, and no gaps between thin limbs.
 */
function hitProxies(root, bones) {
  const boxes = new Map(), box = new THREE.Box3(), inv = new THREE.Matrix4();
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    let seg = o.parent;
    while (seg && !(seg.isBone && SEGMENTS.includes(seg.name === 'neck' ? 'head' : seg.name))) seg = seg.parent;
    if (!seg) return;
    if (seg.name === 'neck') seg = bones.head;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    inv.copy(seg.matrixWorld).invert().multiply(o.matrixWorld);
    box.copy(o.geometry.boundingBox).applyMatrix4(inv);
    boxes.set(seg, (boxes.get(seg) ?? new THREE.Box3()).union(box));
  });
  const out = [];
  for (const [seg, b] of boxes) {
    b.expandByScalar(HIT_PAD);
    const size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    const m = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), hitMat);
    m.position.copy(c);
    m.visible = false;
    m.name = `hit_${seg.name}`;
    m.userData.zone = seg === bones.head ? 'head' : 'body';
    seg.add(m);
    out.push(m);
  }
  root.updateMatrixWorld(true);
  return out;
}

// ───────────────────────────── holding a gun ─────────────────────────────

const _hm = new THREE.Matrix4(), _hp = new THREE.Object3D(), _pole = new THREE.Vector3();
const D2R = Math.PI / 180;

/**
 * Put both hands on a gun using its first-person grip poses (gun space, same hand frame):
 * `frame` is the gun's frame (the gun model sits inside it), `poses` the weapon def's poses.
 */
export function gripGun(robot, frame, poses, { left = poses.lhRest, trigger = poses.triggerCurl } = {}) {
  frame.updateWorldMatrix(true, false);
  for (const [side, pose] of [['R', poses.rightHand], ['L', left]]) {
    if (!pose) continue;
    const arm = robot.arms[side];
    _hp.position.set(pose[0], pose[1], pose[2]);
    _hp.rotation.set(pose[3] * D2R, pose[4] * D2R, pose[5] * D2R, 'YXZ');
    _hp.updateMatrix();
    _hm.multiplyMatrices(frame.matrixWorld, _hp.matrix);
    // elbows down and out, a little back
    arm.shoulder.localToWorld(_pole.set(side === 'L' ? 0.35 : -0.35, -0.6, -0.25));
    reachArm(arm, _hm, _pole);
    arm.hand.userData.setCurl(pose[6]);
  }
  if (trigger !== undefined) robot.arms.R.hand.userData.setIndex(trigger);
  robot.update();
}
