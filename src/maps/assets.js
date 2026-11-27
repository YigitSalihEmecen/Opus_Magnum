import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PALETTE as P, toon } from '../core/toon.js';
import { ITEMS, ITEM_IDS } from '../items/items.js';
import { pickupModel, GUN_SHOW } from '../items/pickups.js';
import { WEAPONS } from '../weapons/weapons.js';

/*
  Placeable map pieces in the game's language: chunky rounded forms in flat colours, ink caps,
  one main colour. build(color, ctx) returns a Group whose origin sits on the floor at the piece's
  centre; walls and fences run along X, "forward" is -Z.

  Pieces are designed to tile on the 1 m grid without overlaps:
    · linear pieces (walls, fences, rails) are exactly their grid length; connectors are generated at
      their ends by buildJoints(): a pillar where walls turn or meet, shared posts along fences
    · adaptive tiles (road, sidewalk) look at their neighbours and pick markings / curbs
  ctx = { ground: bool (standing on terrain → grows a foundation), near(family, dx, dz) → bool }
*/

const mats = new Map();
/** Flat toon colour, shared per colour. */
export function mat(color) {
  if (!mats.has(color)) mats.set(color, toon(color, { rim: 0.16 }));
  return mats.get(color);
}
const decal = (color) => toon(color, { rim: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
const DECALS = { line: decal(P.ivory), dash: decal(P.manilla) };

function add(g, geo, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  g.add(m);
  return m;
}
/** Box in a flat colour. */
const gbox = (g, w, h, d, x, y, z, color) => add(g, new THREE.BoxGeometry(w, h, d), mat(color), x, y, z);
/** Plain sharp box: caps, kicks and strips that must butt seamlessly against their neighbours. */
const sbox = (g, w, h, d, x, y, z, material) => add(g, new THREE.BoxGeometry(w, h, d), material, x, y, z);
/** Rounded block for stand-alone forms. */
/**
 * A trim that sits on a wall face and stands only a few cm proud of it (caps, sills, kicks, frames). It casts no
 * shadow: its shadow would be a band a few cm wide on the wall right beside it, where the sun usually grazes, and
 * a shadow map draws that as a lit gap and a row of teeth. The ink of the trim itself already marks the edge.
 */
const trim = (m) => { m.castShadow = false; return m; };
const rbox = (g, w, h, d, x, y, z, material, r = 0.04) => add(g, new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)), material, x, y, z);
const cyl = (r, h, seg = 20, r2 = r) => new THREE.CylinderGeometry(r2, r, h, seg);
const ico = (r, detail = 1) => new THREE.IcosahedronGeometry(r, detail);
/** Profile in the (a, y) plane extruded `depth`, centred; axis 'x' puts the profile's a along Z. */
function prism(points, depth, axis = 'x', bevel = 0.02) {
  const s = new THREE.Shape(points.map(([a, y]) => new THREE.Vector2(a, y)));
  const geo = new THREE.ExtrudeGeometry(s, { depth: depth - bevel * 2, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 8 });
  geo.translate(0, 0, -(depth - bevel * 2) / 2);
  if (axis === 'x') geo.rotateY(Math.PI / 2);
  return geo;
}
/** Hidden walkable surface (stairs): collides, isn't drawn. */
function collider(g, geo, x, y, z) {
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  m.position.set(x, y, z);
  m.visible = false;
  m.userData.collider = true;
  g.add(m);
  return m;
}

// ───────────────────────────── walls ─────────────────────────────

/*
  Shared measurements. Every piece is cut from these, so pieces meet without steps or gaps:
    · GRID 4 m bays: walls, floors, rooms, walkways, docks all tile on it
    · STOREY 3.5 m: every walking surface sits at a multiple of it (half storeys for steps and ramps);
      a walkable piece's top is its record's y (floor slabs, room floors, walkways, docks, the pool deck)
    · a wall is a storey minus the slab it stands on; doorways, windows and steps share one size each
    · CRATE 1.2 m stacks: two crates are a container's height, so crates climb onto containers
*/
const GRID = 4, STOREY = 3.5, HALF_STOREY = STOREY / 2;
const SLAB = 0.3, WALL_T = 0.3, FOUND = 2;
const WALL_H = STOREY - SLAB;
const DOOR = { w: 1.3, h: 2.3 }, WINDOW = { sill: 1.0, head: 2.3 };
const STEP_RISE = 0.25;
const CRATE = 1.2, CONTAINER = { L: 6.06, H: 2 * CRATE, D: 2.44 };
export { DOOR };
// walls standing on a slab reach down over its edge; slabs reach out to a wall's outer face
const FLUSH = WALL_T / 2 - 0.006; // a slab's reach past a wall's centre line: just inside its outer face (no coplanar faces)

/**
 * Wall along X, exactly `len` long. holes: [{ x0, x1, y0, y1 }] (non-overlapping in x), each framed.
 * On terrain it grows a foundation so slopes never show a gap underneath.
 */
function wall(color, ctx, { len = 4, h = WALL_H, t = WALL_T, holes = [], drop = 0 } = {}) {
  const g = new THREE.Group();
  const L = len / 2;
  const piece = (x0, x1, y0, y1) => { if (x1 - x0 > 0.005 && y1 - y0 > 0.005) gbox(g, x1 - x0, y1 - y0, t, (x0 + x1) / 2, (y0 + y1) / 2, 0, color); };
  const xs = [...new Set([-L, L, ...holes.flatMap((o) => [o.x0, o.x1])])].sort((a, b) => a - b);
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i], b = xs[i + 1], hole = holes.find((o) => o.x0 <= a + 1e-6 && o.x1 >= b - 1e-6);
    if (!hole) piece(a, b, 0, h);
    else { piece(a, b, 0, hole.y0); piece(a, b, hole.y1, h); }
  }
  const frame = mat(P.slate), F = 0.09, fd = t + 0.08, SILL = 0.05;
  for (const o of holes) {
    // a window's sill sits proud of the wall below (top SILL above the opening's base), and the frame stands on it
    const base = o.y0 > 0 ? o.y0 + SILL : o.y0, hh = o.y1 - base;
    trim(rbox(g, F, hh, fd, o.x0 + F / 2, (base + o.y1) / 2, 0, frame, 0.02));
    trim(rbox(g, F, hh, fd, o.x1 - F / 2, (base + o.y1) / 2, 0, frame, 0.02));
    trim(rbox(g, o.x1 - o.x0 - 2 * F, F, fd, (o.x0 + o.x1) / 2, o.y1 - F / 2, 0, frame, 0.02));
    if (o.y0 > 0) trim(sbox(g, o.x1 - o.x0 + 0.2, 0.09, t + 0.2, (o.x0 + o.x1) / 2, o.y0 + SILL - 0.045, 0, mat(P.ink)));
  }
  // door-sized openings at the wall's foot: the clear gap inside the frame, where play hangs a door (maps/doors.js)
  const doorways = holes.filter((o) => o.y0 === 0 && [1, 2].some((k) => Math.abs(o.x1 - o.x0 - k * DOOR.w) < 0.02));
  if (doorways.length) g.userData.doorways = doorways.map((o) => ({ x0: o.x0 + F, x1: o.x1 - F, h: o.y1 - F }));
  if (ctx?.ground) piece(-L, L, -FOUND, 0);
  // standing on a floor slab: cover the slab's edge so the facade runs on from the storey below
  else if (drop || ctx?.slabUnderWall?.()) piece(-L, L, -(drop || SLAB), 0);
  // cap and kick stop a few mm short of the wall's ends, jambs and underside, so no face lies on a wall face
  const E = 0.004;
  trim(sbox(g, len - 2 * E, 0.12, t + 0.08, 0, h + 0.06 - E, 0, mat(P.ink))); // just below a ceiling slab's underside
  if (h > 1) {
    // kick strip along the foot of the wall, broken at doorways (no sill to trip on)
    let x = -L;
    for (const o of [...holes.filter((o) => o.y0 === 0), { x0: L, x1: L }].sort((a, b) => a.x0 - b.x0)) {
      if (o.x0 - x > 0.02) trim(sbox(g, o.x0 - x - 2 * E, 0.16, t + 0.05, (x + o.x0) / 2, 0.08 + E, 0, mat(P.slate)));
      x = Math.max(x, o.x1);
    }
  }
  return g;
}

/** Triangular infill that closes a pitched roof's end; 8 m wide, sits on the wall cap. */
function gable(color) {
  const g = new THREE.Group();
  const geo = prism([[-4.1, 0], [4.1, 0], [0, 2.3]], WALL_T, 'z', 0);
  add(g, geo, mat(color), 0, 0.12, 0);
  return g;
}

function pillar(color, ctx) {
  const g = new THREE.Group();
  gbox(g, 0.6, WALL_H, 0.6, 0, WALL_H / 2, 0, color);
  if (ctx?.ground) gbox(g, 0.6, FOUND, 0.6, 0, -FOUND / 2, 0, color);
  trim(sbox(g, 0.68, 0.14, 0.68, 0, WALL_H + 0.066, 0, mat(P.ink))); // dips under a slab resting on it
  trim(sbox(g, 0.64, 0.18, 0.64, 0, 0.094, 0, mat(P.slate)));
  return g;
}

// ─────────────────────────── structures ───────────────────────────

function floor(color, ctx, { w = 4, d = 4 } = {}) {
  const g = new THREE.Group();
  // sides with no floor next door reach out to the outer face of the wall that runs along them (or close a
  // roof/terrace edge), so no slab edge ever shows recessed between storeys
  let x0 = -w / 2, x1 = w / 2, z0 = -d / 2, z1 = d / 2;
  if (ctx?.openSides && w === 4 && d === 4) {
    const open = ctx.openSides();
    if (open.px) x1 += FLUSH;
    if (open.nx) x0 -= FLUSH;
    if (open.pz) z1 += FLUSH;
    if (open.nz) z0 -= FLUSH;
  }
  gbox(g, x1 - x0, SLAB, z1 - z0, (x0 + x1) / 2, -SLAB / 2, (z0 + z1) / 2, color);
  if (ctx?.ground) gbox(g, w, FOUND, d, 0, -SLAB - FOUND / 2, 0, color);
  return g;
}

/** Inclined slab: low end at +Z, high end at -Z. */
function slab(g, color, run, rise, w, t = 0.4) {
  const len = Math.hypot(run, rise), a = Math.atan2(rise, run);
  const m = gbox(g, w, t, len, 0, rise / 2 - (t / 2) * Math.cos(a), 0, color);
  m.rotation.x = a;
  return m;
}

/** Half a storey up over 6 m, low end at +Z: meets steps, podium half-levels and a slab at HALF_STOREY. */
function ramp(color) {
  const g = new THREE.Group();
  const run = 6, rise = HALF_STOREY;
  slab(g, color, run, rise, 2.5, 0.5);
  for (const s of [-1, 1]) {
    const k = sbox(g, 0.12, 0.12, Math.hypot(run, rise), s * 1.31, rise / 2 + 0.06, 0, mat(P.ink));
    k.rotation.x = Math.atan2(rise, run);
  }
  return g;
}

/** Stepped flight with a hidden ramp to walk on (movement has no step-up). */
function stairs(color, ctx, { rise = 3.5, run = 6, w = 2, rail = true } = {}) {
  const g = new THREE.Group();
  const n = Math.round(rise / STEP_RISE);
  const tread = run / n, stepH = rise / n;
  const geos = [];
  for (let i = 0; i < n; i++) {
    const top = stepH * (i + 1);
    geos.push(new THREE.BoxGeometry(w, top, tread).translate(0, top / 2, run / 2 - tread * (i + 0.5)));
  }
  const steps = add(g, mergeGeometries(geos), mat(color));
  steps.userData.noCollide = true;
  const noses = [];
  for (let i = 0; i < n; i++) noses.push(new THREE.BoxGeometry(w + 0.01, 0.04, 0.06).translate(0, stepH * (i + 1) + 0.005, run / 2 - tread * i - 0.025));
  add(g, mergeGeometries(noses), mat(P.ink)).userData.noCollide = true;
  // solid wedge under the whole flight: its slope (from just below the first step's toe to the top
  // landing edge) is what you walk on, and its sides and back block you like the steps look like they do
  const z0 = run / 2 + 0.3, z1 = -run / 2; // prism() maps the profile's first axis to -Z
  collider(g, prism([[-z0, -0.05], [-z1, rise], [-z1, -0.05]], w, 'x', 0), 0, 0, 0);
  const len = Math.hypot(run, rise), a = Math.atan2(rise, run);
  if (rail) {
    const railMat = mat(P.slate);
    for (const s of [-1, 1]) {
      const r = sbox(g, 0.06, 0.08, len, s * (w / 2 - 0.04), rise / 2 + 0.95, 0, railMat);
      r.rotation.x = a;
      for (let i = 0; i <= 3; i++) {
        const z = run / 2 - (run * i) / 3 - (i === 0 ? 0.15 : i === 3 ? -0.15 : 0);
        const y0 = THREE.MathUtils.clamp(((run / 2 - z) / run) * rise, 0, rise);
        sbox(g, 0.06, 0.95, 0.06, s * (w / 2 - 0.04), y0 + 0.47, z, railMat);
      }
    }
  }
  return g;
}

