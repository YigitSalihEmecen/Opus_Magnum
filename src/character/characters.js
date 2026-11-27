import { buildRobot, buildArm, robotMaterials, SCHEMES, withDetail, addLods } from './robot.js';
import { buildKite, buildKiteArm, kiteMaterials, KITE_SCHEMES } from './kite.js';

/*
  Playable characters. Each shares the skeleton layout and hand frame, so animation clips, gun grips and
  IK work on all of them; they differ in build, silhouette and stats: hp (max health; server/index.js CHAR_HP
  mirrors it) and pace (movement speed multiplier).
*/

export const CHARACTERS = [
  { id: 'rivet', name: 'Rivet', role: 'Bruiser', blurb: 'Scrapyard heavy. Salvaged plating, hydraulic joints, one big eye.', weapon: 'panther', hp: 125, pace: 1, build: (team) => buildRobot({ scheme: SCHEMES[team] }), arm: (side) => buildArm(robotMaterials(SCHEMES.player), side) },
  { id: 'kite', name: 'Kite', role: 'Scout', blurb: 'Light and quick. Long limbs, exposed spine, swept fins.', weapon: 'snake', hp: 100, pace: 1.1, build: (team) => buildKite({ scheme: KITE_SCHEMES[team] }), arm: (side) => buildKiteArm(kiteMaterials(KITE_SCHEMES.player), side) },
];

export const characterById = (id) => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];

// distance LODs: [detail, from (m)]. Past 14 m the rounded edges and round parts are half as fine; past 32 m
// boxes and the fewest segments. The ink lines carry the silhouette, so it reads the same.
export const LODS = [[0.5, 14], [0.25, 32]];
const lodGeometry = new Map(); // `${id}|${team}|${detail}` → skinned geometry, built once and shared

/** team: 'player' | 'ally' | 'enemy'. */
export function buildCharacter(id, team = 'player') {
  const c = characterById(id), r = c.build(team);
  const levels = LODS.map(([d, from]) => {
    const key = `${c.id}|${team}|${d}`;
    if (!lodGeometry.has(key)) lodGeometry.set(key, withDetail(d, () => c.build(team)).skin.geometry);
    return [lodGeometry.get(key), from];
  });
  r.lod = addLods(r.skin, levels);
  return r;
}

const KEY = 'om.character', DEFAULT = 'kite';
export function selectedCharacter() {
  try { return characterById(localStorage.getItem(KEY) ?? DEFAULT).id; } catch { return DEFAULT; }
}
export function selectCharacter(id) {
  try { localStorage.setItem(KEY, id); } catch { /* private mode */ }
}
