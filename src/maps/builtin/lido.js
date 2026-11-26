import { PALETTE as P } from '../../core/toon.js';
import { segFor } from '../terrain.js';

/*
  "Lido" — a walled villa courtyard around a drained pool, 48 × 40 inside a 64 m map. Two mirrored villas
  face each other across the pool (team A north, team B south); each has a lit ground floor, an upstairs
  room with a window on the pool, and roof terraces reached by an outside stair.

  The pool is the middle: crossing it is the short way, but you drop 1–2 m into the open. The diving board
  holds the sniper; heavy armour sits in the puddle at the deep end. The flanks go round the pool: a cabana
  and shade canopies on the west, a garden of planters and trees on the east.

    z -20 ┌──────────────── wall ────────────────┐
          │  terrace ▓▓ villa A ▓▓ terrace  (stairs)│
    z -10 │          guns · spawns              │
          │ cabana  ┌──── pool ────┐  garden    │
          │  ▤▤     │ shallow  deep═│   ♣ ▢ ♣    │
          │         └──────────────┘           │
    z +10 │          guns · spawns              │
          │  terrace ▓▓ villa B ▓▓ terrace      │
    z +20 └──────────────────────────────────────┘
        x -24                                 +24
*/

const SIZE = 64;
const SIDE = { a: P.sky, b: P.clay };

/** Flat, with the pool's pit dug out (see the pool asset: ±8 × ±4 down to -3). */
function terrain() {
  const seg = segFor(SIZE), h = [];
  for (let j = 0; j <= seg; j++) for (let i = 0; i <= seg; i++) {
    const x = -SIZE / 2 + 2 * i, z = -SIZE / 2 + 2 * j;
    h.push(Math.abs(x) <= 8 && Math.abs(z) <= 4 ? -3 : 0);
  }
  return { seg, h };
}

export function lido() {
  const pieces = [];
  const put = (type, x, z, rot = 0, y = 0, color, extra) => pieces.push({ type, x, y, z, rot, color, ...extra });

  // courtyard wall
  for (let x = -22; x <= 22; x += 4) for (const z of [-20, 20]) put('wall', x, z, 0, 0, Math.abs(x) < 4 ? P.ivory : P.manilla);
  for (let z = -18; z <= 18; z += 4) for (const x of [-24, 24]) put('wall', x, z, 90, 0, P.manilla);

  put('pool', 0, 0, 0, 0, P.sky);

  // s = -1: team A (north), +1: team B (south). Rooms face the pool on the side named `front`.
  for (const s of [-1, 1]) {
    const team = s < 0 ? SIDE.a : SIDE.b, front = s < 0 ? 'S' : 'N', back = s < 0 ? 'N' : 'S';
    const z = 16 * s;
    // villa: five rooms on the ground, three upstairs; the end rooms' roofs are terraces
    for (const x of [-8, -4, 0, 4, 8]) put('room', x, z, 0, 0, x === 0 ? team : P.ivory, { door: x === -4 || x === 4 ? front : x === 0 ? back : '' });
    for (const x of [-4, 0, 4]) put('room', x, z, 0, 3.5, P.ivory, { door: x === -4 ? 'W' : x === 4 ? 'E' : '' });
    // outside stairs up to the terraces, from the courtyard
    for (const sx of [-1, 1]) put('stairs', sx * 11.2, z - s * 1, s < 0 ? 0 : 180, 0, P.oat);
    put('awning', -4, z - s * 2.15, s < 0 ? 180 : 0, 0, team);
    put('awning', 4, z - s * 2.15, s < 0 ? 180 : 0, 0, team);

    // spawn yard: four spawns, a few guns laid out on the paving like a pool party gone wrong
    for (const x of [-6, -2, 2, 6]) put(s < 0 ? 'spawn_ally' : 'spawn_enemy', x, 11.5 * s, s < 0 ? 180 : 0);
    put('gun_snake', -3, 9.4 * s);
    put('gun_grizzly', 3, 9.4 * s);
    put('item_armour1', 0, 10.6 * s);
    put('item_ammo', -8, 9.6 * s);

    // poolside loungers and cover between the yard and the water
    for (const x of [-6, -2, 2, 6]) put('bench', x, 7.4 * s, 0, 0, s < 0 ? P.sky : P.clay);
    put('planter', -10.5, 8.2 * s, 0, 0, P.oat);
    put('planter', 10.5, 8.2 * s, 0, 0, P.oat);

    // west: cabana (a pool house you can run through), a bar stall, shade canopies
    put('room', -18, 8 * s, 0, 0, P.sage, { door: s < 0 ? 'SE' : 'NE' });
    put('stall', -14.5, 5.2 * s, 90, 0, team);
    put('canopy', -16, 2 * s, 0, 0, s < 0 ? P.sky : P.clay);
    put('crate', -21.5, 12.5 * s, 0, 0, P.kraft);
    put('crate', -21.5, 12.5 * s, 25, 1.2, P.kraft);
    put('item_grenade', -18, 3 * s);
    put('item_bandage', -18, 8 * s);

    // east: garden — planters and trees in a broken line, a shed
    put('planter', 14, 4 * s, 90, 0, P.cloud);
    put('planter', 19, 7 * s, 0, 0, P.cloud);
    put('tree', 21.5, 2.5 * s, 40 * s, 0, P.sage);
    put('tree', 16, 12.5 * s, 130, 0, P.olive);
    put('bush', 13, 9 * s, 0, 0, P.sage);
    put('bush', 22, 11 * s, 0, 0, P.olive);
    put('crate', 18.5, 0.9 * s, 15, 0, P.sage);
    put('item_charger', 20, 4.5 * s);
    put('item_bandage', 15.5, 7.5 * s);
  }

  // the middle: prizes in and over the pool, cover along the pool ends
  put('gun_kestrel', 8.4, 0, 0, 0.6);
  put('item_armour3', 5.2, 0, 0, -2.3);
  put('item_medkit', -5.4, 0, 0, -1.15);
  put('item_armour2', -12, 0);
  put('item_armour2', 12.4, 0);
  put('jersey', -13, -1.5, 90, 0, P.ivory);
  put('jersey', -13, 1.5, 90, 0, P.ivory);
  put('sandbags', 13.6, 0, 90, 0, P.kraft);
  put('lamp', -10.5, -5, 0, 0, P.slate);
  put('lamp', 10.5, 5, 180, 0, P.slate);
  put('pine', -21, -1, 0, 0, P.olive);
  put('pine', 21.6, -16.5, 0, 0, P.olive);
  put('pine', -21.6, 16.5, 0, 0, P.olive);

  return { id: 'builtin-lido', builtin: true, online: true, name: 'Lido', size: SIZE, updated: 0, pieces, terrain: terrain() };
}
