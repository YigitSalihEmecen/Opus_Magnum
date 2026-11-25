/*
  Saved maps live in localStorage under one key:
    { [id]: { id, name, updated, size, pieces: [{ type, x, y, z, rot, color }] } }
*/
import { settlement } from './maps/settlement.js';

const KEY = 'om.maps';
let builtins;
const BUILTIN = () => (builtins ??= [settlement()]);

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; }
}
function writeAll(all) {
  try { localStorage.setItem(KEY, JSON.stringify(all)); return true; } catch { return false; }
}

/** Built-in maps first (read-only; the editor opens them as copies), then saved maps, newest first. */
export const listMaps = () => [...BUILTIN(), ...Object.values(readAll()).sort((a, b) => b.updated - a.updated)];
export const getMap = (id) => BUILTIN().find((m) => m.id === id) ?? readAll()[id] ?? null;

/** Saves (creating an id if needed) and returns the stored map, or null if storage is unavailable. */
export function saveMap(map) {
  const all = readAll();
  const id = map.id ?? `m${Date.now().toString(36)}`;
  const saved = { ...map, id, updated: Date.now() };
  all[id] = saved;
  return writeAll(all) ? saved : null;
}

export function deleteMap(id) {
  const all = readAll();
  delete all[id];
  writeAll(all);
}

/** A map is TDM-ready when it has at least one spawn for each team. */
export const hasSpawns = (map) => ['spawn_ally', 'spawn_enemy'].every((t) => map.pieces.some((p) => p.type === t));
