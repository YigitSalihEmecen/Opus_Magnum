import * as THREE from 'three';
import { PALETTE as P } from '../core/toon.js';
import { applySky } from '../world/sky.js';
import { gripGun } from '../character/robot.js';
import { CHARACTERS, buildCharacter, selectedCharacter, selectCharacter } from '../character/characters.js';
import { buildPiece, makeContext } from '../maps/assets.js';
import { WEAPONS } from '../weapons/weapons.js';

/*
  Title-screen lobby: every character idles with its signature gun in a scrapyard corner; picking one (the cards)
  swings the camera over to it. Drag on the scene to orbit the camera around it, scroll to zoom.
  Idles are plain AnimationClips on the shared skeleton, played by an AnimationMixer; the arms are solved
  onto the gun grips after the mixer runs.
*/

const D2R = Math.PI / 180;
const _q = new THREE.Quaternion(), _e = new THREE.Euler();
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));

/** Quaternion track from [time, [rx, ry, rz] degrees] keys. */
function rot(bone, keys) {
  const values = keys.flatMap(([, r]) => _q.setFromEuler(_e.set(r[0] * D2R, r[1] * D2R, r[2] * D2R)).toArray());
  return new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, keys.map(([t]) => t), values);
}
const pos = (bone, keys) => new THREE.VectorKeyframeTrack(`${bone}.position`, keys.map(([t]) => t), keys.flatMap(([, p]) => p));
const still = (bone, r, T) => rot(bone, [[0, r], [T, r]]);
/** Two-pose bounce repeated every half second over T seconds. */
const bounce = (bone, a, b, T) => rot(bone, Array.from({ length: T * 2 + 1 }, (_, i) => [i / 2, i % 2 ? b : a]));

/** Rivet: heavy, planted rifle idle — slow breathing, weight shifting onto the right leg, a look around. */
function rivetIdle(hy) {
  const T = 6;
  return new THREE.AnimationClip('idle', T, [
    pos('hips', [[0, [0, hy - 0.03, 0]], [1.5, [0.018, hy - 0.042, 0]], [3, [0, hy - 0.03, 0]], [4.5, [-0.012, hy - 0.038, 0]], [T, [0, hy - 0.03, 0]]]),
    rot('hips', [[0, [0, -22, 0]], [1.5, [0, -24, -2.5]], [3, [0, -22, 0]], [4.5, [0, -20, 1.5]], [T, [0, -22, 0]]]),
    rot('spine', [[0, [3, 8, 0]], [1.5, [4, 9, 2]], [3, [3, 8, 0]], [4.5, [4, 7, -1]], [T, [3, 8, 0]]]),
    rot('chest', [[0, [2, 6, 0]], [1, [-1, 6, 0]], [2, [2, 6, 0]], [3, [-1, 6, 0]], [4, [2, 6, 0]], [5, [-1, 6, 0]], [T, [2, 6, 0]]]),
    rot('neck', [[0, [0, 0, 0]], [1.2, [0, 0, 0]], [2, [4, 22, 0]], [3.2, [4, 24, 3]], [3.9, [-2, -6, 0]], [5, [0, -10, 0]], [T, [0, 0, 0]]]),
    rot('head', [[0, [0, 0, 0]], [2, [-3, 6, 0]], [3.2, [-4, 6, 0]], [4, [0, 0, 0]], [T, [0, 0, 0]]]),
    rot('thigh_L', [[0, [-10, 4, 8]], [1.5, [-8, 4, 10]], [3, [-10, 4, 8]], [4.5, [-12, 4, 7]], [T, [-10, 4, 8]]]),
    rot('shin_L', [[0, [16, 0, 0]], [1.5, [18, 0, 0]], [3, [16, 0, 0]], [4.5, [14, 0, 0]], [T, [16, 0, 0]]]),
    still('foot_L', [-6, 10, -6], T),
    rot('thigh_R', [[0, [6, -6, -4]], [1.5, [4, -6, -3]], [3, [6, -6, -4]], [4.5, [7, -6, -5]], [T, [6, -6, -4]]]),
    rot('shin_R', [[0, [6, 0, 0]], [1.5, [8, 0, 0]], [3, [6, 0, 0]], [4.5, [5, 0, 0]], [T, [6, 0, 0]]]),
    still('foot_R', [-12, -4, 3], T),
  ]);
}

