import * as THREE from 'three';
import { Octree } from 'three/examples/jsm/math/Octree.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PALETTE as P, toon } from '../core/toon.js';
import { buildPiece, buildJoints, makeContext } from './assets.js';
import { terrainMesh, setHeights, heightsOf, heightAt, LIMIT, terrainMaterial, tintGround } from './terrain.js';
import { applySky } from '../world/sky.js';
import { markStatic } from '../core/renderer.js';
import { Doors } from './doors.js';
import { pickupSpec } from '../items/items.js';
import { WEAPONS } from '../weapons/weapons.js';

/*
  Turns a saved map into a playable world. The result fits both level users:
    explore (main.js): octree · spawn · raycastTargets · pickups · doors
    TDM arena:         octree · raycastTargets · spawns { ally, enemy } · pickups · doors · bounds · dispose()  (TDM builds nav + hotspots)
  Ground-level doorways (and placed door pieces) become working doors (doors.js); main.js makes them solid.
  Item and gun pieces aren't built into the world: they come out as pickups [{ type, gun?, position }].
*/

export const MAP_SIZE = 96; // buildable square, metres

/** Build the static scene for a map into `group`; shared by play and the editor's previews. */
export function buildMapScene(map, group) {
  const size = map.size ?? MAP_SIZE;
  const h = heightsOf(map, size);
  const ground = terrainMesh(size);
  setHeights(ground, h);
  group.add(ground);
  const groundAt = (x, z) => heightAt(h, size, x, z);
  const ctx = makeContext(map.pieces, groundAt);
  const spawns = { ally: [], enemy: [] };
  const pickups = [], doors = [];
  const weaponIds = WEAPONS.map((w) => w.id);
  for (const rec of map.pieces) {
    if (/^(item|gun)_/.test(rec.type)) {
      const spec = pickupSpec(rec.type, weaponIds);
      if (spec) pickups.push({ ...spec, position: new THREE.Vector3(rec.x, Math.max(rec.y ?? 0, groundAt(rec.x, rec.z)), rec.z) });
      continue;
    }
    if (rec.type === 'spawn_ally' || rec.type === 'spawn_enemy') {
      spawns[rec.type === 'spawn_ally' ? 'ally' : 'enemy'].push({ position: new THREE.Vector3(rec.x, rec.y ?? 0, rec.z), yaw: ((rec.rot ?? 0) * Math.PI) / 180 });
      continue;
    }
    const piece = buildPiece(rec, ctx(rec));
    if (!piece) continue;
    // doorways at ground level get working doors (a placed door piece is one by itself, not built here)
    piece.updateMatrixWorld(true);
    piece.traverse((o) => { for (const way of o.userData.doorways ?? []) doorway(o, way, rec.type === 'door'); });
    if (rec.type !== 'door') group.add(piece);
  }
  group.add(buildJoints(map.pieces, groundAt));
  return { size, h, groundAt, spawns, pickups, doors };

  function doorway(o, way, placed) {
    const c = new THREE.Vector3((way.x0 + way.x1) / 2, 0, 0).applyMatrix4(o.matrixWorld);
    if (!placed && Math.abs(c.y - groundAt(c.x, c.z)) > 0.45) return;
    if (doors.some((d) => Math.hypot(d.cx - c.x, d.cz - c.z) < 0.5)) return;
    const p = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
    const yaw = new THREE.Euler().setFromRotationMatrix(o.matrixWorld, 'YXZ').y;
    doors.push({ x: p.x, y: p.y, z: p.z, yaw, way, cx: c.x, cz: c.z });
  }
}