/** Half of a pitched roof: eave (low, overhanging) at +Z, ridge at -Z. Two, back to back, make a gable. */
function roofSlope(color) {
  const g = new THREE.Group();
  const run = 4, rise = 2.3, over = 0.45, t = 0.22;
  const len = Math.hypot(run + over, rise * (1 + over / run)), a = Math.atan2(rise, run);
  const roof = mat(color);
  const ribs = [];
  for (let x = -2; x < 2; x += 0.5) ribs.push(new THREE.BoxGeometry(0.46, t, len).translate(x + 0.25, 0, 0));
  const panel = add(g, mergeGeometries(ribs), roof);
  panel.rotation.x = a;
  panel.position.set(0, rise / 2 - (over / run) * rise / 2 + 0.12 + t / 2, over / 2);
  const ridge = sbox(g, 4, 0.16, 0.36, 0, rise + 0.14 + t, -2.02, mat(P.ink));
  ridge.userData.noCollide = true;
  trim(sbox(g, 4, 0.1, 0.1, 0, 0.1, 2 + over - 0.02, mat(P.ink))); // eave fascia
  return g;
}

function awning(color) {
  const g = new THREE.Group();
  const stripes = [];
  for (let i = 0; i < 8; i++) stripes.push(i);
  const a = 0.38;
  for (const i of stripes) {
    const m = sbox(g, 0.5, 0.06, 1.7, -1.75 + i * 0.5, 0, 0, i % 2 ? mat(P.ivory) : mat(color));
    m.rotation.x = -a;
    m.position.set(-1.75 + i * 0.5, 2.85 - Math.sin(a) * 0.85, -0.85 * Math.cos(a) - 0.05);
  }
  sbox(g, 4, 0.26, 0.04, 0, 2.38, -1.62, mat(color)); // valance
  for (const x of [-1.95, 1.95]) {
    const arm = sbox(g, 0.05, 0.05, 1.8, x, 2.55, -0.85, mat(P.slate));
    arm.rotation.x = -0.32;
  }
  g.position.z = 0;
  return g;
}

// ───────────────────────────── roads ─────────────────────────────

const ASPHALT = toon(0x5b5a55, { rim: 0.08 });

/** Road tile, 4 × 4. Markings follow the neighbours: straight, corner, T or crossing (with zebra). */
function road(color, ctx) {
  const g = new THREE.Group();
  sbox(g, 4, 0.1, 4, 0, -0.03, 0, ASPHALT).castShadow = false;
  if (ctx?.ground) sbox(g, 4, FOUND, 4, 0, -FOUND / 2 - 0.08, 0, ASPHALT).castShadow = false;
  const N = ctx?.near('road', 0, -4), S = ctx?.near('road', 0, 4), E = ctx?.near('road', 4, 0), W = ctx?.near('road', -4, 0);
  const sides = [['N', N, 0, -1], ['S', S, 0, 1], ['E', E, 1, 0], ['W', W, -1, 0]];
  const count = sides.filter((s) => s[1]).length;
  const flat = (w, d, x, z, m) => { const p = add(g, new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), m, x, 0.025, z); p.castShadow = false; p.userData.paint = true; return p; };
  // edge lines on open sides
  for (const [, on, dx, dz] of sides) {
    if (on) continue;
    if (dx) flat(0.14, 4, dx * 1.7, 0, DECALS.line); else flat(4, 0.14, 0, dz * 1.7, DECALS.line);
  }
  const cornerPair = count === 2 && !((N && S) || (E && W));
  if (cornerPair) {
    // a bend: replace the square slab with a quarter disc swept around the inner corner
    g.clear();
    const sx = E ? 1 : -1, sz = S ? 1 : -1;
    const [lo, hi] = quarter(sx, sz);
    const c = [sx * 2, sz * 2];
    add(g, arcSlab(c[0], c[1], 0, 4, lo, hi, 0.02, ctx?.ground ? FOUND + 0.1 : 0.1), ASPHALT).castShadow = false;
    arcBand(g, c[0], c[1], 3.68, 3.82, lo, hi, DECALS.line);
    arcDashes(g, c[0], c[1], 2, lo, hi, DECALS.dash);
    return g;
  }
  if (count >= 3) {
    // zebra crossing on each arm
    for (const [, on, dx, dz] of sides) {
      if (!on) continue;
      for (let i = -3; i <= 3; i++) {
        if (dx) flat(0.5, 0.32, dx * 1.6, i * 0.5, DECALS.line); else flat(0.32, 0.5, i * 0.5, dz * 1.6, DECALS.line);
      }
    }
  } else {
    // centre dashes from the middle out toward each connected side (rhythm continues tile to tile)
    const arms = count === 0 ? [] : sides.filter((s) => s[1]);
    if (count === 2 && ((N && S) || (E && W))) {
      for (const p of [-1, 1]) (N ? flat(0.14, 1, 0, p, DECALS.dash) : flat(1, 0.14, p, 0, DECALS.dash));
    } else for (const [, , dx, dz] of arms) {
      if (dx) flat(1, 0.14, dx, 0, DECALS.dash); else flat(0.14, 1, 0, dz, DECALS.dash);
    }
  }
  return g;
}

/** Angular range of the quarter facing away from a corner at (sx, sz) (for bends). */
function quarter(sx, sz) {
  let a = Math.atan2(0, -sx), b = Math.atan2(-sz, 0);
  let lo = Math.min(a, b), hi = Math.max(a, b);
  if (hi - lo > Math.PI) [lo, hi] = [hi, lo + Math.PI * 2];
  return [lo, hi];
}

/** Flat annulus sector around (cx, cz) between radii, angles in the x–z plane; top at `top`, `depth` thick. */
function arcSlab(cx, cz, r0, r1, a0, a1, top, depth) {
  const s = new THREE.Shape();
  if (r0 <= 0) { s.moveTo(cx, cz); s.absarc(cx, cz, r1, a0, a1, false); s.lineTo(cx, cz); }
  else { s.absarc(cx, cz, r1, a0, a1, false); s.absarc(cx, cz, r0, a1, a0, true); }
  const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 24 });
  geo.rotateX(Math.PI / 2); // shape y → world z, extrusion → down
  geo.translate(0, top, 0);
  return geo;
}
function arcBand(g, cx, cz, r0, r1, a0, a1, material) {
  // facing up, the ring's angle θ lands at -θ in x–z; turning by -a1 maps [0, a1 - a0] onto [a0, a1]
  const geo = new THREE.RingGeometry(r0, r1, 40, 1, 0, a1 - a0).rotateX(-Math.PI / 2);
  const m = add(g, geo, material, cx, 0.025, cz);
  m.rotation.y = -a1;
  m.castShadow = false;
  m.userData.paint = true;
  return m;
}
function arcDashes(g, cx, cz, r, a0, a1, material) {
  const n = Math.max(1, Math.floor(((a1 - a0) * r) / 2));
  const span = (a1 - a0) / n;
  for (let i = 0; i < n; i++) arcBand(g, cx, cz, r - 0.07, r + 0.07, a0 + span * (i + 0.25), a0 + span * (i + 0.75), material);
}

/**
 * Sweeping road bend, radius R (centreline): occupies an (R + 2)² square of road tiles, enters on the +Z side
 * and leaves on the +X side; straight tiles snap on and see its ends as road.
 */
function roadCurve(R) {
  return (color, ctx) => {
    const g = new THREE.Group();
    const H = R / 2 + 1;
    const lo = Math.PI, hi = Math.PI * 1.5;
    add(g, arcSlab(H, H, R - 2, R + 2, lo, hi, 0.02, ctx?.ground ? FOUND + 0.1 : 0.1), ASPHALT).castShadow = false;
    arcBand(g, H, H, R - 1.77, R - 1.63, lo, hi, DECALS.line);
    arcBand(g, H, H, R + 1.63, R + 1.77, lo, hi, DECALS.line);
    arcDashes(g, H, H, R, lo, hi, DECALS.dash);
    return g;
  };
}
/** Local road cells at the two ends of a bend (for neighbour lookups). */
const curvePorts = (R) => [[1 - R / 2, R / 2 - 1], [R / 2 - 1, 1 - R / 2]];

/** Sidewalk tile, 4 × 4, 12 cm proud; a bevelled curb runs inside any edge that isn't more sidewalk. */
function sidewalk(color, ctx) {
  const g = new THREE.Group();
  const H = 0.12, B = 0.25;
  const open = { N: !ctx?.near('sidewalk', 0, -4), S: !ctx?.near('sidewalk', 0, 4), E: !ctx?.near('sidewalk', 4, 0), W: !ctx?.near('sidewalk', -4, 0) };
  const x0 = -2 + (open.W ? B : 0), x1 = 2 - (open.E ? B : 0), z0 = -2 + (open.N ? B : 0), z1 = 2 - (open.S ? B : 0);
  gbox(g, x1 - x0, H, z1 - z0, (x0 + x1) / 2, H / 2, (z0 + z1) / 2, color);
  if (ctx?.ground) gbox(g, 4, FOUND, 4, 0, -FOUND / 2, 0, color);
  const curb = mat(P.ivory);
  // each sloped lip stops short of a corner that's also open; a mitred hip fills that corner
  const ends = { N: ['W', 'E'], S: ['W', 'E'], E: ['N', 'S'], W: ['N', 'S'] };
  for (const [side, dx, dz] of [['N', 0, -1], ['S', 0, 1], ['E', 1, 0], ['W', -1, 0]]) {
    if (!open[side]) continue;
    const [a0, a1] = ends[side];
    const t0 = open[a0] ? B : 0, t1 = open[a1] ? B : 0;
    const len = 4 - t0 - t1, shift = (t0 - t1) / 2; // along +x for N/S, +z for E/W
    const lip = add(g, prism([[0, 0], [0, H], [-B, 0]], len, 'x', 0), curb); // local -a points outward
    lip.rotation.y = Math.atan2(dx, dz);
    lip.position.set(dx * (2 - B) + (dz ? shift : 0), 0, dz * (2 - B) + (dx ? shift : 0));
  }
  for (const [sx, sz, a, b] of [[-1, -1, 'W', 'N'], [1, -1, 'E', 'N'], [-1, 1, 'W', 'S'], [1, 1, 'E', 'S']]) {
    if (!open[a] || !open[b]) continue;
    const I = [sx * (2 - B), H, sz * (2 - B)], A = [sx * (2 - B), 0, sz * 2], O = [sx * 2, 0, sz * 2], C = [sx * 2, 0, sz * (2 - B)];
    const tris = sx * sz > 0 ? [I, A, O, I, O, C] : [I, O, A, I, C, O];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
    geo.computeVertexNormals();
    add(g, geo, curb);
  }
  return g;
}

// ───────────────────────────── props ─────────────────────────────

function container(color) {
  const g = new THREE.Group();
  const { L, H, D } = CONTAINER;
  const body = mat(color), dark = mat(P.slate), ink = mat(P.ink);
  rbox(g, L - 0.2, H - 0.24, D - 0.1, 0, H / 2, 0, body, 0.03);
  const ribs = [];
  for (let x = -L / 2 + 0.35; x < L / 2 - 0.3; x += 0.34) for (const s of [-1, 1]) ribs.push(new THREE.BoxGeometry(0.14, H - 0.34, 0.06).translate(x, H / 2, s * (D / 2 - 0.03)));
  for (let z = -D / 2 + 0.35; z < D / 2 - 0.3; z += 0.34) ribs.push(new THREE.BoxGeometry(0.06, H - 0.34, 0.14).translate(-L / 2 + 0.07, H / 2, z));
  add(g, mergeGeometries(ribs), body);
  for (const y of [0.08, H - 0.08]) for (const s of [-1, 1]) sbox(g, L, 0.16, 0.14, 0, y, s * (D / 2 - 0.07), dark);
  for (const y of [0.08, H - 0.08]) for (const s of [-1, 1]) sbox(g, 0.14, 0.16, D - 0.28, s * (L / 2 - 0.07), y, 0, dark);
  for (const x of [-1, 1]) for (const z of [-1, 1]) sbox(g, 0.18, H, 0.18, x * (L / 2 - 0.09), H / 2, z * (D / 2 - 0.09), dark);
  rbox(g, 0.06, H - 0.3, D - 0.36, L / 2 - 0.1, H / 2, 0, body, 0.02);
  rbox(g, 0.08, H - 0.27, 0.05, L / 2 - 0.08, H / 2, 0, dark, 0.02);
  for (const z of [-0.85, -0.45, 0.45, 0.85]) {
    add(g, cyl(0.03, H - 0.3, 10), dark, L / 2 - 0.03, H / 2, z);
    rbox(g, 0.06, 0.32, 0.06, L / 2, 1.15, z + 0.058, ink, 0.02); // handle against its locking bar
  }
  return g;
}

function crate(color) {
  const g = new THREE.Group();
  const s = CRATE, wood = mat(color), band = mat(P.bookcloth);
  rbox(g, s - 0.06, s - 0.06, s - 0.06, 0, s / 2, 0, wood, 0.05);
  for (const y of [0.09, s - 0.09]) rbox(g, s, 0.16, s, 0, y, 0, band, 0.04);
  for (const x of [-1, 1]) for (const z of [-1, 1]) rbox(g, 0.14, s - 0.3, 0.14, x * (s / 2 - 0.07), s / 2, z * (s / 2 - 0.07), band, 0.04);
  for (const z of [-1, 1]) {
    const b = rbox(g, 1.1, 0.12, 0.05, 0, s / 2, z * (s / 2 + 0.005), band, 0.02);
    b.rotation.z = z * Math.PI / 4;
  }
  return g;
}

function barrel(color) {
  const g = new THREE.Group();
  add(g, cyl(0.32, 0.92, 24), mat(color), 0, 0.46, 0);
  for (const y of [0.22, 0.7]) add(g, cyl(0.335, 0.05, 24), mat(P.slate), 0, y, 0);
  add(g, cyl(0.29, 0.03, 24), mat(P.ink), 0, 0.935, 0);
  return g;
}

