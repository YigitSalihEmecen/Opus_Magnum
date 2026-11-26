import * as THREE from 'three';
import { Avatar } from '../../character/avatar.js';
import { CHARACTERS } from '../../character/characters.js';
import { textTexture } from '../../core/toon.js';
import { FX_LAYER } from '../../core/renderer.js';

/*
  Animation demo: a small parkour loop in front of you, and three robots running it one behind the other,
  driven exactly as the game drives bodies (position, velocity, aim, stance) — nothing here poses a bone.
    near leg   sprint · vault a crate · slide · climb onto a platform · jump the gap · drop down
    far leg    wallrun the long wall · jump off · crouch along the cover · strafe · backpedal · stop and
               reload · walk out
  A tag over each says what it's doing. [ and ] slow down / speed up time, \ pauses it.
  Loaded only when picked (main.js MODES).
*/

const SPEEDS = [0, 0.1, 0.25, 0.5, 1, 1.5];
const RUNNERS = [{ char: 0, at: 0 }, { char: 1, at: 0.34 }, { char: 0, at: 0.67 }]; // spaced around the loop

// the course (rot in degrees; walls run along x at rot 0)
const FRONT = -2, BACK = -11, PLAT = 1.2;
const PIECES = [
  { type: 'spawn_ally', x: 0, y: 0, z: 9, rot: 0 },
  { type: 'crate', x: -8, y: 0, z: FRONT, rot: 0 },
  { type: 'floor', x: 4, y: PLAT, z: FRONT, rot: 0 },
  { type: 'floor', x: 10.5, y: PLAT, z: FRONT, rot: 0 },
  { type: 'wall', x: 4, y: 0, z: BACK - 1.05, rot: 0 },
  { type: 'wall', x: 8, y: 0, z: BACK - 1.05, rot: 0 },
  { type: 'wall_half', x: -6, y: 0, z: BACK - 1.1, rot: 0 },
  { type: 'wall_half', x: -10, y: 0, z: BACK - 1.1, rot: 0 },
];

// waypoints [x, y, z] and what the body does from there to the next one; the path through them is a smooth
// closed curve, speed eases toward each part's own. wall: which side the wall is on (+1 right, −1 left)
const ROUTE = [
  { p: [-16, 0, FRONT], label: 'Sprint', sp: 5.7 },
  { p: [-10.2, 0, FRONT], label: 'Vault', sp: 5, pose: { mantle: 1 } },
  { p: [-8, 1.45, FRONT], label: 'Vault', sp: 5, pose: { air: 1 } },
  { p: [-6, 0, FRONT], label: 'Sprint', sp: 5.7 },
  { p: [-4, 0, FRONT], label: 'Slide', sp: 6.2, pose: { slide: 1, crouch: 1 } },
  { p: [0.2, 0, FRONT], label: 'Run', sp: 4.2 },
  { p: [1.2, 0, FRONT], label: 'Climb', sp: 2.2, pose: { mantle: 1 } },
  { p: [2.4, PLAT, FRONT], label: 'Run', sp: 4.8 },
  { p: [5.6, PLAT, FRONT], label: 'Jump the gap', sp: 5.2, pose: { air: 1 } },
  { p: [7.25, PLAT + 0.8, FRONT], label: 'Jump the gap', sp: 5.2, pose: { air: 1 } },
  { p: [8.9, PLAT, FRONT], label: 'Run', sp: 4.6 },
  { p: [12.2, PLAT, FRONT], label: 'Drop down', sp: 4.6, pose: { air: 1 } },
  { p: [14, 0, FRONT], label: 'Run', sp: 4.6 },
  { p: [17, 0, -6.5], label: 'Run', sp: 4.6 },
  { p: [13.5, 0, BACK], label: 'Sprint', sp: 5.7 },
  { p: [11.2, 0.4, BACK - 0.55], label: 'Wallrun', sp: 6.2, pose: { wall: 1 } },
  { p: [6, 0.9, BACK - 0.55], label: 'Wallrun', sp: 6.2, pose: { wall: 1 } },
  { p: [2, 0.6, BACK - 0.5], label: 'Jump off', sp: 5.6, pose: { air: 1 } },
  { p: [0.4, 0.9, BACK + 0.2], label: 'Jump off', sp: 5.6, pose: { air: 1 } },
  { p: [-1.4, 0, BACK], label: 'Run', sp: 4.2 },
  { p: [-3.5, 0, BACK], label: 'Crouch walk', sp: 2, pose: { crouch: 1 } },
  { p: [-12.5, 0, BACK], label: 'Strafe', sp: 3.4, face: -90 },
  { p: [-15, 0, -8], label: 'Backpedal', sp: 3, face: 180 },
  { p: [-17, 0, -6], label: 'Reload', sp: 0, hold: 2.4, reload: true },
  { p: [-17, 0, -4.5], label: 'Walk', sp: 1.4 },
];