/** Kite: light on its feet — bouncing knees, hip cocked, quick head tilts like it's listening. */
function kiteIdle(hy) {
  const T = 4;
  return new THREE.AnimationClip('idle', T, [
    pos('hips', Array.from({ length: T * 2 + 1 }, (_, i) => [i / 2, [0.03, hy - (i % 2 ? 0.055 : 0.04), 0]])),
    rot('hips', [[0, [0, -14, 5]], [2, [0, -16, 6]], [T, [0, -14, 5]]]),
    rot('spine', [[0, [4, 6, -4]], [1, [5, 7, -5]], [2, [4, 6, -4]], [3, [5, 5, -3]], [T, [4, 6, -4]]]),
    bounce('chest', [3, 4, -2], [1, 4, -2], T),
    rot('neck', [[0, [0, -8, 0]], [0.8, [0, -8, 0]], [1.0, [-6, 18, 12]], [1.9, [-6, 20, 14]], [2.1, [2, -4, -4]], [3.2, [2, -6, -6]], [3.4, [0, -8, 0]], [T, [0, -8, 0]]]),
    still('head', [-4, 0, 0], T),
    bounce('thigh_L', [-14, 0, 6], [-17, 0, 6], T),
    bounce('shin_L', [20, 0, 0], [26, 0, 0], T),
    still('foot_L', [-6, 6, -6], T),
    bounce('thigh_R', [10, -4, -6], [8, -4, -6], T),
    bounce('shin_R', [14, 0, 0], [20, 0, 0], T),
    still('foot_R', [-22, -4, 6], T),
  ]);
}

/** Where each character stands and how it carries its gun (gun frame on the chest bone). */
const STAGE = {
  rivet: { at: [-1.0, 0, 0], yaw: 0.25, focusY: 1.05, orbit: [-1.5, 0.9], clip: rivetIdle, gun: { pos: [-0.04, -0.06, 0.34], rot: [-0.55, Math.PI + 0.55, -0.25] } },
  kite: { at: [1.0, 0, 0.15], yaw: -0.3, focusY: 1.15, orbit: [-0.9, 1.5], clip: kiteIdle, gun: { pos: [-0.03, -0.02, 0.3], rot: [-0.35, Math.PI + 0.5, -0.4] } },
};

