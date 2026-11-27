import * as THREE from 'three';

/*
  Tactical knowledge for the TDM bots, shared by everyone in a match. Three parts:

  Tactical points (built once per map, Killzone-style): walkable spots on a sparse grid plus every spot right
  beside an obstacle. Each knows, for 8 compass directions, whether something blocks a shot from that side at
  crouch height (low cover) and at standing height (full cover). Only directions where the nav grid shows a
  break get a ray, so open ground costs nothing.

  Position evaluation: a bot asks for a place to fight from, hide in or flank to. Every point in reach gets a
  cheap weighted score (cover against the known threats, distance to the gun's sweet spot, travel, danger,
  teammates nearby, flank angle); only the best few then pay for line-of-sight rays. Evaluations are rationed
  per frame across all bots (budget), so a busy fight never spikes.

  Team boards: what each team knows — enemies seen (where, when, heading), where its members died — and a
  coarse danger map (4 m cells, decaying) that tactical pathfinding adds to its costs, so bots route around
  the lanes that have been killing them.
*/

const DIRS = 8;
const STEP_A = (Math.PI * 2) / DIRS;
const LOW = 1.2, HIGH = 1.78, REACH = 1.45; // cover test heights: over a crouched head, over a standing eye (m); how close (m)
const BUCKET = 8; // spatial hash for points (m)
const CELL = 4; // danger map cell (m)
const DANGER_HALF = 14; // danger halves every this many seconds
const INTEL_TTL = 7; // a sighting is worth acting on this long (s)

const _ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3());
const _a = new THREE.Vector3(), _b = new THREE.Vector3();

/** Direction index (0..7) for a heading from (x, z) towards (tx, tz). */
export const dirIndex = (x, z, tx, tz) => ((Math.round(Math.atan2(tz - z, tx - x) / STEP_A) % DIRS) + DIRS) % DIRS;

export class Tactics {
  constructor(nav, octree, world) {
    Object.assign(this, { nav, octree, world });
    this.points = [];
    this.buckets = new Map();
    this.#build();
    this.cols = Math.ceil((nav.w * nav.cell) / CELL) + 1;
    this.rows = Math.ceil((nav.d * nav.cell) / CELL) + 1;
    this.boards = { ally: this.#board(), enemy: this.#board() };
    this.budget = 0;
  }

  // ── tactical points ──

  #build() {
    const { nav } = this;
    const L = nav.ok.length / (nav.w * nav.d);
    for (let j = 0; j < nav.d; j++) {
      for (let i = 0; i < nav.w; i++) {
        for (let l = 0; l < L; l++) {
          const n = (j * nav.w + i) * L + l;
          if (!nav.ok[n]) continue;
          const x = nav.x(i), z = nav.z(j), y = nav.h[n];
          // which neighbours rise or are missing: only those directions can hold cover
          let edge = 0;
          for (let d = 0; d < DIRS; d++) {
            const a = d * STEP_A, nx = x + Math.round(Math.cos(a)) * nav.cell, nz = z + Math.round(Math.sin(a)) * nav.cell;
            const m = nav.node(nx, nz, y);
            if (m < 0 || nav.h[m] - y > 0.65) edge |= 1 << d; // a wall, a crate, a higher floor (a drop-off is no cover)
          }
          const grid = i % 3 === 0 && j % 3 === 0;
          if (!edge && !grid) continue;
          if (edge && !grid && (i % 2 || j % 2)) continue; // beside walls: one cell in four (2 m apart) is plenty
          let low = 0, high = 0;
          for (let d = 0; d < DIRS; d++) {
            if (!(edge & (1 << d))) continue;
            const a = d * STEP_A;
            _ray.direction.set(Math.cos(a), 0, Math.sin(a));
            _ray.origin.set(x, y + LOW, z);
            const h1 = this.octree.rayIntersect(_ray);
            if (!h1 || h1.distance > REACH) continue;
            low |= 1 << d;
            _ray.origin.y = y + HIGH;
            const h2 = this.octree.rayIntersect(_ray);
            if (h2 && h2.distance <= REACH) high |= 1 << d;
          }
          const p = { x, y, z, low, high, claim: null, claimT: 0 };
          this.points.push(p);
          const k = this.#bkey(x, z);
          let b = this.buckets.get(k);
          if (!b) this.buckets.set(k, (b = []));
          b.push(p);
        }
      }
    }
  }