function dumpster(color) {
  const g = new THREE.Group();
  add(g, prism([[-0.95, 0.15], [0.95, 0.15], [1.05, 1.3], [-0.95, 1.3]], 2.2, 'x', 0.03), mat(color));
  const lid = rbox(g, 2.24, 0.08, 2.1, 0, 1.38, 0.05, mat(P.slate), 0.03);
  lid.rotation.x = -0.05;
  for (const x of [-0.85, 0.85]) for (const z of [-0.7, 0.7]) add(g, cyl(0.09, 0.08, 12).rotateZ(Math.PI / 2), mat(P.ink), x, 0.09, z);
  for (const x of [-1.15, 1.15]) rbox(g, 0.1, 0.12, 1.4, x, 1.0, 0, mat(P.ink), 0.03);
  return g;
}

function bench(color) {
  const g = new THREE.Group();
  const wood = mat(color), iron = mat(P.ink);
  for (let i = 0; i < 3; i++) rbox(g, 1.8, 0.05, 0.13, 0, 0.45, -0.17 + i * 0.16, wood, 0.02);
  for (let i = 0; i < 2; i++) { const b = rbox(g, 1.8, 0.13, 0.05, 0, 0.62 + i * 0.17, -0.29, wood, 0.02); b.rotation.x = -0.18; }
  for (const x of [-0.75, 0.75]) {
    rbox(g, 0.06, 0.45, 0.5, x, 0.225, 0, iron, 0.02);
    const back = rbox(g, 0.06, 0.5, 0.06, x, 0.68, -0.3, iron, 0.02);
    back.rotation.x = -0.18;
  }
  return g;
}

function lamp(color) {
  const g = new THREE.Group();
  const m = mat(color);
  add(g, cyl(0.16, 0.3, 14, 0.12), m, 0, 0.15, 0);
  add(g, cyl(0.07, 4.6, 12, 0.055), m, 0, 2.6, 0);
  rbox(g, 0.08, 0.08, 1.2, 0, 4.85, -0.55, m, 0.03);
  rbox(g, 0.34, 0.16, 0.62, 0, 4.76, -1.1, mat(P.slate), 0.05);
  const glow = rbox(g, 0.28, 0.04, 0.5, 0, 4.67, -1.1, new THREE.MeshBasicMaterial({ color: 0xfff2d2 }), 0.02);
  glow.castShadow = false;
  return g;
}

function fuelPump(color) {
  const g = new THREE.Group();
  rbox(g, 1.8, 0.2, 1.0, 0, 0.1, 0, mat(P.slate), 0.05); // island
  rbox(g, 0.7, 1.6, 0.5, 0, 1.0, 0, mat(P.ivory), 0.06);
  rbox(g, 0.72, 0.52, 0.52, 0, 1.57, 0, mat(color), 0.05);
  rbox(g, 0.4, 0.26, 0.02, 0, 1.2, -0.26, mat(P.ink), 0.02);
  const hose = add(g, new THREE.TorusGeometry(0.28, 0.025, 6, 16, Math.PI), mat(P.ink), 0.37, 0.85, 0);
  hose.rotation.y = Math.PI / 2;
  for (const x of [-0.75, 0.75]) add(g, cyl(0.07, 1.0, 10), mat(P.clay), x, 0.7, 0); // bollards
  return g;
}

/** Sandbag wall, 2 m: staggered courses of plump bags, each a little askew, tied ends showing. */
function sandbags(color) {
  const g = new THREE.Group();
  const bag = new RoundedBoxGeometry(0.62, 0.2, 0.38, 3, 0.09);
  const geos = [], ties = [];
  for (let row = 0; row < 4; row++) {
    const n = row === 3 ? 2 : 3, off = row % 2 ? 0.32 : 0;
    for (let i = 0; i < n; i++) {
      const x = -0.64 + i * 0.64 + off + (row === 3 ? 0.32 : 0), y = 0.1 + row * 0.19, k = Math.sin(row * 7.3 + i * 3.1);
      geos.push(bag.clone().rotateY(k * 0.08).rotateZ(k * 0.04).translate(x, y, (row % 2 ? -0.03 : 0.03) + k * 0.02));
      ties.push(new THREE.BoxGeometry(0.06, 0.12, 0.2).translate(x + 0.3, y, 0));
    }
  }
  add(g, mergeGeometries(geos), mat(color));
  add(g, mergeGeometries(ties), mat(P.kraft)).userData.noCollide = true;
  return g;
}

/** Concrete planter box, 2 × 1 m, soil and a hedge of shrubs. Waist-high cover. */
function planter(color) {
  const g = new THREE.Group();
  rbox(g, 2, 0.7, 1, 0, 0.35, 0, mat(color), 0.06);
  sbox(g, 1.8, 0.05, 0.8, 0, 0.68, 0, mat(P.bookcloth));
  const leaf = mat(P.sage);
  for (const [r, x, z] of [[0.42, -0.55, 0.05], [0.5, 0.05, -0.05], [0.38, 0.6, 0.08]]) add(g, ico(r, 1), leaf, x, 0.72 + r * 0.55, z).userData.noCollide = true;
  return g;
}

/** 4 × 4 shade canopy: four posts, two beams, a striped sail tilted to shed rain. Walk under it. */
function canopy(color) {
  const g = new THREE.Group();
  const post = mat(P.slate);
  for (const x of [-1.8, 1.8]) for (const z of [-1.8, 1.8]) add(g, cyl(0.07, z < 0 ? 2.9 : 2.6, 10), post, x, (z < 0 ? 2.9 : 2.6) / 2, z);
  for (const x of [-1.8, 1.8]) { const b = sbox(g, 0.1, 0.12, 3.9, x, 2.78, 0, post); b.rotation.x = Math.atan2(0.3, 3.6); }
  const a = Math.atan2(0.3, 3.6);
  for (let i = 0; i < 7; i++) {
    const strip = sbox(g, 0.54, 0.04, 3.9, -1.62 + i * 0.54, 2.88, 0, i % 2 ? mat(P.ivory) : mat(color));
    strip.rotation.x = a;
    strip.userData.noCollide = true;
  }
  for (const z of [-1, 1]) sbox(g, 3.8, 0.22, 0.03, 0, 2.62 + (z < 0 ? 0.15 : -0.15), z * 1.95, mat(color)).userData.noCollide = true; // valances
  return g;
}

/** Market stall, 2.4 × 1.4: counter with produce crates, striped roof on four posts. Faces -Z. */
function stall(color) {
  const g = new THREE.Group();
  const wood = mat(P.kraft), post = mat(P.slate);
  rbox(g, 2.4, 0.9, 0.7, 0, 0.45, -0.3, wood, 0.04);
  sbox(g, 2.5, 0.06, 0.8, 0, 0.93, -0.3, mat(P.bookcloth));
  for (const x of [-1.15, 1.15]) for (const z of [-0.65, 0.65]) add(g, cyl(0.04, 2.3, 8), post, x, 1.15, z);
  const fruit = [P.clay, 0xc6a03a, P.sage, 0xd9a05b];
  for (let i = 0; i < 3; i++) {
    const x = -0.75 + i * 0.75;
    rbox(g, 0.62, 0.18, 0.46, x, 1.05, -0.36, mat(P.manilla), 0.03);
    const m = mat(fruit[(i + (color % 3)) % fruit.length]);
    for (let k = 0; k < 6; k++) add(g, ico(0.075, 0), m, x - 0.18 + (k % 3) * 0.18, 1.18, -0.46 + Math.floor(k / 3) * 0.18).userData.noCollide = true;
  }
  const a = 0.22;
  for (let i = 0; i < 5; i++) {
    const strip = sbox(g, 0.52, 0.04, 1.7, -1.04 + i * 0.52, 2.38, -0.05, i % 2 ? mat(P.ivory) : mat(color));
    strip.rotation.x = -a;
    strip.userData.noCollide = true;
  }
  rbox(g, 0.5, 0.5, 0.5, 0.8, 0.25, 0.4, wood, 0.04); // spare crate behind
  return g;
}

/** Timber utility pole, 7.5 m: crossarm with insulators and a transformer can. */
function pole(color) {
  const g = new THREE.Group();
  const wood = mat(color);
  add(g, cyl(0.13, 7.5, 10, 0.1), wood, 0, 3.75, 0);
  sbox(g, 2.2, 0.14, 0.14, 0, 6.9, 0, wood);
  for (const x of [-0.95, -0.35, 0.35, 0.95]) add(g, cyl(0.05, 0.22, 8), mat(P.ivory), x, 7.08, 0).userData.noCollide = true;
  add(g, cyl(0.26, 0.7, 14), mat(P.cloud), 0, 5.6, 0.3).userData.noCollide = true;
  for (const d of [-1, 1]) { const b = sbox(g, 0.05, 0.05, 0.8, d * 0.4, 6.6, 0, mat(P.slate)); b.rotation.z = d * 0.9; b.rotation.y = Math.PI / 2; b.userData.noCollide = true; }
  return g;
}

function waterTower(color) {
  const g = new THREE.Group();
  const steel = mat(P.slate);
  const legs = [];
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    const leg = add(g, cyl(0.12, 9, 10), steel, x * 1.5, 4.5, z * 1.5);
    leg.rotation.set(z * 0.05, 0, -x * 0.05);
    legs.push(leg);
  }
  for (const y of [2.5, 5.5]) for (const [w, d] of [[3.3, 0.08], [0.08, 3.3]]) for (const s of [-1, 1]) sbox(g, w, 0.1, d, d > 1 ? s * 1.45 : 0, y, w > 1 ? s * 1.45 : 0, steel);
  add(g, cyl(2.3, 3.2, 28), mat(color), 0, 10.6, 0);
  add(g, cyl(2.35, 0.25, 28), mat(P.ink), 0, 9.0, 0);
  add(g, new THREE.ConeGeometry(2.45, 1.2, 28), mat(P.slate), 0, 12.8, 0);
  rbox(g, 5.2, 0.1, 5.2, 0, 8.85, 0, steel, 0.03); // catwalk
  for (let i = 0; i < 18; i++) sbox(g, 0.36, 0.05, 0.05, 0.25, 0.5 + i * 0.47, 1.62, steel); // ladder rungs
  for (const x of [0.07, 0.43]) sbox(g, 0.05, 8.8, 0.05, x, 4.4, 1.62, steel); // rails: ground to catwalk
  return g;
}

// ───────────────────────────── nature ─────────────────────────────

function tree(color) {
  const g = new THREE.Group();
  add(g, cyl(0.2, 2.6, 10, 0.14), mat(P.bookcloth), 0, 1.3, 0);
  const leaf = mat(color);
  for (const [r, x, y, z] of [[1.7, 0, 3.4, 0], [1.25, 0.9, 2.9, 0.5], [1.15, -0.8, 3.0, -0.6], [1.05, 0.2, 4.4, -0.2]]) {
    const b = add(g, ico(r, 1), leaf, x, y, z);
    b.userData.noCollide = true;
  }
  return g;
}

function pine(color) {
  const g = new THREE.Group();
  add(g, cyl(0.18, 1.6, 10, 0.12), mat(P.bookcloth), 0, 0.8, 0);
  const leaf = mat(color);
  [[1.9, 2.2, 1.6], [1.5, 2.0, 2.9], [1.05, 1.8, 4.1]].forEach(([r, h, y]) => { add(g, new THREE.ConeGeometry(r, h, 8), leaf, 0, y, 0).userData.noCollide = true; });
  return g;
}

function bush(color) {
  const g = new THREE.Group();
  const leaf = mat(color);
  for (const [r, x, y, z] of [[0.75, 0, 0.55, 0], [0.55, 0.65, 0.4, 0.2], [0.5, -0.6, 0.38, -0.15]]) add(g, ico(r, 1), leaf, x, y, z);
  return g;
}

function rock(color) {
  const g = new THREE.Group();
  const geo = new THREE.DodecahedronGeometry(1, 0);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const k = 0.8 + 0.35 * Math.abs(Math.sin(pos.getX(i) * 3.1 + pos.getZ(i) * 1.7));
    pos.setXYZ(i, pos.getX(i) * k * 1.3, pos.getY(i) * k * 0.8, pos.getZ(i) * k);
  }
  geo.computeVertexNormals();
  add(g, geo, mat(color), 0, 0.45, 0);
  return g;
}

// ─────────────────────────── vehicles ───────────────────────────

function wheels(g, xs, zs, r, w) {
  for (const x of xs) for (const z of zs) {
    add(g, cyl(r, w, 22).rotateX(Math.PI / 2), mat(P.ink), x, r, z);
    add(g, cyl(r * 0.5, w + 0.02, 18).rotateX(Math.PI / 2), mat(P.ivory), x, r, z);
  }
}

function sedan(color) {
  const g = new THREE.Group();
  const body = mat(color), glass = mat(P.slate), ink = mat(P.ink);
  rbox(g, 4.4, 0.66, 1.8, 0, 0.6, 0, body, 0.22);
  add(g, prism([[-1.35, 0.9], [1.0, 0.9], [0.45, 1.42], [-1.05, 1.42]], 1.62, 'z'), glass);
  rbox(g, 1.58, 0.1, 1.66, -0.3, 1.45, 0, body, 0.04);
  for (const z of [-0.8, 0.8]) rbox(g, 0.12, 0.5, 0.06, -0.15, 1.16, z, body, 0.03);
  for (const z of [-0.6, 0.6]) {
    rbox(g, 0.06, 0.16, 0.42, 2.19, 0.72, z, mat(P.ivory), 0.03);
    rbox(g, 0.06, 0.14, 0.38, -2.19, 0.74, z, mat(P.clay), 0.03);
  }
  for (const x of [-2.18, 2.18]) rbox(g, 0.14, 0.2, 1.84, x, 0.36, 0, ink, 0.06);
  for (const z of [-0.96, 0.96]) rbox(g, 0.16, 0.1, 0.14, 0.55, 0.975, z, ink, 0.03); // mirrors on the door tops
  rbox(g, 4.0, 0.08, 1.82, 0, 0.5, 0, ink, 0.03);
  wheels(g, [-1.35, 1.35], [-0.82, 0.82], 0.34, 0.26);
  return g;
}

