import * as THREE from 'three';
import { Capsule } from 'three/examples/jsm/math/Capsule.js';

/*
  Layered walkable grid sampled from the arena's collision octree. Each 1 m cell keeps up to LAYERS
  standing surfaces (ground, upper floor, roof…) found by casting down through the level; a surface is
  walkable if a bot-sized capsule fits on it. Nodes (cell × layer) connect to neighbouring nodes whose
  height is within a small step (ramps, stairs, kerbs), so bots walk into buildings and up stairs. Ledges up
  to CLIMB high with open air over the edge are links too (straight across only, both ways): bots mantle up
  and hop down them (bot.js). Only the largest connected region is kept.
  Cell centres alone miss a thin wall or fence lying between two of them (both cells fit a bot, so they'd
  link straight through it), so every wall-like triangle of the level is also drawn once into a fine 2D
  raster (WALL m cells, each keeping up to two height spans). Links, straight-line checks and the bots' own
  movement test it: a wall between here and there is a few array reads, no rays.
*/

const STEP = 0.65; // max height change between neighbouring cells (m)
const CLIMB = 1.7; // a ledge up to this high is a climb / drop link
const LINK_COST = 2.5; // extra path cost of using one (a climb is slower than walking)
const LAYERS = 8;
const WALL = 0.25; // wall raster cell (m)
const BODY = [0.35, 1.6]; // a wall blocks a bot when it spans this band above the floor (lower is a kerb or a stair)
const BOT_R = 0.3;
const _ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
const _cap = new Capsule();
const _n = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();

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
    this.#rasterWalls(octree, minX, maxX, minZ, maxZ);
    this.edge = new Uint8Array(n * 8); // per node and direction: 0 not checked yet, 1 open, 2 a wall in the way
    this.#link(octree);
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
        if (!this.#open(n, m, (dj + 1) * 3 + di + 1)) continue;
        out.push(m);
      }
    }
    const l = this.links.get(n);
    if (l) for (const m of l) out.push(m);
    return out;
  }

  /** No wall between neighbouring nodes n and m (dir: which of the 8, for the cache). */
  #open(n, m, dir) {
    const e = n * 8 + (dir > 4 ? dir - 1 : dir);
    if (!this.edge[e]) {
      const a = this.nodePos(n, _a), b = this.nodePos(m, _b);
      this.edge[e] = this.wallOnLine(a.x, a.z, a.y, b.x, b.z, b.y) ? 2 : 1;
    }
    return this.edge[e] === 1;
  }

  // ── walls ──

  #rasterWalls(octree, minX, maxX, minZ, maxZ) {
    this.wx = minX - 1;
    this.wz = minZ - 1;
    this.ww = Math.ceil((maxX - minX + 2) / WALL) + 1;
    this.wd = Math.ceil((maxZ - minZ + 2) / WALL) + 1;
    const spans = (this.spans = new Float32Array(this.ww * this.wd * 4));
    for (let i = 0; i < spans.length; i += 2) { spans[i] = Infinity; spans[i + 1] = -Infinity; }
    const put = (x, z, y0, y1) => {
      const ci = Math.floor((x - this.wx) / WALL), cj = Math.floor((z - this.wz) / WALL);
      if (ci < 0 || cj < 0 || ci >= this.ww || cj >= this.wd) return;
      const k = (cj * this.ww + ci) * 4;
      // two spans per cell (a wall on the ground floor, another upstairs); a third merges into the nearer one
      for (const o of [0, 2]) {
        if (spans[k + o] === Infinity || (y0 <= spans[k + o + 1] + 0.3 && y1 >= spans[k + o] - 0.3)) {
          spans[k + o] = Math.min(spans[k + o], y0);
          spans[k + o + 1] = Math.max(spans[k + o + 1], y1);
          return;
        }
      }
      const o = Math.abs(y0 - spans[k]) < Math.abs(y0 - spans[k + 2]) ? 0 : 2;
      spans[k + o] = Math.min(spans[k + o], y0);
      spans[k + o + 1] = Math.max(spans[k + o + 1], y1);
    };
    const seen = new Set();
    const visit = (node) => {
      for (const t of node.triangles) {
        if (seen.has(t)) continue;
        seen.add(t);
        if (Math.abs(t.getNormal(_n).y) >= 0.5) continue; // floors, ceilings, gentle slopes
        const v = [t.a, t.b, t.c];
        const y0 = Math.min(t.a.y, t.b.y, t.c.y), y1 = Math.max(t.a.y, t.b.y, t.c.y);
        // its footprint on the ground is (nearly) a segment: the two vertices furthest apart in plan
        let p = v[0], q = v[1], best = -1;
        for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
          const d = (v[i].x - v[j].x) ** 2 + (v[i].z - v[j].z) ** 2;
          if (d > best) { best = d; p = v[i]; q = v[j]; }
        }
        const steps = Math.ceil(Math.sqrt(best) / (WALL * 0.5)) + 1;
        for (let s = 0; s <= steps; s++) put(p.x + ((q.x - p.x) * s) / steps, p.z + ((q.z - p.z) * s) / steps, y0, y1);
      }
      for (const sub of node.subTrees) visit(sub);
    };
    visit(octree);
  }

  /** A wall across the body band of a bot standing at height y, at (x, z). */
  wallAt(x, z, y) {
    const ci = Math.floor((x - this.wx) / WALL), cj = Math.floor((z - this.wz) / WALL);
    if (ci < 0 || cj < 0 || ci >= this.ww || cj >= this.wd) return false;
    const k = (cj * this.ww + ci) * 4, s = this.spans, lo = y + BODY[0], hi = y + BODY[1];
    return (s[k] < hi && s[k + 1] > lo) || (s[k + 2] < hi && s[k + 3] > lo);
  }

  /** A wall anywhere on the straight walk from (ax, az) at height ay to (bx, bz) at by. */
  wallOnLine(ax, az, ay, bx, bz, by) {
    const len = Math.hypot(bx - ax, bz - az), steps = Math.max(1, Math.ceil(len / (WALL * 0.5)));
    for (let t = 0; t <= steps; t++) {
      const f = t / steps;
      if (this.wallAt(ax + (bx - ax) * f, az + (bz - az) * f, ay + (by - ay) * f)) return true;
    }
    return false;
  }

  /** Room for a bot's body (radius r) at (x, z) standing at y: no wall at its middle or four sides. */
  bodyFits(x, z, y, r = 0.22) {
    return !this.wallAt(x, z, y) && !this.wallAt(x + r, z, y) && !this.wallAt(x - r, z, y) && !this.wallAt(x, z + r, y) && !this.wallAt(x, z - r, y);
  }

  /** Is n → m a climb or drop link (rather than a walk)? */
  isLink(n, m) { return Math.abs(this.h[n] - this.h[m]) > STEP; }

  /**
   * Climb / drop links between straight neighbours whose heights differ by more than a step but at most CLIMB,
   * where nothing blocks the way over the edge (a horizontal ray just above the higher floor).
   */
  #link(octree) {
    this.links = new Map();
    const L = LAYERS, ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3());
    const add = (a, b) => { let l = this.links.get(a); if (!l) this.links.set(a, (l = [])); if (!l.includes(b)) l.push(b); };
    for (let j = 0; j < this.d; j++) {
      for (let i = 0; i < this.w; i++) {
        for (let l = 0; l < L; l++) {
          const n = (j * this.w + i) * L + l;
          if (!this.ok[n]) continue;
          for (const [di, dj] of [[1, 0], [0, 1]]) {
            const ii = i + di, jj = j + dj;
            if (ii >= this.w || jj >= this.d) continue;
            const kk = (jj * this.w + ii) * L;
            // a walkable step there already: no link needed
            let step = false;
            for (let q = 0; q < L; q++) if (this.ok[kk + q] && Math.abs(this.h[kk + q] - this.h[n]) <= STEP) step = true;
            if (step) continue;
            for (let q = 0; q < L; q++) {
              const m = kk + q;
              if (!this.ok[m]) continue;
              const dh = Math.abs(this.h[m] - this.h[n]);
              if (dh <= STEP || dh > CLIMB) continue;
              const top = Math.max(this.h[m], this.h[n]) + 0.6;
              ray.origin.set(this.x(i), top, this.z(j));
              ray.direction.set(di, 0, dj);
              const hit = octree.rayIntersect(ray);
              if (hit && hit.distance < this.cell) continue;
              add(n, m); add(m, n);
            }
          }
        }
      }
    }
  }

  /**
   * A* from world (ax, az) to (bx, bz) at heights ay / by. Returns smoothed waypoints [{x, y, z}] or null.
   * extra(x, z): optional cost added for stepping onto a cell (tactical pathfinding: danger, enemy sight lines).
   */
  path(ax, az, bx, bz, ay, by, extra) {
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
        let c = cost[m] + (diag ? 1.414 : 1) + Math.abs(this.h[q] - this.h[m]) + (this.isLink(m, q) ? LINK_COST : 0);
        if (extra) c += extra(this.x(qk % this.w), this.z((qk / this.w) | 0));
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
      if (this.wallAt(x, z, this.h[m]) || this.wallAt(x + ox, z + oz, this.h[m]) || this.wallAt(x - ox, z - oz, this.h[m])) return false;
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
