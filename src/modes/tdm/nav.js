import * as THREE from 'three';
import { Capsule } from 'three/examples/jsm/math/Capsule.js';

/*
  Layered walkable grid sampled from the arena's collision octree. Each 1 m cell keeps up to LAYERS
  standing surfaces (ground, upper floor, roof…) found by casting down through the level; a surface is
  walkable if a bot-sized capsule fits on it. Nodes (cell × layer) connect to neighbouring nodes whose
  height is within a small step (ramps, stairs, kerbs), so bots walk into buildings and up stairs but
  never need to mantle or jump. Only the largest connected region is kept.
*/

const STEP = 0.65; // max height change between neighbouring cells (m)
const LAYERS = 8;
const BOT_R = 0.3;
const _ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
const _cap = new Capsule();
const _n = new THREE.Vector3();

export class NavGrid {
  constructor(octree, { minX, maxX, minZ, maxZ, cell = 1 }) {
    Object.assign(this, { minX, minZ, cell });
    // cell centres sit on whole metres, like the building grid: doorways land on a centre, walls on a line of cells
    this.w = Math.floor((maxX - minX) / cell) + 1;
    this.d = Math.floor((maxZ - minZ) / cell) + 1;
    const n = this.w * this.d * LAYERS;
    this.h = new Float32Array(n);
    this.ok = new Uint8Array(n);

    for (let j = 0; j < this.d; j++) {
      for (let i = 0; i < this.w; i++) {
        const base = (j * this.w + i) * LAYERS;
        const x = this.x(i), z = this.z(j);
        let top = 40, layer = 0;
        for (let guard = 0; guard < 32 && layer < LAYERS; guard++) {
          _ray.origin.set(x, top, z);
          const hit = octree.rayIntersect(_ray);
          if (!hit) break;
          const y = top - hit.distance;
          top = y - 0.02;
          if (hit.triangle.getNormal(_n).y < 0.5) continue; // underside of a slab, wall face…
          _cap.start.set(x, y + BOT_R + 0.08, z);
          _cap.end.set(x, y + 1.7 - BOT_R, z);
          _cap.radius = BOT_R;
          if (octree.capsuleIntersect(_cap)) continue;
          this.h[base + layer] = y;
          this.ok[base + layer] = 1;
          layer++;
        }
      }
    }
    this.#keepLargestRegion();
  }

  x(i) { return this.minX + i * this.cell; }
  z(j) { return this.minZ + j * this.cell; }
  /** Cell index for world (x, z), or -1 outside. */
  key(x, z) {
    const i = Math.round((x - this.minX) / this.cell), j = Math.round((z - this.minZ) / this.cell);
    return i < 0 || j < 0 || i >= this.w || j >= this.d ? -1 : j * this.w + i;
  }

  /** Node (cell × layer) at (x, z) nearest to height y (topmost when y is omitted), or -1. */
  node(x, z, y) {
    const k = this.key(x, z);
    if (k < 0) return -1;
    let best = -1, bestD = Infinity;
    for (let l = 0; l < LAYERS; l++) {
      const n = k * LAYERS + l;
      if (!this.ok[n]) continue;
      const d = y === undefined ? -this.h[n] : Math.abs(this.h[n] - y);
      if (d < bestD) { bestD = d; best = n; }
    }
    if (best >= 0 && y !== undefined && bestD > 1.2) return -1;
    return best;
  }

  walkable(x, z, y) { return this.node(x, z, y) >= 0; }
  heightAt(x, z, y) { const n = this.node(x, z, y); return n >= 0 ? this.h[n] : (y ?? 0); }
  nodePos(n, out = new THREE.Vector3()) {
    const k = (n / LAYERS) | 0;
    return out.set(this.x(k % this.w), this.h[n], this.z((k / this.w) | 0));
  }

