import { PALETTE as P } from '../../core/toon.js';
import data from './col2.data.js';

/*
  "col-2" — rebuilt from the author's own map model (tools/maps/stl2map.py reads it; col2.data.js is the
  output). 1 model unit = 0.5 m, so the map is about 86 × 88 m: walled lanes at four floor levels joined
  by ramps — a sunken mid lane down the centre, a raised north-east plateau, a raised south-west yard —
  around two big blocks of buildings. Floors are the terrain (0.5 m lattice), walls and pillars are sized
  blocks traced from the model, boxes are crates where they're crate-sized.
*/

const decode = (b64) => Array.from(Int8Array.from(atob(b64), (c) => c.charCodeAt(0)), (v) => v / 10);

export function col2() {
  const pieces = [];
  const put = (type, x, z, rot = 0, y = 0, color, extra) => pieces.push({ type, x, y, z, rot, color, ...extra });

  for (const w of data.walls) put('block', 0, 0, 0, w.y, w.top > 5.5 ? P.oat : P.manilla, { pts: w.pts, holes: w.holes, h: w.top - w.y });
  for (const p of data.props) {
    if (p.kind === 'block') put('block', 0, 0, 0, p.y, p.top - p.y < 0.7 ? P.oat : P.kraft, { pts: p.pts, holes: p.holes, h: p.top - p.y });
    else if (p.kind === 'sedan') put('sedan', p.x, p.z, p.rot, p.y, P.sky);
    else {
      put('crate', p.x, p.z, p.rot, p.y, P.kraft);
      if (p.kind === 'crate2') put('crate', p.x, p.z, p.rot + 12, p.y + 1.2, P.sage);
    }
  }

  // team spawns: the south-west yard (A) and the north-east plateau (B)
  for (const [x, z] of [[-30, 37], [-26, 37], [-30, 40.5], [-26, 40.5]]) put('spawn_ally', x, z, 0);
  for (const [x, z] of [[28, -38], [32, -38], [28, -34.5], [32, -34.5]]) put('spawn_enemy', x, z, 180);

  return { id: 'builtin-col2', builtin: true, online: true, name: 'col-2', size: data.size, updated: 0, pieces, terrain: { seg: data.seg, h: decode(data.h), plain: true } };
}
