import * as THREE from 'three';
import { WEAPONS } from '../weapons/weapons.js';
import { ITEMS } from '../items/items.js';
import { buildKnife } from '../items/models/knife.js';
import { silhouettes } from './silhouettes.js';

/*
  Small ink silhouettes of whatever can make a kill (each gun, the knife, a grenade), for the kill feed.
  Rendered once, the first time one is asked for. Ids are arsenal ids plus 'knife' and 'grenade'.
*/

const EXTRA = {
  knife: () => { const g = new THREE.Group(), k = buildKnife(); k.rotation.x = -Math.PI / 2; g.add(k); return g; }, // blade along -Z
  grenade: () => ITEMS.grenade.build(),
};

let icons = null;

export function weaponIcon(id) {
  if (!icons) {
    const ids = [...WEAPONS.map((w) => w.id), ...Object.keys(EXTRA)];
    const urls = silhouettes(ids.map((i) => EXTRA[i]?.() ?? WEAPONS.find((w) => w.id === i).build().root), 168, 56);
    icons = Object.fromEntries(ids.map((i, k) => [i, urls[k]]));
  }
  return icons[id] || null;
}
