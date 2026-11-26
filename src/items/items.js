import { buildMedkit } from './models/medkit.js';
import { buildBandage } from './models/bandage.js';
import { buildAmmo } from './models/ammo.js';
import { buildArmour } from './models/armour.js';
import { buildCharger } from './models/charger.js';
import { buildGrenade } from './models/grenade.js';

/*
  Item definitions. Everything that differs between items lives here:
    kind     — heal (Q) · charge (X) · throw (G) · ammo (instant) · armour (worn)
    max      — how many you can carry (consumables)
    time     — seconds to use (heal / charge)
    show     — display scale on the floor, so small items still read at a distance
    accent   — pickup ring / HUD colour
  Armour tiers give that much extra protection (absorbed before health). The server mirrors the heal and
  armour numbers (server/index.js ITEMS) — keep them in step.
*/

export const ARMOUR_TIERS = [
  null,
  { tier: 1, cap: 25, name: 'Light armour', color: 0xd8d2c4 },
  { tier: 2, cap: 50, name: 'Guard armour', color: 0x3f8ad6 },
  { tier: 3, cap: 75, name: 'Heavy armour', color: 0x8e63c9 },
];

export const ITEMS = {
  medkit: { name: 'Medkit', kind: 'heal', heal: 150, time: 5, max: 2, show: 1.5, accent: 0xc23a2e, build: buildMedkit },
  bandage: { name: 'Bandage', kind: 'heal', heal: 40, time: 2.4, max: 4, show: 2.2, accent: 0xf1eee4, build: buildBandage },
  charger: { name: 'Armour charger', kind: 'charge', time: 3, max: 3, show: 1.8, accent: 0x5fd0ff, build: buildCharger },
  grenade: { name: 'Frag grenade', kind: 'throw', max: 2, show: 2.4, accent: 0xd97757, build: buildGrenade },
  ammo: { name: 'Ammo box', kind: 'ammo', mags: 2, show: 1.8, accent: 0xc9a04e, build: buildAmmo },
  ...Object.fromEntries(ARMOUR_TIERS.filter(Boolean).map((a) => [`armour${a.tier}`, {
    name: a.name, kind: 'armour', tier: a.tier, cap: a.cap, show: 1.45, accent: a.color, build: () => buildArmour(a.tier, a.color),
  }])),
};

export const ITEM_IDS = Object.keys(ITEMS);

/**
 * A pickup from a map record's type: 'item_medkit' / 'medkit' → { type: 'medkit' }, 'gun_kestrel' → { type: 'gun', gun: arsenal index }.
 * Arsenal indices follow WEAPONS, so pass its ids in (keeps this file free of the weapon models).
 */
export function pickupSpec(id, weaponIds) {
  if (id.startsWith('gun_')) { const gun = weaponIds.indexOf(id.slice(4)); return gun < 0 ? null : { type: 'gun', gun }; }
  const type = id.replace(/^item_/, '');
  return ITEMS[type] ? { type } : null;
}