// what's underfoot: the platforms' tops, else the ground
const support = (x, z) => (PIECES.some((q) => q.type === 'floor' && Math.abs(x - q.x) < 2 && Math.abs(z - q.z) < 2) ? PLAT : 0);

const tags = new Map();
function tag(text) {
  if (!tags.has(text)) {
    const tex = textTexture([{ text }], { width: 640, height: 128, font: '600 64px "Space Grotesk", sans-serif', align: 'center', pad: 24 });
    tags.set(text, new THREE.SpriteMaterial({ map: tex, depthWrite: false, toneMapped: false }));
  }
  return tags.get(text);
}

/** The route as a closed curve, with a length table: distance along it → curve parameter and route part. */
function course() {
  const curve = new THREE.CatmullRomCurve3(ROUTE.map((r) => new THREE.Vector3(...r.p)), true, 'centripetal');
  const N = 4000, ts = new Float32Array(N + 1), ls = new Float32Array(N + 1), a = new THREE.Vector3(), b = new THREE.Vector3();
  curve.getPoint(0, a);
  for (let i = 1; i <= N; i++) {
    ts[i] = i / N;
    curve.getPoint(ts[i], b);
    ls[i] = ls[i - 1] + b.distanceTo(a);
    a.copy(b);
  }
  const length = ls[N];
  const at = (s) => {
    s = ((s % length) + length) % length;
    let lo = 0, hi = N;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ls[m] <= s) lo = m; else hi = m; }
    const t = ts[lo] + (ts[hi] - ts[lo]) * ((s - ls[lo]) / Math.max(1e-6, ls[hi] - ls[lo]));
    return { t, part: ROUTE[Math.min(ROUTE.length - 1, Math.floor(t * ROUTE.length))] };
  };
  return { curve, length, at };
}

export async function createGallery({ scene, hud, buildWorld }) {
  const world = await buildWorld({ size: 48, pieces: PIECES });
  return new Gallery({ scene, hud, world });
}

class Gallery {
  constructor({ scene, hud, world }) {
    Object.assign(this, { scene, hud, world });
    this.octree = world.octree;
    this.spawn = world.spawns.ally[0];
    this.targets = world.raycastTargets;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.course = course();
    this.speed = 4;
    this.runners = RUNNERS.map((r) => {
      const a = new Avatar({ team: 'enemy', name: '', char: CHARACTERS[r.char].id });
      a.alive = true;
      a.root.visible = true;
      a.run = { s: r.at * this.course.length, sp: 0, part: null, hold: 0 };
      a.label = new THREE.Sprite(tag('…'));
      a.label.scale.set(2.2, 0.44, 1);
      a.label.layers.set(FX_LAYER);
      this.group.add(a.root, a.label);
      this.#place(a, 0);
      return a;
    });
    this.onKey = (e) => {
      if (e.code === 'BracketLeft') this.speed = Math.max(1, this.speed - 1);
      else if (e.code === 'BracketRight') this.speed = Math.min(SPEEDS.length - 1, this.speed + 1);
      else if (e.code === 'Backslash') this.speed = this.speed ? 0 : 4;
      else return;
      this.hud.toast(SPEEDS[this.speed] ? `Time × ${SPEEDS[this.speed]}` : 'Paused');
    };
    addEventListener('keydown', this.onKey);
    setTimeout(() => this.hud.toast('[ ] slow down / speed up · \\ pause'), 1200);
  }

  #place(a, dt) {
    const R = a.run, { curve, at } = this.course;
    const { t, part } = at(R.s);
    if (part !== R.part) {
      R.part = part;
      R.hold = part.hold ?? 0;
      a.label.material = tag(part.label);
      if (part.reload) a.reloadT = a.reloadTime;
    }
    // ease toward the part's speed (a stop holds still for its time, then moves on)
    if (R.hold > 0) R.hold -= dt;
    const goal = R.hold > 0 ? 0 : Math.max(part.sp, 1.4);
    R.sp += (goal - R.sp) * (1 - Math.exp(-6 * dt));
    R.s += R.sp * dt;
    const p = curve.getPoint(t), d = curve.getTangent(t);
    p.y = Math.max(p.y, support(p.x, p.z)); // the smooth path never dips into what it runs on
    if (dt > 0) a.vel.copy(p).sub(a.pos).divideScalar(dt).setY(0);
    a.pos.copy(p);
    const heading = Math.atan2(d.x, d.z);
    a.aimYaw = heading - ((part.face ?? 0) * Math.PI) / 180;
    a.aimPitch = 0;
    a.poseTarget = part.pose ?? {};
    a.reloadT = Math.max(0, a.reloadT - dt);
  }

  update(dt) {
    const step = dt * SPEEDS[this.speed];
    if (!step) return;
    for (const a of this.runners) {
      this.#place(a, step);
      a.pose(step);
      a.label.position.copy(a.pos).setY(a.pos.y + 2.45);
    }
  }

  dispose() {
    removeEventListener('keydown', this.onKey);
    this.scene.remove(this.group);
    this.world.dispose();
  }
}