export function buildMapWorld(scene, map) {
  const group = new THREE.Group();
  scene.add(group);
  const half = (map.size ?? MAP_SIZE) / 2;
  atmosphere(scene, group, half);

  const world = new THREE.Group();
  const { spawns, groundAt, h, pickups, doors: doorSpots } = buildMapScene(map, world);

  // no wall at the edge: the land rolls on into hills, and an invisible fence keeps players in
  group.add(outerLand(h, half * 2, groundAt));
  // flooded maps: a sheet of water at map.water, and anyone who falls in is out (killY)
  if (map.water !== undefined) {
    const water = new THREE.Mesh(new THREE.PlaneGeometry(half * 2 + 160, half * 2 + 160).rotateX(-Math.PI / 2), toon(0x5d93a6, { rim: 0 }));
    water.position.y = map.water;
    water.receiveShadow = true;
    group.add(water);
  }
  let peak = 0;
  for (const v of h) peak = Math.max(peak, v);
  const bottom = LIMIT.min - 0.1, top = peak + 12;
  for (let a = -half - 1.2; a < half + 1.2; a += 8) {
    const len = Math.min(8, half + 1.2 - a), c = a + len / 2;
    for (const [x, z, w, d] of [[c, -half - 0.6, len, 1.2], [c, half + 0.6, len, 1.2], [-half - 0.6, c, 1.2, len], [half + 0.6, c, 1.2, len]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, top - bottom, d));
      m.position.set(x, (top + bottom) / 2, z);
      m.userData.collider = true; // collision only
      world.add(m);
    }
  }

  for (const s of [...spawns.ally, ...spawns.enemy]) s.position.y = Math.max(s.position.y, groundAt(s.position.x, s.position.z));
  if (!spawns.ally.length) spawns.ally.push({ position: new THREE.Vector3(-half + 6, groundAt(-half + 6, 0), 0), yaw: -Math.PI / 2 });
  if (!spawns.enemy.length) spawns.enemy.push({ position: new THREE.Vector3(half - 6, groundAt(half - 6, 0), 0), yaw: Math.PI / 2 });

  // a few thousand small meshes → a few dozen batches (one per material); collision skips decoration
  // (tree crowns, step visuals) but keeps the hidden walk ramps
  const { visual, proxies } = batch(world);
  const collide = new THREE.Group();
  collide.add(...proxies);
  for (const m of visual) markStatic(m);
  group.add(...visual, collide);
  collide.updateMatrixWorld(true);
  const octree = new MapOctree().fromGraphNode(collide);
  const raycastTargets = proxies; // bullets hit the same slim shapes you collide with

  return {
    name: map.name,
    octree,
    raycastTargets,
    spawns,
    pickups,
    spawn: spawns.ally[0],
    killY: map.water !== undefined ? map.water - 0.4 : undefined,
    doors: new Doors(group, doorSpots),
    bounds: { minX: -half, maxX: half, minZ: -half, maxZ: half, cell: 1 },
    dispose: () => scene.remove(group),
  };
}

/**
 * three's Octree splits to depth 16 whenever a cell holds more than 8 triangles. Grid-aligned building
 * kits put many triangle corners exactly on split planes, so that recursion fans out and takes seconds.
 * Same structure, capped: depth 7, up to 24 triangles per leaf.
 */
const _half = new THREE.Vector3(), _off = new THREE.Vector3();
class MapOctree extends Octree {
  split(level) {
    if (!this.box) return this;
    _half.copy(this.box.max).sub(this.box.min).multiplyScalar(0.5);
    const subs = [];
    for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
      const box = new THREE.Box3();
      box.min.copy(this.box.min).add(_off.set(x, y, z).multiply(_half));
      box.max.copy(box.min).add(_half);
      subs.push(new MapOctree(box));
    }
    let tri;
    while ((tri = this.triangles.pop())) for (const s of subs) if (s.box.intersectsTriangle(tri)) s.triangles.push(tri);
    for (const s of subs) {
      if (s.triangles.length > 24 && level < 7) s.split(level + 1);
      if (s.triangles.length || s.subTrees.length) this.subTrees.push(s);
    }
    return this;
  }
}

/**
 * three's capsule test misses boxes thinner than about the capsule radius once the capsule's centre is past
 * their face (you slip through rails and fence panels). Collision-only fix: stand-up thin boxes get at least
 * MIN_T of thickness; flat plates (roads, caps, the stairs' walk ramp) keep their exact height.
 */
const MIN_T = 0.2;
function thicken(w, h, d) {
  if (h < MIN_T && w > 0.25 && d > 0.25) return [w, h, d];
  return [Math.max(w, MIN_T), Math.max(h, MIN_T), Math.max(d, MIN_T)];
}

const EXACT = new Set(['BoxGeometry', 'ExtrudeGeometry', 'PlaneGeometry', 'ShapeGeometry']);

