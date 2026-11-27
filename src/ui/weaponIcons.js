import * as THREE from 'three';
import { WEAPONS } from '../weapons/weapons.js';
import { ITEMS } from '../items/items.js';
import { buildArm, robotMaterials, SCHEMES } from '../character/robot.js';
import { silhouettes } from './silhouettes.js';

/*
  Small ink silhouettes of whatever can make a kill (each gun, a fist, a grenade), for the kill feed.
  Rendered once in the background, starting the first time one is asked for (null until then). Ids are arsenal ids
  plus 'fist' and 'grenade'.
*/

const EXTRA = {
  fist: () => {
    const h = buildArm(robotMaterials(SCHEMES.player), -1).hand;
    h.userData.setCurl(1.5, 1);
    h.removeFromParent();
    h.traverse((o) => { o.userData = {}; }); // rig helpers point back at the bones: the silhouette's clone can't copy them
    h.position.set(0, 0, 0);
    h.rotation.set(Math.PI, Math.PI / 2, 0); // seen from the side, punching the way the guns point
    return new THREE.Group().add(h);
  },
  grenade: () => ITEMS.grenade.build(),
};

let icons = null, started = false;

export function weaponIcon(id) {
  if (!started) {
    started = true;
    const ids = [...WEAPONS.map((w) => w.id), ...Object.keys(EXTRA)];
    silhouettes(ids.map((i) => EXTRA[i]?.() ?? WEAPONS.find((w) => w.id === i).build().root), 168, 56)
      .then((urls) => { icons = Object.fromEntries(ids.map((i, k) => [i, urls[k]])); });
  }
  return icons?.[id] || null;
}
