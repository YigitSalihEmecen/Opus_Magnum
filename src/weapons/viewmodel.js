import * as THREE from 'three';
import { MATS, f2z, shotShell } from './models/parts.js';
import { poseArm } from '../character/robot.js';
import { characterById } from '../character/characters.js';
import { ClipPlayer } from './anim.js';
import { buildClips } from './animations.js';
import { SLOTS } from './attachments.js';
import { FX_LAYER } from '../core/renderer.js';

const D2R = Math.PI / 180;
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
const rand = (a = 1) => (Math.random() * 2 - 1) * a;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeIn = (t) => t * t * t;
const easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

/** Damped vector spring: impulses go into .v, read .x */
class Spring3 {
  constructor(k, c) { this.k = k; this.c = c; this.x = new THREE.Vector3(); this.v = new THREE.Vector3(); }
  update(dt) {
    this.v.x += (-this.k * this.x.x - this.c * this.v.x) * dt;
    this.v.y += (-this.k * this.x.y - this.c * this.v.y) * dt;
    this.v.z += (-this.k * this.x.z - this.c * this.v.z) * dt;
    this.x.addScaledVector(this.v, dt);
    return this.x;
  }
  kick(x, y, z) { this.v.x += x; this.v.y += y; this.v.z += z; }
}

const SPRINT_POS = new THREE.Vector3(-0.01, -0.03, 0.03);
const SPRINT_ROT = new THREE.Vector3(-14 * D2R, 32 * D2R, 16 * D2R);
// inspect: gun lifted to the centre, turned to show its left side (position per weapon)
const INSPECT_ROT = new THREE.Vector3(7 * D2R, 76 * D2R, -3 * D2R);
const INSPECT_TIME = 0.55;
const _inspect = new THREE.Vector3();
const HOLSTER_TIME = 0.24;
const _pv = new THREE.Vector3();
// free-hand running fist in camera space [x, y, z, rx, ry, rz] — lower left, knuckles forward, palm in
const RUN_ARM = [-0.15, -0.175, -0.3, 25, 12, 90];
const _run = new THREE.Object3D(), _runM = new THREE.Matrix4(), _runQ = new THREE.Quaternion(), _runS = new THREE.Vector3();
const MAX_BEND = 42 * D2R;
const _tk = new THREE.Vector3(), _tt = new THREE.Vector3();
// shell-local thumb targets (shell axis +z points back at the shooter; brass head at z +0.03)
const THUMB_KNUCKLE = [-0.014, -0.012, 0.052], THUMB_TIP = [0, -0.004, 0.034];
const SLIDE_AIM_DIST = 2.5; // m in front of the eye where the canted bore crosses the crosshair
const SLIDE_BORE_H = 0.05; // bore height above the gun origin (approx., all guns)
const SHELL_PUSH = 0.016; // how far the thumb slides the shell out of the fingers
const _back = new THREE.Vector3(), _hq = new THREE.Quaternion(), _bq = new THREE.Quaternion();
const _anchor = new THREE.Vector3(), _wr = new THREE.Vector3(), _hwq = new THREE.Quaternion(), _dir = new THREE.Vector3();
const _el = new THREE.Vector3(), _sh = new THREE.Vector3(), _pl = new THREE.Vector3(), _down = new THREE.Vector3(0, -1, 0);

/** How each slot's part leaves/arrives when swapped (gun space metres / radians, seconds). */
const SWAP = {
  muzzle: { move: [0, 0, -0.11], spin: [0, 0, Math.PI * 2.5], out: 0.34, in: 0.4 },
  scope: { move: [0, 0.1, 0.01], spin: [0.3, 0, 0], out: 0.26, in: 0.36 },
  mag: { move: [0, -0.17, -0.04], spin: [-0.35, 0, 0], out: 0.24, in: 0.32 },
  grip: { move: [0, -0.11, 0.01], spin: [0, 0, 0.2], out: 0.22, in: 0.32 },
  stock: { move: [0, 0, 0.17], spin: [0, 0, 0], out: 0.26, in: 0.34 },
};

