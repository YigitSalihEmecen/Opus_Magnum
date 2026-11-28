import * as THREE from 'three';
import { MATS, profile, rbox, tube, f2z, magPrint } from './models/parts.js';
import { toon } from '../core/toon.js';
import { FX_LAYER } from '../core/renderer.js';

/*
  Attachment library shared by all weapons. Each definition:
    { id, slot, name, blurb, stats: { ...multipliers }, build() → THREE.Group }
  build() returns a group in the slot's mount space (see the mounts in models/*.js):
    muzzle — origin at the barrel crown, +f forward     scope — origin on the rail top
    mag    — origin at the seated top of the mag         grip  — origin under the rail
    stock  — gun space (mount sits at the gun origin)
  Stat keys (multipliers unless noted): vRecoil, hRecoil, ads, reload, flash, choke (pellet ring), magSize (abs),
  zoom (abs), suppressed (bool).
*/

export const SLOTS = ['muzzle', 'scope', 'mag', 'grip', 'stock'];
export const SLOT_LABEL = { muzzle: 'Muzzle', scope: 'Optic', mag: 'Magazine', grip: 'Grip', stock: 'Stock' };

const group = (name) => { const g = new THREE.Group(); g.name = name; return g; };
function mesh(parent, geo, mat, x = 0, y = 0, f = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, f2z(f));
  m.castShadow = true;
  parent.add(m);
  return m;
}
const ring = (parent, r, f0, f1, mat, seg = 28) => mesh(parent, tube(r, r, f0, f1, seg, true), mat);
const TUBE_MATS = new Map();
/** Open, double-sided optic body: you see its inner wall when looking through, not what lies beyond. */
function shell(parent, r0, r1, f0, f1, mat, y = 0, seg = 32) {
  if (!TUBE_MATS.has(mat)) TUBE_MATS.set(mat, toon(mat.color.getHex(), { rim: 0.25, rimColor: 0xfff3e8, side: THREE.DoubleSide }));
  return mesh(parent, tube(r0, r1, f0, f1, seg, true), TUBE_MATS.get(mat), 0, y);
}
/** Tube with real wall thickness: outer + inner skins joined by flat rings at both ends. */
function thickTube(parent, rIn, rOut, f0, f1, mat, seg = 32) {
  mesh(parent, tube(rOut, rOut, f0, f1, seg, true), mat);
  shell(parent, rIn, rIn, f0, f1, mat, 0, seg);
  for (const [f, face] of [[f0, 0], [f1, Math.PI]]) mesh(parent, new THREE.RingGeometry(rIn, rOut, seg).rotateY(face), mat, 0, 0, f);
}

/**
 * Magnified optics: depth-only disc just behind the eyepiece reticle. While aimed it occludes the scope's
 * insides and the gun beyond, so the eyepiece shows the world while the body and gun stay drawn around it.
 */
function portal(parent, r, y, f) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(r, 40), new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }));
  m.position.set(0, y, f2z(f));
  m.renderOrder = -1;
  m.visible = false;
  m.userData.adsPortal = true;
  parent.add(m);
}

/** Unlit glass disc/plane with a reticle texture, skipped by the outline pass. */
function glass(parent, tex, size, x, y, f, round = true) {
  const geo = round ? new THREE.CircleGeometry(size / 2, 40) : new THREE.PlaneGeometry(size, size);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
  m.position.set(x, y, f2z(f));
  m.layers.set(FX_LAYER);
  parent.add(m);
  return m;
}

// reticles and mag prints are drawn once and shared: an optic or mag is rebuilt on every swap
const reticles = new Map();
let curvedPrint, drumPrint;

function reticle(draw, tint = 'rgba(150, 190, 200, 0.10)') {
  const key = draw.toString() + tint;
  if (!reticles.has(key)) reticles.set(key, drawReticle(draw, tint));
  return reticles.get(key);
}

function drawReticle(draw, tint) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  if (tint) {
    g.fillStyle = tint;
    g.beginPath(); g.arc(256, 256, 256, 0, Math.PI * 2); g.fill();
  }
  g.translate(256, 256);
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

const RED = '#ff5533';

// ───────────────────────────── muzzles ─────────────────────────────

function compensator() {
  const g = group('compensator');
  ring(g, 0.0135, 0, 0.012, MATS.steel);
  mesh(g, tube(0.0178, 0.0178, 0.012, 0.068, 8).rotateZ(Math.PI / 8), MATS.black);
  ring(g, 0.0182, 0.016, 0.02, MATS.accent, 8).rotation.z = Math.PI / 8;
  mesh(g, tube(0.0178, 0.0145, 0.068, 0.075, 24), MATS.steel);
  for (const f of [0.026, 0.04, 0.054]) mesh(g, rbox(0.013, 0.003, 0.007, 0.001), MATS.vent, 0, 0.0168, f);
  for (const x of [-0.0168, 0.0168]) for (const f of [0.031, 0.051]) mesh(g, rbox(0.003, 0.011, 0.013, 0.0012), MATS.vent, x, 0.002, f);
  mesh(g, new THREE.CircleGeometry(0.0065, 20), MATS.vent, 0, 0, 0.0752);
  return { obj: g, tip: 0.078 };
}

function flashHider() {
  const g = group('flashHider');
  mesh(g, tube(0.0138, 0.0158, 0, 0.018), MATS.steel);
  ring(g, 0.0162, 0.005, 0.008, MATS.accent);
  ring(g, 0.0162, 0.011, 0.013, MATS.black);
  mesh(g, tube(0.009, 0.0095, 0.018, 0.06, 16), MATS.vent);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const prong = mesh(g, rbox(0.0062, 0.0062, 0.05, 0.0015), MATS.black, Math.cos(a) * 0.0125, Math.sin(a) * 0.0125, 0.043);
    prong.rotation.z = a;
    const tipCap = mesh(g, rbox(0.007, 0.007, 0.006, 0.002), MATS.steel, Math.cos(a) * 0.0128, Math.sin(a) * 0.0128, 0.066);
    tipCap.rotation.z = a;
  }
  return { obj: g, tip: 0.07 };
}

/** Rifle/SMG can: oversized rectangular box in the pistol can's style, centred on the bore. */
function suppressor() {
  const g = group('suppressor');
  const SAND = toon(0xebdbbc, { rim: 0.15 });
  // quick-detach collar with knurling
  mesh(g, tube(0.0165, 0.0165, 0, 0.032, 24), MATS.steel);
  for (let i = 0; i < 5; i++) ring(g, 0.0172, 0.004 + i * 0.0045, 0.0062 + i * 0.0045, MATS.black, 24);
  mesh(g, profile([[0.026, -0.036], [0.052, -0.036], [0.052, 0.034], [0.034, 0.034], [0.026, 0.024]], 0.056, { bevel: 0.006, inset: true }), MATS.black);
  // main box
  mesh(g, profile([[0.046, -0.044], [0.25, -0.044], [0.272, -0.028], [0.272, 0.026], [0.26, 0.04], [0.046, 0.04]], 0.064, { bevel: 0.01, segments: 3, inset: true }), MATS.poly);
  mesh(g, profile([[0.09, -0.03], [0.212, -0.03], [0.222, -0.018], [0.222, 0.022], [0.09, 0.022]], 0.0675, { bevel: 0.002 }), SAND);
  for (let i = 0; i < 4; i++) mesh(g, rbox(0.068, 0.004, 0.018, 0.0012), MATS.vent, 0, 0.012 - i * 0.012, 0.15);
  mesh(g, rbox(0.0665, 0.078, 0.012, 0.004), MATS.accent, 0, -0.002, 0.066);
  mesh(g, rbox(0.0665, 0.01, 0.16, 0.003), MATS.black, 0, -0.04, 0.16);
  // front cap
  mesh(g, profile([[0.266, -0.032], [0.292, -0.027], [0.292, 0.023], [0.266, 0.03]], 0.052, { bevel: 0.006, inset: true }), MATS.steel);
  mesh(g, new THREE.CircleGeometry(0.01, 20).rotateY(Math.PI), MATS.vent, 0, 0, 0.2924);
  mesh(g, rbox(0.034, 0.007, 0.002, 0.001), MATS.vent, 0, -0.016, 0.2924);
  return { obj: g, tip: 0.294 };
}