/*
  Joining pieces. The kit is built on one set of measurements (assets.js: 4 m grid, storey, wall thickness), so
  walls, caps, kick strips and slabs from neighbouring pieces line up exactly; each piece keeps its trims a few
  mm short of its own ends so no two faces ever lie on each other. Before rendering, every plain block (a real
  12-triangle box, square to the world axes) is fused with any block of the same material and the same cross
  section that it touches or nearly touches end to end (gap up to JOIN). A run of wall pieces becomes one wall,
  its cap one unbroken cap: no slit of sky between two caps, and no hidden end faces inside the wall to draw
  seam lines in the shadows. Collision still uses the pieces as they are.
*/
const JOIN = 0.012; // ends this close count as touching (the trims' 2 × 4 mm inset)
const SAME = 0.001; // cross sections equal to 1 mm
const _bm = new THREE.Matrix4(), _bb = new THREE.Box3();

/** The world box of a plain box mesh square to the axes, or null. */
function plainBox(o) {
  const g = o.geometry;
  if (g.type !== 'BoxGeometry' || !g.parameters || (g.index ? g.index.count : g.attributes.position.count) !== 36) return null;
  if (o.material.vertexColors || Object.keys(g.morphAttributes).length) return null;
  const e = o.matrixWorld.elements;
  // every basis column a unit axis (any quarter turn, no scale or shear)
  for (const c of [0, 4, 8]) {
    const v = [Math.abs(e[c]), Math.abs(e[c + 1]), Math.abs(e[c + 2])].sort((a, b) => b - a);
    if (Math.abs(v[0] - 1) > 1e-4 || v[1] > 1e-4) return null;
  }
  if (!g.boundingBox) g.computeBoundingBox();
  const b = _bb.copy(g.boundingBox).applyMatrix4(o.matrixWorld);
  return { min: b.min.toArray(), max: b.max.toArray() };
}

/** Fuse boxes that share a cross section and touch end to end, until nothing more joins. */
export function fuseBoxes(boxes) {
  let list = boxes.map((b) => ({ min: [...b.min], max: [...b.max] }));
  for (let changed = true; changed;) {
    changed = false;
    for (let axis = 0; axis < 3; axis++) {
      const [u, v] = [0, 1, 2].filter((a) => a !== axis);
      // same cross section on the other two axes → same row key; sort each row along the axis and sweep
      const rows = new Map();
      for (const b of list) {
        const k = [b.min[u], b.max[u], b.min[v], b.max[v]].map((x) => Math.round(x / SAME)).join(',');
        if (!rows.has(k)) rows.set(k, []);
        rows.get(k).push(b);
      }
      const next = [];
      for (const row of rows.values()) {
        row.sort((a, b) => a.min[axis] - b.min[axis]);
        let cur = row[0];
        for (let i = 1; i < row.length; i++) {
          const b = row[i];
          if (b.min[axis] <= cur.max[axis] + JOIN) { cur.max[axis] = Math.max(cur.max[axis], b.max[axis]); changed = true; } else { next.push(cur); cur = b; }
        }
        next.push(cur);
      }
      list = next;
    }
  }
  return list;
}

/*
  Hidden faces. Where a block face is pressed against a facing block face (a wall against the next wall, a
  sill-height block against a full-height one, a slab on a wall), both lie inside the solid: never seen, but the
  shadow map still sees them, right at the depth of the lit surface beside them, and draws a seam line there.
  Every block face is cut down to the parts not covered by a facing block (any material); what's left is the
  outer shell of the whole box-built level.
*/
const TOUCH = 0.002; // faces this close count as pressed together