function van(color) {
  const g = new THREE.Group();
  const body = mat(color), glass = mat(P.slate), ink = mat(P.ink);
  rbox(g, 3.7, 1.95, 2.0, -0.6, 1.33, 0, body, 0.12);
  add(g, prism([[1.2, 0.38], [2.5, 0.38], [2.5, 1.15], [1.9, 1.95], [1.2, 2.25]], 1.96, 'z', 0.06), body);
  add(g, prism([[1.3, 1.25], [2.0, 1.25], [1.62, 1.98], [1.3, 2.08]], 2.02, 'z', 0.02), glass);
  rbox(g, 3.66, 0.14, 2.04, -0.6, 1.05, 0, mat(P.clay), 0.04);
  for (const z of [-0.65, 0.65]) rbox(g, 0.06, 0.18, 0.4, 2.53, 0.85, z, mat(P.ivory), 0.03);
  rbox(g, 0.16, 0.24, 2.04, 2.54, 0.42, 0, ink, 0.06);
  rbox(g, 0.16, 0.24, 2.04, -2.48, 0.42, 0, ink, 0.06);
  wheels(g, [-1.6, 1.55], [-0.92, 0.92], 0.38, 0.28);
  return g;
}

function pickup(color) {
  const g = new THREE.Group();
  const body = mat(color), ink = mat(P.ink);
  rbox(g, 5.0, 0.7, 1.9, 0, 0.75, 0, body, 0.16);
  add(g, prism([[0.0, 1.05], [1.55, 1.05], [1.15, 1.75], [0.15, 1.78]], 1.8, 'z', 0.04), mat(P.slate));
  rbox(g, 1.3, 0.1, 1.84, 0.62, 1.8, 0, body, 0.04);
  for (const z of [-0.88, 0.88]) rbox(g, 2.2, 0.36, 0.1, -1.35, 1.25, z, body, 0.03); // bed sides
  rbox(g, 0.1, 0.36, 1.86, -2.45, 1.25, 0, body, 0.03); // tailgate
  rbox(g, 2.1, 0.05, 1.7, -1.35, 1.08, 0, mat(P.slate), 0.02); // bed floor
  for (const x of [-2.5, 2.5]) rbox(g, 0.16, 0.22, 1.94, x, 0.44, 0, ink, 0.06);
  for (const z of [-0.6, 0.6]) rbox(g, 0.06, 0.16, 0.36, 2.51, 0.85, z, mat(P.ivory), 0.03);
  wheels(g, [-1.6, 1.55], [-0.86, 0.86], 0.4, 0.3);
  return g;
}

// ─────────────────────────── barriers ───────────────────────────
// End posts come from buildJoints(), so runs share one post at every seam.

function guardrail(color) {
  const g = new THREE.Group();
  const m = mat(color);
  for (const x of [-0.67, 0.67]) sbox(g, 0.08, 1.05, 0.08, x, 0.525, 0, m);
  sbox(g, 4, 0.08, 0.1, 0, 1.06, 0, m);
  sbox(g, 4, 0.06, 0.06, 0, 0.58, 0, m);
  sbox(g, 4, 0.12, 0.04, 0, 0.08, 0, mat(P.ink));
  return g;
}

function fence(color) {
  const g = new THREE.Group();
  const m = mat(color), H = 2.1;
  add(g, cyl(0.05, H + 0.1, 12), m, 0, (H + 0.1) / 2, 0);
  for (const y of [0.12, H]) add(g, cyl(0.035, 4, 10).rotateZ(Math.PI / 2), m, 0, y, 0);
  const bars = [];
  for (let x = -1.9; x <= 1.91; x += 0.14) if (Math.abs(x) > 0.08) bars.push(new THREE.BoxGeometry(0.02, H - 0.14, 0.02).translate(x, (H + 0.12) / 2, 0));
  add(g, mergeGeometries(bars), mat(P.slate));
  return g;
}

function picket(color) {
  const g = new THREE.Group();
  const m = mat(color);
  const slats = [];
  for (let x = -1.74; x <= 1.75; x += 0.29) {
    slats.push(new THREE.BoxGeometry(0.14, 1.0, 0.04).translate(x, 0.55, 0.04));
    slats.push(new THREE.ConeGeometry(0.1, 0.14, 4).rotateY(Math.PI / 4).scale(1, 1, 0.3).translate(x, 1.12, 0.04));
  }
  add(g, mergeGeometries(slats), m);
  for (const y of [0.3, 0.85]) sbox(g, 4, 0.1, 0.05, 0, y, -0.01, m);
  return g;
}

function jersey(color) {
  const g = new THREE.Group();
  add(g, prism([[-0.32, 0], [0.32, 0], [0.32, 0.1], [0.13, 0.32], [0.1, 0.82], [-0.1, 0.82], [-0.13, 0.32], [-0.32, 0.1]], 2, 'x', 0.02), mat(color));
  for (const x of [-0.6, 0.6]) rbox(g, 0.28, 0.08, 0.22, x, 0.83, 0, mat(P.clay), 0.02);
  return g;
}

// ─────────────────────────── gameplay ───────────────────────────

function spawn(color) {
  const g = new THREE.Group();
  const m = new THREE.MeshBasicMaterial({ color, toneMapped: false });
  add(g, new THREE.CircleGeometry(0.7, 32).rotateX(-Math.PI / 2), mat(P.ivory), 0, 0.02, 0).castShadow = false;
  add(g, new THREE.RingGeometry(0.58, 0.7, 32).rotateX(-Math.PI / 2), m, 0, 0.03, 0).castShadow = false;
  const arrow = new THREE.Shape([[-0.3, 0.1], [0, -0.5], [0.3, 0.1], [0.1, 0.1], [0.1, 0.4], [-0.1, 0.4], [-0.1, 0.1]].map(([x, z]) => new THREE.Vector2(x, z)));
  add(g, new THREE.ShapeGeometry(arrow).rotateX(Math.PI / 2), m, 0, 0.04, 0).castShadow = false;
  add(g, cyl(0.04, 2.2, 10), mat(P.slate), 0, 1.1, 0.5);
  rbox(g, 0.6, 0.4, 0.04, 0.32, 1.95, 0.5, mat(color), 0.02);
  g.userData.marker = true;
  return g;
}

/** Editor stand-in for a pickup: the item hovering as it will in play over a pad in its accent colour. */
function pickupPiece(type, gun, color) {
  const g = new THREE.Group();
  add(g, new THREE.CircleGeometry(0.46, 32).rotateX(-Math.PI / 2), mat(P.ivory), 0, 0.02, 0).castShadow = false;
  add(g, new THREE.RingGeometry(0.36, 0.46, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, toneMapped: false }), 0, 0.03, 0).castShadow = false;
  const m = pickupModel(type, gun);
  m.scale.setScalar(type === 'gun' ? GUN_SHOW : ITEMS[type].show);
  m.position.y = 0.32;
  g.add(m);
  g.traverse((o) => { if (o.isMesh) o.userData.noCollide = true; });
  g.userData.marker = true;
  return g;
}

// ─────────────────────────── joints ───────────────────────────

const LINK_PRIORITY = { wall: 4, rail: 3, picket: 2, fence: 1 };

function jointPost(kind, h, t, color, ground, onSlab = false) {
  const g = new THREE.Group();
  if (kind === 'wall') {
    const w = t + 0.16;
    gbox(g, w, h + 0.02, w, 0, (h + 0.02) / 2, 0, color);
    if (ground) gbox(g, w, FOUND, w, 0, -FOUND / 2, 0, color);
    else if (onSlab) gbox(g, w, SLAB, w, 0, -SLAB / 2, 0, color);
    sbox(g, w + 0.06, 0.16, w + 0.06, 0, h + 0.096, 0, mat(P.ink));
    if (h > 1) sbox(g, w + 0.05, 0.18, w + 0.05, 0, 0.094, 0, mat(P.slate));
  } else if (kind === 'fence') add(g, cyl(0.065, 2.25, 12), mat(color), 0, 1.125, 0);
  else if (kind === 'picket') rbox(g, 0.13, 1.25, 0.13, 0, 0.625, 0, mat(P.slate), 0.03);
  else rbox(g, 0.09, 1.12, 0.09, 0, 0.56, 0, mat(color), 0.02);
  return g;
}

const slabKey = (x, y, z) => `${Math.round(x * 2)}|${Math.round(y * 5)}|${Math.round(z * 2)}`;

/** Endpoints of every linear piece → connectors (pillars at wall corners/tees, posts along fences). */
export function buildJoints(records, groundAt) {
  const out = new THREE.Group();
  const slabs = new Set(records.filter((r) => r.type === 'floor').map((r) => slabKey(r.x, r.y ?? 0, r.z)));
  const lines = [];
  for (const r of records) {
    const a = assetById(r.type);
    if (!a?.link) continue;
    const rot = ((r.rot ?? 0) * Math.PI) / 180, dx = Math.cos(rot), dz = -Math.sin(rot);
    const L = a.link.len / 2;
    lines.push({ r, a, kind: a.link.kind, h: a.link.h, t: a.link.t ?? WALL_T, y: r.y ?? 0, ax: r.x - dx * L, az: r.z - dz * L, bx: r.x + dx * L, bz: r.z + dz * L, dx, dz });
  }
  const groups = new Map();
  const key = (x, y, z) => `${Math.round(x * 20)},${Math.round(y * 10)},${Math.round(z * 20)}`;
  for (const l of lines) {
    for (const [x, z, sx, sz] of [[l.ax, l.az, l.dx, l.dz], [l.bx, l.bz, -l.dx, -l.dz]]) {
      const k = key(x, l.y, z);
      if (!groups.has(k)) groups.set(k, { x, z, y: l.y, ends: [] });
      groups.get(k).ends.push({ l, sx, sz });
    }
  }
  // a wall end resting against another wall's side is a tee
  const onSide = (gp, kind) => lines.some((o) => {
    if (o.kind !== kind || Math.abs(o.y - gp.y) > 0.05) return false;
    const vx = o.bx - o.ax, vz = o.bz - o.az, len2 = vx * vx + vz * vz;
    const t = ((gp.x - o.ax) * vx + (gp.z - o.az) * vz) / len2;
    if (t <= 0.02 || t >= 0.98) return false;
    return Math.hypot(o.ax + vx * t - gp.x, o.az + vz * t - gp.z) < o.t / 2 + 0.02;
  });
  for (const gp of groups.values()) {
    const ends = gp.ends;
    const top = ends.reduce((m, e) => (LINK_PRIORITY[e.l.kind] > LINK_PRIORITY[m.l.kind] ? e : m));
    const kind = top.l.kind;
    let need = true;
    if (kind === 'wall') {
      const walls = ends.filter((e) => e.l.kind === 'wall');
      const tee = onSide(gp, 'wall');
      if (walls.length === 1 && ends.length === 1 && !tee) need = false;
      else if (walls.length === 2 && ends.length === 2 && !tee) {
        const [p, q] = walls;
        const straight = p.sx * q.sx + p.sz * q.sz < -0.999;
        if (straight && p.l.h === q.l.h && p.l.t === q.l.t) need = false;
      }
    }
    if (!need) continue;
    const same = ends.filter((e) => e.l.kind === kind);
    const h = Math.max(...same.map((e) => e.l.h)), t = Math.max(...same.map((e) => e.l.t));
    const ground = groundAt ? Math.abs(gp.y - groundAt(gp.x, gp.z)) < 0.35 : gp.y < 0.05;
    const onSlab = !ground && kind === 'wall' && [-2, 2].some((dx) => [-2, 2].some((dz) => slabs.has(slabKey(gp.x + dx, gp.y, gp.z + dz))));
    const post = jointPost(kind, h, t, top.l.r.color ?? top.l.a.colors[0], ground, onSlab);
    post.position.set(gp.x, gp.y, gp.z);
    post.rotation.y = Math.atan2(-top.l.dz, top.l.dx);
    out.add(post);
  }
  return out;
}

// ─────────────────────────── prefabs ───────────────────────────
// Whole buildings built from the same kit, as one piece: big footprints without thousands of records.

const HOLES = {
  window: [{ x0: -0.7, x1: 0.7, y0: WINDOW.sill, y1: WINDOW.head }],
  wide: [{ x0: -1.4, x1: 1.4, y0: WINDOW.sill, y1: WINDOW.head }],
  door: [{ x0: -DOOR.w / 2, x1: DOOR.w / 2, y0: 0, y1: DOOR.h }],
  shop: [{ x0: -1.75, x1: -1.75 + DOOR.w, y0: 0, y1: DOOR.h }, { x0: -0.25, x1: 1.75, y0: 0.55, y1: DOOR.h }],
  gate: [{ x0: -DOOR.w, x1: DOOR.w, y0: 0, y1: DOOR.h }],
  plain: [],
};
function place(g, child, x, y, z, rot = 0) { child.position.set(x, y, z); child.rotation.y = rot; g.add(child); return child; }