/** SMG can: fat cylinder, flutes, closed parts throughout (bands bury their inner skins in the body). */
function smgSuppressor() {
  const g = group('smgSuppressor');
  mesh(g, tube(0.0165, 0.0165, 0, 0.03, 24), MATS.steel);
  for (let i = 0; i < 5; i++) ring(g, 0.0172, 0.004 + i * 0.0045, 0.0062 + i * 0.0045, MATS.black, 24);
  mesh(g, tube(0.0172, 0.036, 0.028, 0.05, 40), MATS.black);
  mesh(g, tube(0.036, 0.036, 0.048, 0.25, 48), MATS.poly);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const fl = mesh(g, rbox(0.0034, 0.003, 0.15, 0.0012), MATS.vent, Math.cos(a) * 0.0356, Math.sin(a) * 0.0356, 0.152);
    fl.rotation.z = a;
  }
  thickTube(g, 0.034, 0.0372, 0.054, 0.068, MATS.accent, 48);
  thickTube(g, 0.034, 0.0368, 0.23, 0.237, MATS.ivory, 48);
  // front cap: stepped, ported face
  mesh(g, tube(0.036, 0.031, 0.25, 0.268, 48), MATS.steel);
  mesh(g, new THREE.CircleGeometry(0.025, 40).rotateY(Math.PI), MATS.black, 0, 0, 0.2683);
  mesh(g, new THREE.CircleGeometry(0.0075, 20).rotateY(Math.PI), MATS.vent, 0, 0, 0.2686);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    mesh(g, new THREE.CircleGeometry(0.0028, 12).rotateY(Math.PI), MATS.vent, Math.cos(a) * 0.0175, Math.sin(a) * 0.0175, 0.2686);
  }
  return { obj: g, tip: 0.27 };
}

// ───────────────────────────── magazines ─────────────────────────────

function rounds(mag) {
  for (let i = 0; i < 2; i++) {
    const r = group('round');
    mesh(r, tube(0.0058, 0.0055, -0.03, 0.012, 12), MATS.brass);
    mesh(r, new THREE.ConeGeometry(0.0055, 0.02, 12).rotateX(-Math.PI / 2), MATS.copper, 0, 0, 0.022);
    r.position.set(i ? 0.004 : -0.004, 0.006 - i * 0.008, 0);
    mag.add(r);
  }
}

/** Curved box magazine: arc angle A (radians) sets the length. */
function curvedMag(A, { N = 14, R = 0.42, flare = 0.006 } = {}) {
  const mag = group('magazine');
  const center = (a) => [R * (1 - Math.cos(a)), -R * Math.sin(a)];
  const halfW = (t) => 0.034 + t * flare;
  const edge = (sign, inset) => Array.from({ length: N + 1 }, (_, i) => {
    const t = i / N, a = t * A;
    const [cf, cy] = center(a);
    const hw = halfW(t) - inset;
    return [cf + Math.cos(a) * hw * sign, cy + Math.sin(a) * hw * sign];
  });
  const outline = (inset = 0, from = 0, to = N) => [...edge(1, inset).slice(from, to + 1), ...edge(-1, inset).slice(from, to + 1).reverse()];

  const printMat = (curvedPrint ??= toon(0xffffff, { map: magPrint(), rim: 0.3, rimColor: 0xfff3e8 }));
  mesh(mag, profile(outline(), 0.03, { bevel: 0.0035 }), printMat);
  mesh(mag, profile(outline(0, 0, 2), 0.034, { bevel: 0.003 }), MATS.poly);
  mesh(mag, profile(outline(0, N - 2, N), 0.034, { bevel: 0.003 }), MATS.poly);
  mesh(mag, profile(outline(0.022, 2, N - 2), 0.0345, { bevel: 0.0015 }), MATS.poly);
  const [bf, by] = center(A);
  const plate = mesh(mag, rbox(0.04, 0.014, 0.088 + flare * 2, 0.004), MATS.black, 0, by - 0.012, bf);
  plate.rotation.x = A;
  const tab = mesh(mag, rbox(0.012, 0.006, 0.03, 0.002), MATS.accent, 0, by - 0.02, bf + 0.03);
  tab.rotation.x = A;
  rounds(mag);
  return mag;
}

/** Straight SMG stick mag hanging from the foregrip; L = full length (more sticks out below). */
function stickMag(L, accent = MATS.olive) {
  const mag = group('magazine');
  mesh(mag, rbox(0.023, L, 0.031, 0.004), MATS.poly, 0, -L / 2, 0);
  for (let y = -0.035; y > -L + 0.03; y -= 0.026) mesh(mag, rbox(0.0245, 0.0035, 0.025, 0.0012), MATS.black, 0, y, 0);
  mesh(mag, rbox(0.0242, L * 0.42, 0.008, 0.002), accent, 0, -L * 0.6, -0.009);
  mesh(mag, rbox(0.029, 0.012, 0.038, 0.004), MATS.black, 0, -L - 0.004, 0.002);
  mesh(mag, rbox(0.01, 0.005, 0.022, 0.002), MATS.accent, 0, -L - 0.012, 0.004);
  rounds(mag);
  mag.children.filter((c) => c.name === 'round').forEach((r) => r.scale.setScalar(0.78));
  return mag;
}

function drumMag() {
  const mag = group('magazine');
  // short feed tower
  const tower = curvedMag(0.16, { N: 4, flare: 0.001 });
  tower.children.filter((c) => c.name === 'round').forEach((r) => r.removeFromParent());
  mag.add(tower);
  rounds(mag);
  const cy = -0.128, cf = 0.03, R = 0.074;
  const body = mesh(mag, new THREE.CylinderGeometry(R, R, 0.058, 48).rotateZ(Math.PI / 2), MATS.poly, 0, cy, cf);
  body.name = 'drum';
  const printMat = (drumPrint ??= toon(0xffffff, { map: magPrint(), rim: 0.25 }));
  printMat.map.repeat.set(1.4, 1.4);
  for (const side of [-1, 1]) {
    const face = mesh(mag, new THREE.CircleGeometry(R * 0.86, 48), printMat, side * 0.0292, cy, cf);
    face.rotation.y = (side * Math.PI) / 2;
    for (const [rr, t] of [[R * 0.88, 0.0035], [R * 0.6, 0.0025], [R * 0.32, 0.0025]]) {
      const tor = mesh(mag, new THREE.TorusGeometry(rr, t, 8, 48), MATS.black, side * 0.0295, cy, cf);
      tor.rotation.y = Math.PI / 2;
    }
  }
  // circumference ribs + winding key + round-count window
  for (const x of [-0.018, 0, 0.018]) {
    const rib = mesh(mag, new THREE.TorusGeometry(R + 0.001, 0.0022, 6, 60), MATS.black, x, cy, cf);
    rib.rotation.y = Math.PI / 2;
  }
  mesh(mag, new THREE.CylinderGeometry(0.013, 0.013, 0.012, 20).rotateZ(Math.PI / 2), MATS.accent, -0.035, cy, cf);
  mesh(mag, rbox(0.006, 0.006, 0.04, 0.002), MATS.steel, -0.042, cy, cf);
  const win = mesh(mag, rbox(0.004, 0.012, 0.05, 0.002), MATS.ivory, 0.03, cy - 0.04, cf + 0.02);
  win.rotation.x = 0.5;
  return mag;
}

