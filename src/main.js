import * as THREE from 'three';
import { Octree } from 'three/examples/jsm/math/Octree.js';
import { Renderer } from './core/renderer.js';
import { Input } from './core/input.js';
import { AudioBank } from './core/audio.js';
import { TestRange } from './world/testRange.js';
import { Dummies } from './world/dummies.js';
import { Movement, SPEED } from './player/movement.js';
import { CameraRig } from './player/cameraRig.js';
import { Viewmodel, addViewmodelLights } from './weapons/viewmodel.js';
import { Gunplay } from './weapons/gunplay.js';
import { WEAPONS } from './weapons/weapons.js';
import { silhouettes } from './ui/silhouettes.js';
import { WorldFX } from './weapons/effects.js';
import { HUD } from './ui/hud.js';
import { Menu } from './ui/menu.js';
import { Gunsmith } from './ui/gunsmith.js';
import { Title } from './ui/title.js';
import { Lobby } from './ui/lobby.js';
import { Scoreboard } from './ui/scoreboard.js';
import { selectedCharacter } from './character/characters.js';
import { Vitals } from './player/vitals.js';
import { Inventory } from './items/inventory.js';
import { Pickups } from './items/pickups.js';
import { Grenades, BLAST } from './items/grenades.js';
import { Handheld } from './items/handheld.js';
import { ITEM_IDS } from './items/items.js';
import { VitalsHud } from './ui/vitalsHud.js';
import { listMaps, getMap, hasSpawns } from './maps/storage.js';

const canvas = document.getElementById('game');
const renderer = new Renderer(canvas);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf0eee6); // behind the title until a level sets its own
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 500);
const vmScene = new THREE.Scene();
const emptyScene = new THREE.Scene();
const vmCamera = new THREE.PerspectiveCamera(54, innerWidth / innerHeight, 0.01, 10);

/*
  Modes build their world on demand. A level is either
    play:  { octree, spawn, targets, update(dt, ctx), playerAlive?, ended? }
    owner: { frame(dt) }  — takes over the whole frame (the map editor)
  load(mapId) gets a saved custom map's id, or null for the mode's own map.
  TDM (src/modes/tdm/), online play (src/net/) and the editor (src/modes/editor/) are only loaded when
  picked and don't depend on each other: delete a folder and its entry here to remove it. Maps
  (src/maps/) are shared by all of them.
*/
const customWorld = async (mapId) => (await import('./maps/mapWorld.js')).buildMapWorld(scene, getMap(mapId));
const MODES = [
  {
    id: 'range', index: '01 / PRACTICE', title: 'Shooting Range', short: 'Warm up and tune', accent: '#8a9a7b', builtin: 'Test Range', blurb: 'Targets, wallrun lanes, mantle steps and a slide ramp. Tune your feel and your loadout.',
    load: async (mapId) => {
      if (mapId && getMap(mapId)) {
        const w = await customWorld(mapId);
        return { octree: w.octree, spawn: w.spawn, targets: w.raycastTargets, pickups: new Pickups(scene, { octree: w.octree, spots: w.pickups, respawn: 20 }), update: () => {} };
      }
      const range = new TestRange(scene);
      const dummies = new Dummies(scene, range.dummySpots);
      // every item on a line in front of the spawn, back a few seconds after you take it
      const spots = ITEM_IDS.map((type, i) => ({ type, position: new THREE.Vector3((i - (ITEM_IDS.length - 1) / 2) * 1.7, 0, 34) }));
      return {
        range, dummies, octree: range.octree, spawn: range.spawn, targets: [...range.raycastTargets, ...dummies.hitboxes],
        pickups: new Pickups(scene, { octree: range.octree, spots, respawn: 3 }),
        update: (dt, c) => dummies.update(dt, c.camera, c.now),
      };
    },
  },
  {
    id: 'tdm', index: '02 / MATCH', title: 'Team Deathmatch', short: '5 v 5 against bots', accent: '#d97757', builtin: 'Kiln', needsSpawns: hasSpawns,
    blurb: 'You and four allies against five enemy bots. First team to 40 eliminations wins.',
    load: async (mapId) => {
      const arena = mapId && getMap(mapId) ? await customWorld(mapId) : undefined;
      return (await import('./modes/tdm/tdm.js')).createTDM({ scene, camera, audio, mv, rig, arsenal, arena, inv, vitals });
    },
  },
  {
    id: 'online', index: '03 / ONLINE', title: 'Multiplayer', short: 'Play with friends', accent: '#6b6a4f',
    lobby: { server: /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? 'ws://localhost:8787' : 'wss://bitter-canavar.tailb7f1ff.ts.net:8443', map: 'builtin-duel' },
    load: async (mapId, opts) => (await import('./net/online.js')).createOnline({
      scene, camera, audio, hud, mv, rig, arsenal, inv, vitals, getMap,
      opts: { name: 'Player', room: 'duel', server: MODES.find((m) => m.id === 'online').lobby.server, char: selectedCharacter(), maps: listMaps().filter((m) => m.online).map((m) => m.id), ...opts, mapId: mapId ?? 'builtin-duel' },
      buildWorld: async (map) => (await import('./maps/mapWorld.js')).buildMapWorld(scene, map),
    }),
  },
  {
    id: 'editor', index: '04 / CREATE', title: 'Map Editor', short: 'Build your own map', accent: '#9fb4c7', lock: false, blurb: 'Lay out walls, containers, cars and fences on a grid. Saved maps show up here to play.',
    load: async () => (await import('./modes/editor/editor.js')).createEditor({ renderer, scene, canvas, onExit: () => { location.href = location.pathname; } }),
  },
];
let level = null;
let targets = [];

