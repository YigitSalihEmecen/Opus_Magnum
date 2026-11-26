import { PALETTE as P } from '../../core/toon.js';
import data from './col2.data.js';

/*
  "col-2" — the author's map model rebuilt from the game's own pieces (tools/maps/stl2map.py reads the
  model; col2.data.js is its output). 1 model unit = 0.5 m, so about 86 × 88 m of walled lanes on a 2 m
  grid: two-storey walls, a door in every doorway the model has, floors at half-storey levels — a sunken
  mid lane, the main floor, a raised south-west yard and north-east plateau — joined by ramps, ceilings
  over the covered passages, and the model's boxes and cars as crates, barriers, containers and sedans.
*/

const decode = (b64) => Array.from(Int8Array.from(atob(b64), (c) => c.charCodeAt(0)), (v) => v / 10);

export function col2() {
  const pieces = data.pieces.map((p, i) => {
    const color = p.type.startsWith('wall') ? P.oat
      : p.type === 'crate' ? (i % 3 ? P.kraft : P.sage) : p.type === 'floor_tile' ? P.oat
        : p.type === 'container' ? [P.clay, P.sky, P.sage][i % 3] : p.type === 'sedan' ? [P.sky, P.ivory, P.clay][i % 3] : P.ivory;
    return { ...p, color };
  });
  const put = (type, x, z, rot = 0, y = 0) => pieces.push({ type, x, y, z, rot });

  // team spawns: the raised south-west yard (A) and the north-east plateau (B)
  for (const [x, z] of [[-34, 37], [-30, 36.5], [-26, 37], [-22, 37]]) put('spawn_ally', x, z, 0);
  for (const [x, z] of [[24.5, -33], [27, -37], [30, -37], [34, -37]]) put('spawn_enemy', x, z, 180);

  // loot: a starter set by each spawn, the prizes along the sunken mid lane (each spot checked clear of
  // walls and props on the generated grid)
  for (const [type, x, z] of [
    ['item_armour1', -27.5, 34], ['item_ammo', -36, 34.5], ['item_armour1', 27.5, -33], ['item_ammo', 35, -33],
    ['gun_kestrel', -2, -23.5], ['item_armour3', -4, -6], ['item_charger', 0, 12],
    ['gun_grizzly', -32, -30.5], ['gun_snake', 30, 4], ['item_medkit', -32, 12.5], ['item_medkit', 31, 18],
    ['item_armour2', -17, 1], ['item_armour2', 12, -8], ['item_grenade', -22.5, -3], ['item_grenade', 21, 5],
  ]) put(type, x, z);

  return { id: 'builtin-col2', builtin: true, online: true, name: 'col-2', size: data.size, updated: 0, pieces, terrain: { seg: data.seg, h: decode(data.h), plain: true } };
}
