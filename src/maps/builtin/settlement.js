import { PALETTE as P } from '../../core/toon.js';
import { assetById } from '../assets.js';
import { segFor, heightAt } from '../terrain.js';

/*
  "Saltgrass" — a packed, vertical hill town, 128 × 128 m.

  An avenue (east–west, the two team entrances) and a cross street split the core into four blocks.
  Each block is a two-storey base of stacked rooms whose joined roofs make a raised DECK — a second
  ground level at 7 m — with L-, U- and tower-shaped buildings standing on it. Under the deck runs a
  covered alley; an open courtyard and a stair court (two flights, street → landing → deck) are cut into
  it. Walkway bridges tie the four decks together over the streets, so you can cross the town without
  touching the street. Hills and terraced houses close the town in.

        hills · houses · pines
      ┌──────────┬──────────┐
      │  BLOCK   ┆  BLOCK   │   ┆ = bridge at deck height
  ═══ │ ▤ court  ┆ court ▤  │ ═══ avenue (spawns at both ends)
      │  BLOCK   ┆  BLOCK   │
      └──────────┴──────────┘
        hills · houses · pines

  Block grid (local): 10 cells across (i, away from the cross street) × 8 deep (j, away from the
  avenue), 4 m each; cell (i, j) sits at x = sx·(8 + 4i), z = sz·(8 + 4j).
*/

const SIZE = 128, HALF = SIZE / 2, ST = 3.5;
const sm = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

function ground(x, z) {
  const edge = Math.max(Math.abs(x) / 48, Math.abs(z) / 41);
  const hills = sm(1, 1.3, edge) * (5.5 + 2 * Math.sin(x * 0.11) * Math.cos(z * 0.09));
  const valley = Math.abs(x) > 46 ? sm(4, 12, Math.abs(z)) : 1; // flat cutting for the avenue's ends
  return hills * valley;
}

/** Upper buildings on each block's deck: cells (i, j) and storeys above the deck. Shapes per quadrant. */
const UPPER = [
  [
    { cells: [[0, 4], [0, 5], [0, 6], [0, 7], [1, 7], [2, 7]], h: 3, color: P.clay },              // L
    { cells: [[5, 4], [6, 4], [7, 4], [5, 5], [5, 6], [7, 5], [7, 6]], h: 2, color: P.sky },       // U
    { cells: [[8, 6], [9, 6], [8, 7], [9, 7]], h: 4, color: P.oat },                              // tower
    { cells: [[1, 1], [2, 1], [2, 2]], h: 1, color: P.sage },                                     // small L
  ],
  [
    { cells: [[0, 5], [1, 5], [2, 5], [0, 6], [0, 7]], h: 2, color: P.manilla },                  // L
    { cells: [[5, 5], [6, 5], [7, 5], [5, 6], [5, 7], [6, 7], [7, 7]], h: 3, color: P.bookcloth }, // U, open east
    { cells: [[8, 0], [9, 0], [9, 1]], h: 4, color: P.slate },
    { cells: [[2, 2], [2, 3]], h: 2, color: P.ivory },
  ],
  [
    { cells: [[1, 6], [2, 6], [3, 6], [1, 7], [3, 7]], h: 3, color: P.sage },                     // U
    { cells: [[6, 4], [6, 5], [6, 6], [7, 6], [8, 6]], h: 2, color: P.kraft },                    // L
    { cells: [[9, 3], [9, 4], [8, 3]], h: 4, color: P.sky },
    { cells: [[0, 1], [1, 1]], h: 1, color: P.clay },
  ],
  [
    { cells: [[0, 4], [1, 4], [0, 5], [0, 6]], h: 4, color: P.oat },                              // tall L
    { cells: [[5, 6], [6, 6], [7, 6], [5, 7], [7, 7]], h: 2, color: P.sage },                     // U
    { cells: [[8, 4], [9, 4], [9, 5]], h: 3, color: P.clay },
    { cells: [[2, 1], [2, 2]], h: 1, color: P.manilla },
  ],
];
const BASES = [[P.manilla, P.ivory, P.kraft], [P.ivory, P.sky, P.oat], [P.kraft, P.manilla, P.sage], [P.oat, P.bookcloth, P.ivory]];

