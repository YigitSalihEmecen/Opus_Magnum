import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PALETTE as P, toon } from '../../core/toon.js';

// Shared materials and geometry helpers for all weapon models.
// Gun space: +X right, +Y up, barrel toward -Z. Helpers take `f` = distance forward (z = -f).

export const MATS = {
  steel: toon(0x4a4c52, { rim: 0.4, rimColor: 0xfff3e8 }),
  poly: toon(0x34363b, { rim: 0.3, rimColor: 0xfff3e8 }),
  black: toon(0x202124, { rim: 0.25, rimColor: 0xfff3e8 }),
  rubber: toon(0x18181a, { rim: 0.1 }),
  accent: toon(P.clay, { rim: 0.25 }),
  ivory: toon(P.ivory, { rim: 0.1 }),
  brass: toon(0xc9a04e, { rim: 0.5, rimColor: 0xfff0c0 }),
  copper: toon(0xb8673e, { rim: 0.4 }),
  vent: new THREE.MeshBasicMaterial({ color: 0x0c0c0d }),
  olive: toon(0x7c8659, { rim: 0.32, rimColor: 0xfff3e8 }),
  red: toon(0xc23a2e, { rim: 0.28, rimColor: 0xfff3e8 }), // Grizzly accent + shotgun shells
};

export const f2z = (f) => -f;

/**
 * Side profile [[f, y], …] extruded across X (centred). holes: cut-out outlines (windows, slots).
 * The bevel normally grows the outline by `bevel`; inset: true keeps the side walls on the drawn
 * outline instead (use it for big rounded bevels so parts don't swell past their neighbours).
 */
export function profile(points, width, { bevel = 0.003, segments = 2, holes = [], inset = false } = {}) {
  const shape = new THREE.Shape(points.map(([f, y]) => new THREE.Vector2(f, y)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([f, y]) => new THREE.Vector2(f, y))));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, width - bevel * 2),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: segments,
    bevelOffset: inset ? -bevel : 0,
    curveSegments: 6,
  });
  geo.rotateY(Math.PI / 2);
  geo.translate(-(width - bevel * 2) / 2, 0, 0);
  return geo;
}

export function rbox(w, h, d, r = 0.002) { return new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)); }

/** Cylinder along the barrel axis between f0 and f1. */
export function tube(r0, r1, f0, f1, seg = 20, open = false) {
  const g = new THREE.CylinderGeometry(r1, r0, f1 - f0, seg, 1, open);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0, f2z((f0 + f1) / 2));
  return g;
}

/** Ivory-on-dark "sticker bomb" print for the magazine, after the reference's printed mag. */
export function magPrint() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#26272a';
  g.fillRect(0, 0, 512, 512);
  let s = 11;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const glyphs = ['OM', '07', '//', '✕', '◆', 'A', 'PILOT', '45', '☐'];
  for (let i = 0; i < 70; i++) {
    const x = rnd() * 512, y = rnd() * 512, sz = 12 + rnd() * 50;
    g.save();
    g.translate(x, y);
    g.rotate((rnd() - 0.5) * 0.9);
    const t = rnd();
    g.fillStyle = t < 0.55 ? '#e9e6dd' : t < 0.8 ? '#9a978f' : '#d97757';
    g.strokeStyle = g.fillStyle;
    g.lineWidth = 3;
    if (t < 0.35) { g.font = `800 ${sz}px "Space Grotesk", sans-serif`; g.fillText(glyphs[(rnd() * glyphs.length) | 0], 0, 0); }
    else if (t < 0.55) g.fillRect(0, 0, sz * 1.4, sz * 0.5);
    else if (t < 0.75) { g.beginPath(); g.arc(0, 0, sz * 0.45, 0, Math.PI * 2); g.stroke(); }
    else { g.beginPath(); g.moveTo(0, 0); g.lineTo(sz, sz * 0.3); g.lineTo(0, sz * 0.6); g.closePath(); g.fill(); }
    g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(5, 5);
  tex.anisotropy = 8;
  return tex;
}

/** A 12-gauge shell along the barrel axis (centre at the origin): red hull, brass head toward the shooter. */
export function shotShell() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(tube(0.0092, 0.0092, -0.022, 0.026, 14), MATS.red));
  g.add(new THREE.Mesh(tube(0.0097, 0.0097, -0.03, -0.016, 14), MATS.brass));
  return g;
}



/**
 * Shared builders for receiver parts every gun has (fire controls, grip, rail, irons, mounts…).
 * Usage: const k = gunKit(root); k.add(geo, mat); k.at(obj, x, y, f); …
 */
