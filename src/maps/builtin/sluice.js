import { PALETTE as P } from '../../core/toon.js';
import { segFor } from '../terrain.js';

/*
  "Sluice" — a flooded lock basin, 48 × 28 m. The caveat: THE WATER KILLS. There is no ground, only piers,
  barges and gantries over deep water, so every jump is a commitment and a shove off an edge is a round.

  Each team holds a pier with a hut block whose roof is a lookout. Three ways across the 8 m channel:
    north  high road: catwalks from the hut roofs onto a shared gantry over the middle (3.5 m up)
    middle a container barge to hop onto (1 m up), then the central island and its container stack
    south  a wallrun: a tall lock wall runs along the open water to a low south platform; a plank links
           that platform to the island
  The sniper sits on the gantry, heavy armour on top of the container stack.

    z -12 ┌──────────── gantry (3.5 m) ────────────┐
          │ hut  ═catwalk═           ═catwalk═  hut │
          │ ▓▓ PIER A  ~ barge ~ [island] ~ barge ~ PIER B ▓▓
          │ ▓▓         ~~~~~~~~~  plank  ~~~~~~~~~      ▓▓ │
    z +12 │      ║wall║~~~~ south platform ~~~~║wall║    │
          └──────────────────────────────────────────┘
        x -24                                       +24
*/

const SIZE = 64, WATER = -1.6;

/** A deep basin under the water, rising to banks beyond the playfield. */
function terrain() {
  const seg = segFor(SIZE), h = [];
  for (let j = 0; j <= seg; j++) for (let i = 0; i <= seg; i++) {
    const x = -SIZE / 2 + 2 * i, z = -SIZE / 2 + 2 * j;
    const out = Math.max(Math.abs(x) - 26, Math.abs(z) - 16);
    h.push(out <= 0 ? -8 : Math.min(1.5, -8 + out * 4));
  }
  return { seg, h };
}

export function sluice() {
  const pieces = [];
  const put = (type, x, z, rot = 0, y = 0, color, extra) => pieces.push({ type, x, y, z, rot, color, ...extra });
  const dock = (x, z, color = P.oat) => put('dock', x, z, 0, 0, color);
  const stilt = (x, z, top) => put('stilt', x, z, 0, top, P.slate);

  // middle: the island with a container stack, and the shared gantry on stilts above the north water
  for (const x of [-2, 2]) for (const z of [-2, 2]) dock(x, z);
  put('container', 0, 0, 90, 0, P.ivory);
  for (const x of [-1.9, 1.9]) put('crate', x, x < 0 ? -1.2 : 1.2, 0, 0, P.kraft);
  for (const x of [-6, -2, 2, 6]) put('floor', x, -10, 0, 3.5, P.manilla);
  for (const x of [-6.6, 0, 6.6]) for (const z of [-11.4, -8.6]) stilt(x, z, 3.2);
  put('parapet', -2, -12, 0, 3.5, P.manilla);
  put('parapet', 2, -12, 0, 3.5, P.manilla);
  put('crate', 3, -9, 20, 3.5, P.sage);

  // south platform and the plank to the island
  for (const x of [-4, 0, 4]) dock(x, 10);
  put('floor_strip', 0, 6, 90, 0, P.kraft);
  put('jersey', 0, 11, 0, 0, P.ivory);

  // the lock wall along the south edge: one long face to wallrun along between the piers and the platform
  for (let x = -22; x <= 22; x += 4) put('seawall', x, 12.35, 0, 0, P.oat);

  for (const s of [-1, 1]) {
    const team = s < 0 ? P.sky : P.clay, inward = s < 0 ? 270 : 90;
    // pier: 12 × 16 of dock, plus a tongue along the lock wall
    for (const x of [14, 18, 22]) for (const z of [-6, -2, 2, 6]) dock(s * x, z);
    for (const x of [14, 18]) dock(s * x, 10);
    dock(s * 22, -10);
    // hut block along the back, doors on the water side; its roof is the lookout
    for (const z of [-10, -6, -2, 2, 6]) {
      const door = z === -2 || z === 6 ? (s < 0 ? 'E' : 'W') : '';
      const open = z === -10 || z === 2 ? (s < 0 ? 'E' : 'W') : ''; // catwalk and stairs reach the roof here
      put('room', s * 22, z, 0, 0, z === 2 ? team : P.ivory, { door, open });
    }
    put('stairs_open', s * 17, 2, s < 0 ? 90 : 270, 0, P.cloud);
    for (const z of [-2, 6]) put(s < 0 ? 'spawn_ally' : 'spawn_enemy', s * 22, z, inward);
    put(s < 0 ? 'spawn_ally' : 'spawn_enemy', s * 16, -5, inward);
    put(s < 0 ? 'spawn_ally' : 'spawn_enemy', s * 16, 6.5, inward);
    put('crate', s * 13.2, -6.6, 0, 0, team);
    put('sandbags', s * 13, 0, 90, 0, P.kraft);
    put('barrel', s * 14, 6.6, 0, 0, team);
    put('item_armour1', s * 15, -2);
    put('item_ammo', s * 18.5, -6.5);

    // north high road: catwalks from the hut roof's front corner to the gantry, on stilts
    for (const x of [10, 14, 18]) put('walkway', s * x, -10, 0, 3.5, P.slate);
    for (const x of [12, 16]) stilt(s * x, -10, 3.2); // under the deck slab, between the girders

    // middle: a container barge riding in the channel
    put('container', s * 8, -2, 0, WATER - 0.3, team);
    put('gun_snake', s * 8, -2, 0, WATER - 0.3 + 2.4);

    put('item_grenade', s * 4, 10);
    put('lamp', s * 12.7, -7.3, 0, 0, P.slate);
  }

  // prizes
  put('gun_kestrel', 0, -10, 0, 3.5);
  put('item_armour3', 0, 0, 0, 2.4);
  put('gun_grizzly', 0, -3.5);
  put('item_medkit', 0, 3.5);
  put('item_charger', 2.5, 9.4);

  return { id: 'builtin-sluice', builtin: true, online: true, name: 'Sluice', size: SIZE, updated: 0, water: WATER, pieces, terrain: terrain() };
}
