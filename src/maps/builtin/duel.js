import { PALETTE as P } from '../../core/toon.js';

/*
  "Duel" — a small walled box for 1v1 / 2v2, 56 × 28 m inside a 64 m map.

  Two raised spawn decks face each other down the long axis: the classic deck-to-deck sniper line runs
  over the centre container. Three lanes connect them: a north alley behind a window wall, an open middle
  with scattered cover, and a south lane of containers you can climb onto from crates.

  Loot is mirrored so neither side is favoured: light armour and ammo on each deck, a grenade and a
  shotgun in the open middle, a medkit and an SMG up the north alley, a charger and guard armour down the
  south lane. The two prizes sit on the centre line, where both players have to commit to reach them:
  heavy armour at the back of the north alley, the Kestrel sniper in the south pinch.

    z +14 ┌────────────────────────────────────────────┐
          │ deck        crates   ▢▢   crates       deck│  north alley
    z  +7 │ ▓▓▓▓      ═╪══════╪═══╪══════╪═  window    ▓▓▓▓│
          │ ▓A▓▓  sb   ▢     ┃cont┃     ▢   sb  ▓▓B▓│  middle
          │ ▓▓▓▓              ┃     ┃              ▓▓▓▓│
    z  -7 │        ▢ ███████        ███████ ▢          │  south lane
    z -14 └────────────────────────────────────────────┘
        x -28                                        +28
*/

const SIDE = { a: P.sky, b: P.clay };

export function duel() {
  const pieces = [];
  const put = (type, x, z, rot = 0, y = 0, color) => pieces.push({ type, x, y, z, rot, color });
  const mirror = (fn) => { fn(-1, SIDE.a); fn(1, SIDE.b); };

  // perimeter: long walls tinted toward each team's half, plain ends
  for (let x = -26; x <= 26; x += 4) {
    const c = Math.abs(x) < 4 ? P.ivory : x < 0 ? SIDE.a : SIDE.b;
    put('wall', x, 14, 0, 0, c);
    put('wall', x, -14, 0, 0, c);
  }
  for (let z = -12; z <= 12; z += 4) { put('wall', -28, z, 90, 0, SIDE.a); put('wall', 28, z, 90, 0, SIDE.b); }

  // centre: one container across the middle line, crates either side of it
  put('container', 0, 0, 90, 0, P.ivory);
  put('crate', 0, 5.2, 0, 0, P.kraft);
  put('crate', 0, -5.2, 12, 0, P.kraft);

  // north alley wall: windows at the ends look into the middle
  put('wall_window', -6, 7, 0, 0, P.manilla);
  put('wall', -2, 7, 0, 0, P.manilla);
  put('wall', 2, 7, 0, 0, P.manilla);
  put('wall_window', 6, 7, 0, 0, P.manilla);
  put('crate', 0, 10.6, 0, 0, P.sage);
  put('crate', 0, 10.6, 0, 1.2, P.sage);

  mirror((s, team) => {
    // spawn deck: the podium's stairs face the middle
    put('podium', s * 21.8, 0, s < 0 ? 180 : 0, 0, P.oat);
    put('crate', s * 24.5, 4.6, 0, 3.5, team);
    put('crate', s * 24.5, -4.6, 0, 3.5, team);
    put('sandbags', s * 17.6, -4.4, 90, 3.5, P.kraft);
    for (const z of [-3, 3]) put(s < 0 ? 'spawn_ally' : 'spawn_enemy', s * 25, z, s < 0 ? 270 : 90, 3.5);

    // middle cover
    put('sandbags', s * 12, 0, 90, 0, P.kraft);
    put('jersey', s * 7, 4, 90, 0, P.ivory);
    put('jersey', s * 7, -4, 90, 0, P.ivory);
    put('crate', s * 13, 4.8, 0, 0, team);
    put('barrel', s * 13, -4.6, 0, 0, team);

    // north alley
    put('crate', s * 10.5, 11.4, 0, 0, P.kraft);
    put('barrel', s * 4.5, 12.6, 0, 0, team);
    put('barrel', s * 15, 8.4, 0, 0, P.sage);

    // south lane: a container per side, crates to climb on, a pinch between
    put('container', s * 7.4, -10.4, 0, 0, team);
    put('crate', s * 11.6, -9.4, 0, 0, P.kraft);
    put('sandbags', s * 2.2, -12.2, 0, 0, P.sage);
    put('barrel', s * 17, -11.6, 0, 0, P.slate);

    // loot
    put('item_armour1', s * 20.4, 2.6, 0, 3.5);
    put('item_ammo', s * 20.4, -1.8, 0, 3.5);
    put('item_grenade', s * 10.4, 0);
    put('gun_grizzly', s * 4.6, 0);
    put('item_medkit', s * 12.8, 11.8);
    put('gun_snake', s * 16.8, 11.6);
    put('item_charger', s * 11.6, -12.2);
    put('item_armour2', s * 14.4, -12);
  });
  put('item_armour3', 0, 12.6);
  put('gun_kestrel', 0, -11.2);

  return { id: 'builtin-duel', builtin: true, online: true, name: 'Duel', size: 64, updated: 0, pieces };
}
