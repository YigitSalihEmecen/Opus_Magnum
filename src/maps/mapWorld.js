import * as THREE from 'three';
import { Octree } from 'three/examples/jsm/math/Octree.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PALETTE as P, toon } from '../core/toon.js';
import { buildPiece, buildJoints, makeContext } from './assets.js';
import { terrainMesh, setHeights, heightsOf, heightAt, segOf, LIMIT, terrainMaterial, tintGround } from './terrain.js';
import { applySky } from '../world/sky.js';
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
  const ground = terrainMesh(size, { seg: segOf(h) });
  setHeights(ground, h, { grass: !map.terrain?.plain });
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
      if (!b) buckets.set(key, (b = { material: o.material, cast: o.castShadow, geos: [] }));
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
  });
  const visual = [];
  for (const b of buckets.values()) {
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
  sun.shadow.mapSize.set(half > 60 ? 4096 : 2048, half > 60 ? 4096 : 2048);
  const c = sun.shadow.camera;
  c.left = c.bottom = -half - 10;
  c.right = c.top = half + 10;
  c.near = 10;
  c.far = 260;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.09; // ~2 texels of the 4k map: no acne stripes on walls lit at grazing angles
  group.add(sun, sun.target);
}