// ───────────────────────────── optics ─────────────────────────────

function railClamp(g, len, f = 0) {
  mesh(g, rbox(0.029, 0.009, len, 0.002), MATS.black, 0, 0.0045, f);
  mesh(g, new THREE.CylinderGeometry(0.0048, 0.0048, 0.008, 14).rotateZ(Math.PI / 2), MATS.steel, 0.019, 0.004, f);
  mesh(g, new THREE.CylinderGeometry(0.0036, 0.0036, 0.003, 14).rotateZ(Math.PI / 2), MATS.accent, 0.0235, 0.004, f);
}

const HOLO_SCALE = 0.8;
const HOLO_SIGHT = [0, 0.0315, 0.004];

/** Rounded rectangle in the x/y plane; top and bottom corners get their own radius. */
function rrect(p, x, y0, y1, rt, rb) {
  p.moveTo(-x + rb, y0); p.lineTo(x - rb, y0); p.quadraticCurveTo(x, y0, x, y0 + rb);
  p.lineTo(x, y1 - rt); p.quadraticCurveTo(x, y1, x - rt, y1);
  p.lineTo(-x + rt, y1); p.quadraticCurveTo(-x, y1, -x, y1 - rt);
  p.lineTo(-x, y0 + rb); p.quadraticCurveTo(-x, y0, -x + rb, y0);
  return p;
}

/** Inverted U in the x/y plane: open at yb, outer/inner top corners rounded by ro/ri. */
function arch(p, xo, xi, yb, yo, yi, ro, ri) {
  p.moveTo(-xo, yb); p.lineTo(-xo, yo - ro); p.quadraticCurveTo(-xo, yo, -xo + ro, yo);
  p.lineTo(xo - ro, yo); p.quadraticCurveTo(xo, yo, xo, yo - ro); p.lineTo(xo, yb);
  p.lineTo(xi, yb); p.lineTo(xi, yi - ri); p.quadraticCurveTo(xi, yi, xi - ri, yi);
  p.lineTo(-xi + ri, yi); p.quadraticCurveTo(-xi, yi, -xi, yi - ri); p.lineTo(-xi, yb);
  p.closePath();
  return p;
}

/** Extrudes an x/y shape along the bore between f0 and f1. */
function extrude(parent, mat, f0, f1, shape, bevel = 0.0008) {
  const geo = new THREE.ExtrudeGeometry(shape, { depth: f1 - f0 - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 10 });
  geo.translate(0, 0, f2z(f1) + bevel);
  return mesh(parent, geo, mat);
}

/** Hollow box section along the bore (outer/hole: [halfWidth, y0, y1, rTop, rBottom]). */
function frame(parent, mat, f0, f1, outer, hole) {
  const s = rrect(new THREE.Shape(), ...outer);
  s.holes.push(rrect(new THREE.Path(), ...hole));
  return extrude(parent, mat, f0, f1, s);
}