export class Lobby {
  constructor(scene, camera, canvas) {
    Object.assign(this, { scene, camera, canvas });
    this.group = new THREE.Group();
    scene.add(this.group);
    applySky(scene);
    scene.fog = new THREE.Fog(P.pampas, 30, 140);
    this.#yard();

    this.actors = CHARACTERS.map((ch) => {
      const st = STAGE[ch.id];
      const robot = buildCharacter(ch.id, 'player');
      robot.root.position.set(...st.at);
      robot.root.rotation.y = st.yaw;
      this.group.add(robot.root);
      const def = WEAPONS.find((w) => w.id === ch.weapon) ?? WEAPONS[0];
      const frame = new THREE.Group();
      frame.position.set(...st.gun.pos);
      frame.rotation.set(...st.gun.rot, 'YXZ');
      robot.bones.chest.add(frame);
      frame.add(def.build().root);
      robot.root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      const mixer = new THREE.AnimationMixer(robot.root);
      const action = mixer.clipAction(st.clip(robot.bones.hips.position.y));
      action.play();
      return { ch, robot, def, frame, mixer };
    });

    // selection ring under the chosen character
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: P.clay, toneMapped: false }));
    this.ring.position.y = 0.012;
    this.group.add(this.ring);

    this.view = { yaw: 0.18, pitch: 0.1, dist: 3.1 };
    this.cur = { ...this.view };
    this.focus = new THREE.Vector3();
    this.idleT = 0;
    this.#picker();
    this.select(selectedCharacter(), true);
    this.#controls();
  }

  #yard() {
    this.group.add(new THREE.HemisphereLight(0xfffaf0, P.kraft, 1.3));
    const sun = new THREE.DirectionalLight(0xfff4e6, 2.4);
    sun.position.set(-6, 12, 9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 40 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.group.add(sun, sun.target);
    const props = [
      ...[-4, 0, 4].flatMap((x) => [-4, 0, 4].map((z) => ({ type: 'floor', x, z, color: P.oat }))),
      { type: 'container', x: -1.2, z: -5.2, rot: 0, color: P.sky }, { type: 'container', x: -0.4, z: -5.2, y: 2.4, rot: 6, color: P.clay },
      { type: 'container', x: 6.2, z: -2.5, rot: 70, color: P.sage },
      { type: 'barrel', x: 2.6, z: -2.6, color: P.clay }, { type: 'barrel', x: 3.4, z: -2.1, color: P.slate }, { type: 'barrel', x: 3.0, z: -3.3, color: P.kraft },
      { type: 'crate', x: -3.4, z: -2.4, rot: 18, color: P.kraft }, { type: 'crate', x: -3.6, z: -2.6, y: 1.18, rot: 5, color: P.sage },
      { type: 'sandbags', x: -2.8, z: 1.4, rot: 30, color: P.kraft }, { type: 'pole', x: 4.6, z: -5.4, color: P.kraft },
    ];
    const ctx = makeContext(props, () => 0);
    for (const rec of props) { const p = buildPiece(rec, ctx(rec)); if (p) this.group.add(p); }
    const ground = new THREE.Mesh(new THREE.CircleGeometry(80, 48).rotateX(-Math.PI / 2), new THREE.MeshToonMaterial({ color: 0xe7dfcf }));
    ground.position.y = -0.01;
    this.group.add(ground);
    this.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  }

  #picker() {
    const el = (this.ui = document.createElement('div'));
    el.className = 'char-pick';
    el.innerHTML = CHARACTERS.map((c) => `
      <button class="char card" type="button" data-id="${c.id}">
        <b>${c.name}</b>
      </button>`).join('');
    el.querySelectorAll('.char').forEach((b) => b.addEventListener('click', () => this.select(b.dataset.id)));
    document.body.appendChild(el);
  }

  select(id, snap = false) {
    const a = this.actors.find((x) => x.ch.id === id) ?? this.actors[0];
    this.selected = a;
    selectCharacter(a.ch.id);
    this.ui.querySelectorAll('.char').forEach((b) => b.classList.toggle('on', b.dataset.id === a.ch.id));
    this.view.yaw = a.robot.root.rotation.y * 0.6 + 0.12;
    if (snap) { this.focus.copy(a.robot.root.position).setY(STAGE[a.ch.id].focusY); Object.assign(this.cur, this.view); }
  }

  /** Hold-and-drag orbits around the selected character, wheel zooms; a click on a robot selects it. */
  #controls() {
    const c = this.canvas;
    let drag = null;
    const down = (e) => { drag = { x: e.clientX, y: e.clientY }; };
    const move = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      this.view.yaw = THREE.MathUtils.clamp(this.view.yaw - dx * 0.006, ...STAGE[this.selected.ch.id].orbit);
      this.view.pitch = THREE.MathUtils.clamp(this.view.pitch + dy * 0.004, -0.05, 0.6);
      this.idleT = 0;
    };
    const up = () => { drag = null; };
    const wheel = (e) => { this.view.dist = THREE.MathUtils.clamp(this.view.dist + e.deltaY * 0.002, 1.6, 4.5); this.idleT = 0; e.preventDefault(); };
    c.addEventListener('pointerdown', down);
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    c.addEventListener('wheel', wheel, { passive: false });
    this.unbind = () => {
      c.removeEventListener('pointerdown', down);
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      c.removeEventListener('wheel', wheel);
    };
  }

  update(dt) {
    for (const x of this.actors) { x.mixer.update(dt); gripGun(x.robot, x.frame, x.def.poses); }
    const sel = this.selected.robot.root.position;
    this.ring.position.x = damp(this.ring.position.x, sel.x, 10, dt);
    this.ring.position.z = damp(this.ring.position.z, sel.z, 10, dt);
    this.focus.x = damp(this.focus.x, sel.x, 4, dt);
    this.focus.z = damp(this.focus.z, sel.z, 4, dt);
    this.focus.y = damp(this.focus.y, STAGE[this.selected.ch.id].focusY, 4, dt);

    // after a while without input, drift back toward the default framing
    this.idleT += dt;
    if (this.idleT > 6) { this.view.pitch = damp(this.view.pitch, 0.1, 0.6, dt); this.view.dist = damp(this.view.dist, 3.1, 0.6, dt); }
    for (const k of ['yaw', 'pitch', 'dist']) this.cur[k] = damp(this.cur[k], this.view[k], 8, dt);

    // a panel open on the left (the modes, maps, the room form): the robot moves into the free space between it and the
    // character cards on the right; mid-swap (no panel yet) it holds where it was
    const sheet = document.querySelector('#title:not([hidden]) > .sheet');
    if (sheet && !sheet.classList.contains('out')) {
      const box = sheet.classList.contains('home') ? sheet : sheet.querySelector('.mode-pick') ?? sheet; // the home sidebar, or the open menu
      const left = box.getBoundingClientRect().right;
      const pick = this.ui.getBoundingClientRect().left;
      const right = innerWidth > 720 && pick > left ? pick : innerWidth;
      this.goal = left && right - left > 160 ? (left + right) / 2 : innerWidth * 0.56;
    }
    this.shift = damp(this.shift ?? this.goal ?? innerWidth * 0.56, this.goal ?? innerWidth * 0.56, 6, dt);
    const { yaw, pitch, dist } = this.cur;
    const cam = this.camera;
    const target = _t.copy(this.focus);
    target.y += (3.1 - dist) * 0.25; // zooming in moves the view up toward the head
    cam.position.set(target.x + Math.sin(yaw) * Math.cos(pitch) * dist, target.y + Math.sin(pitch) * dist + 0.1, target.z + Math.cos(yaw) * Math.cos(pitch) * dist);
    cam.lookAt(target.x, target.y - 0.12, target.z);
    cam.fov = 40;
    cam.setViewOffset(innerWidth, innerHeight, innerWidth / 2 - this.shift, 0, innerWidth, innerHeight); // robot at x = shift px
  }

  dispose() {
    this.unbind();
    this.ui.remove();
    for (const a of this.actors) a.mixer.stopAllAction();
    this.scene.remove(this.group);
    this.scene.fog = null;
    this.camera.clearViewOffset();
  }
}

const _t = new THREE.Vector3();
