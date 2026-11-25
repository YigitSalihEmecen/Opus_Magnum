import * as THREE from 'three';
import { Renderer } from './core/renderer.js';
import { Input } from './core/input.js';
import { AudioBank } from './core/audio.js';
import { TestRange } from './world/testRange.js';
import { Dummies } from './world/dummies.js';
import { Movement } from './player/movement.js';
import { CameraRig } from './player/cameraRig.js';
import { Viewmodel, addViewmodelLights } from './weapons/viewmodel.js';
import { Gunplay } from './weapons/gunplay.js';
import { WEAPONS } from './weapons/weapons.js';
import { WorldFX } from './weapons/effects.js';
import { HUD } from './ui/hud.js';
import { Menu } from './ui/menu.js';
import { Gunsmith } from './ui/gunsmith.js';

const canvas = document.getElementById('game');
const renderer = new Renderer(canvas);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 500);
const vmScene = new THREE.Scene();
const vmCamera = new THREE.PerspectiveCamera(54, innerWidth / innerHeight, 0.01, 10);

const range = new TestRange(scene);
const dummies = new Dummies(scene, range.dummySpots);
const targets = [...range.raycastTargets, ...dummies.hitboxes];

const input = new Input(canvas);
const audio = new AudioBank();
const hud = new HUD(document.getElementById('hud'));
const fx = new WorldFX(scene);

const mv = new Movement(range.octree, range.spawn);
const rig = new CameraRig(camera);
rig.yaw = range.spawn.yaw;
addViewmodelLights(vmScene);

// one viewmodel + gunplay per weapon; only the active one updates and renders
const arsenal = WEAPONS.map((def) => {
  const vm = new Viewmodel(vmScene, vmCamera, def);
  const gun = new Gunplay(def, { viewmodel: vm, audio, fx, hud, rig });
  vm.setActive(false);
  return { vm, gun };
});
let current = 0;
let pendingSwitch = null;
let { vm, gun } = arsenal[current];

function drawWeapon(i) {
  current = i;
  ({ vm, gun } = arsenal[i]);
  vm.setActive(true);
  gun.activate();
  hud.setWeapon(gun.def.name, gun.def.kind, arsenal.map((a, j) => ({ key: j + 1, name: a.gun.def.name, active: j === i })));
}

/** Number keys / wheel: holster the current weapon, then draw the next one. */
function switchWeapon(i) {
  if (i === current || pendingSwitch !== null || !arsenal[i] || vm.inspect || vm.swapping) return;
  vm.cancelClip();
  vm.holster(true);
  pendingSwitch = i;
  audio.play('cloth', { volume: 0.3, rate: 1.15 });
}

const gunsmith = new Gunsmith(document.getElementById('smith'), {
  getGun: () => gun,
  anchor: (slot, w, h) => vm.slotAnchor(slot, w, h),
});

/** F: bring the gun up for the gunsmith (blocked mid-reload / mantle / switch). */
function setInspect(on) {
  if (on && (vm.reloading || mv.state === 'mantle' || pendingSwitch !== null)) return;
  vm.setInspect(on);
  gunsmith.setOpen(on);
  hud.setInspecting(on);
}

// movement → audio / camera / viewmodel feedback
mv.onEvent = (name, d = {}) => {
  switch (name) {
    case 'step':
      audio.play('step', { volume: d.wall ? 0.07 : 0.025 + Math.min(0.05, d.speed * 0.006), rate: d.wall ? 1.15 : 1 });
      break;
    case 'jump':
      audio.play('cloth', { volume: 0.25 });
      if (!d.wall) audio.play('step', { volume: 0.06, rate: 0.9 });
      vm.kickPos.kick(0, -0.25, 0);
      vm.kickRot.kick(-0.6, 0, 0);
      break;
    case 'land': {
      const k = Math.min(1, d.impact / 14);
      audio.play('land', { volume: 0.15 + k * 0.5, rate: 1.05 - k * 0.15 });
      audio.play('step', { volume: 0.05 + k * 0.06, rate: 0.85 });
      rig.land(d.impact);
      vm.kickPos.kick(0, -0.3 - k * 0.5, 0);
      vm.kickRot.kick(-0.8 * k, 0, 0.3 * k);
      break;
    }
    case 'slideStart':
      audio.play('cloth', { volume: 0.45, rate: 0.85 });
      rig.punch(-1.2, 0, 1.5);
      break;
    case 'wallrunStart':
      audio.play('step', { volume: 0.08, rate: 1.1 });
      audio.play('cloth', { volume: 0.3 });
      vm.kickRot.kick(0, 0, d.side * 0.6);
      break;
    case 'mantle':
      audio.play('cloth', { volume: 0.5 });
      audio.play('step', { volume: 0.08, rate: 0.8, delay: 0.12 });
      rig.punch(-2, 0, 2);
      break;
    case 'fellOut':
      mv.respawn(range.spawn);
      rig.yaw = range.spawn.yaw;
      rig.pitch = 0;
      break;
  }
};

