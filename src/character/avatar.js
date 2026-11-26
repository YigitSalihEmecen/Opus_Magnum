import * as THREE from 'three';
import { PALETTE as P } from '../core/toon.js';
import { FX_LAYER } from '../core/renderer.js';
import { gripGun, bakeFlat } from './robot.js';
import { buildCharacter } from './characters.js';
import { WEAPONS } from '../weapons/weapons.js';
import { Motion, BONES } from './motion.js';
import { Spring, Inertializer } from './smooth.js';

/*
  A character in the world holding a gun: the robot body, the third-person gun with its muzzle flash, the
  team marker, its movement, the death fall and the hit boxes. It is only a body: something else moves it
  (pos, vel, aimYaw, aimPitch, poseTarget, reloadT) and calls pose(dt) each frame — the TDM bot's brain, or a
  networked player's snapshots.
  Movement is captured motion (motion.js) blended by what the body is doing — idle, walk, jog and sprint on one
  stride phase matched to its real speed (run backwards when backpedalling), crouch, air, slide, climbing,
  landing and flinching — then shaped in code: the legs turn toward travel while the torso stays on the aim,
  the body leans into speed, acceleration and turns, and the hands stay on the gun.
  Nothing snaps (smooth.js): every input (aim, speed, stance, leans, the reload hand) follows its target on a
  spring, one-shot clips fade in from zero, and the finished pose passes an inertializer that eases out any
  jump that still gets through. A respawn is the one cut.
*/

const NO_POSE = {};
const POSE_KEYS = ['crouch', 'slide', 'wall', 'air', 'ads', 'mantle'];
const NO_POSE_W = Object.fromEntries(POSE_KEYS.map((k) => [k, 0]));
const HL = { aim: 0.045, speed: 0.09, pose: 0.07, legs: 0.07, lean: 0.1, hand: 0.06 }; // spring halflives (s)
const STANCE = -0.5; // torso bladed (left shoulder forward) behind the rifle
const G = {
  flash: new THREE.PlaneGeometry(0.34, 0.34),
  marker: new THREE.OctahedronGeometry(0.1, 0),
};
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const _hand = [0, 0, 0, 0, 0, 0, 0];
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const ss = THREE.MathUtils.smoothstep;
const UP = new THREE.Vector3(0, 1, 0), RIGHT = new THREE.Vector3(1, 0, 0);
// gaits: the speed (m/s) at which each loop plays alone; between them they cross-fade on one stride phase.
// Anything quicker than a strafe is a sprint
const GAITS = [['walk', 1.4], ['jog', 2.8], ['sprint', 4.2]];
// The run cycles are authored for faster ground speeds than ours (the sprint ~8 m/s). Slowing them down to
// match looks like slow motion, so they keep close to their own cadence and the stride shortens instead (the
// legs swing less): speed ratio r → cadence r^0.2 (clamped), leg swing r / cadence, feet stay planted
const CADENCE = 0.2;
const LOWER = ['hips', 'thigh_L', 'shin_L', 'foot_L', 'thigh_R', 'shin_R', 'foot_R'];
const UPPER = ['spine', 'chest', 'neck', 'head', 'shoulder_L', 'shoulder_R'];
const FLINCH = ['spine', 'chest', 'neck', 'head'];
const LEGS = LOWER.slice(1);
const _aim = new THREE.Quaternion(), _lean = new THREE.Quaternion(), _e = new THREE.Euler();

export class Avatar {
  /** team: 'ally' | 'enemy' (allies wear a marker); weapon: id of the gun it starts holding. */
  constructor({ team, name, char = 'rivet', weapon = 'panther', reloadTime = 2.3 }) {
    Object.assign(this, { team, name, char, reloadTime });
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.alive = false;
    this.aimYaw = 0;
    this.aimPitch = 0;
    this.hopY = 0;
    this.phase = 0;
    this.reloadT = 0;
    this.flash = 0;
    this.deathT = 0;
    this.#build(weapon);
  }

