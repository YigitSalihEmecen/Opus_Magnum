import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { toon } from './toon.js';

const plainRender = THREE.Object3D.prototype.onBeforeRender;

/** A leaf mesh nothing refers to on its own: safe to fold into a sibling. */
function mergeable(m, keep) {
  return m.isMesh && !m.isSkinnedMesh && !m.isInstancedMesh && !m.children.length && !keep.has(m) && !m.name && m.visible
    && m.layers.mask === 1 && !Array.isArray(m.material) && !m.material.transparent && m.onBeforeRender === plainRender
    && !m.morphTargetInfluences && !Object.keys(m.userData).length;
}

/** Reverse every triangle (a mirrored part baked into its parent would otherwise face inward). */
function flip(g) {
  if (g.index) {
    const a = g.index.array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    return;
  }
  for (const attr of Object.values(g.attributes)) {
    const s = attr.itemSize, arr = attr.array, tmp = arr.slice(0, s);
    for (let t = 0; t < attr.count; t += 3) {
      tmp.set(arr.subarray((t + 1) * s, (t + 2) * s));
      arr.copyWithin((t + 1) * s, (t + 2) * s, (t + 3) * s);
      arr.set(tmp, (t + 2) * s);
    }
  }
}

/** A plain toon material whose colour and rim can move into vertex attributes (toon({ vertexRim })). */
const recolourable = (mat) => mat.isMeshToonMaterial && !mat.map && !mat.vertexColors && !mat.polygonOffset && mat.emissive.getHex() === 0;
const shared = new Map();
const sharedToon = (mat) => {
  const key = `${mat.gradientMap?.uuid}|${mat.side}`;
  if (!shared.has(key)) shared.set(key, toon(0xffffff, { vertexRim: true, gradientMap: mat.gradientMap, side: mat.side }));
  return shared.get(key);
};
/** The material's colour and rim, written per vertex. */
function recolour(g, mat) {
  const n = g.attributes.position.count, rim = mat.userData.rim, c = mat.color;
  const rc = rim?.rimColor.value ?? c, k = rim ? rim.rimStrength.value : 0;
  const col = new Float32Array(n * 3), rimC = new Float32Array(n * 3), rimK = new Float32Array(n).fill(k);
  for (let i = 0; i < n; i++) { col.set([c.r, c.g, c.b], i * 3); rimC.set([rc.r, rc.g, rc.b], i * 3); }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('rimC', new THREE.BufferAttribute(rimC, 3));
  g.setAttribute('rimK', new THREE.BufferAttribute(rimK, 1));
}

/**
 * Fold static leaf meshes into one mesh per material on their nearest moving ancestor: same look, a few draw
 * calls instead of dozens. A node counts as moving when it is the root, in `keep` (anything gunplay animates,
 * swaps or toggles), a bone, a mesh with children, or hidden; static groups between are flattened through.
 * Meshes referenced elsewhere must be in `keep` (or be named, or carry userData) and aren't touched; neither are
 * hidden, transparent or FX-layer meshes. vertexRim: plain toon materials also merge with each other (their colour
 * and rim go per vertex), so a moving part is about one draw call whatever it's painted with.
 */
export function mergeStatic(root, keep = new Set(), { vertexRim = false } = {}) {
  root.updateMatrixWorld(true);
  const anchorOf = (m) => {
    let p = m.parent;
    while (p !== root && !keep.has(p) && !p.isBone && !p.isMesh && p.visible) p = p.parent;
    return p;
  };
  const groups = new Map();
  root.traverse((m) => {
    if (m === root || !mergeable(m, keep)) return;
    const anchor = anchorOf(m);
    const mat = vertexRim && recolourable(m.material) ? sharedToon(m.material) : m.material;
    const key = `${anchor.uuid}|${mat.uuid}|${m.castShadow}|${m.receiveShadow}|${m.renderOrder}`;
    if (!groups.has(key)) groups.set(key, { anchor, mat, list: [] });
    groups.get(key).list.push(m);
  });
  const rel = new THREE.Matrix4(), inv = new THREE.Matrix4();
  for (const { anchor, mat, list } of groups.values()) {
    if (list.length < 2) continue;
    const indexed = list.every((m) => m.geometry.index);
    const names = Object.keys(list[0].geometry.attributes).filter((n) => list.every((m) => m.geometry.attributes[n]) && (mat === list[0].material || n === 'position' || n === 'normal'));
    if (!names.includes('position') || !names.includes('normal') || (mat.map && !names.includes('uv'))) continue;
    inv.copy(anchor.matrixWorld).invert();
    const geos = list.map((m) => {
      const g = indexed ? m.geometry.clone() : m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const n of Object.keys(g.attributes)) if (!names.includes(n)) g.deleteAttribute(n);
      g.morphAttributes = {};
      g.clearGroups();
      g.applyMatrix4(rel.multiplyMatrices(inv, m.matrixWorld));
      if (mat !== m.material) recolour(g, m.material);
      if (rel.determinant() < 0) flip(g);
      return g;
    });
    const merged = mergeGeometries(geos);
    if (!merged) continue;
    const out = new THREE.Mesh(merged, mat);
    Object.assign(out, { castShadow: list[0].castShadow, receiveShadow: list[0].receiveShadow, renderOrder: list[0].renderOrder });
    for (const m of list) m.removeFromParent();
    anchor.add(out);
  }
}