const menu = new Menu(document.getElementById('menu'), {
  onDeploy: () => {
    input.lock(); // synchronously, inside the click gesture — awaiting anything first makes browsers refuse
    audio.init();
  },
  onSettings: (s) => {
    rig.sensitivity = s.sensitivity;
    rig.hFov = s.fov;
    audio.setVolume(s.volume);
  },
});
menu.ready();

function showPaused() {
  input.devMode = false;
  input.locked = false;
  menu.show(true);
  hud.show(false);
  menu.paused(input.relockCooldown);
}

/** Esc is handled by the browser (it releases the mouse); P is ours and works even without a lock. */
function pause() {
  if (document.pointerLockElement) document.exitPointerLock();
  else showPaused();
}

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) {
    menu.show(false);
    hud.show(true);
  } else showPaused();
});
addEventListener('keydown', (e) => {
  if ((e.code === 'Escape' || e.code === 'KeyP') && input.locked && !e.repeat) pause();
});
input.onLockError = (err) => menu.notice(
  err?.name === 'WrongDocumentError'
    ? `This view can't capture the mouse — open ${location.origin} in Chrome, Safari or Firefox.`
    : 'Mouse lock was blocked — wait a second and click again.',
);
// clicking the game view while it isn't captured (dev mode, or lock lost) recaptures the mouse
canvas.addEventListener('click', () => { if (!input.pointerLocked) { input.lock(); audio.init(); } });

function resize() {
  renderer.resize(innerWidth, innerHeight);
  camera.aspect = vmCamera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  vmCamera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();
const VM_FOV_HIP = 54;

let now = 0;
function tick(dt) {
  now += dt;
  const live = input.locked;

  if (pendingSwitch !== null && vm.lowered) {
    vm.setActive(false);
    vm.holster(false);
    drawWeapon(pendingSwitch);
    pendingSwitch = null;
  }

  if (live) {
    if (input.pressed('KeyF') || (vm.inspect && input.clicked(2))) setInspect(!vm.inspect);
    if (!vm.inspect) {
      arsenal.forEach((_, i) => { if (input.pressed(`Digit${i + 1}`)) switchWeapon(i); });
      if (input.wheel) switchWeapon((current + (input.wheel > 0 ? 1 : -1) + arsenal.length) % arsenal.length);
    }
    const adsSens = THREE.MathUtils.lerp(1, gun.S.adsSensitivity / Math.sqrt(gun.zoom / 1.32), gun.adsEased);
    if (!vm.inspect) rig.look(input, adsSens);
    mv.update(dt, input, rig.yaw);
  }
  const axes = live ? input.axes() : { x: 0, y: 0 };
  rig.update(dt, mv, { ads: gun.adsEased, axes, zoom: gun.zoom });
  camera.updateMatrixWorld();
  if (live) gun.update(dt, { input, mv, camera, targets, now, blocked: vm.inspect || vm.inspectEase > 0.25 || vm.swapping || pendingSwitch !== null });
  if (live) gunsmith.update(dt, input);

  const ads = gun.adsEased;
  const vmFov = THREE.MathUtils.lerp(VM_FOV_HIP, vm.optic.vmFov, ads);
  if (Math.abs(vmCamera.fov - vmFov) > 1e-3) { vmCamera.fov = vmFov; vmCamera.updateProjectionMatrix(); }
  const cursor = vm.inspect ? { x: gunsmith.cursor.x / innerWidth * 2 - 1, y: gunsmith.cursor.y / innerHeight * 2 - 1 } : null;
  vm.update(dt, { mv, axes, mouseDX: vm.inspect ? 0 : input.mouseDX, mouseDY: vm.inspect ? 0 : input.mouseDY, ads, triggerHeld: gun.triggerHeld, cursor });

  dummies.update(dt, camera, now);
  fx.update(dt, camera);
  hud.update(dt, { mv, gun, camera });
  audio.setLoops({
    wind: THREE.MathUtils.clamp((mv.speed - 6) / 9, 0, 1) + (mv.state === 'air' ? Math.min(0.5, Math.abs(mv.vel.y) / 20) : 0),
    scrape: mv.state === 'slide' ? Math.min(1, mv.speed / 10) : mv.state === 'wallrun' ? 0.35 : 0,
  });

  renderer.render(scene, camera, vmScene, vmCamera, { eyepiece: vm.eyepieceInfo(), focus: vm.inspectEase });
  input.endFrame();
}

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!window.OM?.frozen) tick(dt); // OM.frozen = true: only OM.step() advances (frame-exact captures)
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// dev handle for tuning from the console; ?dev skips the menu and pointer lock (keyboard only)
drawWeapon(0);

window.OM = {
  get vm() { return vm; }, get gun() { return gun; }, arsenal, switchWeapon,
  mv, rig, range, dummies, scene, vmScene, input, gunsmith, setInspect,
  step: (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) tick(dt); },
};
if (new URLSearchParams(location.search).has('dev')) {
  input.devMode = true;
  input.locked = true;
  menu.show(false);
  hud.show(true);
}