  /** Neighbour nodes of n reachable in one step (8-way, no corner cutting). */
  neighbours(n, out) {
    out.length = 0;
    const k = (n / LAYERS) | 0, i = k % this.w, j = (k / this.w) | 0, h = this.h[n];
    const at = (ii, jj) => {
      if (ii < 0 || jj < 0 || ii >= this.w || jj >= this.d) return -1;
      const kk = (jj * this.w + ii) * LAYERS;
      let best = -1, bestD = STEP;
      for (let l = 0; l < LAYERS; l++) {
        if (!this.ok[kk + l]) continue;
        const d = Math.abs(this.h[kk + l] - h);
        if (d <= bestD) { bestD = d; best = kk + l; }
      }
      return best;
    };
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const m = at(i + di, j + dj);
        if (m < 0) continue;
        if (di && dj && (at(i + di, j) < 0 || at(i, j + dj) < 0)) continue;
        out.push(m);
      }
    }
    return out;
  }

  /** A* from world (ax, az) to (bx, bz) at heights ay / by. Returns smoothed waypoints [{x, y, z}] or null. */
  path(ax, az, bx, bz, ay, by) {
    let s = this.node(ax, az, ay), g = this.node(bx, bz, by);
    if (s < 0) s = this.nearestNode(ax, az, ay);
    if (g < 0) g = this.nearestNode(bx, bz, by);
    if (s < 0 || g < 0) return null;

    const n = this.ok.length;
    const cost = (this._cost ??= new Float32Array(n)).fill(Infinity);
    const from = (this._from ??= new Int32Array(n)).fill(-1);
    const closed = (this._closed ??= new Uint8Array(n)).fill(0);
    const heap = new MinHeap();
    const gk = (g / LAYERS) | 0, gi = gk % this.w, gj = (gk / this.w) | 0, gh = this.h[g];
    const heur = (m) => {
      const k = (m / LAYERS) | 0;
      const dx = Math.abs((k % this.w) - gi), dz = Math.abs(((k / this.w) | 0) - gj);
      return Math.max(dx, dz) + 0.414 * Math.min(dx, dz) + Math.abs(this.h[m] - gh);
    };
    cost[s] = 0;
    heap.push(s, heur(s));
    const nb = [];
    while (heap.size) {
      const m = heap.pop();
      if (m === g) break;
      if (closed[m]) continue;
      closed[m] = 1;
      const mk = (m / LAYERS) | 0;
      for (const q of this.neighbours(m, nb)) {
        const qk = (q / LAYERS) | 0;
        const diag = (qk % this.w !== mk % this.w) && ((qk / this.w) | 0) !== ((mk / this.w) | 0);
        const c = cost[m] + (diag ? 1.414 : 1) + Math.abs(this.h[q] - this.h[m]);
        if (c < cost[q]) { cost[q] = c; from[q] = m; heap.push(q, c + heur(q)); }
      }
    }
    if (s !== g && from[g] < 0) return null;
    const nodes = [];
    for (let m = g; m >= 0; m = m === s ? -1 : from[m]) nodes.push(m);
    nodes.reverse();
    return this.#smooth(nodes);
  }

  /** Straight walk from a to b (starting at height ay) stays on walkable nodes with gentle steps. */
  clear(ax, az, bx, bz, ay) {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) return true;
    const steps = Math.max(1, Math.ceil(len / (this.cell * 0.4)));
    let prev = ay ?? this.heightAt(ax, az);
    const ox = ((bz - az) / len) * BOT_R * 0.6, oz = (-(bx - ax) / len) * BOT_R * 0.6;
    for (let t = 1; t <= steps; t++) {
      const x = ax + ((bx - ax) * t) / steps, z = az + ((bz - az) * t) / steps;
      const m = this.node(x, z, prev);
      if (m < 0 || Math.abs(this.h[m] - prev) > STEP) return false;
      // keep the bot's body off walls: sample either side of the line too
      if (this.node(x + ox, z + oz, this.h[m]) < 0 || this.node(x - ox, z - oz, this.h[m]) < 0) return false;
      prev = this.h[m];
    }
    return true;
  }

  /** Closest walkable node to (x, z[, y]) within maxR cells. */
  nearestNode(x, z, y, maxR = 6) {
    const k0 = this.key(THREE.MathUtils.clamp(x, this.minX, this.x(this.w - 1)), THREE.MathUtils.clamp(z, this.minZ, this.z(this.d - 1)));
    if (k0 < 0) return -1;
    const i0 = k0 % this.w, j0 = (k0 / this.w) | 0;
    for (let r = 0; r <= maxR; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = i0 + di, j = j0 + dj;
          if (i < 0 || j < 0 || i >= this.w || j >= this.d) continue;
          const m = this.node(this.x(i), this.z(j), y);
          if (m >= 0) return m;
        }
      }
    }
    return -1;
  }

  /** Random walkable point within radius r of (x, z), or anywhere if r is omitted. */
  randomPoint(rng = Math.random, x, z, r) {
    for (let tries = 0; tries < 60; tries++) {
      const px = r ? x + (rng() * 2 - 1) * r : this.minX + rng() * (this.w - 1) * this.cell;
      const pz = r ? z + (rng() * 2 - 1) * r : this.minZ + rng() * (this.d - 1) * this.cell;
      const k = this.key(px, pz);
      if (k < 0) continue;
      const layers = [];
      for (let l = 0; l < LAYERS; l++) if (this.ok[k * LAYERS + l]) layers.push(k * LAYERS + l);
      if (!layers.length) continue;
      const m = layers[(rng() * layers.length) | 0];
      return new THREE.Vector3(px, this.h[m], pz);
    }
    return null;
  }

  #smooth(nodes) {
    const pts = nodes.map((m) => this.nodePos(m));
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    let a = 0;
    while (a < pts.length - 1) {
      let b = pts.length - 1;
      while (b > a + 1 && !this.clear(pts[a].x, pts[a].z, pts[b].x, pts[b].z, pts[a].y)) b--;
      out.push(pts[b]);
      a = b;
    }
    return out;
  }

  #keepLargestRegion() {
    const label = new Int32Array(this.ok.length).fill(-1);
    let best = -1, bestSize = 0, id = 0;
    const nb = [];
    for (let n = 0; n < this.ok.length; n++) {
      if (!this.ok[n] || label[n] >= 0) continue;
      const stack = [n];
      label[n] = id;
      let size = 0;
      while (stack.length) {
        const c = stack.pop();
        size++;
        for (const m of this.neighbours(c, nb)) if (label[m] < 0) { label[m] = id; stack.push(m); }
      }
      if (size > bestSize) { bestSize = size; best = id; }
      id++;
    }
    for (let n = 0; n < this.ok.length; n++) if (label[n] !== best) this.ok[n] = 0;
  }
}

class MinHeap {
  constructor() { this.k = []; this.p = []; }
  get size() { return this.k.length; }
  push(key, pri) {
    const { k, p } = this;
    let i = k.length;
    k.push(key); p.push(pri);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (p[up] <= pri) break;
      k[i] = k[up]; p[i] = p[up]; i = up;
    }
    k[i] = key; p[i] = pri;
  }
  pop() {
    const { k, p } = this;
    const top = k[0], lk = k.pop(), lp = p.pop();
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i, mp = lp;
        if (l < k.length && p[l] < mp) { m = l; mp = p[l]; }
        if (r < k.length && p[r] < mp) { m = r; }
        if (m === i) break;
        k[i] = k[m]; p[i] = p[m]; i = m;
      }
      k[i] = lk; p[i] = lp;
    }
    return top;
  }
}