export function gunKit(root) {
  const add = (geo, mat, parent = root) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  const at = (obj, x, y, f) => { obj.position.set(x, y, f2z(f)); return obj; };
  const group = (name, x, y, f, parent = root) => { const g = new THREE.Group(); g.name = name; at(g, x, y, f); parent.add(g); return g; };

  return {
    add, at, group,

    /** Trigger guard + pivoting trigger (at f 0.036) + selector lever on the left. */
    fireControls(guardMat = MATS.poly) {
      const outer = new THREE.Shape([[-0.012, -0.034], [0.068, -0.034], [0.07, -0.06], [0.052, -0.082], [0.0, -0.084], [-0.014, -0.07]].map(([a, b]) => new THREE.Vector2(a, b)));
      outer.holes.push(new THREE.Path([[-0.002, -0.034], [0.058, -0.034], [0.058, -0.058], [0.046, -0.073], [0.004, -0.074], [-0.003, -0.064]].reverse().map(([a, b]) => new THREE.Vector2(a, b))));
      const g = new THREE.ExtrudeGeometry(outer, { depth: 0.01, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.0015, bevelSegments: 2 });
      g.rotateY(Math.PI / 2).translate(-0.005, 0, 0);
      add(g, guardMat);
      const trigger = group('trigger', 0, -0.034, 0.036);
      add(profile([[0.004, 0], [0.002, -0.014], [0.006, -0.026], [-0.002, -0.03], [-0.006, -0.018], [-0.004, 0]], 0.007, { bevel: 0.0012 }), MATS.steel, trigger);
      const selector = group('selector', -0.028, -0.012, 0.0);
      add(new THREE.CylinderGeometry(0.007, 0.007, 0.004, 16).rotateZ(Math.PI / 2), MATS.black, selector);
      at(add(rbox(0.004, 0.006, 0.024, 0.0015), MATS.black, selector), -0.002, 0, 0.012);
      at(add(new THREE.CylinderGeometry(0.0022, 0.0022, 0.003, 8).rotateZ(Math.PI / 2), MATS.accent, selector), -0.003, 0, 0.022);
      return { trigger, selector };
    },

    /** Raked pistol grip behind the trigger with stipple panels. */
    pistolGrip(mat = MATS.poly, panelMat = MATS.black) {
      add(profile([[0.012, -0.028], [0.006, -0.058], [0.0, -0.068], [-0.002, -0.082], [-0.009, -0.093], [-0.012, -0.108], [-0.019, -0.122], [-0.025, -0.138], [-0.03, -0.152], [-0.05, -0.16], [-0.077, -0.152], [-0.074, -0.13], [-0.064, -0.082], [-0.054, -0.04], [-0.046, -0.028]], 0.031, { bevel: 0.006 }), mat);
      for (const x of [-0.0175, 0.0175]) add(profile([[-0.006, -0.05], [-0.018, -0.13], [-0.06, -0.135], [-0.05, -0.05]], 0.004, { bevel: 0.001 }), panelMat).position.x = x;
      at(add(rbox(0.036, 0.012, 0.03, 0.004), MATS.black), 0, -0.158, -0.052);
    },

    /** Picatinny rail from f0 to f1; base centred at y, teeth on top (top surface ≈ y + 0.01). */
    topRail(f0, f1, y) {
      const base = rbox(0.022, 0.009, f1 - f0, 0.0015).translate(0, y, f2z((f0 + f1) / 2));
      const geos = [base];
      for (let f = f0 + 0.01; f <= f1 - 0.005; f += 0.01) geos.push(new THREE.BoxGeometry(0.025, 0.005, 0.0055).translate(0, y + 0.007, f2z(f)));
      add(mergeGeometries(geos.map((g) => g.toNonIndexed())), MATS.black);
    },

    /** Folding iron sights on the rail; returns groups + the aperture point for ADS. */
    ironSights(fRear, fFront, railTop) {
      const ironRear = group('ironRear', 0, railTop, fRear);
      at(add(rbox(0.026, 0.007, 0.026, 0.002), MATS.black, ironRear), 0, 0.0035, 0);
      const leaf = new THREE.Shape([[-0.009, 0.004], [0.009, 0.004], [0.009, 0.026], [0.005, 0.0295], [-0.005, 0.0295], [-0.009, 0.026]].map(([a, b]) => new THREE.Vector2(a, b)));
      const hole = new THREE.Path();
      hole.absarc(0, 0.0215, 0.0058, 0, Math.PI * 2, true);
      leaf.holes.push(hole);
      add(new THREE.ExtrudeGeometry(leaf, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.001, bevelSize: 0.0008, bevelSegments: 1, curveSegments: 16 }).translate(0, 0, -0.002), MATS.steel, ironRear);
      const ironFront = group('ironFront', 0, railTop, fFront);
      at(add(rbox(0.026, 0.007, 0.022, 0.002), MATS.black, ironFront), 0, 0.0035, 0);
      for (const x of [-0.0095, 0.0095]) at(add(rbox(0.003, 0.026, 0.012, 0.001), MATS.steel, ironFront), x, 0.017, 0);
      at(add(rbox(0.0028, 0.016, 0.004, 0.0008), MATS.steel, ironFront), 0, 0.014, 0);
      at(add(rbox(0.003, 0.003, 0.0045, 0.0006), MATS.accent, ironFront), 0, 0.0215, 0);
      return { ironRear, ironFront, ironSight: new THREE.Vector3(0, railTop + 0.0215, f2z(fRear)) };
    },

    /** Right-side ejection port with a reciprocating bolt carrier. */
    boltAndPort(f, y, len = 0.082, x = 0.0275) {
      at(add(rbox(0.003, 0.03, len, 0.001), MATS.vent), x, y, f);
      const bolt = group('bolt', 0, 0, 0);
      at(add(rbox(0.006, 0.022, len - 0.012, 0.002), MATS.steel, bolt), x - 0.002, y, f);
      at(add(rbox(0.004, 0.004, len * 0.6, 0.001), MATS.accent, bolt), x + 0.001, y + 0.004, f);
      const ejectPort = group('ejectPort', x + 0.0045, y + 0.002, f);
      return { bolt, ejectPort };
    },

    /** Left-side non-reciprocating charging handle in a slot ending at fFront. */
    chargingHandle(fFront, y, slot = 0.115, x = -0.0275) {
      at(add(rbox(0.003, 0.008, slot, 0.001), MATS.vent), x, y, fFront - slot / 2 + 0.008);
      const ch = group('chargingHandle', x - 0.0005, y, fFront);
      add(rbox(0.026, 0.012, 0.014, 0.003), MATS.black, ch).position.x = -0.012;
      add(rbox(0.012, 0.016, 0.018, 0.004), MATS.accent, ch).position.x = -0.028;
      return ch;
    },
  };
}
