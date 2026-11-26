import * as THREE from 'three';
import { Avatar } from '../../character/avatar.js';
import { CHARACTERS } from '../../character/characters.js';
import { textTexture } from '../../core/toon.js';
import { FX_LAYER } from '../../core/renderer.js';

/*
  Animation demo: three bots lap a ring on an open floor, each looping a short gameplay routine (sprint, slide,
  crouch, strafe, backpedal, jump, reload, take a hit…), driven exactly as the game drives bots: speed, travel
  direction against facing, stance, aim. A tag over each says what it's doing.
  [ and ] slow down / speed up time, \ pauses it. Loaded only when picked (main.js MODES).
*/

const CENTRE = new THREE.Vector3(0, 0, -4);
const SPEEDS = [0, 0.1, 0.25, 0.5, 1, 1.5];
const BOTS = [{ char: 0, r: 3.5, start: 0 }, { char: 1, r: 6, start: 9 }, { char: 0, r: 8.5, start: 18 }];

// one routine step: seconds, speed (m/s), facing against travel (° — 90 strafes, 180 backpedals), stance, extras
const ROUTINE = [
  { label: 'Sprint', t: 3, sp: 5.7 },
  { label: 'Slide', t: 0.9, sp: 6.5, pose: { slide: 1, crouch: 1 } },
  { label: 'Crouch walk', t: 2, sp: 2, pose: { crouch: 1 } },
  { label: 'Crouch, aim around', t: 1.6, sp: 0, pose: { crouch: 1 }, pitch: true },
  { label: 'Run', t: 2, sp: 4.2 },
  { label: 'Jump', t: 0.9, sp: 4.6, pose: { air: 1 } },
  { label: 'Run', t: 1.2, sp: 4.6 },
  { label: 'Strafe', t: 1.6, sp: 3.4, face: 90 },
  { label: 'Strafe', t: 1.6, sp: 3.4, face: 90, flip: true },
  { label: 'Backpedal', t: 1.6, sp: 3, face: 180 },
  { label: 'Stop, reload', t: 2.4, sp: 0, reload: true },
  { label: 'Walk', t: 2.2, sp: 1.4 },
  { label: 'Hit', t: 1, sp: 0, hit: true },
  { label: 'Aim down sights', t: 1.6, sp: 0, pose: { ads: 1 }, pitch: true },
];
const LOOP = ROUTINE.reduce((s, r) => s + r.t, 0);

const tags = new Map();
function tag(text) {
  if (!tags.has(text)) {
    const tex = textTexture([{ text }], { width: 640, height: 128, font: '600 64px "Space Grotesk", sans-serif', align: 'center', pad: 24 });
    tags.set(text, new THREE.SpriteMaterial({ map: tex, depthWrite: false, toneMapped: false }));
  }
  return tags.get(text);
}

function stepAt(t) {
  let u = ((t % LOOP) + LOOP) % LOOP;
  for (const s of ROUTINE) { if (u < s.t) return [s, u]; u -= s.t; }
  return [ROUTINE[0], 0];
}

export async function createGallery({ scene, hud, buildWorld }) {
  const world = await buildWorld({ size: 40, pieces: [{ type: 'spawn_ally', x: 0, y: 0, z: 9, rot: 0 }] });
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
    this.time = 0;
    this.speed = 4;
    this.bots = BOTS.map((b) => {
      const a = new Avatar({ team: 'enemy', name: '', char: CHARACTERS[b.char].id });
      a.alive = true;
      a.root.visible = true;
      a.lap = { ...b, theta: 0, step: null };
      a.label = new THREE.Sprite(tag('…'));
      a.label.scale.set(2.2, 0.44, 1);
      a.label.layers.set(FX_LAYER);
      this.group.add(a.root, a.label);
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

  update(dt) {
    const step = dt * SPEEDS[this.speed];
    if (!step) return;
    this.time += step;
    for (const a of this.bots) {
      const L = a.lap;
      const [s, u] = stepAt(this.time + L.start);
      if (s !== L.step) {
        L.step = s;
        a.label.material = tag(s.label);
        if (s.reload) a.reloadT = a.reloadTime;
        if (s.hit) a.flash = 0.08;
      }
      // round the ring anticlockwise; travel along its tangent, face per the step
      L.theta += (s.sp * step) / L.r;
      a.pos.set(CENTRE.x + Math.cos(L.theta) * L.r, 0, CENTRE.z - Math.sin(L.theta) * L.r);
      const heading = Math.atan2(-Math.sin(L.theta), -Math.cos(L.theta));
      a.vel.set(Math.sin(heading) * s.sp, 0, Math.cos(heading) * s.sp);
      a.aimYaw = heading - (((s.face ?? 0) * (s.flip ? -1 : 1)) * Math.PI) / 180;
      a.aimPitch = s.pitch ? Math.sin(u * 2.2) * 0.6 : 0;
      a.poseTarget = s.pose ?? {};
      a.reloadT = Math.max(0, a.reloadT - step);
      a.pose(step);
      a.label.position.copy(a.pos).setY(2.45);
    }
  }

  dispose() {
    removeEventListener('keydown', this.onKey);
    this.scene.remove(this.group);
    this.world.dispose();
  }
}