function setPose(obj, p) {
  obj.position.set(p[0], p[1], p[2]);
  obj.rotation.set(p[3] * D2R, p[4] * D2R, p[5] * D2R, 'YXZ');
}
const lerpArr = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function flashTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,250,235,1)');
  grad.addColorStop(0.18, 'rgba(255,214,150,0.95)');
  grad.addColorStop(0.45, 'rgba(240,130,70,0.45)');
  grad.addColorStop(1, 'rgba(217,119,87,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = 'rgba(255,230,190,0.9)';
  for (let i = 0; i < 6; i++) {
    g.save();
    g.translate(128, 128);
    g.rotate((i / 6) * Math.PI * 2 + 0.3);
    g.beginPath();
    g.moveTo(0, -8); g.lineTo(118, 0); g.lineTo(0, 8);
    g.fill();
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Additive-looking blend that still composites correctly over a transparent viewmodel buffer. */
function glowMaterial(map) {
  return new THREE.MeshBasicMaterial({
    map, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor, blendEquationAlpha: THREE.MaxEquation,
  });
}

/** Lights shared by every viewmodel (call once per viewmodel scene). */
export function addViewmodelLights(scene) {
  scene.add(new THREE.HemisphereLight(0xfff6ea, 0x6b5a4a, 1.5));
  const key = new THREE.DirectionalLight(0xfff1e0, 2.2);
  key.position.set(0.8, 1.4, 0.6);
  const fill = new THREE.DirectionalLight(0xb9c8ff, 0.6);
  fill.position.set(-1, 0.2, 0.4);
  scene.add(key, fill);
}

/**
 * First-person presentation of one weapon: pose layering (hip/ADS/sprint/bob/sway/recoil springs),
 * keyframed clips, inspect mode with animated attachment swaps, hands & forearms, flash, brass.
 * Gameplay lives in gunplay.js; this file only makes it look and feel right.
 */
export class Viewmodel {
  constructor(scene, camera, def) {
    this.scene = scene;
    this.camera = camera;
    this.def = def;
    this.poses = def.poses;
    const v = def.vm;
    this.hipPos = new THREE.Vector3(...v.hipPos);
    this.hipRot = new THREE.Vector3(...v.hipRot).multiplyScalar(D2R);
    this.inspectPos = new THREE.Vector3(...v.inspectPos);
    this.sprintPos = v.sprintPos ? new THREE.Vector3(...v.sprintPos) : SPRINT_POS;
    this.sprintRot = v.sprintRot ? new THREE.Vector3(...v.sprintRot).multiplyScalar(D2R) : SPRINT_ROT;
    this.onEvent = () => {};

    this.muzzleLight = new THREE.PointLight(0xffb070, 0, 1.2, 2);
    scene.add(this.muzzleLight);

    this.sway = new THREE.Group();
    this.anim = new THREE.Group();
    scene.add(this.sway);
    this.sway.add(this.anim);

    const { root, parts } = def.build();
    this.model = root;
    this.parts = parts;
    // free: the gun relative to the hands (tosses), rotated about the bore pivot
    this.free = new THREE.Group();
    this.anim.add(this.free);
    this.free.add(root);
    this.pivot = new THREE.Vector3(...(v.pivot ?? [0, 0.03, 0]));
    this.boltRest = parts.bolt.position.z;
    this.chRest = parts.chargingHandle.position.z;
    this.mounts = { muzzle: parts.muzzleMount, scope: parts.scopeMount, mag: parts.magSocket, grip: parts.gripMount, stock: parts.stockMount };
    this.attached = {};
    this.swaps = {};
    this.ironFold = 0;

    // the player robot's arms: rightHand / leftHand are grip targets in gun space (mags and shells ride on
    // them); each frame the arm chain is laid so its hand bone lands exactly on its target
    this.lhRest = this.poses.lhRest;
    this.rightHand = new THREE.Group();
    this.leftHand = new THREE.Group();
    setPose(this.rightHand, this.poses.rightHand);
    setPose(this.leftHand, this.lhRest);
    this.anim.add(this.rightHand, this.leftHand);
    this.setCharacter('rivet');

    // magazine-fed guns: mag transform relative to the left hand when gripping it at the magwell
    if (parts.magSocket) {
      const handAtMag = new THREE.Object3D();
      setPose(handAtMag, this.poses.lhMag);
      handAtMag.updateMatrix();
      root.updateMatrixWorld(true); // sockets may sit inside a scaled body group
      const socket = root.matrixWorld.clone().invert().multiply(parts.magSocket.matrixWorld);
      this.magInHand = handAtMag.matrix.clone().invert().multiply(socket);
    }

    // shell-fed guns: a shell the left hand carries to the loading port (shown between shellGrab and shellIn)
    if (this.poses.lhPort) {
      const handAtPort = new THREE.Object3D();
      setPose(handAtPort, this.poses.lhPort);
      handAtPort.updateMatrix();
      this.handShell = shotShell();
      const [sx, sy, sf] = this.poses.shellAt ?? [0, -0.03, 0.1];
      handAtPort.matrix.clone().invert().multiply(new THREE.Matrix4().makeTranslation(sx, sy, f2z(sf)))
        .decompose(this.handShell.position, this.handShell.quaternion, this.handShell.scale);
      this.handShellRest = this.handShell.position.clone();
      this.handShell.visible = false;
      this.leftHand.add(this.handShell);
    }

    this.#buildFlash();
    this.#buildPools();
    // guns without a muzzle slot fire from their muzzle mount
    this.muzzleSocket = new THREE.Object3D();
    parts.muzzleMount.add(this.muzzleSocket);
    this.muzzleSocket.add(this.flash);

    this.buildClips = def.clips ?? buildClips;
    this.clips = this.buildClips(this.poses, this.lhRest);
    this.player = new ClipPlayer((name, data) => this.#clipEvent(name, data));

    this.kickPos = new Spring3(420, 26);
    this.kickRot = new Spring3(340, 22);
    this.swayLag = new THREE.Vector3();
    this.w = { sprint: 0, slide: 0, wall: 0, walk: 0, air: 0, crouch: 0, strafe: 0 };
    this.time = 0;
    this.boltCycle = 1;
    this.boltLocked = false;
    this.trigger = 0;
    this.selectorAngle = -90 * D2R;
    this.flashT = 0;
    this.flashScale = 1;
    this.ads = 0;
    this.inspect = false;
    this.inspectT = 0;
    this.inspectEase = 0;
    this.sightPoint = new THREE.Vector3();
    this.holsterT = 0;
    this.holstered = false;
    this.twoHand = 0;
  }

  /** Swap the arm chains for another character's (same hand frame, so every grip pose still fits). */
  setCharacter(id) {
    const ch = characterById(id);
    if (this.character === ch.id) return;
    const visible = this.rightArm?.upper.visible ?? true;
    if (this.rightArm) this.scene.remove(this.rightArm.upper, this.leftArm.upper);
    this.character = ch.id;
    this.rightArm = ch.arm(-1);
    this.leftArm = ch.arm(1);
    this.rightArm.upper.visible = this.leftArm.upper.visible = visible;
    this.scene.add(this.rightArm.upper, this.leftArm.upper);
    this.rightHand.userData = this.rightArm.hand.userData;
    this.leftHand.userData = this.leftArm.hand.userData;
    this.rightHand.userData.setCurl(this.poses.rightHand[6]);
    this.leftHand.userData.setCurl(this.lhRest[6]);
  }

  /** Show/hide this weapon entirely (weapon switching). */
  setActive(on) {
    this.sway.visible = on;
    this.rightArm.upper.visible = this.leftArm.upper.visible = on;
    if (!on) { for (const sh of this.shells) sh.visible = false; this.flashT = 0; this.flash.visible = false; this.muzzleLight.intensity = 0; }
  }

  /** Abort any clip (e.g. switching mid-reload): the mag goes back in the gun, nothing is refilled. */
  cancelClip() {
    if (!this.player.playing) return;
    this.player.stop();
    this.player.rate = 1;
    const { mag, magSocket } = this.parts;
    if (mag && mag.parent !== magSocket) {
      magSocket.add(mag);
      mag.position.set(0, 0, 0);
      mag.quaternion.identity();
      mag.scale.setScalar(1);
    }
    if (mag) mag.visible = true;
    if (this.handShell) this.handShell.visible = false;
    this.parts.chargingHandle.position.z = this.chRest;
  }

  /** Lower the weapon out of view (true) or bring it back (false). */
  holster(on) { this.holstered = on; }
  get lowered() { return this.holsterT >= 1; }

  // ───────────────────────── public API ─────────────────────────

  get busy() { return this.player.playing && this.player.time < (this.player.clip.readyAt ?? this.player.clip.duration); }
  get cycling() { return this.player.playing && this.player.clip.name === 'bolt'; }
  get reloading() { return this.player.playing && this.player.clip.name.startsWith('reload'); }
  get swapping() { return Object.keys(this.swaps).length > 0; }

  playEquip() { this.player.play(this.clips.equip); }
  /** Play any named clip of this weapon (shell-by-shell reload steps). */
  playClip(name, rate = 1) { this.player.rate = rate; this.player.play(this.clips[name]); }

  /** Pump-action: rack the fore-end after a shot. */
  playPump() { this.player.play(this.clips.pump); }
  playReload(empty, rate = 1) { this.player.rate = rate; this.player.play(empty ? this.clips.reloadEmpty : this.clips.reload); }

  /** Selector lever position for fire-mode index i (0 = first mode). */
  setFireMode(i) { this.targetSelector = (-90 + 45 * i) * D2R; }

  setInspect(on) {
    if (on === this.inspect) return;
    this.inspect = on;
    this.kickRot.kick(on ? -0.6 : 0.4, on ? 1.2 : -0.8, on ? 0.8 : -0.6);
    this.onEvent(on ? 'inspectOpen' : 'inspectClose');
  }

  /** Mount an attachment. animate = false snaps it in (initial loadout). */
  equip(slot, def, animate = true) {
    if (!animate) { this.#attach(slot, def); return; }
    const s = this.swaps[slot];
    if (s) { s.next = def; return; }
    if (this.attached[slot]?.def === def) return;
    this.swaps[slot] = { phase: this.attached[slot]?.obj ? 'out' : 'in', t: 0, def };
    if (this.swaps[slot].phase === 'in') this.#attach(slot, def);
    this.onEvent('attachOut', slot);
  }

  /**
   * Gun kick for one shot, driven by the same recoil the aim takes (pitch up, yaw right in degrees).
   * Aimed, the gun only slams straight back along the sight line, so the reticle stays on the shot;
   * from the hip it also tips the way the recoil pulls.
   */
  fire(ads, pitch = 1, yaw = 0) {
    const s = (ads ? 0.5 : 1) * this.def.vm.kick;
    const hip = ads ? 0 : 1;
    this.kickPos.kick(yaw * 0.035 * s * hip, 0.13 * s * hip, 1.15 * s);
    this.kickRot.kick(0.9 * pitch * s * hip, -yaw * 0.5 * s * hip, -yaw * 0.6 * s * hip);
    this.boltCycle = 0;
    this.trigger = 1;
    if (this.flashScale > 0.01) {
      this.flashT = 0.045;
      this.flash.rotation.z = Math.random() * Math.PI;
      const sc = (0.8 + Math.random() * 0.5) * this.flashScale;
      this.flash.scale.set(sc, sc, sc * (0.8 + Math.random() * 0.6));
    }
    if (!this.def.vm.pump && !this.def.vm.bolt) this.#ejectShell();
  }

  /** Approximate world-space muzzle position (for tracers), mapping viewmodel space through both cameras. */
  muzzleWorld(worldCam, out = new THREE.Vector3()) {
    this.muzzleSocket.getWorldPosition(out);
    const d = out.length();
    out.applyMatrix4(this.camera.projectionMatrix);
    out.z = 0.5;
    out.unproject(worldCam).sub(worldCam.position).normalize();
    return out.multiplyScalar(d * 1.1).add(worldCam.position);
  }

  get optic() { return this.attached.scope?.def.optic ?? { iron: true, adsDist: this.def.vm.ironAds ?? 0.3, vmFov: 42 }; }

  /** Eyepiece circle in screen UV for the post pass's scope shadow (magnified optics only). */
  eyepieceInfo() {
    const o = this.optic;
    if (!o.shadow || this.ads < 0.05 || this.inspectEase > 0.01) return null;
    const c = this.model.localToWorld(this.#mountPoint(o.sight, new THREE.Vector3()));
    const e = c.clone();
    e.y += o.eyeR * this.mounts.scope.getWorldScale(_pv).y; // includes a scaled body group
    c.project(this.camera);
    e.project(this.camera);
    return { x: c.x * 0.5 + 0.5, y: c.y * 0.5 + 0.5, r: Math.abs(e.y - c.y) * 0.5, shadow: o.shadow * this.ads };
  }

  /** Screen-space (px) anchor for a slot's callout. */
  slotAnchor(slot, w, h) {
    const obj = this.attached[slot]?.obj;
    const p = new THREE.Vector3();
    if (obj && !this.swaps[slot]) new THREE.Box3().setFromObject(obj).getCenter(p);
    else if (slot === 'scope') this.parts.ironRear.getWorldPosition(p);
    else this.mounts[slot].getWorldPosition(p);
    p.project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h };
  }

  update(dt, ctx) {
    const { mv, axes, mouseDX, mouseDY, ads, triggerHeld, cursor } = ctx;
    this.time += dt;
    this.ads = ads;
    this.player.update(dt);

    // inspect transition (eased, with an arcing lift and a roll flourish)
    this.inspectT = THREE.MathUtils.clamp(this.inspectT + (this.inspect ? dt : -dt) / INSPECT_TIME, 0, 1);
    const ie = (this.inspectEase = easeInOut(this.inspectT));
    this.holsterT = THREE.MathUtils.clamp(this.holsterT + (this.holstered ? dt : -dt) / HOLSTER_TIME, 0, 1);
    const ho = easeIn(this.holsterT);
    const arc = Math.sin(Math.PI * ie);

    // movement weights
    const w = this.w;
    const onGround = mv.state === 'ground' && mv.grounded;
    w.sprint = damp(w.sprint, mv.sprinting && onGround ? 1 : 0, 9, dt);
    w.slide = damp(w.slide, mv.state === 'slide' ? 1 : 0, 10, dt);
    w.wall = damp(w.wall, mv.state === 'wallrun' ? mv.wallSide : 0, 8, dt);
    w.walk = damp(w.walk, onGround || mv.state === 'wallrun' ? Math.min(1, mv.speed / 7.8) : 0, 10, dt);
    w.air = damp(w.air, mv.state === 'air' ? THREE.MathUtils.clamp(mv.vel.y / 8, -1, 1) : 0, 8, dt);
    w.crouch = damp(w.crouch, mv.crouched ? 1 : 0, 10, dt);
    w.strafe = damp(w.strafe, axes.x, 8, dt);
    const mantle = mv.state === 'mantle' ? Math.sin(mv.mantleProgress * Math.PI) : 0;
    // vault: the gun swings down and across while the free hand plants on the top
    const vault = mv.state === 'vault' ? Math.sin(mv.mantleProgress * Math.PI) : 0;
    const sprint = w.sprint * (1 - ads) * (1 - ie);
    // magnified optics sit ~0.1 m from the eye, where a millimetre of sway throws the reticle off the
    // bullets' line: aimed through one, bob, mouse lag and breathing switch off entirely
    const o = this.optic;
    const steady = o.shadow ? 1 : 0.85;
    const free = (1 - ads * steady) * (1 - ie * 0.75);
    // movement poses (slide cant, air, wallrun, crouch, strafe lean) are hip-only: aimed, the sight stays dead centre
    const move = (1 - ads) * (1 - ie * 0.75);

    // mouse sway lags behind the view
    this.swayLag.x = damp(this.swayLag.x, THREE.MathUtils.clamp(-mouseDY * 0.0011, -0.07, 0.07), 14, dt);
    this.swayLag.y = damp(this.swayLag.y, THREE.MathUtils.clamp(-mouseDX * 0.0011, -0.07, 0.07), 14, dt);

    // gait bob (figure-8), stronger while sprinting
    const ph = mv.gaitPhase;
    const bobAmp = w.walk * free * (1 + w.sprint * 0.9);
    const breathe = (1 - ads * (o.shadow ? 1 : 0.8)) * (1 - w.walk);

    const kp = this.kickPos.update(dt);
    const kr = this.kickRot.update(dt);

    // sight alignment for the mounted optic
    if (o.iron) this.sightPoint.copy(this.parts.ironSight);
    else this.#mountPoint(o.sight, this.sightPoint);
    const adsPos = new THREE.Vector3(-this.sightPoint.x, -this.sightPoint.y, -o.adsDist - this.sightPoint.z);

    const p = this.sway.position;
    p.copy(this.hipPos).lerp(adsPos, ads);
    p.addScaledVector(this.sprintPos, sprint);
    // pull the showcase pose back on narrow screens so the whole gun stays in frame
    const fit = Math.max(1, 1.78 / this.camera.aspect);
    p.lerp(_inspect.set(this.inspectPos.x, this.inspectPos.y, this.inspectPos.z * fit), ie);
    p.y -= 0.24 * ho;
    p.y += arc * 0.05;
    p.x += Math.sin(ph) * 0.009 * bobAmp + this.swayLag.y * -0.05 * free - w.strafe * 0.006 * move;
    p.y += (Math.cos(ph * 2) - 1) * 0.006 * bobAmp + Math.sin(this.time * 1.7) * 0.0014 * breathe - w.air * 0.012 * move - w.crouch * 0.006 * move;
    // slide: cant the gun inward on its side, pulled toward the centre and down (eased in and out)
    const sl = w.slide * w.slide * (3 - 2 * w.slide) * move;
    p.x -= sl * 0.03;
    p.y += -0.13 * mantle - sl * 0.024 - 0.09 * vault;
    p.x -= 0.05 * vault;
    p.z += sl * 0.02;
    p.add(kp);

    const hipK = 1 - ads;
    const HIP_ROT = this.hipRot;
    const SPRINT_ROT = this.sprintRot;
    let rx = -42 * D2R * ho + HIP_ROT.x * hipK + SPRINT_ROT.x * sprint + this.swayLag.x * free + (Math.cos(ph * 2) * 0.6 * D2R) * bobAmp + w.air * 3 * D2R * move - 26 * D2R * mantle + Math.sin(this.time * 1.1) * 0.25 * D2R * breathe;
    // while canted for a slide, swap the hip angles for ones that point the bore at the crosshair
    const aimDist = SLIDE_AIM_DIST + p.z;
    rx += sl * (Math.atan2(-(p.y + SLIDE_BORE_H), aimDist) - HIP_ROT.x * hipK);
    const ry = HIP_ROT.y * hipK + SPRINT_ROT.y * sprint + this.swayLag.y * free + sl * (Math.atan2(p.x, aimDist) - HIP_ROT.y * hipK);
    const rz = HIP_ROT.z * hipK + SPRINT_ROT.z * sprint + this.swayLag.y * 0.8 * free + Math.sin(ph) * 1.8 * D2R * bobAmp - w.strafe * 3 * D2R * move
      + sl * 28 * D2R + w.wall * 7 * D2R * move + 12 * D2R * mantle + 34 * D2R * vault;
    // while inspecting, the gun leans toward the cursor
    const cx = cursor ? cursor.x : 0, cy = cursor ? cursor.y : 0;
    this.sway.rotation.set(
      THREE.MathUtils.lerp(rx, INSPECT_ROT.x + cy * 5 * D2R, ie) + kr.x,
      THREE.MathUtils.lerp(ry, INSPECT_ROT.y + cx * 9 * D2R, ie) + kr.y,
      THREE.MathUtils.lerp(rz, INSPECT_ROT.z, ie) - arc * 12 * D2R + kr.z,
      'YXZ',
    );

    // clip layer; left hand leaves the gun while inspecting
    const g = this.player.get('gun', null);
    if (g) { setPose(this.anim, g); } else { this.anim.position.set(0, 0, 0); this.anim.rotation.set(0, 0, 0); }
    const fr = this.player.get('free', null);
    if (fr) {
      setPose(this.free, fr);
      this.free.position.add(this.pivot).sub(_pv.copy(this.pivot).applyEuler(this.free.rotation));
    } else { this.free.position.set(0, 0, 0); this.free.rotation.set(0, 0, 0); }
    const rh = this.player.get('rh', this.poses.rightHand);
    setPose(this.rightHand, rh);
    this.rightHand.userData.setCurl(rh[6]);
    if (this.poses.triggerCurl !== undefined && !this.player.get('rh', null)) this.rightHand.userData.setIndex(this.poses.triggerCurl);

    let lh = this.player.get('lh', this.lhRest);
    if (this.def.vm.oneHand) {
      // oneHand: the support hand only comes up for ADS and reloads; twoHandHip keeps it on the gun
      // at the hip too, so it's only freed for the sprint arm swing
      const wantTwo = ads > 0.02 || this.reloading || (this.def.vm.twoHandHip && w.sprint < 0.4);
      this.twoHand = damp(this.twoHand, wantTwo ? 1 : 0, 14, dt);
      const k = this.twoHand * this.twoHand * (3 - 2 * this.twoHand);
      lh = lerpArr(this.poses.lhHip ?? this.poses.lhOff, lh, k);
    }
    if (ie > 0) lh = lerpArr(lh, this.poses.lhOff, Math.min(1, ie * 1.4));
    setPose(this.leftHand, lh);
    this.leftHand.userData.setCurl(lh[6]);
    // one-handed guns: the free hand pumps like a runner's arm while sprinting (authored in camera space)
    const run = this.def.vm.oneHand ? w.sprint * (1 - this.twoHand) * (1 - ie) : 0;
    if (run > 0.01) {
      const sw = Math.sin(ph);
      _run.position.set(RUN_ARM[0] + 0.012 * sw, RUN_ARM[1] + 0.03 * sw, RUN_ARM[2] - 0.065 * sw);
      _run.rotation.set((RUN_ARM[3] + 22 * sw) * D2R, RUN_ARM[4] * D2R, RUN_ARM[5] * D2R, 'YXZ');
      _run.updateMatrix();
      this.anim.updateWorldMatrix(true, false);
      _runM.copy(this.anim.matrixWorld).invert().multiply(this.camera.matrixWorld).multiply(_run.matrix);
      _runM.decompose(_pv, _runQ, _runS);
      this.leftHand.position.lerp(_pv, run);
      this.leftHand.quaternion.slerp(_runQ, run);
      this.leftHand.userData.setCurl(THREE.MathUtils.lerp(lh[6], 1.75, run), 0.9);
    }
    // one-handed guns park the support hand out of frame; hide it there so sprint tilts can't swing it into view
    const parked = this.def.vm.oneHand && this.twoHand < 0.02 && run < 0.05;
    this.leftHand.visible = ie < 0.5 && !parked;
    this.leftArm.upper.visible = ie < 0.5 && !parked;

    // mechanical parts
    this.boltCycle = Math.min(1, this.boltCycle + dt / 0.075);
    const boltOpen = this.boltLocked ? 1 : Math.sin(Math.PI * this.boltCycle);
    const ch = this.player.get('ch', [0])[0];
    if (this.def.vm.bolt) {
      // bolt-action: the right hand lifts the handle (roll about the bolt axis), then draws it back
      this.parts.bolt.position.z = this.boltRest + ch * this.def.vm.boltTravel;
      this.parts.bolt.rotation.z = (this.player.get('ch', [0, 0])[1] ?? 0) * 1.05;
    } else if (this.def.vm.pump) {
      // pump-action: fore-end and bolt only move when the left hand racks
      this.parts.bolt.position.z = this.boltRest + ch * this.def.vm.boltTravel;
      this.parts.chargingHandle.position.z = this.chRest + ch * this.def.vm.chTravel;
    } else {
      this.parts.bolt.position.z = this.boltRest + boltOpen * this.def.vm.boltTravel;
      // charging handle rides the bolt on every shot (and locks back with it); reload clips can pull it further
      this.parts.chargingHandle.position.z = this.chRest + Math.max(ch, boltOpen * 0.6) * this.def.vm.chTravel;
    }
    this.trigger = damp(this.trigger, triggerHeld ? 1 : 0, 30, dt);
    this.parts.trigger.rotation.x = -0.32 * this.trigger;
    this.selectorAngle = damp(this.selectorAngle, this.targetSelector ?? this.selectorAngle, 20, dt);
    this.parts.selector.rotation.x = this.selectorAngle;
    const scopeDef = this.swaps.scope?.def ?? this.attached.scope?.def;
    const wantIrons = !scopeDef || !!scopeDef.optic?.iron;
    this.ironFold = damp(this.ironFold, wantIrons ? 0 : 1, 12, dt);
    this.parts.ironRear.rotation.x = (Math.PI / 2) * this.ironFold;
    this.parts.ironFront.rotation.x = (-Math.PI / 2) * this.ironFold;
    // fully folded irons still stand a little proud of the rail and peek into an optic's window: hide them
    this.parts.ironRear.visible = this.parts.ironFront.visible = this.ironFold < 0.97;

    this.#updateSwaps(dt);

    // magnified optics: open the eyepiece portal once mostly aimed so the view runs clean through the scope
    const aimed = ads > 0.5 && !this.swaps.scope && !!o.shadow;
    const scopeObj = this.attached.scope?.obj;
    if (aimed !== this.portalOpen || scopeObj !== this.portalScope) {
      this.portalOpen = aimed;
      this.portalScope = scopeObj;
      scopeObj?.traverse((c) => { if (c.userData.adsPortal) c.visible = aimed; });
    }

    // flash
    this.flashT -= dt;
    this.flash.visible = this.flashT > 0;
    this.muzzleLight.intensity = this.flashT > 0 ? 6 * this.flashScale : 0;
    if (this.flashT > 0) this.muzzleSocket.getWorldPosition(this.muzzleLight.position);

    this.#updatePools(dt);

    // arms follow the hands toward fixed shoulder anchors (off-screen); thumbs aim once the hands are placed
    this.scene.updateMatrixWorld();
    this.#arm(this.rightHand, this.rightArm, _anchor.set(0.26, -0.42, 0.18));
    this.#arm(this.leftHand, this.leftArm, _anchor.set(-0.2, -0.5, 0.1));
    if (this.poses.thumbAim && !this.player.get('rh', null)) this.#aimThumb(this.rightHand, this.poses.thumbAim);
    // shell loading: the left thumb sits behind the shell's brass head and drives it forward out of the fingers
    const push = this.handShell && this.player.get('lthumb', null);
    if (this.handShell) this.handShell.position.copy(this.handShellRest);
    if (push) {
      this.handShell.translateZ(-SHELL_PUSH * push[0]);
      this.handShell.updateWorldMatrix(true, false);
      this.leftHand.userData.aimThumb(this.handShell.localToWorld(_tk.set(...THUMB_KNUCKLE)), this.handShell.localToWorld(_tt.set(...THUMB_TIP)));
    }
  }

  // ───────────────────────── attachments ─────────────────────────

  /** [x, y, f] in scope-mount space → gun space (respects the mount's offset and scale). */
  #mountPoint([x, y, f], out) {
    // via world space, so mounts nested in a scaled body group still land right
    this.model.updateMatrixWorld(true);
    return this.model.worldToLocal(this.mounts.scope.localToWorld(out.set(x, y, f2z(f))));
  }

  #attach(slot, def) {
    const prev = this.attached[slot];
    if (prev?.obj) prev.obj.removeFromParent();
    const built = def.build?.();
    const obj = built?.isObject3D ? built : built?.obj ?? null;
    if (obj) {
      obj.traverse((c) => { if (c.isMesh && !c.layers.isEnabled(FX_LAYER)) c.castShadow = true; });
      this.mounts[slot].add(obj);
    }
    this.attached[slot] = { def, obj };

    if (slot === 'muzzle') {
      const socket = new THREE.Object3D();
      socket.position.z = f2z(built?.tip ?? 0.02);
      (obj ?? this.mounts.muzzle).add(socket);
      this.muzzleSocket = socket;
      socket.add(this.flash);
    }
    if (slot === 'mag') this.parts.mag = obj;
    if (slot === 'grip') {
      this.lhRest = this.poses[this.def.gripPoses?.[def.id] ?? 'lhRest'];
      if (!this.player.playing) this.clips = this.buildClips(this.poses, this.lhRest);
      else this.pendingClips = true;
    }
    return obj;
  }

  #updateSwaps(dt) {
    if (this.pendingClips && !this.player.playing) { this.clips = this.buildClips(this.poses, this.lhRest); this.pendingClips = false; }
    for (const slot of SLOTS) {
      const s = this.swaps[slot];
      if (!s) continue;
      const cfg = SWAP[slot];
      s.t += dt / (s.phase === 'out' ? cfg.out : cfg.in);
      const t = Math.min(1, s.t);
      const k = s.phase === 'out' ? easeIn(t) : 1 - easeOutBack(t);
      const obj = this.attached[slot]?.obj;
      if (obj) {
        obj.position.set(cfg.move[0] * k, cfg.move[1] * k, cfg.move[2] * k);
        obj.rotation.set(cfg.spin[0] * k, cfg.spin[1] * k, cfg.spin[2] * k);
        const sc = s.phase === 'out' ? 1 - Math.max(0, (t - 0.6) / 0.4) * 0.6 : 1;
        obj.scale.setScalar(sc);
      }
      if (t < 1) continue;
      if (s.phase === 'out') {
        this.#attach(slot, s.def);
        s.phase = 'in';
        s.t = 0;
        this.#updateSwaps(0);
      } else {
        if (obj) { obj.position.set(0, 0, 0); obj.rotation.set(0, 0, 0); obj.scale.setScalar(1); }
        this.kickRot.kick(slot === 'stock' ? -0.4 : 0.5, slot === 'muzzle' ? 0.4 : 0, -0.4);
        this.kickPos.kick(0, slot === 'mag' ? 0.25 : 0.12, slot === 'stock' ? -0.2 : 0);
        this.onEvent('attachIn', slot);
        delete this.swaps[slot];
        if (s.next && s.next !== s.def) this.equip(slot, s.next);
      }
    }
  }

  // ───────────────────────── internals ─────────────────────────

  /** Aim a hand's thumb at [knuckle, tip] targets given in gun space. */
  #aimThumb(hand, [k, t]) {
    this.anim.updateWorldMatrix(true, false);
    hand.userData.aimThumb(this.anim.localToWorld(_tk.set(...k)), this.anim.localToWorld(_tt.set(...t)));
  }

  /**
   * Lay an arm chain onto its hand target: the forearm runs from the wrist toward the shoulder anchor, swung
   * toward the back of the hand so the wrist never bends past MAX_BEND; the upper arm heads for the anchor.
   */
  #arm(hand, arm, anchor) {
    const wrist = hand.getWorldPosition(_wr);
    const handQ = hand.getWorldQuaternion(_hwq);
    const dir = _dir.subVectors(anchor, wrist).normalize();
    const back = _back.set(0, 0, 1).applyQuaternion(handQ);
    const bend = dir.angleTo(back);
    // inspect turns the gun sideways: let the arm hang toward its anchor (off screen) instead
    const max = MAX_BEND + this.inspectEase * Math.PI;
    if (bend > max) dir.applyQuaternion(_hq.identity().slerp(_bq.setFromUnitVectors(dir, back), 1 - max / bend));
    const elbow = _el.copy(wrist).addScaledVector(dir, arm.dims.fore);
    const shoulder = _sh.subVectors(anchor, elbow).normalize().multiplyScalar(arm.dims.upper).add(elbow);
    poseArm(arm, shoulder, elbow, wrist, handQ, _pl.copy(elbow).add(_down));
  }

  #clipEvent(name, data) {
    const { mag, magSocket } = this.parts;
    switch (name) {
      case 'kick':
        this.kickPos.kick(...data.pos.map((v) => v * 8));
        this.kickRot.kick(...data.rot.map((v) => v * D2R * 8));
        break;
      case 'magGrab':
      case 'magFromPouch':
        if (!mag) break;
        this.leftHand.add(mag);
        mag.matrix.copy(this.magInHand).decompose(mag.position, mag.quaternion, mag.scale);
        mag.visible = true;
        break;
      case 'magDrop': this.#dropMag(); if (mag) mag.visible = false; break;
      case 'magSeat':
        if (!mag) break;
        magSocket.add(mag);
        mag.position.set(0, 0, 0);
        mag.quaternion.identity();
        mag.scale.setScalar(1);
        mag.visible = true;
        break;
      case 'boltForward': this.boltLocked = false; break;
      case 'eject': this.#ejectShell(); break;
      case 'shellGrab': if (this.handShell) this.handShell.visible = true; break;
      case 'shellIn': if (this.handShell) this.handShell.visible = false; break;
      case 'clipEnd': this.player.rate = 1; break;
    }
    this.onEvent(name, data);
  }

  #buildFlash() {
    const tex = flashTexture();
    const mat = glowMaterial(tex);
    this.flash = new THREE.Group();
    const front = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.11), mat);
    const side1 = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.2).rotateX(-Math.PI / 2).translate(0, 0, -0.07), mat);
    const side2 = side1.clone();
    side2.rotation.z = Math.PI / 2;
    this.flash.add(front, side1, side2);
    this.flash.traverse((o) => o.layers.set(FX_LAYER));
    this.flash.visible = false;
  }

  #buildPools() {
    const pump = this.def.vm.pump;
    const shellGeo = (pump ? new THREE.CylinderGeometry(0.0092, 0.0092, 0.05, 12) : new THREE.CylinderGeometry(0.0055, 0.0055, 0.03, 10)).rotateX(Math.PI / 2);
    this.shells = Array.from({ length: 14 }, () => {
      const m = new THREE.Mesh(shellGeo, pump ? MATS.red : MATS.brass);
      m.visible = false;
      m.userData = { v: new THREE.Vector3(), w: new THREE.Vector3(), life: 0 };
      this.scene.add(m);
      return m;
    });
    this.shellIndex = 0;
    this.drops = [];
  }

  #ejectShell() {
    const sh = this.shells[this.shellIndex++ % this.shells.length];
    this.parts.ejectPort.getWorldPosition(sh.position);
    this.parts.ejectPort.getWorldQuaternion(sh.quaternion);
    sh.userData.v.set(1.6 + Math.random() * 0.8, 1.1 + Math.random() * 0.6, 0.5 + Math.random() * 0.4);
    sh.userData.w.set(rand(20), 25 + Math.random() * 15, rand(12));
    sh.userData.life = 0.6;
    sh.visible = true;
  }

  #dropMag() {
    const { mag } = this.parts;
    const def = this.attached.mag?.def;
    if (!mag || !def) return;
    const copy = def.build();
    mag.updateWorldMatrix(true, false);
    mag.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
    copy.userData = { v: new THREE.Vector3(rand(0.15), -0.6, 0.1), w: new THREE.Vector3(-4 + rand(1), rand(2), rand(3)), life: 1.0 };
    this.scene.add(copy);
    this.drops.push(copy);
  }

  #updatePools(dt) {
    const g = 9.8;
    const step = (o) => {
      const u = o.userData;
      u.life -= dt;
      u.v.y -= g * dt;
      o.position.addScaledVector(u.v, dt);
      o.rotation.x += u.w.x * dt;
      o.rotation.y += u.w.y * dt;
      o.rotation.z += u.w.z * dt;
    };
    for (const sh of this.shells) {
      if (!sh.visible) continue;
      step(sh);
      if (sh.userData.life <= 0) sh.visible = false;
    }
    this.drops = this.drops.filter((d) => {
      step(d);
      if (d.userData.life > 0) return true;
      this.scene.remove(d);
      return false;
    });
  }
}