const input = new Input(canvas);
const audio = new AudioBank();
const hud = new HUD(document.getElementById('hud'));
const scoreboard = new Scoreboard();
const fx = new WorldFX(scene);

const mv = new Movement(new Octree(), { position: new THREE.Vector3(), yaw: 0 }); // real world arrives with the level
const vitals = new Vitals();
const vitalsHud = new VitalsHud(document.getElementById('hud'));
const rig = new CameraRig(camera);
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
const inv = new Inventory({ arsenal, vitals, audio, hud });
const handheld = new Handheld(vmScene);
let grenades = null;
let prompt = null;

let icons = null;
let iconsStale = true; // re-drawn once the gunsmith closes and the attachment swaps have settled
const loadoutSlots = () => {
  if (iconsStale || !icons) { icons = silhouettes(arsenal.map((a) => a.vm.model)); iconsStale = false; }
  return inv.guns.map((j, k) => ({ key: k + 1, name: arsenal[j].gun.def.name, icon: icons[j], active: j === current }));
};

function drawWeapon(i) {
  current = i;
  ({ vm, gun } = arsenal[i]);
  vm.setActive(true);
  gun.activate();
  hud.setWeapon(gun.def.name, gun.def.kind, loadoutSlots());
}

/** Number keys / wheel: holster the current weapon, then draw the next one. */
function switchWeapon(i) {
  if (i === current || pendingSwitch !== null || !inv.carries(i) || vm.inspect || vm.swapping) return;
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
  if (on && (vm.reloading || mv.state === 'mantle' || mv.state === 'vault' || pendingSwitch !== null || inv.busy)) return;
  vm.setInspect(on);
  gunsmith.setOpen(on);
  hud.setInspecting(on);
  if (!on) iconsStale = true;
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
    case 'vault':
      audio.play('cloth', { volume: 0.5, rate: 1.1 });
      audio.play('step', { volume: 0.1, rate: 0.9, delay: 0.08 });
      rig.punch(-1.2, 0, -1.5);
      break;
    case 'vaultEnd':
      audio.play('step', { volume: 0.14, rate: 0.85 });
      rig.punch(0.8, 0, 0);
      break;
    case 'fellOut':
      mv.respawn(level.spawn);
      rig.yaw = level.spawn.yaw;
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
    renderer.setQuality(s.graphics);
    rig.sensitivity = s.sensitivity;
    rig.hFov = s.fov;
    audio.setVolume(s.volume);
  },
  onTitle: () => { location.href = location.pathname; },
});
menu.ready();
menu.show(false);

