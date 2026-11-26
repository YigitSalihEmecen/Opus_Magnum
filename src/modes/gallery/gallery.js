import * as THREE from 'three';
import { Avatar } from '../../character/avatar.js';
import { CHARACTERS } from '../../character/characters.js';
import { motionClips } from '../../character/motion.js';
import { textTexture } from '../../core/toon.js';
import { FX_LAYER } from '../../core/renderer.js';

/*
  Animation gallery: every animation on every robot, on an open floor you can walk around.
  Per character, two rows facing you:
    clips   — each captured clip on its own, exactly as authored (one-shots repeat after a pause)
    in game — the body as bots and online players show it: clips blended and shaped by speed, direction,
              stance and aim, the way the game drives them, running in place
  [ and ] slow down / speed up time, \\ freezes it. Robots far from you rest hidden (labels stay up).
  Loaded only when picked (main.js MODES).
*/

const GAP = 3.4, ROW = 7, LABEL_Y = 2.45;
const NEAR = 26; // robots further than this from you rest hidden (sixty bodies at once is a lot of draw calls)
const SPEEDS = [0, 0.1, 0.25, 0.5, 1, 1.5];
const NAMES = { idle: 'Idle', walk: 'Walk', jog: 'Jog', sprint: 'Sprint', crouchIdle: 'Crouch idle', crouchWalk: 'Crouch walk', jump: 'Jump start', air: 'In the air', land: 'Landing', hit: 'Hit', slide: 'Slide', climb: 'Climb up' };

// what the game drives: speed (m/s), travel direction relative to facing (°), stance, and scripted changes
const STATES = [
  { label: 'Idle', sp: 0 },
  { label: 'Walk', sp: 1.4 },
  { label: 'Run', sp: 3.6 },
  { label: 'Sprint', sp: 5.4 },
  { label: 'Strafe', sp: 3.6, dir: 90 },
  { label: 'Backpedal', sp: 3.0, dir: 180 },
  { label: 'Run in a circle', sp: 4.5, turn: 1.4 },
  { label: 'Start / stop', sp: (t) => (t % 3 < 1.5 ? 5.4 : 0) },
  { label: 'Crouch', sp: 0, pose: { crouch: 1 } },
  { label: 'Crouch walk', sp: 2.0, pose: { crouch: 1 } },
  { label: 'Slide', sp: 6.5, pose: { slide: 1, crouch: 1 } },
  { label: 'Jump / land', sp: 4, pose: (t) => ({ air: t % 2.4 < 1.0 ? 1 : 0 }) },
  { label: 'Wallrun', sp: 6, pose: { wall: 1 } },
  { label: 'Climb (mantle)', sp: 1, pose: (t) => ({ mantle: t % 2 < 0.9 ? 1 : 0 }) },
  { label: 'Aim sweep', sp: 0, pitch: (t) => Math.sin(t * 1.3) * 0.9 },
  { label: 'Aiming down sights', sp: 0, pose: { ads: 1 } },
  { label: 'Reload', sp: 0, reload: 2.4 },
  { label: 'Hit flinch', sp: 0, hit: 1.4 },
];

function label(text, wide = false) {
  const tex = textTexture([{ text }], { width: wide ? 1024 : 640, height: 128, font: '600 64px "Space Grotesk", sans-serif', align: 'center', pad: 24 });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, toneMapped: false }));
  s.scale.set(wide ? 3.6 : 2.2, wide ? 0.45 : 0.44, 1);
  s.layers.set(FX_LAYER);
  return s;
}

export async function createGallery({ scene, hud, buildWorld }) {
  const clips = Object.values(motionClips());
  const rows = CHARACTERS.flatMap((ch) => [
    { title: `${ch.name} · clips`, char: ch.id, items: clips.map((c) => ({ clip: c.name, label: NAMES[c.name] ?? c.name })) },
    { title: `${ch.name} · in game`, char: ch.id, items: STATES },
  ]);
  const width = Math.max(...rows.map((r) => r.items.length)) * GAP;
  const size = Math.ceil((width + 16) / 8) * 8;
  const world = await buildWorld({ size, pieces: [{ type: 'spawn_ally', x: 0, y: 0, z: 9, rot: 0 }] });
  return new Gallery({ scene, hud, world, rows });
}

class Gallery {
  constructor({ scene, hud, world, rows }) {
    Object.assign(this, { scene, hud, world });
    this.octree = world.octree;
    this.spawn = world.spawns.ally[0];
    this.targets = world.raycastTargets;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.time = 0;
    this.speed = 4; // index into SPEEDS: real time
    this.bodies = [];
    rows.forEach((row, r) => {
      const z = -r * ROW;
      const x0 = (-(row.items.length - 1) * GAP) / 2;
      const title = label(row.title, true);
      title.position.set(x0 - GAP * 1.4, 1.2, z);
      this.group.add(title);
      row.items.forEach((item, i) => {
        const a = new Avatar({ team: 'enemy', name: item.label, char: row.char });
        a.alive = true;
        a.root.visible = true;
        a.pos.set(x0 + i * GAP, 0, z);
        a.home = a.pos.clone();
        a.item = item;
        this.group.add(a.root);
        const tag = label(item.label);
        tag.position.set(a.pos.x, LABEL_Y, z);
        this.group.add(tag);
        this.bodies.push(a);
      });
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

  update(dt, { camera }) {
    const k = SPEEDS[this.speed], step = dt * k;
    this.time += step;
    const t = this.time;
    for (const a of this.bodies) {
      a.root.visible = a.home.distanceTo(camera.position) < NEAR;
      if (!a.root.visible) continue;
      const s = a.item;
      if (s.clip) {
        // a one-shot clip plays, holds a beat, plays again
        const c = a.motion.clips[s.clip];
        a.showClip(s.clip, c.loop ? t : t % (c.duration + 0.7));
        continue;
      }
      if (!step) continue;
      const sp = typeof s.sp === 'function' ? s.sp(t) : s.sp;
      const heading = s.turn ? t * s.turn : ((s.dir ?? 0) * Math.PI) / 180;
      a.aimYaw = s.turn ? heading : 0;
      a.vel.set(Math.sin(heading) * sp, 0, Math.cos(heading) * sp);
      a.poseTarget = (typeof s.pose === 'function' ? s.pose(t) : s.pose) ?? {};
      a.aimPitch = s.pitch ? s.pitch(t) : 0;
      if (s.reload && t % s.reload < step) a.reloadT = a.reloadTime;
      a.reloadT = Math.max(0, a.reloadT - step);
      if (s.hit && t % s.hit < step) a.flash = 0.08;
      a.pos.copy(a.home); // running in place
      a.pose(step);
    }
  }

  dispose() {
    removeEventListener('keydown', this.onKey);
    this.scene.remove(this.group);
    this.world.dispose();
  }
}