  /** What shots and blasts check before hurting it. */
  get dead() { return !this.alive; }

  #build(weaponId) {
    const r = (this.robot = buildCharacter(this.char, this.team));
    this.mats = r.flashMats;
    this.root = new THREE.Group();
    this.body = new THREE.Group(); // tips over on death
    this.root.add(this.body);
    this.body.add(r.root);
    const b = r.bones;
    this.legs = ['L', 'R'].map((s) => ({ thigh: r.legs[s].thigh, knee: r.legs[s].shin }));
    this.motion = new Motion(b, b.root);
    Object.assign(this, { cycle: 0, idleT: 0, lastVel: new THREE.Vector3(), heading: 0, turnRate: 0, live: false });
    this.clipT = { air: 0, slide: 0, climb: 9, land: 9, hit: 9 };
    this.sm = Object.fromEntries(['yaw', 'pitch', 'speed', 'legYaw', 'leanX', 'leanY', 'hand', ...POSE_KEYS].map((k) => [k, new Spring()]));
    this.poseW = { ...NO_POSE_W };
    this.inert = new Inertializer(BONES);

    // the gun pitches with the aim from the right shoulder; both hands are solved onto its grips every frame
    this.arms = new THREE.Group();
    this.arms.position.set(-0.1, 0.24, 0.02);
    b.chest.add(this.arms);
    this.gunFrame = new THREE.Group();
    this.gunFrame.position.set(0.02, -0.04, 0.34);
    this.gunFrame.rotation.y = Math.PI - STANCE;
    this.arms.add(this.gunFrame);
    this.muzzle = new THREE.Object3D();
    this.flashMesh = new THREE.Mesh(G.flash, new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false }));
    this.flashMesh.layers.set(FX_LAYER);
    this.flashMesh.visible = false;
    this.muzzle.add(this.flashMesh);
    this.flashT = 0;
    this.guns = new Map();
    this.holdWeapon(WEAPONS.find((w) => w.id === weaponId) ?? WEAPONS[0]);

    if (this.team === 'ally') {
      const mk = new THREE.Mesh(G.marker, new THREE.MeshBasicMaterial({ color: P.sky, depthTest: false, transparent: true, opacity: 0.9, toneMapped: false }));
      mk.scale.y = 1.4;
      mk.position.y = 2.3;
      mk.renderOrder = 10;
      mk.layers.set(FX_LAYER);
      this.root.add(mk);
      this.marker = mk;
    }

    this.hitboxes = r.hitboxes;
    for (const h of this.hitboxes) h.userData.dummy = this;
    this.root.visible = false;
  }

  /** Swap the third-person gun model (built once per weapon, kept for later swaps). */
  holdWeapon(def) {
    if (this.weapon === def) return;
    if (this.weapon) this.guns.get(this.weapon.id).visible = false;
    let gun = this.guns.get(def.id);
    if (!gun) {
      const { root, parts } = def.build();
      bakeFlat(root); // one draw call; its moving parts never move in third person
      root.userData.muzzle = parts.muzzleMount;
      this.gunFrame.add(root);
      this.guns.set(def.id, (gun = root));
    }
    gun.visible = true;
    gun.userData.muzzle.add(this.muzzle);
    this.weapon = def;
  }

  /** Pose the body from pos / vel / aimYaw / aimPitch / poseTarget / reloadT. */
  animate(dt) {
    const S = this.sm, tgt = this.poseTarget ?? NO_POSE;
    const airTgt = Math.max(tgt.air ?? 0, this.hopY > 0 ? 1 : 0);
    if (!this.live) {
      // (re)appearing: start from where it is, no easing in from the last life
      this.live = true;
      S.yaw.snap(this.aimYaw); S.pitch.snap(this.aimPitch); S.speed.snap(Math.hypot(this.vel.x, this.vel.z));
      for (const k of ['legYaw', 'leanX', 'leanY', 'hand']) S[k].snap(0);
      for (const k of POSE_KEYS) S[k].snap(k === 'air' ? airTgt : tgt[k] ?? 0);
      this.lastVel.copy(this.vel);
      this.inert.reset();
      this.body.position.y = 0;
    }
    this.root.position.copy(this.pos);
    this.root.position.y += this.hopY;
    const yaw = S.yaw.toAngle(this.aimYaw, HL.aim, dt), pitch = S.pitch.to(this.aimPitch, HL.aim, dt);
    this.root.rotation.y = yaw;
    this.pitch = pitch;

    // what the body is doing: networked players set poseTarget, bots only hop; each on a spring so changes blend
    const w = this.poseW;
    for (const k of POSE_KEYS) w[k] = S[k].to(k === 'air' ? airTgt : tgt[k] ?? 0, HL.pose, dt);
    const T = this.clipT, C = this.motion.clips;
    for (const k in T) T[k] += dt;
    // one-shots start while their weight is still zero, so they never jump in mid-clip
    if (this.airWas && !airTgt) T.land = 0; // touched down
    if (!this.mantleWas && tgt.mantle) T.climb = 0;
    this.airWas = airTgt > 0.5;
    this.mantleWas = !!tgt.mantle;
    if (this.flash > 0.07) T.hit = 0;

    // travel: the legs face it (backpedalling runs the cycle backwards), the torso keeps facing the aim
    const sp = S.speed.to(Math.hypot(this.vel.x, this.vel.z), HL.speed, dt);
    let legYaw = 0, dir = 1;
    if (sp > 0.4) {
      legYaw = wrap(Math.atan2(this.vel.x, this.vel.z) - yaw);
      if (Math.abs(legYaw) > Math.PI / 2) { legYaw = wrap(legYaw + Math.PI); dir = -1; }
      const h = Math.atan2(this.vel.x, this.vel.z);
      this.turnRate = damp(this.turnRate, wrap(h - this.heading) / Math.max(dt, 1e-3), 6, dt);
      this.heading = h;
    } else this.turnRate = damp(this.turnRate, 0, 6, dt);
    this.legYaw = S.legYaw.to(THREE.MathUtils.clamp(legYaw, -1.2, 1.2), HL.legs, dt);

    // gait weights by speed, and one stride phase advanced at the rate that keeps the feet planted
    const move = ss(sp, 0.25, 1.2);
    const gw = GAITS.map(([, v], i) => {
      const lo = GAITS[i - 1]?.[1], hi = GAITS[i + 1]?.[1];
      if (sp <= v) return lo === undefined ? 1 : THREE.MathUtils.clamp((sp - lo) / (v - lo), 0, 1);
      return hi === undefined ? 1 : THREE.MathUtils.clamp((hi - sp) / (hi - v), 0, 1);
    });
    let dur = 0, speed = 0;
    const scale = this.motion.scale;
    GAITS.forEach(([name], i) => { dur += gw[i] * C[name].duration; speed += gw[i] * C[name].speed * scale; });
    const crouchLoop = C.crouchWalk;
    dur = THREE.MathUtils.lerp(dur, crouchLoop.duration, w.crouch);
    speed = THREE.MathUtils.lerp(speed, crouchLoop.speed * scale, w.crouch);
    const ratio = sp / Math.max(0.3, speed);
    const cadence = THREE.MathUtils.clamp(Math.pow(ratio, CADENCE), 0.85, 1.2);
    const stride = THREE.MathUtils.clamp(ratio / cadence, 0.5, 1.2);
    const rate = cadence / dur; // cycles per second
    this.cycle += dt * rate * dir * move;
    this.idleT += dt;
    this.phase = this.cycle * Math.PI * 2; // footsteps: one per half cycle

    // layers: the special states take over from walking; landing and flinches ride on top for a moment
    const special = Math.min(1, w.slide + w.air * (1 - w.mantle) + w.mantle);
    const base = 1 - special, stand = base * (1 - w.crouch), crouch = base * w.crouch;
    const landEnd = C.land.duration * 0.6;
    const land = T.land < landEnd ? 0.85 * ss(T.land, 0, 0.06) * (1 - ss(T.land, landEnd * 0.3, landEnd)) : 0;
    const hit = T.hit < C.hit.duration ? 0.7 * Math.sin((T.hit / C.hit.duration) * Math.PI) : 0;
    const layers = [
      { clip: 'idle', t: this.idleT, w: stand * (1 - move) },
      ...GAITS.map(([name], i) => ({ clip: name, t: this.cycle * C[name].duration, w: stand * move * gw[i] })),
      { clip: 'crouchIdle', t: this.idleT, w: crouch * (1 - move) },
      { clip: 'crouchWalk', t: this.cycle * crouchLoop.duration, w: crouch * move },
      { clip: 'air', t: T.air, w: w.air * (1 - w.mantle) },
      // a slide: crouch height and torso, the slide clip's legs (out front, one tucked) — the clip itself lies
      // back on the ground, lower than a slide sits in play
      { clip: 'crouchIdle', t: this.idleT, w: w.slide, bones: ['hips', ...UPPER] },
      { clip: 'slide', t: T.slide, w: w.slide, bones: LEGS },
      { clip: 'climb', t: T.climb, w: w.mantle },
      { clip: 'land', t: T.land, w: land * (1 - w.slide) },
      { clip: 'hit', t: T.hit, w: hit, bones: FLINCH },
    ];
    const m = this.motion.blend(layers);
    m.swing(LEGS, THREE.MathUtils.lerp(1, stride, base * move)); // shorter steps at our slower speeds

    // the legs and hips swing toward travel; the torso stays square to the aim, bladed behind the rifle,
    // and carries the aim's pitch; the head looks along it
    // sliding legs swing down from the hips until the feet meet the floor
    if (w.slide > 0.01) m.turn(LEGS, RIGHT, w.slide * Math.asin(THREE.MathUtils.clamp((m.hipsRest.y + m.offset.y - 0.1) / 0.86, 0, 1)));
    m.turn(LOWER, UP, this.legYaw);
    m.turn(UPPER, RIGHT, -pitch * 0.35 - w.slide * 0.3 + w.crouch * 0.1);
    m.turn(['chest', 'neck', 'head', 'shoulder_L', 'shoulder_R'], UP, STANCE * (1 - w.ads * 0.3));
    m.turn(['neck', 'head'], UP, -STANCE * 0.8);
    m.turn(['neck', 'head'], RIGHT, -pitch * 0.3 + w.slide * 0.3 + w.ads * 0.08);
    this.inert.apply(m.world, m.offset, dt);
    m.apply();

    // whole-body lean: forward with speed and when speeding up (back when braking), into turns, into the wall
    const inv = 1 / Math.max(dt, 1e-3), ax = (this.vel.x - this.lastVel.x) * inv, az = (this.vel.z - this.lastVel.z) * inv;
    this.lastVel.copy(this.vel);
    const fwd = sp > 0.4 ? (ax * this.vel.x + az * this.vel.z) / sp : 0;
    const run = gw[2] * move * base * (1 - w.crouch);
    const leanX = S.leanX.to(THREE.MathUtils.clamp(0.1 * run + fwd * 0.018, -0.12, 0.22), HL.lean, dt);
    const leanY = S.leanY.to(THREE.MathUtils.clamp(-this.turnRate * sp * 0.025, -0.22, 0.22), HL.lean, dt);
    // on a wall the feet press into it and the head tips away (wall: +1 on the right; +z rolls the head right)
    this.body.rotation.set(leanX * (1 - w.slide), 0, leanY * base - w.wall * 0.32, 'YXZ');

    this.dt = dt;
    this.#holdGun(w);

    this.flashT -= dt;
    this.flashMesh.visible = this.flashT > 0;
    this.flash = Math.max(0, (this.flash ?? 0) - dt);
    const e = this.flash > 0 ? 0.5 : 0;
    for (const mt of this.mats) mt.emissive.setScalar(e);
  }

  /**
   * The gun rides on the chest (it bobs with the stride) but points where they aim, whatever the torso and the
   * lean are doing: its rotation is the aim, bladed behind the rifle, undone from the chest's and the lean's.
   */
  #holdGun(w) {
    _aim.setFromEuler(_e.set(-(this.pitch ?? this.aimPitch), STANCE * (1 - w.ads * 0.3), 0, 'YXZ'));
    _lean.setFromEuler(this.body.rotation).invert();
    this.arms.quaternion.copy(this.motion.world.chest).invert().multiply(_lean).multiply(_aim);
    // aiming: the gun comes up to the eye line and in toward the centre
    this.arms.position.set(-0.1 + w.ads * 0.05, 0.24 + w.ads * 0.1, 0.02 + w.ads * 0.04);
    // reload: gun dips and rolls, the support hand goes to the magazine; sliding tips it up
    const rl = this.reloadT > 0 ? Math.sin(Math.min(1, this.reloadT / this.reloadTime) * Math.PI) : 0;
    this.arms.quaternion.multiply(_aim.setFromEuler(_e.set(rl * 0.6 + w.slide * 0.3, 0, rl * 0.5)));
    // the support hand travels between the grip and the magazine rather than jumping
    const poses = this.weapon.poses, k = this.sm.hand.to(rl > 0.3 && poses.lhMag ? 1 : 0, HL.hand, this.dt ?? 1 / 60);
    for (let i = 0; i < 7; i++) _hand[i] = poses.lhRest[i] + ((poses.lhMag ?? poses.lhRest)[i] - poses.lhRest[i]) * k;
    gripGun(this.robot, this.gunFrame, poses, { left: _hand });
  }

  /** One clip exactly as authored, t seconds in, nothing layered on (the animation gallery). */
  showClip(name, t) {
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.aimYaw;
    this.body.rotation.set(0, 0, 0);
    this.motion.blend([{ clip: name, t, w: 1 }]).apply();
    this.#holdGun(NO_POSE_W);
  }

  /** Topple away from the killing shot (fallDir), then sink and hide. */
  animateDeath(dt) {
    if (!this.root.visible) return;
    if (this.live) {
      // the fall starts from the lean it died in
      this.live = false;
      this.deathFrom = { x: this.body.rotation.x, z: this.body.rotation.z };
    }
    this.deathT += dt;
    const t = Math.min(1, this.deathT / 0.55);
    const ease = t * t * (3 - 2 * t);
    // topple away from the shot, knees buckle first
    const f = this.deathFrom ?? { x: 0, z: 0 };
    this.body.rotation.set(THREE.MathUtils.lerp(f.x, -Math.cos(this.fallDir) * 1.45, ease), 0, THREE.MathUtils.lerp(f.z, Math.sin(this.fallDir) * 1.45, ease));
    this.legs.forEach((l) => { l.knee.rotation.x = damp(l.knee.rotation.x, 1.2, 8, dt); });
    this.arms.rotation.x = damp(this.arms.rotation.x, 0.8, 6, dt);
    gripGun(this.robot, this.gunFrame, this.weapon.poses);
    this.body.position.y = this.deathT > 2.6 ? -(this.deathT - 2.6) * 0.5 : 0;
    this.flashMesh.visible = false;
    if (this.marker) this.marker.visible = false;
    if (this.deathT > 3.6) this.root.visible = false;
    this.flash = 0;
    for (const mt of this.mats) mt.emissive.setScalar(0);
  }

  showMarker() { if (this.marker) this.marker.visible = true; }

  /** Animate from externally driven pos / vel / aimYaw / aimPitch (networked players). */
  pose(dt) { if (this.alive) this.animate(dt); else this.animateDeath(dt); }
}