async function startMode(id, mapId = null, opts) {
  const mode = MODES.find((m) => m.id === id) ?? MODES[0];
  title.show(false);
  lobby?.dispose();
  lobby = null;
  for (const a of arsenal) a.vm.setCharacter(selectedCharacter());
  document.querySelector('#hud .brand .label').textContent = mapId ? `${mode.title} · ${getMap(mapId)?.name ?? ''}` : `${mode.title} · 0.3`;
  try {
    level = await mode.load(mapId, opts);
  } catch (err) {
    if (document.pointerLockElement) document.exitPointerLock();
    lobby = new Lobby(scene, camera, canvas);
    title.show(true);
    title.notice(err.message);
    return;
  }
  if (level.frame) return; // the editor drives its own frame
  bindWorld();
  level.onMap = bindWorld; // online: the map vote swapped the world under us
  handheld.setCharacter(selectedCharacter());
  vitals.reset();
  inv.reset(level.loadout);
  if (!inv.carries(current)) { vm.setActive(false); drawWeapon(inv.guns[0]); }
  iconsStale = true;
  mv.respawn(level.spawn);
  rig.yaw = level.spawn.yaw;
  rig.pitch = 0;
}

/** Hook the player up to the level's world: collision, pickups, grenades, what bullets can hit. */
function bindWorld() {
  level.pickups ??= new Pickups(scene, { octree: level.octree });
  level.pickups.onGrant = (p) => { const drawn = inv.receive(p, current); if (drawn !== null) switchWeapon(drawn); };
  inv.onDrop = (d) => level.pickups.release(d, dropPoint());
  grenades?.dispose();
  grenades = level.grenades = new Grenades(scene, { octree: level.octree, audio, camera, onBlast });
  mv.octree = level.octree;
  targets = level.targets;
}

const title = new Title(document.getElementById('title'), {
  modes: MODES,
  getMaps: listMaps,
  onPick: (id, mapId, opts) => {
    if (MODES.find((m) => m.id === id)?.lock !== false) input.lock(); // inside the click gesture, before the level loads
    audio.init();
    startMode(id, mapId, opts);
  },
});