/** Ring of 4 m wall bays around a w × d footprint (centred); sides list hole presets in travel order. */
function shell(g, color, ctx, w, d, y, { N, S, W, E }, h = WALL_H) {
  const run = (list, len, fn) => list.forEach((kind, i) => fn(-len / 2 + 2 + i * 4, kind));
  // only ground bays get foundations; bays standing on a slab reach down over its edge
  const bay = (kind) => wall(color, y === 0 ? ctx : null, { h, holes: HOLES[kind] ?? [], drop: y > 0 ? SLAB : 0 });
  run(N, w, (x, k) => place(g, bay(k), x, y, -d / 2, 0));
  run(S, w, (x, k) => place(g, bay(k), x, y, d / 2, 0));
  run(W, d, (z, k) => place(g, bay(k), -w / 2, y, z, Math.PI / 2));
  run(E, d, (z, k) => place(g, bay(k), w / 2, y, z, Math.PI / 2));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) place(g, jointPost('wall', h, WALL_T, color, ctx?.ground && y === 0, y > 0), sx * w / 2, y, sz * d / 2);
}

/** Flat roof slab + parapet ring with corner posts. */
function flatRoof(g, color, w, d, y, slab = P.oat) {
  gbox(g, w, 0.3, d, 0, y + 0.15, 0, slab);
  shell(g, color, null, w, d, y + 0.3, { N: Array(w / 4).fill('plain'), S: Array(w / 4).fill('plain'), W: Array(d / 4).fill('plain'), E: Array(d / 4).fill('plain') }, 0.75);
}

const pick = (list, i) => list[i % list.length];

/**
 * 12 × 12 tower, `n` storeys (3.5 m each). Ground floor: shopfront to the south, door to the north.
 * Switchback stairs in two 2 m columns along the east side, one flight per storey, the last onto the roof.
 * Storey 2 has side doors in the north bay east and west, so walkways can link towers 4 m apart.
 */
function tower(n) {
  return (color, ctx) => {
    const g = new THREE.Group();
    const accent = color === P.slate ? P.ivory : P.slate;
    for (let k = 0; k < n; k++) {
      const y = k * STOREY;
      const side = k === 2 ? ['door', 'window', 'window'] : [pick(['window', 'wide'], k), 'plain', 'window'];
      shell(g, color, ctx, 12, 12, y, {
        N: k === 0 ? ['window', 'door', 'window'] : ['window', 'window', 'window'],
        S: k === 0 ? ['shop', 'door', 'shop'] : ['wide', 'window', 'wide'],
        W: side, E: k === 2 ? ['door', 'plain', 'plain'] : ['window', 'plain', 'plain'],
      });
      // slab above this storey with a stairwell over both stair columns (x 2…6, z -3…3)
      const top = y + WALL_H;
      gbox(g, 8, 0.3, 12, -2, top + 0.15, 0, P.oat);
      gbox(g, 4, 0.3, 3, 4, top + 0.15, -4.5, P.oat);
      gbox(g, 4, 0.3, 3, 4, top + 0.15, 4.5, P.oat);
      // flight: even storeys in column A (low end south), odd in column B (low end north)
      // column B stops at the east wall's inner face instead of running into it
      const fl = place(g, stairs(accent, null, { rise: STOREY, run: 6, w: k % 2 ? 1.84 : 2 }), k % 2 ? 4.93 : 3, y, 0, k % 2 ? Math.PI : 0);
      fl.userData.flight = true;
    }
    const roofY = n * STOREY;
    // parapet ring and a few roof fixtures
    shell(g, color, null, 12, 12, roofY, { N: ['plain', 'plain', 'plain'], S: ['plain', 'plain', 'plain'], W: ['plain', 'plain', 'plain'], E: ['plain', 'plain', 'plain'] }, 0.75);
    rbox(g, 1.6, 1.0, 1.2, -3, roofY + 0.5, -3, mat(P.ivory), 0.06);
    rbox(g, 1.2, 0.8, 1.2, -3.2, roofY + 0.4, 2.5, mat(P.cloud), 0.06);
    add(g, cyl(0.9, 1.6, 18), mat(P.sky), -0.5, roofY + 0.8, 3.6);
    return g;
  };
}

/** 12 × 12 raised terrace, one storey high, with a stair cut into its west edge (low end south). */
function podium(color, ctx) {
  const g = new THREE.Group();
  const H = STOREY, base = ctx?.ground ? -FOUND : 0;
  const T = H - 0.12; // body stops under the ink cap so the walking surface is exactly one storey up
  gbox(g, 10, T - base, 12, 1, (T + base) / 2, 0, color);
  gbox(g, 2, T - base, 6, -5, (T + base) / 2, -3, color);
  if (base < 0) gbox(g, 2, -base, 6, -5, base / 2, 3, color);
  gbox(g, 10, 0.12, 12, 1, H - 0.06, 0, P.manilla);
  gbox(g, 2, 0.12, 6, -5, H - 0.06, -3, P.manilla);
  place(g, stairs(P.ivory, null, { rise: H, run: 6, w: 2, rail: false }), -5, 0, 3, 0);
  return g;
}

// ─────────────────────────── doors ───────────────────────────

const DOOR_FRAME = 0.09; // a wall opening's jambs and head (wall() frames every hole with this)
const DOOR_TINTS = [P.sage, P.sky, P.clay, P.kraft, P.slate, P.olive];

/**
 * One door leaf `w` × `h`, hinged at its local origin and reaching along +X (or -X when `flip`): a panelled
 * slab with a kick plate and a handle on both faces. Shared by the editor piece and the working doors.
 */
export function doorLeaf(w, h, color, flip = false) {
  const g = new THREE.Group();
  const s = flip ? -1 : 1, t = 0.06, body = mat(color), trim = mat(P.ink);
  rbox(g, w, h, t, s * w / 2, h / 2, 0, body, 0.02);
  for (const z of [-1, 1]) {
    for (const [y, ph] of [[h * 0.71, h * 0.36], [h * 0.27, h * 0.34]]) rbox(g, w - 0.3, ph, 0.02, s * w / 2, y, z * (t / 2 + 0.006), mat(P.cloud), 0.01).userData.noCollide = true;
    sbox(g, w - 0.06, 0.16, 0.012, s * w / 2, 0.1, z * (t / 2 + 0.006), trim).userData.noCollide = true;
    const knob = add(g, new THREE.SphereGeometry(0.035, 12, 8), trim, s * (w - 0.1), 1.0, z * (t / 2 + 0.05));
    knob.userData.noCollide = true;
    sbox(g, 0.024, 0.024, 0.05, s * (w - 0.1), 1.0, z * (t / 2 + 0.025), trim).userData.noCollide = true;
  }
  for (const y of [0.3, h - 0.3]) add(g, cyl(0.022, 0.14, 8), trim, 0, y, 0).userData.noCollide = true; // hinges
  return g;
}

/** The leaves a doorway { x0, x1, h } takes (in its wall's frame): one, or a pair for a double-width gate. */
export function doorLeaves({ x0, x1, h }) {
  const gap = 0.006, w = x1 - x0, hh = h - 0.03;
  if (w < DOOR.w * 1.5) return [{ x: x0 + gap, w: w - 2 * gap, h: hh, flip: false }];
  return [{ x: x0 + gap, w: w / 2 - 1.5 * gap, h: hh, flip: false }, { x: x1 - gap, w: w / 2 - 1.5 * gap, h: hh, flip: true }];
}

export const doorTint = (x, z) => DOOR_TINTS[Math.abs(Math.round(x * 7 + z * 13)) % DOOR_TINTS.length];

/** Editor piece: a doorway's leaf, closed. In play it's a working door (maps/doors.js), not this. */
function doorPiece(color, ctx) {
  const g = new THREE.Group();
  const way = { x0: -DOOR.w / 2 + DOOR_FRAME, x1: DOOR.w / 2 - DOOR_FRAME, h: DOOR.h - DOOR_FRAME };
  for (const l of doorLeaves(way)) g.add(doorLeaf(l.w, l.h, color, l.flip)).children.at(-1).position.x = l.x;
  g.userData.doorways = [way];
  return g;
}

// ─────────────────────────── waterfront ───────────────────────────
// For flooded maps (map.water): solid concrete that reaches below the waterline, so nothing floats.

const SEA_DEEP = 3.4; // how far dock bodies and walls reach below their deck

/**
 * 4 × 4 concrete dock tile, deck top at the record's y, body down under the water. Sides with no dock
 * beside them get a painted kerb line, rubber fenders at the waterline and now and then a bollard.
 */
function dock(color, ctx) {
  const g = new THREE.Group();
  const r = ctx?.rec ?? { x: 0, y: 0, z: 0 };
  const deco = (m) => { m.userData.noCollide = true; return m; };
  gbox(g, 4, 0.3, 4, 0, -0.15, 0, color);
  gbox(g, 3.9, SEA_DEEP - 0.3, 3.9, 0, -0.3 - (SEA_DEEP - 0.3) / 2, 0, P.cloud);
  const sides = [['N', 0, -1], ['S', 0, 1], ['W', -1, 0], ['E', 1, 0]];
  const roll = (salt) => { const v = Math.sin(r.x * 12.9898 + r.z * 78.233 + salt * 4.137) * 43758.5453; return v - Math.floor(v); };
  sides.forEach(([, sx, sz], i) => {
    if (ctx?.near('dock', sx * 4, sz * 4)) return;
    const along = sz ? 'x' : 'z';
    const at = (u, y, out, w, h, d, material) => {
      const [x, z] = along === 'x' ? [u, sz * (2 - d / 2 + out)] : [sx * (2 - d / 2 + out), u];
      return along === 'x' ? sbox(g, w, h, d, x, y, z, material) : sbox(g, d, h, w, x, y, z, material);
    };
    deco(at(0, 0.006, -0.12, 3.6, 0.012, 0.14, mat(P.manilla))); // painted edge line
    deco(at(0, -0.152, 0.06, 4.12, 0.3, 0.06, mat(P.ink))); // deck edge, just outside the deck's face
    for (const u of [-1.1, 1.1]) deco(add(g, new RoundedBoxGeometry(along === 'x' ? 0.7 : 0.24, 0.9, along === 'x' ? 0.24 : 0.7, 2, 0.06), mat(P.slate), along === 'x' ? u : sx * 2.08, -1.25, along === 'x' ? sz * 2.08 : u));
    if (roll(i) < 0.4) {
      const [bx, bz] = along === 'x' ? [roll(i + 9) < 0.5 ? -1.5 : 1.5, sz * 1.55] : [sx * 1.55, roll(i + 9) < 0.5 ? -1.5 : 1.5];
      add(g, cyl(0.16, 0.42, 14), mat(P.slate), bx, 0.21, bz);
      add(g, cyl(0.22, 0.08, 14), mat(P.ink), bx, 0.44, bz);
    }
  });
  return g;
}

/** 4 m quay / lock wall: rises from below the water to 3.5 m over the deck line, flat faces for wallrunning. */
function seawall(color) {
  const g = new THREE.Group();
  const deco = (m) => { m.userData.noCollide = true; return m; };
  const H = SEA_DEEP + STOREY, t = 0.7;
  gbox(g, 4, H, t, 0, H / 2 - SEA_DEEP, 0, color);
  gbox(g, 4, 0.22, t + 0.24, 0, STOREY + 0.11, 0, P.oat); // coping
  trim(sbox(g, 4.02, 0.06, t + 0.28, 0, STOREY + 0.24, 0, mat(P.ink)));
  for (const s of [-1, 1]) {
    deco(sbox(g, 0.05, H - 0.4, 0.04, 0, H / 2 - SEA_DEEP - 0.2, s * (t / 2 + 0.024), mat(P.cloud))); // pour joint, over the band
    deco(sbox(g, 3.98, 0.5, 0.04, 0, -1.15, s * (t / 2 + 0.01), mat(P.olive))); // waterline weed band
    for (const x of [-1.2, 1.2]) deco(add(g, new RoundedBoxGeometry(0.5, 1.1, 0.24, 2, 0.06), mat(P.slate), x, -1.2, s * (t / 2 + 0.12)));
  }
  return g;
}

/** Support column under a raised deck: its top at the record's y, reaching 8 m down. */
function stilt(color) {
  const g = new THREE.Group();
  add(g, cyl(0.24, 8, 16), mat(color), 0, -4.2, 0);
  sbox(g, 0.7, 0.24, 0.7, 0, -0.12, 0, mat(P.ink));
  for (const y of [-1.4, -3.2]) add(g, cyl(0.3, 0.12, 16), mat(P.ink), 0, y, 0).userData.noCollide = true;
  return g;
}

/**
 * Drained swimming pool, 14 × 7 inside, sunk into the ground: shallow end (-X, 1.15 m, steps) sloping to a
 * deep end (+X, 2.3 m, ladder, diving board, a puddle). The paved surround reaches 10 × 6 from the centre
 * so it covers the terrain's 2 m lattice bank: dig the ground under it to -3 m first (inside ±8 × ±4).
 */