function holo() {
  const root = group('holo');
  const g = group('holoBody'); // scaled inner group: swap animations drive the outer group's transform
  g.scale.setScalar(HOLO_SCALE);
  root.add(g);
  railClamp(g, 0.06, 0.004);
  // electronics deck the window sits on
  mesh(g, rbox(0.038, 0.01, 0.05, 0.004), MATS.steel, 0, 0.0105, 0.004);
  // thin-walled window body with a lip at the back
  const hole = [0.019, 0.0158, 0.0472, 0.0075, 0.0025];
  frame(g, MATS.poly, -0.012, 0.014, [0.0212, 0.0132, 0.0495, 0.009, 0.003], hole);
  frame(g, MATS.black, -0.016, -0.011, [0.0222, 0.0125, 0.0505, 0.0098, 0.0035], hole);
  // hood arching forward past the window, legs down onto the battery cap
  extrude(g, MATS.black, 0.012, 0.032, arch(new THREE.Shape(), 0.0232, 0.0196, 0.012, 0.0525, 0.0479, 0.012, 0.008));
  // raised spine along the top
  mesh(g, rbox(0.012, 0.0028, 0.03, 0.001), MATS.steel, 0, 0.0504, 0.006);
  // right side: dial housing standing proud of the wall, two knurled dials on its face
  mesh(g, rbox(0.006, 0.03, 0.026, 0.002), MATS.steel, 0.0225, 0.028, 0);
  for (const [y, f] of [[0.035, -0.004], [0.021, 0.006]]) {
    mesh(g, new THREE.CylinderGeometry(0.005, 0.005, 0.003, 20).rotateZ(Math.PI / 2), MATS.black, 0.0264, y, f);
    mesh(g, rbox(0.0012, 0.0016, 0.0068, 0.0005), MATS.steel, 0.0281, y, f);
  }
  // left side: slim plate with an accent stripe
  mesh(g, rbox(0.003, 0.02, 0.02, 0.001), MATS.steel, -0.0218, 0.03, 0.001);
  mesh(g, rbox(0.001, 0.012, 0.003, 0.0004), MATS.accent, -0.0236, 0.03, -0.004);
  // battery cap across the front foot, knurled end on the right
  mesh(g, new THREE.CylinderGeometry(0.0075, 0.0075, 0.044, 22).rotateZ(Math.PI / 2), MATS.poly, 0, 0.008, 0.026);
  mesh(g, new THREE.CylinderGeometry(0.0088, 0.0088, 0.006, 22).rotateZ(Math.PI / 2), MATS.black, 0.024, 0.008, 0.026);
  mesh(g, new THREE.CylinderGeometry(0.0034, 0.0034, 0.0015, 14).rotateZ(Math.PI / 2), MATS.accent, 0.0275, 0.008, 0.026);
  // rear control buttons under the window
  mesh(g, rbox(0.009, 0.004, 0.004, 0.0015), MATS.accent, -0.0075, 0.012, -0.02);
  mesh(g, rbox(0.009, 0.004, 0.004, 0.0015), MATS.rubber, 0.0075, 0.012, -0.02);
  const tex = reticle((c) => {
    c.strokeStyle = RED; c.fillStyle = RED;
    c.lineWidth = 3;
    c.beginPath(); c.arc(0, 0, 59, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(0, 0, 3.5, 0, Math.PI * 2); c.fill();
    c.lineWidth = 2.5;
    for (const [x, y] of [[0, -1], [1, 0], [-1, 0], [0, 1]]) { c.beginPath(); c.moveTo(x * 66, y * 66); c.lineTo(x * 75, y * 75); c.stroke(); }
  }, 'rgba(150, 200, 210, 0.07)');
  glass(g, tex, 0.036, ...HOLO_SIGHT, false);
  return root;
}

function redDot() {
  const g = group('redDot');
  railClamp(g, 0.04);
  // riser stops under the tube (tube bottom at y 0.0175) so nothing shows through the window
  mesh(g, rbox(0.022, 0.012, 0.034, 0.003), MATS.black, 0, 0.0115, 0);
  const y = 0.036;
  const body = group('tube');
  body.position.y = y;
  g.add(body);
  // thick-walled body with chunky steel bezels at both ends
  thickTube(body, 0.0152, 0.0185, -0.028, 0.026, MATS.poly);
  thickTube(body, 0.0152, 0.0202, -0.036, -0.028, MATS.steel);
  thickTube(body, 0.0152, 0.0202, 0.026, 0.034, MATS.steel);
  ring(body, 0.0189, 0.004, 0.009, MATS.accent, 32);
  // turrets sit on the outside of the tube wall, not through it
  mesh(body, new THREE.CylinderGeometry(0.0072, 0.0072, 0.01, 18), MATS.steel, 0, 0.0245, -0.004);
  mesh(body, new THREE.CylinderGeometry(0.0072, 0.0072, 0.01, 18).rotateZ(Math.PI / 2), MATS.steel, 0.0245, 0, -0.004);
  mesh(body, new THREE.CylinderGeometry(0.0058, 0.0058, 0.003, 18), MATS.accent, 0, 0.031, -0.004);
  // clear glass: just the dot, no tinted lens disc
  const tex = reticle((c) => {
    c.fillStyle = RED;
    c.beginPath(); c.arc(0, 0, 8.5, 0, Math.PI * 2); c.fill();
  }, null);
  glass(body, tex, 0.03, 0, 0, -0.031);
  return g;
}

function prism2x() {
  const g = group('prism2x');
  railClamp(g, 0.07);
  const y = 0.03;
  const b = group('body');
  b.position.y = y;
  g.add(b);
  // squat prism housing wrapping the optical axis; the eyepiece portal hides its inside while aimed
  mesh(b, rbox(0.04, 0.042, 0.058, 0.009), MATS.poly, 0, -0.001, 0.002);
  mesh(b, rbox(0.032, 0.007, 0.046, 0.003), MATS.black, 0, 0.022, 0.002);
  mesh(b, rbox(0.042, 0.008, 0.05, 0.003), MATS.steel, 0, -0.019, 0.002);
  // objective: thick bell with a steel bezel and accent band
  mesh(b, tube(0.02, 0.0245, 0.026, 0.035, 32), MATS.black);
  thickTube(b, 0.0185, 0.025, 0.034, 0.06, MATS.black);
  thickTube(b, 0.0192, 0.0258, 0.057, 0.066, MATS.steel);
  ring(b, 0.0254, 0.044, 0.05, MATS.accent, 32);
  // ocular with a rubber eyecup
  mesh(b, tube(0.0205, 0.019, -0.031, -0.024, 32), MATS.black);
  thickTube(b, 0.0165, 0.021, -0.048, -0.03, MATS.poly);
  thickTube(b, 0.0172, 0.0232, -0.056, -0.046, MATS.rubber);
  // battery pod on the right, elevation cap on top
  mesh(b, rbox(0.009, 0.022, 0.026, 0.003), MATS.steel, 0.023, -0.002, 0.006);
  mesh(b, new THREE.CylinderGeometry(0.006, 0.006, 0.004, 18).rotateZ(Math.PI / 2), MATS.accent, 0.0285, -0.002, 0.006);
  mesh(b, new THREE.CylinderGeometry(0.008, 0.008, 0.008, 20), MATS.steel, 0, 0.028, 0.002);
  mesh(b, new THREE.CylinderGeometry(0.0065, 0.0065, 0.003, 20), MATS.accent, 0, 0.0328, 0.002);
  const tex = reticle((c) => {
    c.fillStyle = '#141413'; c.strokeStyle = '#141413';
    // post rising from the bottom, ending in an arrow at the centre
    c.fillRect(-5, 30, 10, 230);
    c.beginPath(); c.moveTo(0, 0); c.lineTo(-22, 34); c.lineTo(22, 34); c.closePath(); c.fill();
    c.fillStyle = RED;
    c.beginPath(); c.moveTo(0, 6); c.lineTo(-12, 26); c.lineTo(12, 26); c.closePath(); c.fill();
    c.lineWidth = 3;
    for (const s of [-1, 1]) { c.beginPath(); c.moveTo(s * 70, 0); c.lineTo(s * 230, 0); c.stroke(); }
    for (let i = 1; i <= 3; i++) for (const s of [-1, 1]) { c.beginPath(); c.moveTo(s * 70 * i * 0.9, -8); c.lineTo(s * 70 * i * 0.9, 8); c.stroke(); }
  }, 'rgba(150, 190, 210, 0.08)');
  glass(b, tex, 0.03, 0, 0, -0.05);
  glass(b, reticle(() => {}, 'rgba(120, 170, 210, 0.14)'), 0.036, 0, 0, 0.06);
  portal(b, 0.0165, 0, -0.049);
  return g;
}

function scope3x({ L = 0, B = 1, name = 'scope3x', acc = MATS.accent, dot = true } = {}) {
  const g = group(name);
  const y = 0.04;
  for (const f of [-0.03, 0.045 + L * 0.6]) {
    mesh(g, rbox(0.028, 0.012, 0.018, 0.002), MATS.black, 0, 0.006, f);
    mesh(g, rbox(0.02, 0.02, 0.016, 0.003), MATS.black, 0, 0.018, f);
    // clamp band: inner skin buried in the solid tube so only the outer band shows
    const band = group('ring');
    band.position.y = y;
    g.add(band);
    thickTube(band, 0.0152, 0.0198, f - 0.008, f + 0.008, MATS.black, 36);
    mesh(g, new THREE.CylinderGeometry(0.0035, 0.0035, 0.008, 10).rotateZ(Math.PI / 2), MATS.steel, 0.02, 0.006, f);
  }
  const s = group('tube');
  s.position.y = y;
  g.add(s);
  // solid main tube; the eyepiece portal hides its inside while aimed
  mesh(s, tube(0.016, 0.016, -0.07, 0.078 + L, 32), MATS.poly);
  // eyepiece: thick bell, taper into the tube, power ring and rubber cup
  // bands and caps overlap the bell with their inner skins tucked inside its wall, so no faces coincide
  thickTube(s, 0.0185, 0.0222, -0.11, -0.078, MATS.black, 36);
  shell(s, 0.0218, 0.0155, -0.079, -0.062, MATS.black, 0, 36);
  thickTube(s, 0.0205, 0.0228, -0.1, -0.093, acc, 36);
  thickTube(s, 0.0192, 0.0236, -0.12, -0.108, MATS.rubber, 36);
  // objective: taper out to a thick bell with steel bezel and ivory band
  shell(s, 0.0155, 0.0258 * B, 0.076 + L, 0.097 + L, MATS.black, 0, 40);
  thickTube(s, 0.0225 * B, 0.0262 * B, 0.096 + L, 0.13 + L, MATS.poly, 40);
  thickTube(s, 0.0228 * B, 0.0272 * B, 0.127 + L, 0.138 + L, MATS.steel, 40);
  ring(s, 0.0266 * B, 0.104 + L, 0.108 + L, MATS.ivory, 40);
  // turret saddle with elevation (top), windage (right), parallax (left)
  mesh(s, rbox(0.04, 0.04, 0.03, 0.013), MATS.black, 0, 0, 0.008);
  const turret = (rot, cap) => {
    const t = group('turret');
    t.position.set(0, 0, f2z(0.008));
    t.rotation.z = rot;
    mesh(t, new THREE.CylinderGeometry(0.0095, 0.0095, 0.007, 20).translate(0, 0.021, 0), MATS.black);
    mesh(t, new THREE.CylinderGeometry(0.011, 0.011, 0.01, 24).translate(0, 0.029, 0), MATS.steel);
    for (let i = 0; i < 3; i++) mesh(t, new THREE.CylinderGeometry(0.0113, 0.0113, 0.0012, 24).translate(0, 0.0255 + i * 0.0032, 0), MATS.black);
    if (cap) mesh(t, new THREE.CylinderGeometry(0.009, 0.009, 0.002, 24).translate(0, 0.0345, 0), acc);
    s.add(t);
  };
  turret(0, true);
  turret(-Math.PI / 2, false);
  turret(Math.PI / 2, false);
  const tex = reticle((c) => {
    c.strokeStyle = '#141413'; c.fillStyle = '#141413';
    c.lineWidth = 2.5;
    c.beginPath(); c.moveTo(-256, 0); c.lineTo(256, 0); c.moveTo(0, -256); c.lineTo(0, 256); c.stroke();
    c.fillRect(140, -5, 116, 10); c.fillRect(-256, -5, 116, 10);
    c.fillRect(-5, 140, 10, 116); c.fillRect(-5, -256, 10, 116);
    c.lineWidth = 2;
    for (let i = 1; i <= 4; i++) for (const s2 of [-1, 1]) {
      c.beginPath(); c.moveTo(-7, s2 * i * 26); c.lineTo(7, s2 * i * 26); c.stroke();
      c.beginPath(); c.moveTo(s2 * i * 26, -7); c.lineTo(s2 * i * 26, 7); c.stroke();
    }
    if (!dot) return;
    c.fillStyle = RED;
    c.beginPath(); c.arc(0, 0, 4, 0, Math.PI * 2); c.fill();
  }, 'rgba(140, 180, 200, 0.06)');
  glass(s, tex, 0.034, 0, 0, -0.116);
  glass(s, reticle(() => {}, 'rgba(110, 160, 210, 0.16)'), 0.046 * B, 0, 0, 0.132 + L);
  portal(s, 0.0185, 0, -0.114);
  return g;
}

/** Sniper glass: the 3× body stretched with a wide objective bell, a touch bigger overall. */
const SCOPE6 = 1.3;
function scope6x() {
  const g = scope3x({ L: 0.09, B: 1.32, name: 'scope6x', acc: MATS.blue, dot: false });
  g.scale.setScalar(SCOPE6);
  return g;
}

/** Revolver comp: a slotted block clamped under the shroud's crown, ports on top. */
function revolverComp() {
  const g = group('revolverComp');
  mesh(g, rbox(0.03, 0.05, 0.05, 0.006), MATS.poly, 0, 0.002, 0.024);
  mesh(g, rbox(0.031, 0.008, 0.014, 0.003), MATS.accent, 0, 0.002, 0.006);
  for (const f of [0.022, 0.036]) mesh(g, rbox(0.02, 0.006, 0.008, 0.002), MATS.vent, 0, 0.026, f);
  mesh(g, new THREE.CircleGeometry(0.007, 18).rotateY(Math.PI), MATS.vent, 0, 0, 0.0495);
  return { obj: g, tip: 0.05 };
}

/** Twin choke for the double barrel: one ringed block over both muzzles. */
function twinChoke() {
  const g = group('twinChoke');
  mesh(g, rbox(0.064, 0.034, 0.05, 0.008), MATS.poly, 0, 0, 0.025);
  mesh(g, rbox(0.066, 0.036, 0.01, 0.005), MATS.red, 0, 0, 0.01);
  for (const x of [-0.0125, 0.0125]) {
    ring(g, 0.0105, 0.05, 0.056, MATS.steel, 20).position.x = x;
    mesh(g, new THREE.CircleGeometry(0.0065, 16).rotateY(Math.PI), MATS.vent, x, 0, 0.0505);
  }
  return { obj: g, tip: 0.056 };
}

/** Sniper brake: castellated block with side ports and a blue collar. */
function sniperBrake() {
  const g = group('sniperBrake');
  mesh(g, tube(0.016, 0.016, 0, 0.02, 20), MATS.steel);
  mesh(g, rbox(0.044, 0.044, 0.1, 0.006), MATS.poly, 0, 0, 0.07);
  mesh(g, rbox(0.0455, 0.0455, 0.012, 0.004), MATS.blue, 0, 0, 0.03);
  for (let i = 0; i < 3; i++) {
    const f = 0.055 + i * 0.024;
    mesh(g, rbox(0.047, 0.016, 0.012, 0.002), MATS.vent, 0, 0, f);
    mesh(g, rbox(0.014, 0.047, 0.012, 0.002), MATS.vent, 0, 0, f);
  }
  mesh(g, new THREE.CircleGeometry(0.01, 20).rotateY(Math.PI), MATS.vent, 0, 0, 0.1205);
  return { obj: g, tip: 0.12 };
}

/** Bolt-gun box mag (origin at the seated top): dark body, ribbed sides, a base plate in the gun's colour. */
function sniperMag(h, plate = MATS.blue) {
  const g = group('sniperMag');
  mesh(g, rbox(0.036, h, 0.07, 0.004), MATS.black, 0, -h / 2 + 0.01, 0);
  for (let i = 0; i < 3; i++) mesh(g, rbox(0.0375, 0.004, 0.05, 0.001), MATS.poly, 0, -0.02 - i * (h - 0.03) / 3, 0);
  mesh(g, rbox(0.04, 0.012, 0.076, 0.004), plate, 0, -h + 0.008, 0);
  return g;
}

/** Marksman box mag (origin at the seated top): straight, slab-sided, ribbed, rounds showing, sage base plate. */
function dmrMag(L) {
  const mag = group('magazine');
  mesh(mag, rbox(0.03, L, 0.07, 0.004), MATS.poly, 0, -L / 2, 0);
  for (let y = -0.03; y > -L + 0.02; y -= 0.022) mesh(mag, rbox(0.0315, 0.004, 0.056, 0.0012), MATS.black, 0, y, 0.002);
  mesh(mag, rbox(0.0312, L * 0.5, 0.012, 0.002), MATS.steel, 0, -L * 0.45, -0.026);
  mesh(mag, rbox(0.036, 0.012, 0.078, 0.004), MATS.sage, 0, -L - 0.004, 0.002);
  for (const [f, y] of [[0.004, 0.004], [-0.018, 0.008]]) mesh(mag, tube(0.0058, 0.0058, -0.032, 0.03, 10), MATS.brass, 0, y, f);
  return mag;
}

// ───────────────────────────── grips ─────────────────────────────

function verticalGrip() {
  const g = group('verticalGrip');
  mesh(g, rbox(0.026, 0.01, 0.045, 0.002), MATS.black, 0, -0.003, 0);
  mesh(g, new THREE.CylinderGeometry(0.0035, 0.0035, 0.03, 10).rotateZ(Math.PI / 2), MATS.steel, 0, -0.003, -0.012);
  mesh(g, profile([[-0.016, -0.008], [0.016, -0.008], [0.014, -0.03], [0.017, -0.04], [0.012, -0.05], [0.016, -0.06], [0.012, -0.07], [0.015, -0.08], [0.012, -0.09], [-0.014, -0.09], [-0.017, -0.06], [-0.018, -0.03]], 0.027, { bevel: 0.004 }), MATS.poly);
  mesh(g, rbox(0.032, 0.009, 0.036, 0.003), MATS.accent, 0, -0.095, 0);
  for (const x of [-0.0138, 0.0138]) mesh(g, rbox(0.003, 0.05, 0.02, 0.001), MATS.black, x, -0.055, 0.0);
  return g;
}

function angledGrip() {
  const g = group('angledGrip');
  mesh(g, rbox(0.026, 0.01, 0.07, 0.002), MATS.black, 0, -0.003, 0);
  mesh(g, profile([[-0.04, -0.008], [0.036, -0.008], [0.034, -0.016], [-0.018, -0.048], [-0.03, -0.05], [-0.042, -0.04]], 0.028, { bevel: 0.004 }), MATS.poly);
  mesh(g, profile([[-0.032, -0.044], [-0.019, -0.046], [0.02, -0.022], [0.012, -0.018]], 0.03, { bevel: 0.002 }), MATS.accent);
  return g;
}

// ───────────────────────────── stocks ─────────────────────────────

function skeletonStock() {
  const g = group('skeletonStock');
  mesh(g, tube(0.0075, 0.0075, -0.39, -0.12, 14), MATS.steel, 0, 0.05);
  const a = new THREE.Vector3(0, 0.012, f2z(-0.12));
  const b = new THREE.Vector3(0, -0.035, f2z(-0.37));
  const strut = mesh(g, new THREE.CylinderGeometry(0.0065, 0.0065, a.distanceTo(b), 12), MATS.steel);
  strut.position.copy(a).lerp(b, 0.5);
  strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  mesh(g, profile([[-0.31, 0.044], [-0.2, 0.044], [-0.21, 0.068], [-0.3, 0.072]], 0.03, { bevel: 0.004 }), MATS.poly);
  mesh(g, profile([[-0.368, 0.066], [-0.368, -0.07], [-0.382, -0.08], [-0.404, -0.072], [-0.404, 0.062], [-0.39, 0.074]], 0.042, { bevel: 0.005 }), MATS.poly);
  mesh(g, rbox(0.046, 0.15, 0.012, 0.004), MATS.rubber, 0, -0.003, -0.41);
  mesh(g, new THREE.CylinderGeometry(0.008, 0.008, 0.05, 14).rotateZ(Math.PI / 2), MATS.black, 0, 0.03, -0.36);
  return g;
}

/** Marksman stock: long box over the buffer tube, adjustable cheek, angular butt with a rear monopod hook. */
function marksmanStock() {
  const g = group('marksmanStock');
  mesh(g, profile([[-0.12, 0.058], [-0.36, 0.058], [-0.372, 0.048], [-0.372, 0.008], [-0.12, 0.004]], 0.04, { bevel: 0.005 }), MATS.poly);
  mesh(g, profile([[-0.2, 0.058], [-0.215, 0.078], [-0.35, 0.08], [-0.362, 0.066], [-0.362, 0.058]], 0.036, { bevel: 0.004 }), MATS.black);
  mesh(g, profile([[-0.34, 0.072], [-0.4, 0.074], [-0.41, 0.064], [-0.41, -0.07], [-0.396, -0.084], [-0.37, -0.084], [-0.33, -0.04], [-0.27, 0.004], [-0.34, 0.004]], 0.044, { bevel: 0.005, holes: [[[-0.36, -0.012], [-0.388, -0.012], [-0.388, -0.06], [-0.372, -0.06]]] }), MATS.poly);
  mesh(g, rbox(0.048, 0.15, 0.014, 0.005), MATS.rubber, 0, -0.004, -0.414);
  mesh(g, rbox(0.045, 0.008, 0.06, 0.002), MATS.sage, 0, 0.004, -0.3);
  for (const f of [-0.24, -0.29]) mesh(g, new THREE.CylinderGeometry(0.004, 0.004, 0.042, 10).rotateZ(Math.PI / 2), MATS.steel, 0, 0.068, f);
  return g;
}

function precisionStock() {
  const g = group('precisionStock');
  const outer = [[-0.134, 0.058], [-0.2, 0.062], [-0.36, 0.064], [-0.39, 0.074], [-0.404, 0.07], [-0.404, -0.078], [-0.384, -0.088], [-0.33, -0.078], [-0.25, -0.04], [-0.17, -0.014], [-0.134, 0.002]];
  const shape = new THREE.Shape(outer.map(([f, y]) => new THREE.Vector2(f, y)));
  shape.holes.push(new THREE.Path([[-0.21, 0.036], [-0.3, 0.042], [-0.33, 0.018], [-0.32, -0.025], [-0.28, -0.018], [-0.21, 0.012]].reverse().map(([f, y]) => new THREE.Vector2(f, y))));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.034, bevelEnabled: true, bevelThickness: 0.005, bevelSize: 0.005, bevelSegments: 2, curveSegments: 6 });
  geo.rotateY(Math.PI / 2).translate(-0.017, 0, 0);
  mesh(g, geo, MATS.poly);
  // adjustable cheek riser on posts
  mesh(g, profile([[-0.33, 0.07], [-0.21, 0.07], [-0.22, 0.088], [-0.32, 0.092]], 0.03, { bevel: 0.004 }), MATS.black);
  for (const f of [-0.235, -0.305]) mesh(g, new THREE.CylinderGeometry(0.003, 0.003, 0.02), MATS.steel, 0, 0.07, f);
  mesh(g, new THREE.CylinderGeometry(0.0055, 0.0055, 0.05, 16).rotateZ(Math.PI / 2), MATS.steel, 0, 0.078, -0.27);
  // buttpad with accent stripe + sling loop
  mesh(g, rbox(0.05, 0.17, 0.014, 0.005), MATS.rubber, 0, -0.005, -0.414);
  mesh(g, rbox(0.051, 0.012, 0.015, 0.002), MATS.accent, 0, 0.04, -0.414);
  const loop = mesh(g, new THREE.TorusGeometry(0.009, 0.0025, 8, 16), MATS.steel, 0, -0.08, -0.36);
  loop.rotation.y = Math.PI / 2;
  return g;
}