  #bkey(x, z) { return `${Math.floor(x / BUCKET)},${Math.floor(z / BUCKET)}`; }

  near(x, z, r, out = []) {
    out.length = 0;
    const r2 = r * r;
    for (let bx = Math.floor((x - r) / BUCKET); bx <= Math.floor((x + r) / BUCKET); bx++) {
      for (let bz = Math.floor((z - r) / BUCKET); bz <= Math.floor((z + r) / BUCKET); bz++) {
        const b = this.buckets.get(`${bx},${bz}`);
        if (b) for (const p of b) { const dx = p.x - x, dz = p.z - z; if (dx * dx + dz * dz <= r2) out.push(p); }
      }
    }
    return out;
  }

  /** Does point p have cover against a threat at (tx, tz)? 2 = full, 1 = low (shoot over it), 0 = none. */
  coverFrom(p, tx, tz) {
    const d = dirIndex(p.x, p.z, tx, tz), bit = 1 << d;
    return p.high & bit ? 2 : p.low & bit ? 1 : 0;
  }

  /**
   * Best place for `bot` to go. kind:
   *   'fight'  cover from the threats with a line of fire to the main one (over low cover or a step to the side)
   *   'hide'   out of every threat's sight, away from them
   *   'flank'  a firing spot at a wide angle to the main threat, off the line its attention is on
   * threats: [{ pos, eye, facing }] (main threat first); avoid: a point not to pick (the one being left). Returns { p, peek } or null (null too when out of budget).
   */
  find(bot, kind, threats, { radius = 16, near = 6, far = 24, avoid = null } = {}) {
    if (this.budget <= 0 || !threats.length) return null;
    this.budget--;
    const now = this.world.now;
    const main = threats[0];
    const pts = this.near(bot.pos.x, bot.pos.z, radius, (this._near ??= []));
    const scored = [];
    const ideal = (near + far) / 2;
    for (const p of pts) {
      if (p === avoid || Math.abs(p.y - bot.pos.y) > 4) continue;
      if (p.claim && p.claim !== bot && p.claim.alive && now - p.claimT < 6) continue;
      const travel = Math.hypot(p.x - bot.pos.x, p.z - bot.pos.z);
      let s = -0.12 * travel - 2.5 * this.danger(bot.team, p.x, p.z);
      let covered = 0;
      for (const t of threats) covered += this.coverFrom(p, t.pos.x, t.pos.z) ? 1 : 0;
      const dMain = Math.hypot(p.x - main.pos.x, p.z - main.pos.z);
      if (kind === 'hide') {
        s += 3 * (covered / threats.length) + 0.08 * Math.min(dMain, 30);
        if (dMain < Math.hypot(bot.pos.x - main.pos.x, bot.pos.z - main.pos.z) - 2) s -= 4; // don't run at them
      } else {
        const c = this.coverFrom(p, main.pos.x, main.pos.z);
        s += c === 1 ? 2.6 : c === 2 ? 2 : 0;
        s += 0.8 * (covered / threats.length);
        s -= 0.12 * Math.abs(dMain - ideal);
        if (dMain < near * 0.6) s -= 3;
        if (kind === 'flank') {
          // the angle at the threat between it→us-now and it→point: wide is a flank
          const ax = bot.pos.x - main.pos.x, az = bot.pos.z - main.pos.z, bx = p.x - main.pos.x, bz = p.z - main.pos.z;
          const cos = (ax * bx + az * bz) / (Math.hypot(ax, az) * Math.hypot(bx, bz) || 1);
          s += 3 * (1 - cos) * 0.6;
          // and away from where it's looking: behind its shoulder beats in front of its gun
          if (main.facing !== undefined) s += 1.2 * (1 - Math.cos(Math.atan2(bx, bz) - main.facing)) * 0.5;
        }
      }
      // spread out: teammates on or heading for the same area
      for (const o of this.world.bots) {
        if (o === bot || o.team !== bot.team || !o.alive) continue;
        const g = o.dest ?? o.pos, dx = g.x - p.x, dz = g.z - p.z;
        if (dx * dx + dz * dz < 9) s -= 1.6;
      }
      scored.push([s, p]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    // the few best pay for the rays
    let best = null, bestS = -Infinity;
    for (let i = 0; i < Math.min(5, scored.length); i++) {
      let [s, p] = scored[i];
      let peek = 0;
      if (kind === 'hide') {
        for (const t of threats) if (this.#sees(t.eye, _a.set(p.x, p.y + LOW, p.z))) s -= 5;
      } else {
        // a line of fire standing, else from a step to either side (a corner peek)
        const ex = main.eye ?? _b.copy(main.pos).setY(main.pos.y + 1.4);
        if (this.#sees(ex, _a.set(p.x, p.y + 1.55, p.z))) peek = 0;
        else {
          const hx = main.pos.x - p.x, hz = main.pos.z - p.z, hl = Math.hypot(hx, hz) || 1;
          const rx = -hz / hl, rz = hx / hl; // perpendicular to the threat line
          if (this.#sees(ex, _a.set(p.x + rx * 0.9, p.y + 1.55, p.z + rz * 0.9))) peek = 1;
          else if (this.#sees(ex, _a.set(p.x - rx * 0.9, p.y + 1.55, p.z - rz * 0.9))) peek = -1;
          else s -= 4;
        }
        // the main threat shouldn't see us crouched there (else it's no cover at all)
        if (this.coverFrom(p, main.pos.x, main.pos.z) && this.#sees(ex, _a.set(p.x, p.y + 0.9, p.z))) s -= 1.5;
      }
      if (s > bestS) { bestS = s; best = { p, peek, score: s }; }
    }
    if (best) { best.p.claim = bot; best.p.claimT = now; }
    return best;
  }

  #sees(from, to) {
    const d = from.distanceTo(to);
    _ray.origin.copy(from);
    _ray.direction.subVectors(to, from).divideScalar(d || 1);
    const hit = this.octree.rayIntersect(_ray);
    return !hit || hit.distance >= d - 0.2;
  }

  // ── team boards ──

  #board() {
    return { seen: new Map(), danger: new Float32Array(this.cols * this.rows), lastDecay: 0 };
  }

  #cell(x, z) {
    const c = Math.floor((x - this.nav.minX) / CELL), r = Math.floor((z - this.nav.minZ) / CELL);
    return c < 0 || r < 0 || c >= this.cols || r >= this.rows ? -1 : r * this.cols + c;
  }

  /** A teammate saw `enemy`. */
  report(team, enemy, now) {
    const b = this.boards[team];
    let s = b.seen.get(enemy);
    if (!s) b.seen.set(enemy, (s = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), t: -99 }));
    s.pos.copy(enemy.pos);
    s.vel.copy(enemy.vel ?? _a.set(0, 0, 0));
    s.t = now;
    this.#mark(team, enemy.pos.x, enemy.pos.z, 0.15);
  }

  /** A member of `team` died at pos: that ground is dangerous for a while. */
  died(team, pos) { this.#mark(team, pos.x, pos.z, 1); }

  #mark(team, x, z, amount) {
    const d = this.boards[team].danger;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const k = this.#cell(x + dx * CELL, z + dz * CELL);
        if (k >= 0) d[k] = Math.min(3, d[k] + amount * (dx || dz ? 0.4 : 1));
      }
    }
  }

  danger(team, x, z) { const k = this.#cell(x, z); return k < 0 ? 0 : this.boards[team].danger[k]; }

  /** Fresh sightings for `team`: [{ enemy, pos, vel, t }], newest first. */
  known(team, now = this.world.now, out = []) {
    out.length = 0;
    for (const [enemy, s] of this.boards[team].seen) if (enemy.alive && now - s.t < INTEL_TTL) out.push({ enemy, ...s });
    return out.sort((a, b) => b.t - a.t);
  }

  /** Path cost added for walking through (x, z): ground where the team has been dying. */
  costFor(team) { return (x, z) => this.danger(team, x, z) * 2.5; }

  update(dt, now) {
    this.budget = 3;
    const k = Math.pow(0.5, dt / DANGER_HALF);
    for (const b of Object.values(this.boards)) {
      const d = b.danger;
      for (let i = 0; i < d.length; i++) d[i] *= k;
      for (const [e, s] of b.seen) if (!e.alive || now - s.t > INTEL_TTL * 2) b.seen.delete(e);
    }
  }
}
