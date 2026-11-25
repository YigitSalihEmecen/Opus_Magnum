import { PALETTE as P } from '../../../core/toon.js';
import { assetById } from '../assets.js';
import { segFor, heightAt } from '../terrain.js';

/*
  "Saltgrass" — a dense little city in a bowl of hills, 192 × 192 m.

     hills ─────────────────────────────────────────────────────── hills
       │  ╭──────────────── ring road (wide bends) ───────────────╮  │
       │  │  TOWERS + bridges │ CIVIC TERRACE + tower │ SHOP STREET  │  │
  ally ═══╡──────────────── 20 ──────────────────────────────────────╞═══ enemy
  spawn   │  MOTEL BLOCK      │  PARK (mound, cover)  │ INDUSTRIAL   │   spawn
       │  │──────────────── -20 ─────────────────────────────────────│  │
       │  │  HOUSES (gabled)  │ TERRACES + towers     │ HIGH-RISE    │  │
       │  ╰──────────────────────────────────────────────────────────╯  │
     hills ─────────────────────────────────────────────────────── hills

  Cross streets at ±20 inside a ring road at ±64 with bends at the corners; each 36 m block has a sidewalk ring around a 28 m
  core (two 12 m lots, a 4 m alley). Height comes from towers (3–5 storeys, roof access), podium
  terraces, walkway bridges at the third floor, the park mound and the hills outside the ring.
*/

const SIZE = 192, HALF = SIZE / 2;
const BLOCKS = [-40, 0, 40];
const s = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

function ground(x, z) {
  const d = Math.max(Math.abs(x), Math.abs(z));
  // hills outside the ring, with a flat cutting for the two exit roads along z = 0
  const hills = s(66, 92, d) * (6 + 2.5 * Math.sin(x * 0.07) * Math.cos(z * 0.05)) * (Math.abs(x) > Math.abs(z) ? s(5, 16, Math.abs(z)) : 1);
  // a grassy mound in the central park
  const r = Math.hypot(x - 2, z + 1) / 11;
  const mound = r < 1 ? 2.6 * (1 - r * r) ** 2 : 0;
  return hills + mound;
}