const POOL = { x: 7, z: 3.5, shallow: 1.15, deep: 2.3, outX: 10, outZ: 6 };
let waterMat;
function pool(color) {
  const g = new THREE.Group();
  const { x: X, z: Z, shallow: S, deep: D, outX, outZ } = POOL;
  const deco = (m) => { m.userData.noCollide = true; return m; };
  const t = 0.3, top = -0.13; // the paved deck (0.13 thick) is flush with the ground
  // basin floor: flat shallow end, an incline, flat deep end
  gbox(g, 4, t, 2 * Z, -X + 2, -S - t / 2, 0, color);
  gbox(g, 5, t, 2 * Z, X - 2.5, -D - t / 2, 0, color);
  const run = 5, fall = D - S, a = Math.atan2(fall, run), len = Math.hypot(run, fall);
  const inc = gbox(g, len + 0.1, t, 2 * Z, -0.5, -(S + D) / 2 - t / 2 / Math.cos(a), 0, color);
  inc.rotation.z = -a;
  // liner walls down to below the deep floor
  const bottom = -D - t, h = top - bottom;
  for (const sx of [-1, 1]) gbox(g, t, h, 2 * Z + 2 * t, sx * (X + t / 2), bottom + h / 2, 0, color);
  for (const sz of [-1, 1]) gbox(g, 2 * X, h, t, 0, bottom + h / 2, sz * (Z + t / 2), color);
  // waterline tile band and lane marks
  const band = mat(P.slate);
  for (const sx of [-1, 1]) deco(sbox(g, 0.03, 0.14, 2 * Z - 0.06, sx * (X - 0.015), -0.13, 0, band));
  for (const sz of [-1, 1]) deco(sbox(g, 2 * X - 0.06, 0.14, 0.03, 0, -0.13, sz * (Z - 0.015), band));
  deco(sbox(g, 2.1, 0.02, 0.22, -X + 2.85, -S + 0.01, 0, band));
  deco(sbox(g, 4.4, 0.02, 0.22, X - 2.6, -D + 0.01, 0, band));
  deco(sbox(g, 0.22, 0.02, 1.4, X - 0.55, -D + 0.01, 0, band));
  // paved surround (walkable), its edges flush with the ground beyond
  const pave = P.ivory, dt = 0.13, dy = top + dt / 2;
  for (const sx of [-1, 1]) gbox(g, outX - X, dt, 2 * outZ, sx * (X + outX) / 2, dy, 0, pave);
  for (const sz of [-1, 1]) gbox(g, 2 * X, dt, outZ - Z, 0, dy, sz * (Z + outZ) / 2, pave);
  // rounded coping over the lip
  const cope = mat(P.pampas);
  for (const sx of [-1, 1]) rbox(g, 0.5, 0.14, 2 * Z + 0.5, sx * (X + 0.05), top + dt + 0.03, 0, cope, 0.05);
  for (const sz of [-1, 1]) rbox(g, 2 * X - 0.4, 0.14, 0.5, 0, top + dt + 0.03, sz * (Z + 0.05), cope, 0.05);
  // shallow-end steps (each under a step-up's height)
  const lip = top + dt, rise = (S + lip) / 4;
  for (let i = 1; i <= 3; i++) { const hgt = S + lip - rise * i; gbox(g, 0.5, hgt, 3, -X + 0.25 + (i - 1) * 0.5, -S + hgt / 2, 0, pave); }
  // deep-end ladder (decoration: climb out up the slope or the steps)
  const rail = mat(P.cloud);
  for (const sz of [-0.3, 0.3]) {
    deco(add(g, cyl(0.03, D + 0.9, 8), rail, X - 0.16, (0.9 - D) / 2, -2 + sz));
    const hook = deco(add(g, new THREE.TorusGeometry(0.16, 0.03, 6, 12, Math.PI), rail, X + 0.0, 0.9, -2 + sz));
    hook.rotation.y = Math.PI / 2;
  }
  for (let y = -D + 0.35; y < 0; y += 0.42) deco(sbox(g, 0.05, 0.04, 0.6, X - 0.16, y, -2, rail));
  // diving board over the deep end
  gbox(g, 0.8, 0.5, 0.9, X + 1.9, top + dt + 0.25, 0, P.cloud);
  rbox(g, 3.4, 0.09, 0.62, X + 0.4, top + dt + 0.56, 0, mat(P.sky), 0.04);
  // a puddle left at the deep end
  waterMat ??= Object.assign(toon(0x7cc0d2, { rim: 0 }), { transparent: true, opacity: 0.55, depthWrite: false });
  const water = deco(add(g, new THREE.PlaneGeometry(4.6, 2 * Z - 0.2).rotateX(-Math.PI / 2), waterMat, X - 2.4, -D + 0.12, 0));
  water.castShadow = false;
  return g;
}

/** Single-storey row of three shops, 12 × 8, awnings on the street side. */
function shopRow(color, ctx) {
  const g = new THREE.Group();
  shell(g, color, ctx, 12, 8, 0, { N: ['window', 'door', 'plain'], S: ['shop', 'shop', 'shop'], W: ['window', 'plain'], E: ['plain', 'window'] });
  flatRoof(g, color, 12, 8, WALL_H);
  const tints = [P.clay, P.sage, P.sky];
  for (let i = 0; i < 3; i++) place(g, awning(tints[i]), -4 + i * 4, 0, 4, Math.PI);
  return g;
}

/** 8 × 8 house with a pitched roof (ridge along X) and gables. */
function house(color, ctx) {
  const g = new THREE.Group();
  shell(g, color, ctx, 8, 8, 0, { N: ['window', 'plain'], S: ['window', 'door'], W: ['plain', 'window'], E: ['window', 'plain'] });
  const roof = color === P.clay ? P.slate : P.clay;
  for (const dx of [-2, 2]) { place(g, roofSlope(roof), dx, WALL_H, 2, 0); place(g, roofSlope(roof), dx, WALL_H, -2, Math.PI); }
  place(g, gable(color), -4, WALL_H, 0, Math.PI / 2);
  place(g, gable(color), 4, WALL_H, 0, Math.PI / 2);
  return g;
}

/** 16 × 12 double-height shed: gateways on the long sides, clerestory windows high up. */
function warehouse(color, ctx) {
  const g = new THREE.Group();
  const h = 6.4;
  const high = [{ x0: -1.4, x1: 1.4, y0: 4.2, y1: 5.6 }];
  const bay = (holes) => wall(color, ctx, { h, holes });
  [-6, -2, 2, 6].forEach((x, i) => {
    place(g, bay(i === 1 ? [{ x0: -1.6, x1: 1.6, y0: 0, y1: 3.6 }] : high), x, 0, -6);
    place(g, bay(i === 2 ? [{ x0: -1.6, x1: 1.6, y0: 0, y1: 3.6 }] : high), x, 0, 6);
  });
  [-4, 0, 4].forEach((z, i) => {
    place(g, bay(i === 1 ? HOLES.door : high), -8, 0, z, Math.PI / 2);
    place(g, bay(high), 8, 0, z, Math.PI / 2);
  });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) place(g, jointPost('wall', h, WALL_T, color, ctx?.ground), sx * 8, 0, sz * 6);
  gbox(g, 16.4, 0.3, 12.4, 0, h + 0.15, 0, P.slate);
  sbox(g, 16.6, 0.14, 12.6, 0, h + 0.37, 0, mat(P.ink));
  return g;
}

/** 4 m bridge deck with rails, for linking upper floors and roofs. */
function walkway(color) {
  const g = new THREE.Group();
  gbox(g, 4, 0.3, 2.4, 0, -0.15, 0, color);
  for (const s of [-1, 1]) {
    sbox(g, 4, 0.08, 0.08, 0, 1.0, s * 1.16, mat(P.slate));
    for (const x of [-1.9, 0, 1.9]) sbox(g, 0.07, 0.94, 0.07, x, 0.53, s * 1.16, mat(P.slate));
  }
  for (const s of [-1, 1]) sbox(g, 3.96, 0.36, 0.16, 0, -0.42, s * 1.08, mat(P.slate)); // girders, tucked inside the deck's edge
  for (const x of [-1.5, 0, 1.5]) sbox(g, 0.12, 0.12, 2.1, x, -0.36, 0, mat(P.slate)); // cross ties
  sbox(g, 4, 0.06, 0.08, 0, 0.03, -1.16, mat(P.ink));
  sbox(g, 4, 0.06, 0.08, 0, 0.03, 1.16, mat(P.ink));
  return g;
}

// ─────────────────────────── stacked rooms ───────────────────────────
// One storey of a 4 × 4 m room. Rooms snap to the 4 m grid and to 3.5 m storeys and read their
// neighbours: shared walls disappear (connected interiors), stacked rooms share the slab, exposed edges
// grow walls, roofs grow parapets and clutter. Build favelas / cyberpunk stacks by piling them up.
// Optional record fields: door: 'NSEW' sides forced to doors, open: 'NSEW' roof edges left without parapet.

const NEON = [0xff7a4d, 0x7fd8ff, 0xc6ff6a, 0xffd25a];
const neonMat = new Map();
const glow = (c) => { if (!neonMat.has(c)) neonMat.set(c, new THREE.MeshBasicMaterial({ color: c, toneMapped: false })); return neonMat.get(c); };
const hash = (x, y, z, salt) => { const v = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + salt * 4.137) * 43758.5453; return v - Math.floor(v); };
const SIDES = [['N', 0, -1], ['S', 0, 1], ['W', -1, 0], ['E', 1, 0]];

const SHUTTERS = [P.sage, P.sky, P.clay, P.olive, P.kraft];
/**
 * Small facade life on an outside wall (wall-local: along X, outward = +Z or -Z per side): shutters by
 * windows, a canopy over doors, a striped awning over shopfronts, balconies, AC boxes and downpipes on
 * blank walls. Decoration doesn't collide, except balconies, which you can stand on.
 */
function facade(w, color, kind, { side, level, balcony, roll }) {
  const o = side === 'S' || side === 'E' ? 1 : -1, face = o * (WALL_T / 2);
  const deco = (m) => { m.userData.noCollide = true; return m; };
  const tint = SHUTTERS.find((c, i) => c !== color && roll(60 + i) < 0.5) ?? P.slate;
  const sign = level > 0 && kind !== 'door' && roll(9) < 0.16; // room() hangs a blade sign here: keep clear
  if (kind === 'window' && !sign && roll(50) < 0.55) {
    for (const s of [-1, 1]) {
      deco(rbox(w, 0.55, 1.36, 0.06, s * 1.0, 1.65, face + o * 0.04, mat(tint), 0.02));
      for (let i = 0; i < 4; i++) deco(sbox(w, 0.46, 0.03, 0.03, s * 1.0, 1.15 + i * 0.32, face + o * 0.08, mat(P.ink)));
    }
  }
  if (kind === 'door' && !balcony) {
    deco(sbox(w, 1.9, 0.1, 0.9, 0, 2.58, face + o * 0.45, mat(P.slate)));
    deco(sbox(w, 1.94, 0.04, 0.04, 0, 2.52, face + o * 0.88, mat(P.ink)));
    // braces from the wall up to the canopy's front edge (outer end high)
    for (const s of [-1, 1]) { const b = deco(sbox(w, 0.05, 0.05, 0.86, s * 0.85, 2.36, face + o * 0.4, mat(P.ink))); b.rotation.x = -o * 0.42; }
  }
  if (kind === 'shop') {
    const a = 0.36;
    for (let i = 0; i < 7; i++) {
      const strip = deco(sbox(w, 0.5, 0.05, 1.3, -1.5 + i * 0.5, 2.62, face + o * 0.6, i % 2 ? mat(P.ivory) : mat(tint)));
      strip.rotation.x = -o * a;
    }
    deco(sbox(w, 3.5, 0.24, 0.03, 0, 2.3, face + o * 1.22, mat(tint)));
  }
  if (balcony) {
    sbox(w, 2.4, 0.14, 1.05, 0, -0.05, face + o * 0.52, mat(P.cloud));
    const rail = mat(P.slate);
    sbox(w, 2.4, 0.06, 0.06, 0, 1.0, face + o * 1.02, rail);
    for (const s of [-1, 1]) sbox(w, 0.06, 0.06, 1.0, s * 1.17, 1.0, face + o * 0.52, rail);
    const bars = [];
    for (let x = -1.1; x <= 1.11; x += 0.22) bars.push(new THREE.BoxGeometry(0.03, 0.95, 0.03).translate(x, 0.5, face + o * 1.02));
    for (const s of [-1, 1]) for (let z = 0.2; z < 1.0; z += 0.22) bars.push(new THREE.BoxGeometry(0.03, 0.95, 0.03).translate(s * 1.17, 0.5, face + o * z));
    deco(add(w, mergeGeometries(bars), rail));
    for (const s of [-1, 1]) { const b = deco(sbox(w, 0.08, 0.08, 0.7, s * 1.0, -0.32, face + o * 0.3, mat(P.ink))); b.rotation.x = -o * 0.6; }
    if (roll(70) < 0.6) deco(add(w, ico(0.3, 1), mat(P.sage), 0.8, 0.35, face + o * 0.75));
  }
  if (kind === 'plain' && !sign) {
    const r = roll(80);
    if (r < 0.17) { // AC box with a grille and a drip pipe
      const x = roll(81) < 0.5 ? -1.0 : 1.0, y = level === 0 ? 2.4 : 1.5;
      deco(rbox(w, 0.8, 0.55, 0.36, x, y, face + o * 0.18, mat(roll(82) < 0.5 ? P.ivory : P.cloud), 0.04));
      deco(sbox(w, 0.5, 0.36, 0.03, x - 0.08, y, face + o * 0.37, mat(P.slate)));
      deco(add(w, cyl(0.02, y - 0.3, 6), mat(P.slate), x + 0.3, (y - 0.3) / 2, face + o * 0.1));
    } else if (r < 0.32) { // downpipe from the roof edge to the ground
      const x = roll(83) < 0.5 ? -1.75 : 1.75;
      deco(add(w, cyl(0.06, WALL_H + 0.3, 8), mat(P.slate), x, (WALL_H + 0.3) / 2 - 0.05, face + o * 0.08));
      for (const y of [0.9, 2.2]) deco(sbox(w, 0.16, 0.05, 0.16, x, y, face + o * 0.08, mat(P.ink)));
    }
  }
}

