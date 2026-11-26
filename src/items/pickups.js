import * as THREE from 'three';
import { ITEMS } from './items.js';
import { WEAPONS } from '../weapons/weapons.js';
import { bakeFlat } from '../character/robot.js';
import { FX_LAYER } from '../core/renderer.js';

/*
  Items and guns lying in the world. Each hovers over a soft ring in its accent colour, turning slowly.
    spots   — fixed pickups from the map: { type, gun?, position }; they come back `respawn` s after being taken
    drops   — guns players let go of; they vanish after DROP_LIFE s
  Taking one goes through claim(): offline it's granted at once; online (net set) the server decides who got
  it and the mode calls grant() with the answer. onGrant(p) hands the pickup to the inventory.
*/

const DROP_LIFE = 40;
export const GUN_SHOW = 1.25; // floor display scale for guns (items use ITEMS[type].show)
const HOVER = 0.32, BOB = 0.05, SPIN = 0.9;
const _v = new THREE.Vector3(), _d = new THREE.Vector3();
const _down = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));

const models = new Map();
/** A floor-display model for an item type (or 'gun' + arsenal index), built and baked once, then cloned. */
export function pickupModel(type, gun = 0) {
  const key = type === 'gun' ? `gun${gun}` : type;
  if (!models.has(key)) {
    let root;
    if (type === 'gun') {
      root = WEAPONS[gun].build().root;
      root.rotation.y = Math.PI / 2; // side on, barrel to +X
      const holder = new THREE.Group();
      holder.add(root);
      root = holder;
    } else root = ITEMS[type].build();
    root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    bakeFlat(root);
    models.set(key, root);
  }
  return models.get(key).clone();
}

const ringGeo = new THREE.RingGeometry(0.36, 0.44, 40).rotateX(-Math.PI / 2);
const discGeo = new THREE.CircleGeometry(0.44, 40).rotateX(-Math.PI / 2);
const ringMats = new Map();
function ringMat(color) {
  if (!ringMats.has(color)) {
    const base = { color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false };
    ringMats.set(color, { ring: new THREE.MeshBasicMaterial({ ...base, opacity: 0.85 }), disc: new THREE.MeshBasicMaterial({ ...base, opacity: 0.16 }) });
  }
  return ringMats.get(color);
}

export class Pickups {
  constructor(scene, { octree, spots = [], respawn = 30, net = null } = {}) {
    Object.assign(this, { octree, respawn, net });
    this.group = new THREE.Group();
    scene.add(this.group);
    this.scene = scene;
    this.list = [];
    this.time = 0;
    this.dropN = 0;
    this.onGrant = () => {};
    spots.forEach((s, i) => this.#add({ id: `m${i}`, type: s.type, gun: s.gun, position: s.position, spot: true }));
  }

  dispose() { this.scene.remove(this.group); }

  #add({ id, type, gun, position, spot = false, ammo, reserve }) {
    const p = { id, type, gun, ammo, reserve, spot, active: true, t: 0, life: DROP_LIFE, pos: position.clone(), phase: Math.random() * 6 };
    const holder = new THREE.Group();
    holder.position.copy(p.pos);
    const model = pickupModel(type, gun);
    model.scale.setScalar(type === 'gun' ? GUN_SHOW : ITEMS[type].show);
    holder.add(model);
    const accent = type === 'gun' ? 0xfaf9f5 : ITEMS[type].accent;
    const m = ringMat(accent);
    for (const [geo, mat, y] of [[discGeo, m.disc, 0.012], [ringGeo, m.ring, 0.014]]) {
      const r = new THREE.Mesh(geo, mat);
      r.position.y = y;
      r.layers.set(FX_LAYER);
      holder.add(r);
    }
    Object.assign(p, { obj: holder, model });
    this.group.add(holder);
    this.list.push(p);
    return p;
  }

  byId(id) { return this.list.find((p) => p.id === id); }

  /** A gun left at `pos` (snapped to the floor below). id comes from the server online. */
  drop({ gun, ammo, reserve }, pos, id = `d${this.dropN++}`) {
    _down.origin.copy(pos).setY(pos.y + 0.6);
    const hit = this.octree?.rayIntersect(_down);
    const at = pos.clone();
    if (hit && hit.distance < 6) at.y = _down.origin.y - hit.distance;
    return this.#add({ id, type: 'gun', gun, position: at, ammo, reserve });
  }

  /** We let go of a gun: offline it lands now; online the server names it and tells everyone (dropped). */
  release(d, pos) {
    if (this.net) this.net.send({ t: 'drop', w: d.gun, p: [pos.x, pos.y, pos.z].map((v) => +v.toFixed(2)), ammo: d.ammo, reserve: d.reserve });
    else this.drop(d, pos);
  }

  /** Remove (drops) or hide until respawn (map spots). */
  take(p) {
    if (!p?.active) return;
    p.active = false;
    p.pending = false;
    p.obj.visible = false;
    p.t = this.respawn;
    if (!p.spot) { this.group.remove(p.obj); this.list.splice(this.list.indexOf(p), 1); }
  }

  /** Ask for a pickup; offline it's ours immediately. */
  claim(p) {
    if (!p.active || p.pending) return;
    if (!this.net) { this.take(p); this.onGrant(p); return; }
    p.pending = true;
    p.pendingT = 0.6;
    this.net.send({ t: 'take', id: p.id });
  }

  /** Server verdict: someone took it; if it was us, it's ours. */
  grant(id, mine) {
    const p = this.byId(id);
    if (!p) return;
    const snapshot = { ...p };
    this.take(p);
    if (mine) this.onGrant(snapshot);
  }

  /** Everything back: map items in place, drops gone (new round). */
  reset() {
    for (const p of [...this.list]) {
      if (!p.spot) { this.group.remove(p.obj); this.list.splice(this.list.indexOf(p), 1); continue; }
      p.active = true;
      p.pending = false;
      p.obj.visible = true;
    }
  }

  /**
   * The pickup the player is reaching for: within reach of the feet, and for prompts the one closest to the
   * crosshair. Returns { touch, look }: touch = close enough to walk over, look = aimed at within reach.
   */
  nearby(feet, camera) {
    let touch = null, look = null, bestT = Infinity, bestL = -1;
    camera.getWorldDirection(_d);
    for (const p of this.list) {
      if (!p.active || p.pending) continue;
      _v.copy(p.pos).sub(feet);
      const dy = _v.y;
      _v.y = 0;
      const flat = _v.length();
      if (dy > 1.4 || dy < -0.9 || flat > 2.4) continue;
      if (flat < 1 && flat < bestT) { bestT = flat; touch = p; }
      const aim = _v.copy(p.pos).setY(p.pos.y + HOVER).sub(camera.position).normalize().dot(_d) - flat * 0.04;
      if (aim > 0.82 && aim > bestL) { bestL = aim; look = p; }
    }
    return { touch, look };
  }

  update(dt) {
    this.time += dt;
    for (const p of this.list) {
      if (p.pending && (p.pendingT -= dt) <= 0) p.pending = false; // no answer: allow another try
      if (!p.active) {
        if (p.spot && !this.net && (p.t -= dt) <= 0) { p.active = true; p.obj.visible = true; }
        continue;
      }
      if (!p.spot && (p.life -= dt) <= 0) { this.take(p); continue; }
      const ph = this.time + p.phase;
      p.model.position.y = HOVER + Math.sin(ph * 2.1) * BOB;
      p.model.rotation.y = ph * SPIN;
    }
    for (const m of ringMats.values()) m.disc.opacity = 0.13 + 0.05 * Math.sin(this.time * 3);
  }
}