export function settlement() {
  const seg = segFor(SIZE), n = seg + 1, step = SIZE / seg;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = Math.round(ground(-HALF + i * step, -HALF + j * step) * 100) / 100;
  const gy = (x, z) => Math.round(heightAt(h, SIZE, x, z) * 20) / 20;

  const pieces = [];
  const put = (type, x, z, rot = 0, y = 0, color) => pieces.push({ type, x, y, z, rot, color: color ?? assetById(type).colors[0] });
  const onGround = (type, x, z, rot = 0, color, sink = 0) => put(type, x, z, rot, gy(x, z) - sink, color);

  // ── roads: ring at ±64 with bends at the corners, cross streets, exit roads ──
  for (let t = -52; t <= 52; t += 4) for (const e of [-64, 64]) { put('road', e, t); put('road', t, e); }
  const bends = [[-60, -60, 0], [60, -60, 270], [60, 60, 180], [-60, 60, 90]];
  for (const [x, z, r] of bends) put('road_curve', x, z, r);
  const bendCentres = [[-54, -54], [54, -54], [54, 54], [-54, 54]]; // each bend sweeps 8…12 m around these
  for (const c of [-20, 20]) for (let t = -60; t <= 60; t += 4) { if (Math.abs(t) !== 20) put('road', c, t); put('road', t, c); }
  for (let x = 68; x <= 92; x += 4) { put('road', -x, 0); put('road', x, 0); }

  // ── sidewalks: a ring round every block, and a promenade inside the ring road (clear of the bends) ──
  const clearOfBends = (x, z) => bendCentres.every(([cx, cz]) => { const d = Math.hypot(x - cx, z - cz); return d + 2.9 < 8 || d - 2.9 > 12; });
  for (const bx of BLOCKS) for (const bz of BLOCKS) {
    for (let t = -16; t <= 16; t += 4) {
      put('sidewalk', bx + t, bz - 16); put('sidewalk', bx + t, bz + 16);
      if (Math.abs(t) !== 16) { put('sidewalk', bx - 16, bz + t); put('sidewalk', bx + 16, bz + t); }
    }
  }
  const promenade = new Set();
  for (let t = -60; t <= 60; t += 4) {
    if (Math.abs(t) === 20) continue; // cross streets run through here
    for (const [x, z] of [[t, -60], [t, 60], [-60, t], [60, t]]) promenade.add(`${x},${z}`);
  }
  for (const key of promenade) {
    const [x, z] = key.split(',').map(Number);
    if (clearOfBends(x, z)) put('sidewalk', x, z);
  }

  const lot = (bx, bz, qx, qz) => [bx + qx * 8, bz + qz * 8]; // 12 m lot centres in a block core

  /**
   * Favela / cyberpunk stack filling a 28 m block core (7 × 7 cells of 4 m) at base height y0.
   * Heights are smoothed noise; colours come in small groups so each group reads as one building.
   * Two dead-end alleys get stairs up to the building at their end; some terraces get stairs up to a
   * doorway in a taller neighbour.
   */
  const stack = (bx, bz, sd, { maxH = 5, minH = 1, y0 = 0, palette = [P.manilla, P.sky, P.sage, P.kraft, P.clay, P.ivory, P.bookcloth, P.oat] } = {}) => {
    let st = sd;
    const r = () => (st = (st * 16807) % 2147483647) / 2147483647;
    const N = 7, cx = (i) => bx - 12 + 4 * i, cz = (j) => bz - 12 + 4 * j;
    const raw = [...Array(N)].map(() => [...Array(N)].map(() => r()));
    const hgt = raw.map((row, i) => row.map((v, j) => {
      let sum = 0, n = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (raw[i + a]?.[j + b] !== undefined) { sum += raw[i + a][j + b]; n++; }
      const t = (sum / n) * 0.55 + v * 0.45;
      return Math.max(minH, Math.min(maxH, Math.round(minH + t ** 1.4 * (maxH - minH + 0.9))));
    }));
    const colAlley = 4, rowAlley = 2;
    for (let j = 0; j < N - 1; j++) hgt[colAlley][j] = 0;          // N–S alley, dead end at the south row
    for (let i = 1; i < N; i++) hgt[i][rowAlley] = 0;               // E–W alley, dead end at the west column
    hgt[1 + Math.floor(r() * 2)][5] = 0;                            // a courtyard
    hgt[colAlley][N - 1] = Math.max(2, hgt[colAlley][N - 1]);
    hgt[0][rowAlley] = Math.max(2, hgt[0][rowAlley]);
    // a staircase spine up the west edge: paired roofs stepping up a storey every 8 m
    const spine = [1, 1, 2, 2, 3, 3, 4].map((v) => Math.min(maxH, v));
    for (let j = 0; j < N; j++) hgt[0][j] = spine[j];
    // colour groups: 2 × 2 patches with some merges
    const groups = [...Array(N)].map((_, i) => [...Array(N)].map((_, j) => palette[(Math.floor(i / 2) * 3 + Math.floor(j / 2) * 5 + Math.floor(r() * 1.4)) % palette.length]));
    const rec = new Map(); // `${i},${j},${k}` → record
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let k = 0; k < hgt[i][j]; k++) {
      put('room', cx(i), cz(j), 0, y0 + k * 3.5, groups[i][j]);
      rec.set(`${i},${j},${k}`, pieces.at(-1));
    }
    const addTo = (i, j, k, field, side) => { const p = rec.get(`${i},${j},${k}`); if (p) p[field] = (p[field] ?? '') + side; };
    // alley stairs up to the dead-end building: a doorway on its first floor (or an open roof edge)
    put('stairs', cx(colAlley), cz(N - 1) - 2 - 3, 180, y0, P.slate); // centred: lands square on the doorway
    if (hgt[colAlley][N - 1] >= 2) addTo(colAlley, N - 1, 1, 'door', 'N'); else addTo(colAlley, N - 1, 0, 'open', 'N');
    put('stairs', cx(0) + 2 + 3, cz(rowAlley), 90, y0, P.slate);
    if (hgt[0][rowAlley] >= 2) addTo(0, rowAlley, 1, 'door', 'E'); else addTo(0, rowAlley, 0, 'open', 'E');
    // terrace stairs: two equal roofs in a line, then a neighbour at least two storeys taller
    // spine stairs first (they guarantee a way to the top), then any other terraces, lowest roofs first
    const used = new Set();
    const climb = (i, j, di, dj, back, rot) => {
      const hA = hgt[i][j], hC = hgt[i + di]?.[j + dj];
      if (hA < 1 || hgt[i - di]?.[j - dj] !== hA || !(hC >= hA + 1)) return false;
      const cells = [`${i},${j}`, `${i - di},${j - dj}`];
      if (cells.some((c) => used.has(c))) return false;
      cells.forEach((c) => used.add(c));
      // stairs end at the A–C boundary (square on C's doorway / roof gap) and run back across A into B
      put('stairs_open', cx(i) + di * 2 - di * 3, cz(j) + dj * 2 - dj * 3, rot, y0 + hA * 3.5, P.slate); // no rails: the roof beside it stays walkable
      if (hC === hA + 1) addTo(i + di, j + dj, hA, 'open', back); else addTo(i + di, j + dj, hA + 1, 'door', back);
      for (const [a, c] of [[i, j], [i - di, j - dj]]) { const top = rec.get(`${a},${c},${hA - 1}`); if (top) top.clear = true; }
      return true;
    };
    addTo(0, rowAlley, 1, 'door', 'N'); // the alley stair's landing room opens onto the spine's first terrace
    for (const j of [1, 3, 5]) climb(0, j, 0, 1, 'N', 180);
    // lowest roofs first, so each storey's terraces lead on to the next one up
    const dirs = [[0, 1, 'S', 'N', 180], [0, -1, 'N', 'S', 0], [1, 0, 'E', 'W', 270], [-1, 0, 'W', 'E', 90]];
    const cands = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const hA = hgt[i][j];
      if (hA < 1) continue;
      for (const d of dirs) {
        const [di, dj] = d;
        if (hgt[i - di]?.[j - dj] === hA && hgt[i + di]?.[j + dj] >= hA + 1) cands.push({ i, j, hA, d, k: r() });
      }
    }
    cands.sort((a, b) => a.hA - b.hA || a.k - b.k);
    let placed = 0;
    for (const { i, j, d: [di, dj, , back, rot] } of cands) {
      if (placed >= 12) break;
      if (climb(i, j, di, dj, back, rot)) placed++;
    }  };


  // ── NW: hillside-style favela — the densest stack, five storeys at the peaks ──
  stack(-40, -40, 11, { maxH: 5 });

  // ── N: civic terrace — four podiums, the gaps decked over, water tower on top ──
  {
    const [bx, bz] = [0, -40];
    for (const qx of [-1, 1]) for (const qz of [-1, 1]) put('podium', ...lot(bx, bz, qx, qz), qx < 0 ? 0 : 180, 0, P.manilla);
    // deck over the cross-shaped gap between the four podiums
    for (const t of [-12, -8, -4, 4, 8, 12]) { put('floor', bx, bz + t, 0, 3.2, P.oat); put('floor', bx + t, bz, 0, 3.2, P.oat); }
    put('floor', bx, bz, 0, 3.2, P.oat);
    put('tower', bx, bz - 8, 0, 3.5, P.sky);
    put('tree', bx - 9, bz + 9, 0, 3.5, P.sage);
    put('tree', bx + 9, bz - 10, 0, 3.5, P.olive);
    put('bench', bx + 3, bz + 6, 0, 3.5, P.kraft);
    put('bench', bx - 6, bz - 3, 90, 3.5, P.kraft);
    put('sandbags', bx + 5, bz + 2, 0, 3.5, P.kraft);
    put('lamp', bx + 6, bz + 10, 0, 3.5, P.slate);
  }

  // ── NE: neon stack — taller and greyer, billboards and masts on the roofs ──
  stack(40, -40, 23, { maxH: 6, minH: 2, palette: [P.slate, P.oat, P.sky, P.ivory, P.cloud, P.bookcloth] });

  // ── W: low market stack, mostly two storeys, lots of shopfronts ──
  stack(-40, 0, 37, { maxH: 3 });

  // ── centre: park on a mound, low cover, two kiosks ──
  {
    const [bx, bz] = [0, 0];
    for (const [x, z, c] of [[-10, -9, P.sage], [10, -10, P.olive], [-11, 9, P.olive], [9, 11, P.sage], [-4, 11, P.sage], [12, 2, P.olive]]) onGround('tree', bx + x, bz + z, 0, c);
    for (const [x, z] of [[-6, -4], [6, 6], [-9, 3], [4, -9], [11, -4]]) onGround('bush', bx + x, bz + z, 0, P.olive);
    for (const [x, z, r] of [[-3, 6, 30], [7, -3, 200], [-8, -10, 120]]) onGround('rock', bx + x, bz + z, r, P.cloud, 0.3);
    onGround('sandbags', bx - 2, bz - 7, 0, P.kraft);
    onGround('sandbags', bx + 7, bz + 4, 90, P.kraft);
    onGround('bench', bx - 12, bz - 2, 90, P.kraft);
    onGround('bench', bx + 1, bz + 12, 0, P.kraft);
  }

  // ── E: industrial yard ──
  {
    const [bx, bz] = [40, 0];
    put('warehouse', bx - 4, bz - 6, 0, 0, P.sage);
    put('container', bx - 6, bz + 7, 0, 0, P.clay);
    put('container', bx - 6, bz + 7, 90, 2.6, P.sky);
    put('container', bx + 5, bz + 10, 0, 0, P.sage);
    put('container', bx + 11, bz + 3, 90, 0, P.kraft);
    for (const [x, z, r] of [[1, 5, 0], [2.3, 5.4, 25], [1.5, 6.2, 0]]) put('crate', bx + x, bz + z, r);
    put('crate', bx + 1.6, bz + 5.5, 0, 1.2);
    for (const [x, z] of [[8, -12], [8.8, -11.2]]) put('barrel', bx + x, bz + z, 0, 0, P.clay);
    for (const x of [-12, -8, 0, 4, 8, 12]) put('fence', bx + x, bz + 14, 0, 0, P.slate);
    put('van', bx + 9, bz - 4, 90, 0, P.ivory);
    put('sandbags', bx - 12, bz + 12, 0, 0, P.kraft);
  }

  // ── SW: colourful stack climbing to four storeys ──
  stack(-40, 40, 53, { maxH: 4, palette: [P.clay, P.sky, P.sage, P.manilla, P.kraft, P.bookcloth, P.ivory] });

  // ── S: terraces with towers on top ──
  {
    const [bx, bz] = [0, 40];
    put('podium', ...lot(bx, bz, -1, -1), 0, 0, P.oat);
    put('podium', ...lot(bx, bz, 1, -1), 180, 0, P.oat);
    put('tower3', ...lot(bx, bz, -1, 1), 0, 0, P.ivory);
    put('shoprow', bx + 8, bz + 10, 0, 0, P.manilla);
    put('house', bx - 8, bz - 8, 0, 3.5, P.sky);
    put('tree', bx + 8, bz - 8, 0, 3.5, P.olive);
    put('walkway', bx, bz - 10, 0, 3.5, P.oat);
    put('walkway', bx, bz - 6, 0, 3.5, P.oat);
    put('sandbags', bx + 9, bz - 4, 90, 3.5, P.kraft);
    put('dumpster', bx + 9, bz + 2, 0, 0, P.sky);
  }

  // ── SE: high-rise quarter ──
  {
    const [bx, bz] = [40, 40];
    const cols = [P.slate, P.oat, P.sky, P.ivory];
    [[-1, -1, 'tower5'], [1, -1, 'tower3'], [-1, 1, 'tower3'], [1, 1, 'tower5']].forEach(([qx, qz, t], i) => put(t, ...lot(bx, bz, qx, qz), 0, 0, cols[i]));
    for (const qz of [-1, 1]) put('walkway', bx, bz + qz * 8 - 4, 0, 7.0, P.slate);
    put('dumpster', bx, bz + 1.5, 90, 0, P.clay);
  }

  // ── street furniture ──
  for (const c of [-20, 20]) for (const t of [-48, -32, 32, 48]) { put('lamp', c - 2.6, t, 270, 0, P.slate); put('lamp', t, c + 2.6, 0, 0, P.slate); }
  for (const [x, z, r] of [[-20, 6, 0], [20, -6, 0], [6, 20, 90], [-6, -20, 90]]) put('jersey', x, z, r, 0, P.ivory);

  // ── outer band: a row of buildings facing the ring road, climbing the first slope of the hills ──
  {
    const kinds = ['house', 'shoprow', 'house', 'warehouse', 'house', 'shoprow', 'tower3', 'house'];
    const cols = [P.ivory, P.manilla, P.sage, P.sky, P.kraft, P.oat];
    let i = 0;
    for (const side of ['N', 'S', 'W', 'E']) {
      for (let t = -44; t <= 44; t += 16) {
        const kind = kinds[i % kinds.length];
        const depth = kind === 'warehouse' ? 12 : kind === 'house' ? 8 : kind === 'tower3' ? 12 : 8;
        const off = 66 + 2 + depth / 2; // just past the ring road's outer edge
        if ((side === 'W' || side === 'E') && Math.abs(t) < 10) { i++; continue; } // exit road
        const [x, z, rot] = side === 'N' ? [t, -off, 0] : side === 'S' ? [t, off, 180] : side === 'W' ? [-off, t, 90] : [off, t, 270];
        // buildings face the ring: front (south side of the prefab) turned toward the city
        onGround(kind, x, z, rot, cols[i % cols.length], 0.1);
        i++;
      }
    }
  }

  // ── outskirts: houses on the hillside, pines, rocks, a few wrecks ──
  for (const [x, z, r] of [[-88, -36, 90], [-88, -22, 90], [-88, 30, 90], [88, 34, 270], [36, -88, 0], [-36, 88, 180], [6, 88, 180]]) onGround('house', x, z, r, pick([P.ivory, P.manilla, P.sage, P.sky], x + z), 0.2);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 70; i++) {
    const a = rnd() * Math.PI * 2, r = 82 + rnd() * 12;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.abs(x) > HALF - 3 || Math.abs(z) > HALF - 3) continue;
    if (Math.abs(z) < 8 && Math.abs(x) > 60) continue; // keep the exit roads clear
    onGround(rnd() < 0.6 ? 'pine' : rnd() < 0.5 ? 'tree' : 'rock', x, z, Math.round(rnd() * 360), rnd() < 0.5 ? P.olive : P.sage, 0.25);
  }
  put('sedan', -74, -4.5, 90, 0, P.slate);
  put('pickup', 76, 4.5, 270, 0, P.clay);

  // ── spawns at the ends of the exit roads ──
  for (const [x, z] of [[-90, -2], [-90, 2], [-86, -2], [-86, 2]]) put('spawn_ally', x, z, 270, gy(x, z));
  for (const [x, z] of [[90, -2], [90, 2], [86, -2], [86, 2]]) put('spawn_enemy', x, z, 90, gy(x, z));

  return { id: 'builtin-saltgrass', builtin: true, name: 'Saltgrass', size: SIZE, updated: 0, pieces, terrain: { seg, h: Array.from(h) } };
}

const pick = (list, i) => list[Math.abs(Math.round(i)) % list.length];