// ───────────────────────────── definitions ─────────────────────────────

/**
 * Pistol can: a big rectangular box suppressor, longer than the pistol. Sits low on the bore so its
 * top stays under the iron-sight line. Built from a few large blocks to match the pistol.
 */
function pistolSuppressor() {
  const g = group('pistolSuppressor');
  const SAND = toon(0xebdbbc, { rim: 0.15 });
  mesh(g, tube(0.01, 0.01, 0, 0.016, 20), MATS.steel);
  mesh(g, profile([[0.012, -0.03], [0.04, -0.03], [0.04, 0.024], [0.02, 0.024], [0.012, 0.014]], 0.046, { bevel: 0.006, inset: true }), MATS.black);
  mesh(g, profile([[0.034, -0.036], [0.254, -0.036], [0.272, -0.022], [0.272, 0.02], [0.262, 0.028], [0.034, 0.028]], 0.052, { bevel: 0.009, segments: 3, inset: true }), MATS.poly);
  mesh(g, profile([[0.075, -0.024], [0.205, -0.024], [0.215, -0.014], [0.215, 0.016], [0.075, 0.016]], 0.0555, { bevel: 0.002 }), SAND);
  mesh(g, rbox(0.0545, 0.064, 0.012, 0.004), MATS.accent, 0, -0.004, 0.05);
  mesh(g, rbox(0.0545, 0.01, 0.13, 0.003), MATS.black, 0, -0.03, 0.145);
  mesh(g, profile([[0.266, -0.026], [0.288, -0.022], [0.288, 0.016], [0.266, 0.022]], 0.044, { bevel: 0.005, inset: true }), MATS.steel);
  mesh(g, new THREE.CircleGeometry(0.009, 20).rotateY(Math.PI), MATS.vent, 0, 0, 0.2884);
  mesh(g, rbox(0.03, 0.007, 0.002, 0.001), MATS.vent, 0, -0.014, 0.2884);
  return { obj: g, tip: 0.29 };
}