/** groups: [[box…] per bucket] → [BufferGeometry | null per bucket]: each box's faces minus their hidden parts. */
export function boxShells(groups) {
  const faces = [];
  groups.forEach((boxes, g) => {
    for (const b of boxes) for (let a = 0; a < 3; a++) {
      const [u, v] = a === 0 ? [1, 2] : a === 1 ? [2, 0] : [0, 1];
      for (const s of [-1, 1]) faces.push({ g, a, s, u, v, c: s > 0 ? b.max[a] : b.min[a], r: [b.min[u], b.max[u], b.min[v], b.max[v]] });
    }
  });
  // faces by plane: axis, facing, position (to 1 mm), with the neighbouring millimetres for rounding
  const planes = new Map();
  const pk = (a, s, c) => `${a}${s}${Math.round(c / 0.001)}`;
  for (const f of faces) { const k = pk(f.a, f.s, f.c); if (!planes.has(k)) planes.set(k, []); planes.get(k).push(f); }
  const out = groups.map(() => []);
  for (const f of faces) {
    const covers = [];
    for (const d of [-1, 0, 1]) for (const o of planes.get(pk(f.a, -f.s, f.c + d * 0.001)) ?? []) {
      if (Math.abs(o.c - f.c) > TOUCH) continue;
      const r = [Math.max(f.r[0], o.r[0]), Math.min(f.r[1], o.r[1]), Math.max(f.r[2], o.r[2]), Math.min(f.r[3], o.r[3])];
      if (r[1] - r[0] > 1e-4 && r[3] - r[2] > 1e-4) covers.push(r);
    }
    for (const r of subtract(f.r, covers)) quad(out[f.g], f, r);
  }
  return out.map((p) => {
    if (!p.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.computeVertexNormals();
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((p.length / 3) * 2), 2));
    return g;
  });
}

/** rect [u0, u1, v0, v1] minus the union of `holes`, as rects (grid cut, then cells joined along u). */
function subtract(rect, holes) {
  if (!holes.length) return [rect];
  const us = [...new Set([rect[0], rect[1], ...holes.flatMap((h) => [h[0], h[1]])])].sort((a, b) => a - b);
  const vs = [...new Set([rect[2], rect[3], ...holes.flatMap((h) => [h[2], h[3]])])].sort((a, b) => a - b);
  const out = [];
  for (let j = 0; j < vs.length - 1; j++) {
    const cv = (vs[j] + vs[j + 1]) / 2;
    let run = null;
    for (let i = 0; i < us.length - 1; i++) {
      const cu = (us[i] + us[i + 1]) / 2;
      const hidden = holes.some((h) => cu > h[0] && cu < h[1] && cv > h[2] && cv < h[3]);
      if (!hidden && run && run[1] === us[i]) run[1] = us[i + 1];
      else if (!hidden) { if (run) out.push(run); run = [us[i], us[i + 1], vs[j], vs[j + 1]]; } else if (run) { out.push(run); run = null; }
    }
    if (run) out.push(run);
  }
  return out;
}

/**
 * Two triangles for face f over rect r, wound to face outward. Each face is grown by SEAL in its own plane:
 * neighbouring faces that meet at a T (a short step's side against a tall one's) leave hairline cracks when
 * rasterised, and with the hidden faces gone the far background shows through them; the overlap closes them.
 */
const SEAL = 0.0006;
function quad(p, f, r) {
  const pt = (uu, vv) => { const q = [0, 0, 0]; q[f.a] = f.c; q[f.u] = uu; q[f.v] = vv; return q; };
  const A = pt(r[0] - SEAL, r[2] - SEAL), B = pt(r[1] + SEAL, r[2] - SEAL), C = pt(r[1] + SEAL, r[3] + SEAL), D = pt(r[0] - SEAL, r[3] + SEAL);
  // (u, v, axis) is right-handed for every axis above, so A→B→C faces +axis
  if (f.s > 0) p.push(...A, ...B, ...C, ...A, ...C, ...D);
  else p.push(...A, ...C, ...B, ...A, ...D, ...C);
}

/**
 * Render batches: every mesh merged by material (a few dozen draw calls instead of thousands).
 * Collision proxy: one invisible mesh for the octree and bullets — boxes, ramps and terrain stay exact,
 * rounded/organic forms become their bounding boxes, decoration and paint are left out.
 */