export function settlement() {
  const seg = segFor(SIZE), n = seg + 1, step = SIZE / seg;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = Math.round(ground(-HALF + i * step, -HALF + j * step) * 100) / 100;
  const gy = (x, z) => Math.round(heightAt(h, SIZE, x, z) * 20) / 20;

  const pieces = [];
  const put = (type, x, z, rot = 0, y = 0, color) => { pieces.push({ type, x, y, z, rot, color: color ?? assetById(type).colors[0] }); return pieces.at(-1); };
  const onGround = (type, x, z, rot = 0, color, sink = 0) => put(type, x, z, rot, gy(x, z) - sink, color);

  // ── streets ──
  for (let x = -60; x <= 60; x += 4) put('road', x, 0);
  for (let z = 4; z <= 36; z += 4) { put('road', 0, z); put('road', 0, -z); }
  for (let t = 4; t <= 44; t += 4) for (const s of [-1, 1]) { put('sidewalk', s * t, 4); put('sidewalk', s * t, -4); }
  for (let t = 8; t <= 36; t += 4) for (const s of [-1, 1]) { put('sidewalk', 4, s * t); put('sidewalk', -4, s * t); }

  // ── the four blocks ──
  let qi = 0;
  for (const sz of [-1, 1]) for (const sx of [-1, 1]) block(sx, sz, qi++);

  function block(sx, sz, q) {
    const W = 10, D = 8;
    const X = (i) => sx * (8 + 4 * i), Z = (j) => sz * (8 + 4 * j);
    const sideOf = (di, dj) => (di ? (di * sx > 0 ? 'E' : 'W') : dj * sz > 0 ? 'S' : 'N'); // local step → world side
    const stairRot = (di, dj) => { const wx = di * sx, wz = dj * sz; return wz > 0 ? 180 : wz < 0 ? 0 : wx > 0 ? 270 : 90; }; // rising toward (di, dj)
    const baseColor = (i) => BASES[q][i < 4 ? 0 : i < 7 ? 1 : 2];

    // storeys present per cell: the base is storeys 0 and 1, its roof is the deck
    const lv = [...Array(W)].map(() => [...Array(D)].map(() => new Set([0, 1])));
    const color = [...Array(W)].map((_, i) => [...Array(D)].map(() => baseColor(i)));
    const court = [[3, 0], [3, 1], [3, 2], [3, 3], [4, 0], [4, 1], [4, 2], [4, 3]];
    const yard = [[7, 1], [8, 1], [7, 2], [8, 2]];
    for (const [i, j] of [...court, ...yard]) lv[i][j].clear();
    for (let i = 0; i < W; i++) lv[i][5].delete(0); // covered alley under the deck
    for (const b of UPPER[q]) for (const [i, j] of b.cells) { for (let k = 2; k < 2 + b.h; k++) lv[i][j].add(k); color[i][j] = b.color; }
    const top = (i, j) => (lv[i]?.[j]?.size ? Math.max(...lv[i][j]) + 1 : 0); // storeys up to the roof

    const rec = new Map();
    for (let i = 0; i < W; i++) for (let j = 0; j < D; j++) for (const k of lv[i][j]) {
      rec.set(`${i},${j},${k}`, put('room', X(i), Z(j), 0, k * ST, k >= 2 ? color[i][j] : baseColor(i)));
    }
    const mark = (i, j, k, field, side) => { const p = rec.get(`${i},${j},${k}`); if (p) p[field] = (p[field] ?? '') + side; };
    // deck-level roofs are plazas: curated props instead of random roof clutter
    for (let i = 0; i < W; i++) for (let j = 0; j < D; j++) if (top(i, j) === 2) { const p = rec.get(`${i},${j},1`); if (p) p.clear = true; }

    // ── stair court: street → landing (3.5) → deck (7) ──
    put('stairs', X(3), sz * (6 + 3), stairRot(0, 1), 0, P.oat);
    put('floor', X(3), sz * (6 + 8), 0, ST, P.oat);
    put('floor', X(4), sz * (6 + 8), 0, ST, P.oat);
    put('stairs', X(4), sz * (6 + 13), stairRot(0, 1), ST, P.oat);
    for (const z of [12.4, 15.6]) put('pillar', (X(3) + X(4)) / 2, sz * z, 0, 0, P.oat); // the landing's open span
    if (top(4, 4) > 2) mark(4, 4, 2, 'door', sideOf(0, -1)); else mark(4, 4, 1, 'open', sideOf(0, -1));
    put('dumpster', X(4) + sx * 0.2, sz * 8.5, 90, 0, P.sage);
    put('crate', X(4) - sx * 1, sz * 11.2, 15);
    put('barrel', X(3) + sx * 1.3, sz * 18.5, 0, 0, P.clay);

    // ── courtyard: open to the sky, a tree and somewhere to sit ──
    const yx = (X(7) + X(8)) / 2, yz = (Z(1) + Z(2)) / 2;
    put('tree', yx, yz, 0, 0, P.sage);
    put('bench', yx + sx * 2.6, yz, 90, 0, P.kraft);
    put('bush', yx - sx * 2.6, yz - sz * 2.4, 0, 0, P.olive);
    put('barrel', yx - sx * 2.8, yz + sz * 2.8, 0, 0, P.sky);
    put('planter', yx, yz + sz * 2.9, 0, 0, P.ivory);

    // ── covered alley (row 5): crates and bins in the run under the deck ──
    put('dumpster', X(1), Z(5), 0, 0, P.slate);
    put('crate', X(6) + sx * 0.8, Z(5) - sz * 0.9, 0);
    put('crate', X(6) + sx * 0.8, Z(5) - sz * 0.9, 20, 1.2);
    put('barrel', X(8), Z(5) + sz * 1.2, 0, 0, P.clay);

    // ── terrace stairs up to the buildings on the deck (lowest roofs first) ──
    const used = new Set(['0,2', '1,0', '4,4']); // bridge landings and the stair court's top stay clear
    const climb = (i, j, di, dj) => {
      const hA = top(i, j), hB = top(i - di, j - dj), hC = top(i + di, j + dj);
      if (hA < 2 || hB !== hA || !(hC >= hA + 1)) return false;
      if (!lv[i][j].has(hA - 1) || !lv[i - di][j - dj].has(hA - 1)) return false;
      const cells = [`${i},${j}`, `${i - di},${j - dj}`];
      if (cells.some((c) => used.has(c))) return false;
      cells.forEach((c) => used.add(c));
      const ex = X(i) + sx * di * 2, ez = Z(j) + sz * dj * 2;
      put('stairs_open', ex - sx * di * 3, ez - sz * dj * 3, stairRot(di, dj), hA * ST, P.cloud);
      const back = sideOf(-di, -dj);
      // the flight tops out one storey above A's roof: onto C's roof, or through a door into C
      if (hC === hA + 1) mark(i + di, j + dj, hA, 'open', back); else mark(i + di, j + dj, hA + 1, 'door', back);
      return true;
    };
    const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
    const cands = [];
    for (let i = 0; i < W; i++) for (let j = 0; j < D; j++) for (const [di, dj] of dirs) cands.push({ i, j, di, dj, hA: top(i, j), k: Math.sin(i * 7.1 + j * 3.3 + q) });
    cands.sort((a, b) => a.hA - b.hA || a.k - b.k);
    let placed = 0;
    for (const c of cands) if (placed < 7 && climb(c.i, c.j, c.di, c.dj)) placed++;

    // ── deck plazas: planters, benches, lamps, cover ──
    let n = 0;
    for (let i = 0; i < W; i++) for (let j = 0; j < D; j++) {
      if (top(i, j) !== 2 || used.has(`${i},${j}`)) continue;
      const x = X(i), z = Z(j), y = 2 * ST, r = (i * 13 + j * 7 + q * 5) % 12;
      if (r === 0) put('tree', x, z, 0, y, P.olive);
      else if (r === 1) put('canopy', x, z, sz > 0 ? 0 : 180, y, [P.clay, P.sky, P.sage][(i + j + q) % 3]);
      else if (r === 3) put('planter', x, z, (i + j) % 2 ? 90 : 0, y, P.oat);
      else if (r === 6) put('stall', x, z, sz > 0 ? 180 : 0, y, [P.sky, P.clay, P.sage][(i + q) % 3]);
      else if (r === 2) put('bench', x, z + sz * 1.2, 0, y, P.kraft);
      else if (r === 4) put('sandbags', x, z, (n++ % 2) * 90, y, P.kraft);
      else if (r === 5) put('lamp', x + sx * 1.6, z, sx > 0 ? 90 : 270, y, P.slate);
      else if (r === 7) { put('crate', x - 0.6, z, 0, y); put('barrel', x + 0.9, z + 0.6, 0, y, P.sky); }
      else if (r === 8) put('bush', x, z, 0, y, P.sage);
    }

    // street-side dressing at ground level
    put('lamp', X(1), sz * 5.4, sz > 0 ? 0 : 180, 0, P.slate);
    put('lamp', X(7), sz * 5.4, sz > 0 ? 0 : 180, 0, P.slate);
    put('lamp', sx * 5.4, Z(6), sx > 0 ? 90 : 270, 0, P.slate);
    put('jersey', X(9) + sx * 2, sz * 4.6, 0, 0, P.oat);
    for (const x of [30, 40]) put('stall', sx * x, sz * 4.9, sz > 0 ? 0 : 180, 0, [P.clay, P.sky, P.sage, P.kraft][(q + x / 10) % 4]);
    put('stall', sx * 4.9, Z(5) + sz * 0.4, sx > 0 ? 90 : 270, 0, [P.sage, P.clay, P.sky, P.kraft][q]);
    put('planter', sx * 5, sz * 37, 90, 0, P.oat);
  }

  // ── bridges at deck height, over the cross street and the avenue ──
  /** Remove the parapet (or add a door, if a building stands there) where a bridge meets a deck cell. */
  const openDeck = (sx, sz, i, j, side) => {
    const x = sx * (8 + 4 * i), z = sz * (8 + 4 * j);
    const deck = pieces.find((r) => r.type === 'room' && r.x === x && r.z === z && Math.abs(r.y - ST) < 0.01);
    const above = pieces.find((r) => r.type === 'room' && r.x === x && r.z === z && Math.abs(r.y - 2 * ST) < 0.01);
    if (above) above.door = (above.door ?? '') + side; else if (deck) deck.open = (deck.open ?? '') + side;
  };
  for (const sz of [-1, 1]) {
    for (const x of [-4, 0, 4]) put('walkway', x, sz * 16, 0, 2 * ST, P.oat);
    openDeck(-1, sz, 0, 2, 'E');
    openDeck(1, sz, 0, 2, 'W');
  }
  for (const sx of [-1, 1]) {
    for (const z of [-4, 0, 4]) put('walkway', sx * 12, z, 90, 2 * ST, P.oat);
    openDeck(sx, -1, 1, 0, 'S');
    openDeck(sx, 1, 1, 0, 'N');
  }

  // ── avenue ends: cover and wrecks at the entrances ──
  for (const s of [-1, 1]) {
    put('sedan', s * 50, -1.2, 90 + s * 10, 0, s < 0 ? P.slate : P.clay);
    put('sandbags', s * 54, 2.8, 90, 0, P.kraft);
    put('jersey', s * 47, 1.6, 90, 0, P.ivory);
    put('pickup', s * 30, 1.4, 270, 0, s < 0 ? P.sage : P.sky);
  }
  for (const s of [-1, 1]) {
    put('container', s * 62.6, -3.1, 90, 0, s < 0 ? P.sky : P.clay);
    put('container', s * 62.6, 3.1, 90, 0, s < 0 ? P.sage : P.kraft);
    put('container', s * 62.6, 0.2, 86, 2.4, s < 0 ? P.clay : P.sky);
    for (const x of [-2, 2]) put('jersey', x, s * 39.2, 0, 0, P.oat);
    for (const x of [49, 55, 61]) onGround('pole', -s * x, 7.2 * s, 0, P.kraft);
  }
  put('van', 2.4, -24, 0, 0, P.ivory);
  put('sedan', -1.4, 26, 180, 0, P.kraft);

  // ── outskirts: terraced houses on the slopes, pines and rocks ──
  const houses = [[-40, -50, 0], [-26, -52, 0], [-12, -51, 0], [14, -52, 0], [30, -50, 0], [-36, 52, 180], [-20, 53, 180], [10, 52, 180], [26, 54, 180], [42, 50, 180]];
  houses.forEach(([x, z, r], i) => {
    onGround('house', x, z, r, [P.ivory, P.manilla, P.sage, P.sky, P.kraft][i % 5], 0.15);
    const f = r === 0 ? 1 : -1; // front (door side) faces the town
    for (const dx of [-4, 4]) onGround('picket', x + dx, z + f * 6.5, 0, [P.ivory, P.kraft, P.sage][i % 3]);
    onGround('bush', x + 2.5, z + f * 5.2, 0, P.sage);
  });
  let seed = 19;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 46; i++) {
    const a = rnd() * Math.PI * 2, rad = 50 + rnd() * 12;
    const x = Math.cos(a) * rad * 1.05, z = Math.sin(a) * rad * 0.95;
    if (Math.abs(x) > HALF - 3 || Math.abs(z) > HALF - 3 || (Math.abs(z) < 7 && Math.abs(x) > 44)) continue;
    if (houses.some(([hx, hz]) => Math.hypot(hx - x, hz - z) < 7)) continue;
    const kind = rnd() < 0.6 ? 'pine' : rnd() < 0.5 ? 'tree' : 'rock';
    onGround(kind, x, z, Math.round(rnd() * 360), kind === 'rock' ? P.cloud : rnd() < 0.5 ? P.olive : P.sage, 0.25);
  }

  for (let i = 0; i < 34; i++) {
    const x = (rnd() * 2 - 1) * 44, z = (rnd() < 0.5 ? -1 : 1) * (40.5 + rnd() * 5);
    if (Math.abs(x) < 7 || houses.some(([hx, hz]) => Math.hypot(hx - x, hz - z) < 8)) continue;
    const bush = rnd() < 0.65;
    onGround(bush ? 'bush' : 'rock', x, z, Math.round(rnd() * 360), bush ? (rnd() < 0.5 ? P.sage : P.olive) : P.cloud, 0.1);
  }

  // ── spawns at the avenue's ends ──
  for (const [x, z] of [[-58, -1.5], [-58, 1.5], [-55, -1.5], [-55, 1.5]]) put('spawn_ally', x, z, 270, gy(x, z));
  for (const [x, z] of [[58, -1.5], [58, 1.5], [55, -1.5], [55, 1.5]]) put('spawn_enemy', x, z, 90, gy(x, z));

  return { id: 'builtin-saltgrass', builtin: true, name: 'Saltgrass', size: SIZE, updated: 0, pieces, terrain: { seg, h: Array.from(h) } };
}