function room(color, ctx) {
  const g = new THREE.Group();
  const r = ctx?.rec ?? { x: 0, y: 0, z: 0 };
  const has = (dx, dz, dy = 0) => !!ctx?.near('room', dx, dz, dy);
  const H = (salt) => hash(r.x, r.y ?? 0, r.z, salt);
  const above = has(0, 0, STOREY), below = has(0, 0, -STOREY), level = Math.round((r.y ?? 0) / STOREY);
  const forced = (side) => (r.door ?? '').includes(side);
  // a room above ground stands on a slab (the room below's ceiling, or its own floor over air): walls cover its edge
  const onSlab = !ctx?.ground && (below || (r.y ?? 0) > 0.05);

  // slab overhead (the floor of the room above, or the roof), and a floor if this room overhangs air
  gbox(g, 4, 0.3, 4, 0, WALL_H + 0.15, 0, P.oat);
  if (!below && !ctx?.ground && !ctx?.near('dock', 0, 0)) gbox(g, 4, 0.3, 4, 0, -0.15, 0, P.oat);

  for (const [side, dx, dz] of SIDES) {
    const nb = ctx?.near('room', dx * 4, dz * 4);
    if (nb) {
      // same building (same colour): open plan. A different building: one party wall, usually with a doorway
      if (nb.color === r.color || !(side === 'E' || side === 'S')) continue;
      const kind = H(side.charCodeAt(0) + 21) < 0.35 ? 'door' : 'plain';
      place(g, wall(color, level === 0 ? ctx : null, { holes: HOLES[kind], drop: onSlab ? SLAB : 0 }), dx * 2, 0, dz * 2, dx ? Math.PI / 2 : 0);
      continue;
    }
    const terrace = has(dx * 4, dz * 4, -STOREY); // the room beside us is a storey lower: its roof is our doorstep
    const roll = H(side.charCodeAt(0));
    let kind;
    if (forced(side)) kind = 'door';
    // mostly blank walls: openings are rare enough to mean something
    else if (level === 0) kind = roll < 0.1 ? 'door' : roll < 0.17 ? 'shop' : roll < 0.3 ? 'window' : 'plain';
    else if (terrace) kind = roll < 0.25 ? 'door' : roll < 0.4 ? 'window' : 'plain';
    else kind = roll < 0.22 ? 'window' : roll < 0.27 ? 'wide' : 'plain';
    // upper walls on open air sometimes get a balcony: a door out onto a small railed slab
    const balcony = level > 0 && !terrace && !forced(side) && kind === 'plain' && H(side.charCodeAt(0) + 44) < 0.12;
    if (balcony) kind = 'door';
    const w = wall(color, level === 0 ? ctx : null, { holes: HOLES[kind], drop: onSlab ? SLAB : 0 });
    facade(w, color, kind, { side, level, balcony, roll: (s) => H(side.charCodeAt(0) + s) });
    place(g, w, dx * 2, 0, dz * 2, dx ? Math.PI / 2 : 0);
    // neon sign hung off an upper wall
    if (level > 0 && kind !== 'door' && H(side.charCodeAt(0) + 9) < 0.16) {
      const c = NEON[Math.floor(H(side.charCodeAt(0) + 3) * NEON.length)];
      // blade sign sticking out of the wall: ink frame, glowing panel proud of both broad faces
      const frame = dx ? [0.78, 1.8, 0.12] : [0.12, 1.8, 0.78], panel = dx ? [0.6, 1.55, 0.18] : [0.18, 1.55, 0.6];
      const off = 0.55, along = H(5) < 0.5 ? -1.2 : 1.2;
      const px = dx * (2 + off) + (dz ? along : 0), pz = dz * (2 + off) + (dx ? along : 0);
      rbox(g, ...frame, px, 1.6, pz, mat(P.ink), 0.03).userData.noCollide = true;
      const face = rbox(g, ...panel, px, 1.6, pz, glow(c), 0.02);
      face.userData.noCollide = true;
      face.castShadow = false;
      rbox(g, dx ? 0.5 : 0.06, 0.06, dz ? 0.5 : 0.06, dx * (2 + off / 2), 2.4, dz * (2 + off / 2), mat(P.slate), 0.01).userData.noCollide = true;
    }
  }

  // corner posts: one per corner, built by the corner's "first" room, only where walls actually turn
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const cells = [[0, 0], [sx * 4, 0], [0, sz * 4], [sx * 4, sz * 4]].map(([dx, dz]) => ({ dx, dz, on: dx === 0 && dz === 0 ? true : has(dx, dz) }));
    const on = cells.filter((c) => c.on);
    const n = on.length;
    if (n === 4) continue;
    if (n === 2 && !(on[0].dx !== on[1].dx && on[0].dz !== on[1].dz)) continue; // straight run: no post
    const owner = on.reduce((m, c) => (c.dx < m.dx || (c.dx === m.dx && c.dz < m.dz) ? c : m));
    if (owner.dx !== 0 || owner.dz !== 0) continue;
    place(g, jointPost('wall', WALL_H, WALL_T, color, level === 0 && ctx?.ground, onSlab), sx * 2, 0, sz * 2);
  }

  if (!above) {
    // roof: parapet on every edge without a same-level neighbour (their roof continues ours)
    const top = STOREY;
    for (const [side, dx, dz] of SIDES) {
      if (has(dx * 4, dz * 4) || (r.open ?? '').includes(side)) continue;
      place(g, wall(color, null, { h: 0.75, drop: SLAB }), dx * 2, top, dz * 2, dx ? Math.PI / 2 : 0);
    }
    for (const [sx, sz, a, b] of [[-1, -1, 'W', 'N'], [1, -1, 'E', 'N'], [-1, 1, 'W', 'S'], [1, 1, 'E', 'S']]) {
      const open = (side, dx, dz) => !has(dx, dz) && !(r.open ?? '').includes(side);
      if (open(a, sx * 4, 0) && open(b, 0, sz * 4)) place(g, jointPost('wall', 0.75, WALL_T, color, false, true), sx * 2, top, sz * 2);
    }
    // rooftop clutter
    const pickRoof = r.clear ? 1 : H(77);
    if (pickRoof < 0.22) { // water tank on legs
      for (const [lx, lz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) sbox(g, 0.08, 0.6, 0.08, 0.6 + lx, top + 0.3, -0.6 + lz, mat(P.slate));
      add(g, cyl(0.75, 1.3, 18), mat(H(8) < 0.5 ? P.sky : P.ivory), 0.6, top + 1.25, -0.6);
      add(g, new THREE.ConeGeometry(0.8, 0.35, 18), mat(P.slate), 0.6, top + 2.07, -0.6);
    } else if (pickRoof < 0.4) { // AC units
      rbox(g, 1.1, 0.7, 0.8, -0.6, top + 0.35, 0.5, mat(P.ivory), 0.05);
      rbox(g, 0.8, 0.55, 0.7, 0.8, top + 0.28, 0.7, mat(P.cloud), 0.05);
      add(g, cyl(0.24, 0.04, 16), mat(P.slate), -0.6, top + 0.72, 0.5);
    } else if (pickRoof < 0.52) { // antenna mast
      add(g, cyl(0.05, 4.5, 8), mat(P.slate), -1, top + 2.25, -1).userData.noCollide = true;
      for (const y of [1.5, 2.6, 3.6]) sbox(g, 1.1 - y * 0.2, 0.04, 0.04, -1, top + y, -1, mat(P.slate)).userData.noCollide = true;
      add(g, new THREE.SphereGeometry(0.08, 8, 6), glow(NEON[0]), -1, top + 4.55, -1).userData.noCollide = true;
    } else if (pickRoof < 0.64) { // billboard facing the street side with the most open air
      const [side, dx, dz] = SIDES.find(([, dx, dz]) => !has(dx * 4, dz * 4)) ?? SIDES[1];
      const b = new THREE.Group();
      for (const x of [-1.2, 1.2]) sbox(b, 0.12, 1.6, 0.12, x, 0.8, 0, mat(P.slate));
      rbox(b, 3.4, 1.5, 0.16, 0, 2.3, 0, mat(P.ink), 0.04);
      const panel = rbox(b, 3.1, 1.2, 0.05, 0, 2.3, 0.09, glow(NEON[Math.floor(H(31) * NEON.length)]), 0.02);
      panel.castShadow = false;
      rbox(b, 1.6, 0.18, 0.06, -0.4, 2.45, 0.12, mat(P.ink), 0.02);
      rbox(b, 2.2, 0.12, 0.06, 0.1, 2.12, 0.12, mat(P.ink), 0.02);
      b.traverse((o) => { if (o.isMesh) o.userData.noCollide = true; });
      place(g, b, dx * 0.9, top, dz * 0.9, Math.atan2(dx, dz));
      void side;
    } else if (pickRoof < 0.72) { // solar panel
      const sp = rbox(g, 2.2, 0.06, 1.3, 0, top + 0.6, 0.4, mat(P.slate), 0.02);
      sp.rotation.x = -0.4;
      sbox(g, 0.08, 0.5, 0.08, 0, top + 0.25, 0.6, mat(P.slate));
    }
  }
  return g;
}

// ─────────────────────────── catalogue ───────────────────────────

const WALL_COLORS = [P.ivory, P.oat, P.manilla, P.kraft, P.sage, P.sky, P.clay, P.bookcloth, P.slate];
const PAINT = [P.clay, P.sky, P.sage, P.kraft, P.ivory, P.slate, P.olive];
const LEAF = [P.sage, P.olive, 0x9aa86f, P.kraft];
const W = (len = 4, h = WALL_H) => ({ kind: 'wall', len, h, t: WALL_T });

export const CATEGORIES = ['Buildings', 'Walls', 'Parts', 'Roads', 'Waterfront', 'Props', 'Nature', 'Vehicles', 'Barriers', 'Gameplay', 'Items', 'Terrain'];