/** Pistol mag seated in the grip (flush length SEAT); a longer L adds a grip-extension sleeve. */
function pistolMag(L, SEAT = 0.09) {
  const mag = group('magazine');
  mesh(mag, rbox(0.021, L, 0.03, 0.003), MATS.steel, 0, -L / 2, 0);
  mesh(mag, rbox(0.0215, L * 0.5, 0.004, 0.001), MATS.vent, 0, -L * 0.5, 0.009);
  if (L > SEAT + 0.01) {
    const h = L - SEAT;
    mesh(mag, rbox(0.05, h, 0.056, 0.008), MATS.poly, 0, -SEAT - h / 2, -0.004);
    mesh(mag, rbox(0.052, h * 0.45, 0.05, 0.003), MATS.black, 0, -SEAT - h * 0.5, -0.004);
  }
  mesh(mag, rbox(0.048, 0.014, 0.058, 0.005), MATS.black, 0, -L - 0.004, -0.004);
  mesh(mag, rbox(0.034, 0.005, 0.04, 0.002), MATS.accent, 0, -L - 0.012, -0.004);
  rounds(mag);
  mag.children.filter((c) => c.name === 'round').forEach((r) => r.scale.setScalar(0.62));
  return mag;
}

/** Folding brace for the pistol, authored in gun space behind the grip's beavertail. */
function pistolStock() {
  const g = group('pistolStock');
  const rod = (a, b, r = 0.0045) => {
    const A = new THREE.Vector3(a[0], a[1], f2z(a[2])), B = new THREE.Vector3(b[0], b[1], f2z(b[2]));
    const m = mesh(g, new THREE.CylinderGeometry(r, r, A.distanceTo(B), 12), MATS.steel);
    m.position.copy(A).lerp(B, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  };
  mesh(g, rbox(0.03, 0.022, 0.018, 0.004), MATS.black, 0, -0.016, -0.084);
  mesh(g, new THREE.CylinderGeometry(0.006, 0.006, 0.034, 14).rotateZ(Math.PI / 2), MATS.accent, 0, -0.016, -0.094);
  rod([0, -0.01, -0.09], [0, -0.008, -0.27]);
  rod([0, -0.024, -0.09], [0, -0.078, -0.262]);
  mesh(g, rbox(0.02, 0.014, 0.075, 0.004), MATS.poly, 0, 0.001, -0.2);
  mesh(g, profile([[-0.262, 0.024], [-0.262, -0.098], [-0.276, -0.106], [-0.282, 0.028]], 0.03, { bevel: 0.004 }), MATS.poly);
  mesh(g, rbox(0.034, 0.138, 0.008, 0.003), MATS.rubber, 0, -0.04, -0.285);
  mesh(g, rbox(0.031, 0.006, 0.008, 0.002), MATS.accent, 0, -0.03, -0.268);
  return g;
}

/** Optics carry ADS data: sight = eye-line point (mount space), adsDist = eye relief, shadow/eyeR = eyepiece shadow for magnified optics. */
const ATTACHMENTS = {
  muzzle: [
    { id: 'comp', name: 'Compensator', blurb: 'Top ports fight muzzle climb.', stats: { vRecoil: 0.78, flash: 1.15 }, build: compensator },
    { id: 'flash', name: 'Flash Hider', blurb: 'Four-prong cage. Kills flash, steadies sway.', stats: { hRecoil: 0.82, vRecoil: 0.95, flash: 0.15 }, build: flashHider },
    { id: 'suppressor', name: 'Suppressor', blurb: 'Big box can. Quiet, no flash, heavier.', stats: { vRecoil: 0.9, hRecoil: 0.92, flash: 0.0, ads: 1.12, suppressed: true }, build: suppressor },
    { id: 'smgcan', name: 'Suppressor', blurb: 'Fat round can. Quiet, no flash, heavier.', stats: { vRecoil: 0.9, hRecoil: 0.92, flash: 0.0, ads: 1.12, suppressed: true }, build: smgSuppressor },
    { id: 'pthread', name: 'Threaded Barrel', blurb: 'Bare muzzle. Light, bright flash.', stats: {} },
    { id: 'sbrake', name: 'Muzzle Brake', blurb: 'Ported block. Tames the kick.', stats: { vRecoil: 0.85 }, build: sniperBrake },
    { id: 'rbare', name: 'Bare Crown', blurb: 'Nothing on the shroud. Light and quick.', stats: {} },
    { id: 'rcomp', name: 'Revolver Comp', blurb: 'Ported block. Flattens the flip, brighter flash.', stats: { vRecoil: 0.8, flash: 1.2, ads: 1.05 }, build: revolverComp },
    { id: 'dbare', name: 'Open Bores', blurb: 'Cylinder bores. Widest spread, quickest handling.', stats: {} },
    { id: 'choke', name: 'Twin Choke', blurb: 'Tightens both patterns for reach. A little heavier.', stats: { choke: 0.68, ads: 1.06 }, build: twinChoke },
    { id: 'pcan', name: 'Silent-12 Can', blurb: 'Big box can, longer than the pistol. Whisper quiet.', stats: { vRecoil: 0.85, hRecoil: 0.9, flash: 0.0, ads: 1.15, suppressed: true }, build: pistolSuppressor },
  ],
  scope: [
    { id: 'piron', name: 'Iron Sights', blurb: 'Slide sights. Fastest, widest view.', stats: {}, optic: { iron: true, adsDist: 0.36, vmFov: 42 } },
    { id: 'iron', name: 'Iron Sights', blurb: 'Folding BUIS. Fastest, widest view.', stats: { zoom: 1.12, ads: 0.88 }, optic: { iron: true, adsDist: 0.3, vmFov: 42 } },
    { id: 'holo', name: 'Holo', blurb: 'Fine ring and dot. Open window.', stats: { zoom: 1.32 }, build: holo, optic: { sight: HOLO_SIGHT.map((v) => v * HOLO_SCALE), adsDist: 0.17, vmFov: 40 } },
    { id: 'reddot', name: 'Red Dot', blurb: 'Tube sight, single crisp dot.', stats: { zoom: 1.32 }, build: redDot, optic: { sight: [0, 0.036, -0.031], adsDist: 0.16, vmFov: 40 } },
    { id: 'prism2', name: '2× Prism', blurb: 'Rising arrow reticle.', stats: { zoom: 2.0, ads: 1.1 }, build: prism2x, optic: { sight: [0, 0.03, -0.05], eyeR: 0.0145, shadow: 0.25, adsDist: 0.105, vmFov: 36 } },
    { id: 'scope6', name: '6× Longshot', blurb: 'Fine cross, wide bell. Built for one shot.', stats: { zoom: 6.0, ads: 1.35 }, build: scope6x, optic: { sight: [0, 0.04 * SCOPE6, -0.116 * SCOPE6], eyeR: 0.0172 * SCOPE6, shadow: 0.55, adsDist: 0.1, vmFov: 30 } },
    { id: 'scope3', name: '3× Scout', blurb: 'Thin full-width cross. Long eye relief.', stats: { zoom: 3.0, ads: 1.22 }, build: scope3x, optic: { sight: [0, 0.04, -0.116], eyeR: 0.0172, shadow: 0.4, adsDist: 0.1, vmFov: 32 } },
  ],
  mag: [
    { id: 'small', name: 'Short Mag', blurb: '20 rounds. Quick to swap.', stats: { magSize: 20, reload: 0.88, ads: 0.96 }, build: () => curvedMag(0.4, { N: 10, flare: 0.003 }) },
    { id: 'big', name: 'Extended Mag', blurb: '30 rounds. The standard.', stats: { magSize: 30 }, build: () => curvedMag(0.66, { N: 16, flare: 0.007 }) },
    { id: 'drum', name: 'Drum', blurb: '50 rounds. Heavy and slow.', stats: { magSize: 50, reload: 1.35, ads: 1.12 }, build: drumMag },
    { id: 'smg25', name: 'Compact Mag', blurb: '25 rounds. Flush with the grip.', stats: { magSize: 25, reload: 0.9 }, build: () => stickMag(0.12) },
    { id: 'smg35', name: 'Extended Mag', blurb: '35 rounds. The standard.', stats: { magSize: 35 }, build: () => stickMag(0.16) },
    { id: 'h25', name: 'Compact Mag', blurb: '25 rounds. Flush with the well.', stats: { magSize: 25, reload: 0.9 }, build: () => stickMag(0.12, MATS.amber) },
    { id: 'h35', name: 'Extended Mag', blurb: '35 rounds. The standard.', stats: { magSize: 35 }, build: () => stickMag(0.16, MATS.amber) },
    { id: 'h50', name: 'Long Stick', blurb: '50 rounds. Long and slower to swap.', stats: { magSize: 50, reload: 1.22, ads: 1.07 }, build: () => stickMag(0.215, MATS.amber) },
    { id: 'smg50', name: 'Long Stick', blurb: '50 rounds. Long and slower to swap.', stats: { magSize: 50, reload: 1.22, ads: 1.07 }, build: () => stickMag(0.215) },
    { id: 's5', name: 'Box Mag', blurb: '5 rounds. Quick to swap.', stats: { magSize: 5 }, build: () => sniperMag(0.07) },
    { id: 's10', name: 'Long Box', blurb: '10 rounds. Heavier, slower to swap.', stats: { magSize: 10, reload: 1.15, ads: 1.06 }, build: () => sniperMag(0.11) },
    { id: 'd10', name: 'Short Box', blurb: '10 rounds. Light, quick to swap.', stats: { magSize: 10, reload: 0.9, ads: 0.96 }, build: () => dmrMag(0.085) },
    { id: 'd20', name: 'Box Mag', blurb: '20 rounds. The standard.', stats: { magSize: 20 }, build: () => dmrMag(0.13) },
    { id: 'c5', name: 'Box Mag', blurb: '5 rounds. Quick to swap.', stats: { magSize: 5 }, build: () => sniperMag(0.07, MATS.tan) },
    { id: 'c10', name: 'Long Box', blurb: '10 rounds. Heavier, slower to swap.', stats: { magSize: 10, reload: 1.12, ads: 1.05 }, build: () => sniperMag(0.11, MATS.tan) },
    { id: 'p15', name: 'Standard Mag', blurb: '15 rounds. Flush fit.', stats: { magSize: 15 }, build: () => pistolMag(0.092) },
    { id: 'p24', name: 'Extended Mag', blurb: '24 rounds with a grip sleeve.', stats: { magSize: 24, reload: 1.1, ads: 1.04 }, build: () => pistolMag(0.136) },
  ],
  grip: [
    { id: 'none', name: 'Bare Rail', blurb: 'No grip. Hand on the handguard.', stats: {} },
    { id: 'vertical', name: 'Vertical Grip', blurb: 'Stable, reduces climb.', stats: { vRecoil: 0.88 }, build: verticalGrip },
    { id: 'angled', name: 'Angled Grip', blurb: 'Snappier aim, steadier sideways.', stats: { ads: 0.88, hRecoil: 0.9 }, build: angledGrip },
  ],
  stock: [
    { id: 'skeleton', name: 'Skeleton Stock', blurb: 'Light. Fast handling.', stats: { ads: 0.93 }, build: skeletonStock },
    { id: 'precision', name: 'Precision Stock', blurb: 'Solid cheek weld, less recoil.', stats: { vRecoil: 0.9, hRecoil: 0.88, ads: 1.06 }, build: precisionStock },
    { id: 'marksman', name: 'Marksman Stock', blurb: 'Long, adjustable cheek. Steadiest follow-ups.', stats: { vRecoil: 0.86, hRecoil: 0.9, ads: 1.08 }, build: marksmanStock },
    { id: 'pnone', name: 'No Stock', blurb: 'One-handed carry. Fastest handling.', stats: {} },
    { id: 'pbrace', name: 'Brace Stock', blurb: 'Folding brace. Steadier bursts.', stats: { vRecoil: 0.82, hRecoil: 0.85, ads: 1.08 }, build: pistolStock },
  ],
};

export const findAttachment = (slot, id) => ATTACHMENTS[slot].find((a) => a.id === id) ?? ATTACHMENTS[slot][0];

/** Combined stats for a loadout (only the slots the weapon has). */
export function loadoutStats(loadout) {
  const s = { vRecoil: 1, hRecoil: 1, ads: 1, reload: 1, flash: 1, choke: 1, magSize: 30, zoom: 1.32, suppressed: false };
  for (const slot of Object.keys(loadout)) {
    for (const [k, v] of Object.entries(findAttachment(slot, loadout[slot]).stats)) {
      if (k === 'magSize' || k === 'zoom' || k === 'suppressed') s[k] = v;
      else s[k] *= v;
    }
  }
  return s;
}

/** Human-readable stat chips for the gunsmith cards. good = true when the change helps. */
export function statChips(def) {
  const out = [];
  const pct = (v) => `${v < 1 ? '−' : '+'}${Math.round(Math.abs(1 - v) * 100)}%`;
  const st = def.stats;
  if (st.magSize) out.push({ text: `${st.magSize} rounds`, good: null });
  if (st.zoom) out.push({ text: `${st.zoom.toFixed(st.zoom % 1 ? 2 : 0)}× zoom`, good: null });
  if (st.vRecoil) out.push({ text: `V-recoil ${pct(st.vRecoil)}`, good: st.vRecoil < 1 });
  if (st.hRecoil) out.push({ text: `H-recoil ${pct(st.hRecoil)}`, good: st.hRecoil < 1 });
  if (st.ads) out.push({ text: `ADS time ${pct(st.ads)}`, good: st.ads < 1 });
  if (st.reload) out.push({ text: `Reload ${pct(st.reload)}`, good: st.reload < 1 });
  if (st.choke) out.push({ text: `Pellet spread ${pct(st.choke)}`, good: st.choke < 1 });
  if (st.flash !== undefined) out.push({ text: st.flash < 0.5 ? 'Low flash' : 'Bright flash', good: st.flash < 0.5 });
  if (st.suppressed) out.push({ text: 'Suppressed', good: true });
  return out;
}