function batch(root) {
  root.updateMatrixWorld(true);
  const buckets = new Map();
  const chunks = new Map(); // 16 m cells so a bullet only tests the chunks it passes through
  const _c = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const geo = o.geometry;
    if (!o.userData.collider) {
      const key = `${o.material.uuid}|${o.castShadow}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { material: o.material, cast: o.castShadow, geos: [], boxes: [] }));
      const box = plainBox(o);
      if (box) { b.boxes.push(box); return collide(o, geo); }
      const g = geo.index ? geo.toNonIndexed() : geo.clone();
      const keep = ['position', 'normal', 'uv', ...(o.material.vertexColors ? ['color'] : [])];
      for (const name of Object.keys(g.attributes)) if (!keep.includes(name)) g.deleteAttribute(name);
      if (!g.attributes.normal) g.computeVertexNormals();
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      g.morphAttributes = {};
      g.clearGroups();
      g.applyMatrix4(o.matrixWorld);
      b.geos.push(g);
    }
    collide(o, geo);
  });
  function collide(o, geo) {
    if (o.userData.noCollide || o.userData.paint) return;
    let p;
    const tris = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    // (RoundedBoxGeometry also reports 'BoxGeometry'; only a real 12-triangle box counts as exact)
    const exact = o.userData.collider || (EXACT.has(geo.type) && (geo.type !== 'BoxGeometry' || tris === 12));
    if (exact && geo.type === 'BoxGeometry' && geo.parameters) {
      const { width, height, depth } = geo.parameters;
      p = new THREE.BoxGeometry(...thicken(width, height, depth)).toNonIndexed();
    } else if (exact) p = geo.index ? geo.toNonIndexed() : geo.clone();
    else {
      geo.computeBoundingBox();
      const size = geo.boundingBox.getSize(new THREE.Vector3()), c = geo.boundingBox.getCenter(new THREE.Vector3());
      p = new THREE.BoxGeometry(...thicken(size.x, size.y, size.z)).translate(c.x, c.y, c.z).toNonIndexed();
    }
    const pos = new THREE.BufferGeometry();
    pos.setAttribute('position', p.attributes.position);
    pos.applyMatrix4(o.matrixWorld);
    o.getWorldPosition(_c);
    const key = o.userData.terrain ? 'terrain' : `${Math.floor(_c.x / 16)},${Math.floor(_c.z / 16)}`;
    if (!chunks.has(key)) chunks.set(key, []);
    chunks.get(key).push(pos);
  }
  const visual = [];
  const all = [...buckets.values()];
  const shells = boxShells(all.map((b) => fuseBoxes(b.boxes)));
  all.forEach((b, i) => { if (shells[i]) b.geos.push(shells[i]); });
  for (const b of all) {
    if (!b.geos.length) continue;
    const m = new THREE.Mesh(mergeGeometries(b.geos), b.material);
    m.castShadow = b.cast;
    m.receiveShadow = true;
    visual.push(m);
  }
  const hidden = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const proxies = [...chunks.values()].map((list) => {
    const m = new THREE.Mesh(mergeGeometries(list), hidden);
    m.visible = false;
    return m;
  });
  return { visual, proxies };
}

/**
 * Scenery beyond the build square: a coarse ring of land that starts at the map's edge heights and swells
 * into hills, so the world doesn't end at a wall or a drop.
 */
function outerLand(h, size, groundAt) {
  const half = size / 2, far = half + 220, step = 8;
  const n = Math.round((far * 2) / step);
  const geo = new THREE.PlaneGeometry(far * 2, far * 2, n, n).rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const out = Math.max(Math.abs(x), Math.abs(z)) - half;
    if (out < -0.01) { pos.setY(i, groundAt(x, z) - 6); continue; } // tucked under the playable terrain
    const edge = groundAt(THREE.MathUtils.clamp(x, -half, half), THREE.MathUtils.clamp(z, -half, half));
    const hills = 4 + 3 * Math.sin(x * 0.031) * Math.cos(z * 0.027) + 2 * Math.sin((x + z) * 0.013);
    const rise = THREE.MathUtils.smoothstep(out, 0, 90);
    pos.setY(i, edge + rise * (hills + out * 0.06));
  }
  geo.computeVertexNormals();
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / 4, -pos.getZ(i) / 4);
  tintGround(geo);
  const m = new THREE.Mesh(geo, terrainMaterial());
  m.receiveShadow = true;
  return m;
}

function atmosphere(scene, group, half) {
  applySky(scene);
  scene.fog = new THREE.Fog(P.pampas, 90, 360);
  group.add(new THREE.HemisphereLight(0xfffaf0, P.kraft, 1.25));
  const sun = new THREE.DirectionalLight(0xfff4e6, 2.4);
  sun.position.set(-45, 90, 35);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.userData.shadowFollow = 16; // near shadows: a sharp box on the player (±16 m); the far map covers the rest
  const c = sun.shadow.camera;
  c.near = 10;
  c.far = 260;
  group.add(sun, sun.target);
}