export const ASSETS = [
  { id: 'wall', cat: 'Walls', name: 'Wall', note: '4 m', colors: WALL_COLORS, link: W(), build: (c, x) => wall(c, x) },
  { id: 'wall_window', cat: 'Walls', name: 'Window wall', note: '4 m', colors: WALL_COLORS, link: W(), build: (c, x) => wall(c, x, { holes: [{ x0: -0.7, x1: 0.7, y0: 1.0, y1: 2.3 }] }) },
  { id: 'wall_wide', cat: 'Walls', name: 'Wide window', note: '4 m', colors: WALL_COLORS, link: W(), build: (c, x) => wall(c, x, { holes: [{ x0: -1.4, x1: 1.4, y0: 1.0, y1: 2.3 }] }) },
  { id: 'wall_door', cat: 'Walls', name: 'Door wall', note: '4 m', colors: WALL_COLORS, link: W(), build: (c, x) => wall(c, x, { holes: [{ x0: -0.65, x1: 0.65, y0: 0, y1: 2.3 }] }) },
  { id: 'wall_shop', cat: 'Walls', name: 'Shopfront', note: '4 m', colors: WALL_COLORS, link: W(), build: (c, x) => wall(c, x, { holes: [{ x0: -1.7, x1: -0.5, y0: 0, y1: 2.4 }, { x0: -0.3, x1: 1.7, y0: 0.55, y1: 2.4 }] }) },
  { id: 'wall_gate', cat: 'Walls', name: 'Gateway', note: '4 m', colors: WALL_COLORS, link: W(), build: (c, x) => wall(c, x, { holes: [{ x0: -1.25, x1: 1.25, y0: 0, y1: 2.6 }] }) },
  { id: 'wall_short', cat: 'Walls', name: 'Short wall', note: '2 m', colors: WALL_COLORS, link: W(2), build: (c, x) => wall(c, x, { len: 2 }) },
  { id: 'wall_short_door', cat: 'Walls', name: 'Short door wall', note: '2 m', colors: WALL_COLORS, link: W(2), build: (c, x) => wall(c, x, { len: 2, holes: HOLES.door }) },
  { id: 'wall_short_window', cat: 'Walls', name: 'Short window', note: '2 m', colors: WALL_COLORS, link: W(2), build: (c, x) => wall(c, x, { len: 2, holes: [{ x0: -0.5, x1: 0.5, y0: 1.0, y1: 2.3 }] }) },
  { id: 'wall_half', cat: 'Walls', name: 'Half wall', note: 'cover · 4 m', colors: WALL_COLORS, link: W(4, 1.15), build: (c, x) => wall(c, x, { h: 1.15 }) },
  { id: 'parapet', cat: 'Walls', name: 'Parapet', note: 'roof edge', colors: WALL_COLORS, link: W(4, 0.75), build: (c, x) => wall(c, x, { h: 0.75 }) },
  { id: 'pillar', cat: 'Walls', name: 'Pillar', note: 'column', colors: WALL_COLORS, build: pillar },

  { id: 'floor', cat: 'Parts', name: 'Floor slab', note: '4 × 4 · top at its height', colors: [P.ivory, P.oat, P.manilla, P.slate, P.sage], build: (c, x) => floor(c, x) },
  { id: 'floor_strip', cat: 'Parts', name: 'Floor strip', note: '2 × 4', colors: [P.ivory, P.oat, P.manilla, P.slate, P.sage], build: (c, x) => floor(c, x, { w: 4, d: 2 }) },
  { id: 'stairs', cat: 'Parts', name: 'Staircase', note: 'one storey', colors: [P.ivory, P.oat, P.kraft, P.cloud, P.slate], build: (c, x) => stairs(c, x) },
  { id: 'stairs_open', cat: 'Parts', name: 'Open stairs', note: 'one storey · no rails', colors: [P.oat, P.ivory, P.kraft, P.cloud, P.slate], build: (c, x) => stairs(c, x, { rail: false }) },
  { id: 'steps', cat: 'Parts', name: 'Steps', note: 'rises 1.75 m', colors: [P.ivory, P.oat, P.kraft, P.slate], build: (c, x) => stairs(c, x, { rise: 1.75, run: 3, rail: false }) },
  { id: 'ramp', cat: 'Parts', name: 'Ramp', note: 'rises half a storey', colors: [P.manilla, P.sky, P.ivory, P.sage], build: ramp },
  { id: 'roof', cat: 'Parts', name: 'Roof slope', note: 'pair for 8 m', colors: [P.clay, P.slate, P.sage, P.kraft, P.sky], build: roofSlope },
  { id: 'gable', cat: 'Parts', name: 'Gable', note: '8 m end', colors: WALL_COLORS, build: gable },
  { id: 'canopy', cat: 'Parts', name: 'Shade canopy', note: '4 × 4 · walk under', colors: [P.clay, P.sky, P.sage, P.kraft], tile: 4, build: canopy },
  { id: 'awning', cat: 'Parts', name: 'Awning', note: '4 m', colors: [P.clay, P.sage, P.sky, P.kraft], build: awning },

  { id: 'room', cat: 'Buildings', name: 'Room', note: 'stacks · auto-joins', colors: [P.manilla, P.ivory, P.sky, P.sage, P.kraft, P.clay, P.bookcloth, P.oat, P.slate], tile: 4, build: room },
  { id: 'tower3', cat: 'Buildings', name: 'Tower · 3', note: '12 × 12 · enterable', colors: [P.ivory, P.manilla, P.oat, P.sky, P.sage, P.kraft, P.slate], snap: 2, build: tower(3) },
  { id: 'tower5', cat: 'Buildings', name: 'Tower · 5', note: '12 × 12 · roof access', colors: [P.oat, P.ivory, P.manilla, P.sky, P.sage, P.bookcloth, P.slate], snap: 2, build: tower(5) },
  { id: 'door', cat: 'Parts', name: 'Door', note: 'in a door opening · opens with E', colors: [P.sage, P.sky, P.clay, P.kraft, P.slate], build: doorPiece },
  { id: 'dock', cat: 'Waterfront', name: 'Dock', note: '4 × 4 · deck at its height, body under water', colors: [P.oat, P.ivory, P.manilla], tile: 4, build: dock },
  { id: 'seawall', cat: 'Waterfront', name: 'Sea wall', note: '4 m · 3.5 m over its deck line', colors: [P.oat, P.ivory, P.cloud], build: seawall },
  { id: 'stilt', cat: 'Waterfront', name: 'Stilt', note: 'under a raised deck · top at its height', colors: [P.slate, P.cloud, P.oat], build: stilt },
  { id: 'pool', cat: 'Buildings', name: 'Pool', note: '14 × 7 · dig ground to -3 first', colors: [P.sky, P.ivory, P.sage], snap: 2, build: pool },
  { id: 'podium', cat: 'Buildings', name: 'Podium', note: '12 × 12 terrace', colors: [P.manilla, P.oat, P.ivory, P.kraft], snap: 2, build: podium },
  { id: 'shoprow', cat: 'Buildings', name: 'Shop row', note: '12 × 8', colors: [P.ivory, P.manilla, P.sky, P.sage, P.kraft], snap: 2, build: shopRow },
  { id: 'house', cat: 'Buildings', name: 'House', note: '8 × 8 · gabled', colors: [P.ivory, P.manilla, P.sage, P.sky, P.kraft], snap: 2, build: house },
  { id: 'warehouse', cat: 'Buildings', name: 'Warehouse', note: '16 × 12', colors: [P.oat, P.sage, P.sky, P.kraft, P.ivory], snap: 2, build: warehouse },
  { id: 'walkway', cat: 'Parts', name: 'Walkway', note: 'bridge · 4 m', colors: [P.oat, P.ivory, P.slate], build: walkway },

  { id: 'road_curve', cat: 'Roads', name: 'Bend', note: 'radius 10 m', colors: [0x5b5a55], fixed: true, snap: 4, ports: curvePorts(10), build: roadCurve(10) },
  { id: 'road_curve_wide', cat: 'Roads', name: 'Wide bend', note: 'radius 18 m', colors: [0x5b5a55], fixed: true, snap: 4, ports: curvePorts(18), build: roadCurve(18) },
  { id: 'road', cat: 'Roads', name: 'Road', note: 'auto-joins · 4 m', colors: [0x5b5a55], fixed: true, tile: 4, build: road },
  { id: 'sidewalk', cat: 'Roads', name: 'Sidewalk', note: 'auto-curbs · 4 m', colors: [P.ivory, P.manilla, P.oat, P.sage], tile: 4, build: sidewalk },

  { id: 'container', cat: 'Props', name: 'Container', note: '20 ft', colors: PAINT, build: container },
  { id: 'crate', cat: 'Props', name: 'Crate', note: '1.2 m', colors: [P.kraft, P.sage, P.sky, P.oat], build: crate },
  { id: 'barrel', cat: 'Props', name: 'Drum', note: '0.9 m', colors: PAINT, build: barrel },
  { id: 'dumpster', cat: 'Props', name: 'Dumpster', note: '2.2 m', colors: [P.sage, P.sky, P.clay, P.slate], build: dumpster },
  { id: 'sandbags', cat: 'Props', name: 'Sandbags', note: 'cover · 2 m', colors: [P.kraft, P.oat, P.sage], build: sandbags },
  { id: 'planter', cat: 'Props', name: 'Planter', note: '2 × 1 · cover', colors: [P.oat, P.ivory, P.cloud, P.kraft], build: planter },
  { id: 'stall', cat: 'Props', name: 'Market stall', note: '2.4 m', colors: [P.clay, P.sky, P.sage, P.kraft], build: stall },
  { id: 'pole', cat: 'Props', name: 'Utility pole', note: '7.5 m', colors: [P.kraft, P.bookcloth, P.cloud], build: pole },
  { id: 'bench', cat: 'Props', name: 'Bench', note: '1.8 m', colors: [P.kraft, P.sage, P.sky], build: bench },
  { id: 'lamp', cat: 'Props', name: 'Street lamp', note: '5 m', colors: [P.slate, P.ink, P.sage], build: lamp },
  { id: 'pump', cat: 'Props', name: 'Fuel pump', note: 'island', colors: [P.clay, P.sky, P.sage], build: fuelPump },
  { id: 'tower', cat: 'Props', name: 'Water tower', note: 'landmark', colors: [P.sky, P.ivory, P.clay, P.sage], build: waterTower },

  { id: 'tree', cat: 'Nature', name: 'Tree', note: 'broadleaf', colors: LEAF, build: tree },
  { id: 'pine', cat: 'Nature', name: 'Pine', note: '5 m', colors: [P.olive, P.sage, 0x5f6b4a], build: pine },
  { id: 'bush', cat: 'Nature', name: 'Bush', note: 'soft cover', colors: LEAF, build: bush },
  { id: 'rock', cat: 'Nature', name: 'Rock', note: 'boulder', colors: [P.cloud, P.oat, P.kraft, P.slate], build: rock },

  { id: 'sedan', cat: 'Vehicles', name: 'Sedan', note: '4.4 m', colors: PAINT, build: sedan },
  { id: 'pickup', cat: 'Vehicles', name: 'Pickup', note: '5 m', colors: PAINT, build: pickup },
  { id: 'van', cat: 'Vehicles', name: 'Van', note: '5 m', colors: [P.ivory, P.sky, P.sage, P.kraft, P.slate, P.clay], build: van },

  { id: 'guardrail', cat: 'Barriers', name: 'Guardrail', note: 'auto-posts', colors: [P.ivory, P.clay, P.slate, P.sky], link: { kind: 'rail', len: 4, h: 1.06, t: 0.1 }, build: guardrail },
  { id: 'fence', cat: 'Barriers', name: 'Mesh fence', note: 'auto-posts', colors: [P.slate, P.ivory, P.sage, P.clay], link: { kind: 'fence', len: 4, h: 2.2, t: 0.1 }, build: fence },
  { id: 'picket', cat: 'Barriers', name: 'Picket fence', note: 'auto-posts', colors: [P.ivory, P.kraft, P.sage, P.sky], link: { kind: 'picket', len: 4, h: 1.2, t: 0.1 }, build: picket },
  { id: 'jersey', cat: 'Barriers', name: 'Barrier', note: 'concrete', colors: [P.ivory, P.oat, P.kraft], build: jersey },

  { id: 'spawn_ally', cat: 'Gameplay', name: 'Ally spawn', note: 'TDM · you', colors: [P.sky], fixed: true, build: () => spawn(P.sky) },
  { id: 'spawn_enemy', cat: 'Gameplay', name: 'Enemy spawn', note: 'TDM', colors: [P.clay], fixed: true, build: () => spawn(P.clay) },

  // pickups: placed like props, played as items (mapWorld lists them instead of building them)
  ...ITEM_IDS.map((id) => ({ id: `item_${id}`, cat: 'Items', name: ITEMS[id].name, note: 'pickup', colors: [ITEMS[id].accent], fixed: true, pickup: true, build: () => pickupPiece(id, 0, ITEMS[id].accent) })),
  ...WEAPONS.map((w, i) => ({ id: `gun_${w.id}`, cat: 'Items', name: w.name, note: `${w.kind} · pickup`, colors: [P.ivory], fixed: true, pickup: true, build: () => pickupPiece('gun', i, P.ink) })),
];

export const assetById = (id) => ASSETS.find((a) => a.id === id);

/**
 * Neighbour lookup for adaptive tiles: near(family, dx, dz) is true when a tile of that family sits at
 * this tile's position + (dx, dz) at the same height.
 */
export function makeContext(records, groundAt) {
  const tiles = new Map();
  const k = (fam, x, y, z) => `${fam}|${Math.round(x * 2)}|${Math.round(y * 5)}|${Math.round(z * 2)}`;
  for (const r of records) {
    const a = assetById(r.type);
    if (a?.tile) tiles.set(k(r.type, r.x, r.y ?? 0, r.z), r);
    if (r.type === 'floor') tiles.set(k('floor', r.x, r.y ?? 0, r.z), r);
    // bends expose their two end cells as road so straights snap onto them
    if (a?.ports) {
      const t = ((r.rot ?? 0) * Math.PI) / 180, c = Math.cos(t), sn = Math.sin(t);
      for (const [px, pz] of a.ports) tiles.set(k('road', r.x + px * c + pz * sn, r.y ?? 0, r.z - px * sn + pz * c), true);
    }
  }
  return (rec) => ({
    rec,
    ground: groundAt ? Math.abs((rec.y ?? 0) - groundAt(rec.x, rec.z)) < 0.35 : (rec.y ?? 0) < 0.05,
    /** The neighbouring record (or true for a bend's end cell), else undefined. */
    near: (fam, dx, dz, dy = 0) => tiles.get(k(fam, rec.x + dx, (rec.y ?? 0) + dy, rec.z + dz)),
    /** Floor only: which local sides (±x, ±z) have no floor beside them at the same level. */
    openSides() {
      const t = ((rec.rot ?? 0) * Math.PI) / 180, c = Math.round(Math.cos(t)), sn = Math.round(Math.sin(t));
      const free = (lx, lz) => !tiles.get(k('floor', rec.x + lx * c + lz * sn, rec.y ?? 0, rec.z - lx * sn + lz * c));
      return { px: free(4, 0), nx: free(-4, 0), pz: free(0, 4), nz: free(0, -4) };
    },
    /** Wall-family pieces only: is there a floor slab on either side whose top this wall stands on? */
    slabUnderWall() {
      if (assetById(rec.type)?.link?.kind !== 'wall') return false;
      const t = ((rec.rot ?? 0) * Math.PI) / 180, nx = Math.sin(t) * 2, nz = Math.cos(t) * 2, y = rec.y ?? 0;
      return [1, -1].some((s) => tiles.get(k('floor', rec.x + nx * s, y, rec.z + nz * s)));
    },
  });
}

/**
 * Merge a built piece's meshes per material (keeping hidden colliders and decoration apart): hundreds of
 * draw calls per building become a handful. Used by the editor; play mode batches the whole map instead.
 */
function compact(g) {
  g.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(g.matrixWorld).invert(), rel = new THREE.Matrix4();
  const buckets = new Map();
  g.traverse((o) => {
    if (!o.isMesh) return;
    const role = o.userData.collider ? 'c' : o.userData.noCollide ? 'd' : 's';
    const key = `${o.material.uuid}|${role}|${o.castShadow}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { o, geos: [] }));
    const geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name);
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    geo.morphAttributes = {};
    geo.clearGroups();
    geo.applyMatrix4(rel.multiplyMatrices(inv, o.matrixWorld));
    b.geos.push(geo);
  });
  g.clear();
  for (const { o, geos } of buckets.values()) {
    const m = new THREE.Mesh(mergeGeometries(geos), o.material);
    m.castShadow = o.castShadow;
    m.receiveShadow = true;
    m.visible = o.visible;
    Object.assign(m.userData, o.userData);
    g.add(m);
  }
  return g;
}

/** Build a placed piece from its saved record { type, x, y, z, rot, color }. compact: merge its meshes (editor). */
export function buildPiece(rec, ctx, { compact: merge = false } = {}) {
  const a = assetById(rec.type);
  if (!a) return null;
  // adaptive tiles read neighbours in world axes, so they ignore rotation
  const g = a.build(rec.color ?? a.colors[0], ctx);
  g.position.set(rec.x, rec.y ?? 0, rec.z);
  g.rotation.y = a.tile ? 0 : ((rec.rot ?? 0) * Math.PI) / 180;
  g.userData.asset = a;
  return merge ? compact(g) : g;
}
