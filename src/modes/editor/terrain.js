import * as THREE from 'three';
import { PALETTE as P, toon, gridTexture } from '../../core/toon.js';

/*
  Heightfield ground: (seg + 1)² heights on a 2 m lattice over the build square (seg = size / 2).
  Saved on the map as map.terrain = { seg, h: [...] } (row-major, z then x); missing means flat.
  Pieces don't follow the terrain after placement; flatten a pad first, then build on it.
*/

export const LIMIT = { min: -8, max: 16 };
export const segFor = (size) => Math.round(size / 2);
const segOf = (h) => Math.round(Math.sqrt(h.length)) - 1;

export function emptyHeights(seg) { return new Float32Array((seg + 1) * (seg + 1)); }

export function heightsOf(map, size = map.size ?? 96) {
  const seg = segFor(size);
  const t = map.terrain;
  if (!t?.h || t.seg !== seg || t.h.length !== (seg + 1) ** 2) return emptyHeights(seg);
  return Float32Array.from(t.h);
}

export function packHeights(h) {
  let flat = true;
  for (const v of h) if (Math.abs(v) > 1e-3) { flat = false; break; }
  return flat ? undefined : { seg: segOf(h), h: Array.from(h, (v) => Math.round(v * 100) / 100) };
}

const GRID = gridTexture();

/** Ground mesh for a size × size square; heights applied by setHeights. */
export function terrainMesh(size) {
  const seg = segFor(size);
  const geo = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(-Math.PI / 2);
  // world-scale UVs so the paper grid meets every piece's grid
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / 4, -pos.getZ(i) / 4);
  const mesh = new THREE.Mesh(geo, toon(P.oat, { map: GRID, rim: 0 }));
  mesh.receiveShadow = true;
  mesh.userData.terrain = true;
  return mesh;
}

/** Vertex i of the rotated plane is lattice (ix, iz) with i = iz * (seg + 1) + ix, z running -half → +half. */
export function setHeights(mesh, h) {
  const pos = mesh.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, h[i]);
  pos.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
  mesh.geometry.computeBoundingSphere();
  mesh.geometry.computeBoundingBox();
}

/** Height at world (x, z), interpolated on the same two triangles per cell the mesh uses. */
export function heightAt(h, size, x, z) {
  const seg = segOf(h), step = size / seg, half = size / 2, n = seg + 1;
  const fx = THREE.MathUtils.clamp((x + half) / step, 0, seg - 1e-4), fz = THREE.MathUtils.clamp((z + half) / step, 0, seg - 1e-4);
  const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
  const a = h[iz * n + ix], b = h[(iz + 1) * n + ix], c = h[(iz + 1) * n + ix + 1], d = h[iz * n + ix + 1];
  // PlaneGeometry splits each cell along the b–d diagonal (faces a-b-d and b-c-d)
  return tx + tz <= 1 ? a + (d - a) * tx + (b - a) * tz : c + (b - c) * (1 - tx) + (d - c) * (1 - tz);
}

/**
 * Brush stroke at (x, z). mode: raise | lower | smooth | flatten (to `target`). Returns true if anything changed.
 * Strength is metres per second at the brush centre; falloff is a smooth bump.
 */
export function brush(h, size, { mode, x, z, radius, strength, target = 0 }, dt) {
  const seg = segOf(h), step = size / seg, half = size / 2, n = seg + 1;
  const r2 = radius * radius;
  const src = mode === 'smooth' ? Float32Array.from(h) : h;
  let changed = false;
  const i0 = Math.max(0, Math.floor((x - radius + half) / step)), i1 = Math.min(seg, Math.ceil((x + radius + half) / step));
  const j0 = Math.max(0, Math.floor((z - radius + half) / step)), j1 = Math.min(seg, Math.ceil((z + radius + half) / step));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const dx = i * step - half - x, dz = j * step - half - z, d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const t = 1 - d2 / r2;
      const w = t * t * (3 - 2 * t);
      const k = j * n + i;
      let v = h[k];
      if (mode === 'raise') v += strength * w * dt;
      else if (mode === 'lower') v -= strength * w * dt;
      else if (mode === 'flatten') v += (target - v) * Math.min(1, w * strength * dt * 1.5);
      else if (mode === 'smooth') {
        let s = 0, c = 0;
        for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
          const ii = i + a, jj = j + b;
          if (ii < 0 || jj < 0 || ii > seg || jj > seg) continue;
          s += src[jj * n + ii]; c++;
        }
        v += (s / c - v) * Math.min(1, w * strength * dt * 0.8);
      }
      v = THREE.MathUtils.clamp(v, LIMIT.min, LIMIT.max);
      if (v !== h[k]) { h[k] = v; changed = true; }
    }
  }
  return changed;
}
