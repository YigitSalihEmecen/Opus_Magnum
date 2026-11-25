import { buildRobot, buildArm, robotMaterials, SCHEMES } from './robot.js';
import { buildKite, buildKiteArm, kiteMaterials, KITE_SCHEMES } from './kite.js';

/*
  Playable characters. Each shares the skeleton layout and hand frame, so animation clips, gun grips and
  IK work on all of them; they differ in build, silhouette and (later) abilities.
*/

export const CHARACTERS = [
  { id: 'rivet', name: 'Rivet', role: 'Bruiser', blurb: 'Scrapyard heavy. Salvaged plating, hydraulic joints, one big eye.', weapon: 'panther', build: (team) => buildRobot({ scheme: SCHEMES[team] }), arm: (side) => buildArm(robotMaterials(SCHEMES.player), side) },
  { id: 'kite', name: 'Kite', role: 'Scout', blurb: 'Light and quick. Long limbs, exposed spine, swept fins.', weapon: 'snake', build: (team) => buildKite({ scheme: KITE_SCHEMES[team] }), arm: (side) => buildKiteArm(kiteMaterials(KITE_SCHEMES.player), side) },
];

export const characterById = (id) => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];

/** team: 'player' | 'ally' | 'enemy'. */
export const buildCharacter = (id, team = 'player') => characterById(id).build(team);

const KEY = 'om.character';
export function selectedCharacter() {
  try { return characterById(localStorage.getItem(KEY)).id; } catch { return CHARACTERS[0].id; }
}
export function selectCharacter(id) {
  try { localStorage.setItem(KEY, id); } catch { /* private mode */ }
}