function showPaused() {
  if (!level || level.ended || level.frame) return;
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
input.onLockError = (err) => (level ? menu : title).notice(
  err?.name === 'WrongDocumentError'
    ? `This view can't capture the mouse — open ${location.origin} in Chrome, Safari or Firefox.`
    : 'Mouse lock was blocked — wait a second and click again.',
);
// clicking the game view while it isn't captured (dev mode, or lock lost) recaptures the mouse
canvas.addEventListener('click', () => { if (level && !level.frame && !level.ended && !input.pointerLocked) { input.lock(); audio.init(); } });

const _fwd = new THREE.Vector3(), _right = new THREE.Vector3();

/** Where a dropped gun lands: a step ahead of the feet. */
function dropPoint() {
  camera.getWorldDirection(_fwd).setY(0).normalize();
  return mv.feet.clone().addScaledVector(_fwd, 0.9);
}

/** G: the grenade leaves the hand a little right of the eye; online modes pass it on. */
inv.onThrow = () => {
  camera.getWorldDirection(_fwd);
  _right.setFromMatrixColumn(camera.matrixWorld, 0);
  const origin = camera.position.clone().addScaledVector(_fwd, 0.35).addScaledVector(_right, 0.12);
  const g = grenades.throw(origin, _fwd, mv.vel);
  level.onThrow?.(g);
};

/** A grenade went off. Ours deal damage to whatever they reach (and to us); any blast shakes the view. */
function onBlast(pos, mine) {
  const chest = mv.feet.clone().setY(mv.feet.y + mv.height * 0.55);
  const d = chest.distanceTo(pos);
  if (d < 14) rig.punch(-(1 - d / 14) * 4, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 4);
  if (!mine || !level) return;
  for (const h of grenades.reach(pos, targets)) {
    const res = h.target.damage(h.dmg, 'blast', h.point, h.dir, now);
    if (!res) continue;
    hud.hitmarker(res.killed ? 'kill' : 'hit');
    hud.damageNumber(h.point, h.dmg, false);
    audio.hit(res.killed ? 'kill' : 'body');
  }
  if (d < BLAST.radius && (level.playerAlive ?? true) && grenades.clear(pos, chest)) {
    const dmg = Math.round(BLAST.damage * BLAST.self * (1 - THREE.MathUtils.smoothstep(d, BLAST.full, BLAST.radius)));
    if (dmg > 0) level.hurtSelf ? level.hurtSelf(dmg) : vitals.damage(dmg);
  }
}

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
let wasAlive = true;
let wasLowered = false;
function tick(dt) {
  now += dt;
  if (level?.frame) { level.frame(dt); input.endFrame(); return; }
  if (!level) { lobby?.update(dt); renderer.render(scene, camera, emptyScene, vmCamera, {}); return; } // title: no gun yet
  // modes without deaths of their own (the range): a fatal blast just puts you back at the start
  if (level.playerAlive === undefined && vitals.dead) {
    mv.respawn(level.spawn);
    rig.yaw = level.spawn.yaw;
    rig.pitch = 0;
    vitals.reset();
  }
  const alive = level?.playerAlive ?? true;
  const live = input.locked && !!level && alive && !level.ended;
  // a mode can take the player out (TDM death): drop the gun, lower the arms, bring them back on respawn
  if (alive !== wasAlive) {
    wasAlive = alive;
    if (!alive) {
      inv.cancel();
      level.pickups?.release({ gun: current, ammo: gun.ammo, reserve: gun.reserve === Infinity ? 2 * gun.magSize : gun.reserve }, mv.feet.clone());
    }
  }
  // the gun goes down while dead or while the hands are busy with an item
  const lowered = !alive || inv.busy;
  if (lowered !== wasLowered) {
    wasLowered = lowered;
    if (lowered) { vm.cancelClip(); vm.holster(true); setInspect(false); } else { vm.holster(false); gun.activate(); }
  }
  if (!inv.carries(current) && pendingSwitch === null && inv.guns.length) switchWeapon(inv.guns[0]);

  if (iconsStale && icons && !vm.inspect && !vm.swapping) hud.setLoadout(loadoutSlots());

  if (pendingSwitch !== null && vm.lowered) {
    vm.setActive(false);
    vm.holster(false);
    drawWeapon(pendingSwitch);
    pendingSwitch = null;
  }

  if (live) {
    if (input.pressed('KeyF') || (vm.inspect && input.clicked(2))) setInspect(!vm.inspect);
    if (!vm.inspect && !inv.busy) {
      inv.guns.forEach((i, k) => { if (input.pressed(`Digit${k + 1}`)) switchWeapon(i); });
      const n = inv.guns.length, k = inv.guns.indexOf(current);
      if (input.wheel && n > 1) switchWeapon(inv.guns[(k + (input.wheel > 0 ? 1 : -1) + n) % n]);
      if (input.pressed('KeyT') && pendingSwitch === null && inv.drop(current)) switchWeapon(inv.guns[0]);
    }
    inv.update(dt, { input, blocked: vm.inspect || pendingSwitch !== null || mv.state === 'mantle' || mv.state === 'vault' });
    vitals.update(dt);
    // pickups: walk over consumables, E for guns and armour upgrades
    const { touch, look } = level.pickups.nearby(mv.feet, camera);
    if (touch && inv.wants(touch) === 'auto') level.pickups.claim(touch);
    const target = [look, touch].find((p) => p && inv.wants(p) === 'prompt') ?? null;
    prompt = target ? inv.promptFor(target) : null;
    if (target && input.pressed('KeyE') && !inv.busy && pendingSwitch === null) level.pickups.claim(target);
    // zoom-matched: a mouse inch moves the target the same distance on screen at any magnification
    if (!vm.inspect) rig.look(input, 1 / rig.zoom);
    mv.update(dt, input, rig.yaw);
  }
  const axes = live ? input.axes() : { x: 0, y: 0 };
  rig.update(dt, mv, { ads: gun.adsEased, axes, zoom: gun.zoom });
  const view = window.OM?.view; // dev free camera: OM.view = { pos: [x, y, z], yaw, pitch } (degrees)
  if (view) { camera.position.set(...view.pos); camera.rotation.set((view.pitch ?? 0) * Math.PI / 180, (view.yaw ?? 0) * Math.PI / 180, 0); }
  camera.updateMatrixWorld();
  if (!live) prompt = null;
  if (live) gun.update(dt, { input, mv, camera, targets, octree: mv.octree, now, blocked: vm.inspect || vm.inspectEase > 0.25 || vm.swapping || pendingSwitch !== null || inv.busy || vm.holsterT > 0 || !inv.carries(current) });
  if (live) gunsmith.update(dt, input, rig.sensitivity);

  const ads = gun.adsEased;
  const vmFov = THREE.MathUtils.lerp(VM_FOV_HIP, vm.optic.vmFov, ads);
  if (Math.abs(vmCamera.fov - vmFov) > 1e-3) { vmCamera.fov = vmFov; vmCamera.updateProjectionMatrix(); }
  const cursor = vm.inspect ? { x: gunsmith.cursor.x / innerWidth * 2 - 1, y: gunsmith.cursor.y / innerHeight * 2 - 1 } : null;
  vm.update(dt, { mv, axes, mouseDX: vm.inspect ? 0 : input.mouseDX, mouseDY: vm.inspect ? 0 : input.mouseDY, ads, triggerHeld: gun.triggerHeld, cursor });

  handheld.update(dt, inv.action, now);
  level?.update(dt, { camera, now, gun });
  level.pickups.update(dt);
  grenades.update(dt);
  scoreboard.update(dt, input.locked && input.down('Tab') && level?.scoreRows ? level.scoreRows() : null);
  fx.update(dt, camera);
  hud.update(dt, { mv, gun, camera });
  vitalsHud.update(dt, { vitals, inv, prompt });
  audio.setLoops({
    wind: THREE.MathUtils.clamp((mv.speed / SPEED - 6) / 9, 0, 1) + (mv.state === 'air' ? Math.min(0.5, Math.abs(mv.vel.y) / 20) : 0),
    scrape: mv.state === 'slide' ? Math.min(1, mv.speed / SPEED / 10) : mv.state === 'wallrun' ? 0.35 : 0,
  });

  renderer.render(scene, camera, vmScene, vmCamera, { eyepiece: vm.eyepieceInfo(), focus: vm.inspectEase });
  input.endFrame();
}

// one bad frame (a bug, a malformed message) must not stop the loop: log it once a second and keep going
let lastError = 0;
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (window.OM?.frozen) return; // OM.frozen = true: only OM.step() advances (frame-exact captures)
  try { tick(dt); } catch (err) {
    if (performance.now() - lastError > 1000) { lastError = performance.now(); console.error(err); }
    input.endFrame();
  }
}
// the GPU can drop the context (driver reset, sleep): ask to keep it, and rebuild the render targets on restore
canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
canvas.addEventListener('webglcontextrestored', () => resize());
requestAnimationFrame(frame);

// dev handle for tuning from the console; ?dev skips the menu and pointer lock (keyboard only)
drawWeapon(0);

window.OM = {
  get vm() { return vm; }, get gun() { return gun; }, arsenal, switchWeapon, inv, vitals, get grenades() { return grenades; },
  mv, rig, get level() { return level; }, get lobby() { return lobby; }, scene, vmScene, input, gunsmith, setInspect, startMode,
  step: (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) tick(dt); },
};
const params = new URLSearchParams(location.search);
let lobby = params.has('dev') ? null : new Lobby(scene, camera, canvas);
if (params.has('dev')) {
  title.show(false);
  startMode(params.get('mode') ?? 'range', params.get('map'));
  input.devMode = true;
  input.locked = true;
  menu.show(false);
  hud.show(params.get('mode') !== 'editor');
}
