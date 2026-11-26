import * as THREE from 'three';
import { PALETTE as P } from '../core/toon.js';
import { FX_LAYER } from '../core/renderer.js';
import { gripGun, bakeFlat } from './robot.js';
import { buildCharacter } from './characters.js';
import { WEAPONS } from '../weapons/weapons.js';
import { Motion } from './motion.js';

/*
  A character in the world holding a gun: the robot body, the third-person gun with its muzzle flash, the
  team marker, its movement, the death fall and the hit boxes. It is only a body: something else moves it
  (pos, vel, aimYaw, aimPitch, poseTarget, reloadT) and calls pose(dt) each frame — the TDM bot's brain, or a
  networked player's snapshots.
  Movement is captured motion (motion.js) blended by what the body is doing — idle, walk, jog and sprint on one
  stride phase matched to its real speed (run backwards when backpedalling), crouch, air, slide, climbing,
  landing and flinching — then shaped in code: the legs turn toward travel while the torso stays on the aim,
  the body leans into speed, acceleration and turns, and the hands stay on the gun.
*/

const NO_POSE = {};
const STANCE = -0.5; // torso bladed (left shoulder forward) behind the rifle
const G = {
  flash: new THREE.PlaneGeometry(0.34, 0.34),
  marker: new THREE.OctahedronGeometry(0.1, 0),
};
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const ss = THREE.MathUtils.smoothstep;
const UP = new THREE.Vector3(0, 1, 0), RIGHT = new THREE.Vector3(1, 0, 0);
// gaits: the speed (m/s) at which each loop plays alone (walking pace, our run, our sprint); between them they
// cross-fade on one stride phase
const GAITS = [['walk', 1.4], ['jog', 3.6], ['sprint', 5.4]];
// playback follows speed / the clip's own ground speed, eased (^CADENCE): the stylised run and sprint cycles are
// authored faster than we move, and slowing them fully would look floaty — a touch of stride stretch reads better
const CADENCE = 0.75;
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
    Object.assign(this, { cycle: 0, idleT: 0, legYaw: 0, lean: new THREE.Vector2(), lastVel: new THREE.Vector3(), heading: 0, turnRate: 0 });
    this.clipT = { air: 0, slide: 0, climb: 9, land: 9, hit: 9 };

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
    this.root.position.copy(this.pos);
    this.root.position.y += this.hopY;
    this.root.rotation.y = this.aimYaw;

    // what the body is doing: networked players set poseTarget, bots only hop; eased so changes blend
    const w = (this.poseW ??= { crouch: 0, slide: 0, wall: 0, air: 0, ads: 0, mantle: 0 });
    const tgt = this.poseTarget ?? NO_POSE;
    const was = { air: w.air, mantle: w.mantle };
    for (const key in w) w[key] = damp(w[key], key === 'air' ? Math.max(tgt.air ?? 0, this.hopY > 0 ? 1 : 0) : tgt[key] ?? 0, 12, dt);
    const T = this.clipT, C = this.motion.clips;
    for (const k in T) T[k] += dt;
    if (was.air > 0.5 && w.air <= 0.5) T.land = 0; // touched down
    if (was.mantle < 0.2 && w.mantle >= 0.2) T.climb = 0;
    if (this.flash > 0.07) T.hit = 0;

    // travel: the legs face it (backpedalling runs the cycle backwards), the torso keeps facing the aim
    const sp = Math.hypot(this.vel.x, this.vel.z);
    let legYaw = 0, dir = 1;
    if (sp > 0.4) {
      legYaw = wrap(Math.atan2(this.vel.x, this.vel.z) - this.aimYaw);
      if (Math.abs(legYaw) > Math.PI / 2) { legYaw = wrap(legYaw + Math.PI); dir = -1; }
      const h = Math.atan2(this.vel.x, this.vel.z);
      this.turnRate = damp(this.turnRate, wrap(h - this.heading) / Math.max(dt, 1e-3), 6, dt);
      this.heading = h;
    } else this.turnRate = damp(this.turnRate, 0, 6, dt);
    this.legYaw = damp(this.legYaw, THREE.MathUtils.clamp(legYaw, -1.2, 1.2), 10, dt);

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
    const rate = THREE.MathUtils.clamp(Math.pow(sp / Math.max(0.3, speed), CADENCE), 0.4, 2.2) / dur; // cycles per second
    this.cycle += dt * rate * dir * move;
    this.idleT += dt;
    this.phase = this.cycle * Math.PI * 2; // footsteps: one per half cycle

    // layers: the special states take over from walking; landing and flinches ride on top for a moment
    const special = Math.min(1, w.slide + w.air * (1 - w.mantle) + w.mantle);
    const base = 1 - special, stand = base * (1 - w.crouch), crouch = base * w.crouch;
    const land = T.land < C.land.duration * 0.6 ? 0.85 * (1 - T.land / (C.land.duration * 0.6)) : 0;
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

    // the legs and hips swing toward travel; the torso stays square to the aim, bladed behind the rifle,
    // and carries the aim's pitch; the head looks along it
    // sliding legs swing down from the hips until the feet meet the floor
    if (w.slide > 0.01) m.turn(LEGS, RIGHT, w.slide * Math.asin(THREE.MathUtils.clamp((m.hipsRest.y + m.offset.y - 0.1) / 0.86, 0, 1)));
    m.turn(LOWER, UP, this.legYaw);
    m.turn(UPPER, RIGHT, -this.aimPitch * 0.35 - w.slide * 0.3 + w.crouch * 0.1);
    m.turn(['chest', 'neck', 'head', 'shoulder_L', 'shoulder_R'], UP, STANCE * (1 - w.ads * 0.3));
    m.turn(['neck', 'head'], UP, -STANCE * 0.8);
    m.turn(['neck', 'head'], RIGHT, -this.aimPitch * 0.3 + w.slide * 0.3 + w.ads * 0.08);
    m.apply();

    // whole-body lean: forward with speed and when speeding up (back when braking), into turns, into the wall
    const inv = 1 / Math.max(dt, 1e-3), ax = (this.vel.x - this.lastVel.x) * inv, az = (this.vel.z - this.lastVel.z) * inv;
    this.lastVel.copy(this.vel);
    const fwd = sp > 0.4 ? (ax * this.vel.x + az * this.vel.z) / sp : 0;
    const run = gw[2] * move * base * (1 - w.crouch);
    this.lean.x = damp(this.lean.x, THREE.MathUtils.clamp(0.1 * run + fwd * 0.018, -0.12, 0.22), 7, dt);
    this.lean.y = damp(this.lean.y, THREE.MathUtils.clamp(-this.turnRate * sp * 0.025, -0.22, 0.22), 7, dt);
    this.body.rotation.set(this.lean.x * (1 - w.slide), 0, this.lean.y * base + w.wall * 0.32, 'YXZ');

    // the gun rides on the chest (it bobs with the stride) but points where they aim, whatever the torso and
    // the lean are doing: its rotation is the aim, bladed behind the rifle, undone from the chest's and the lean's
    _aim.setFromEuler(_e.set(-this.aimPitch, STANCE * (1 - w.ads * 0.3), 0, 'YXZ'));
    _lean.setFromEuler(this.body.rotation).invert();
    this.arms.quaternion.copy(m.world.chest).invert().multiply(_lean).multiply(_aim);
    // aiming: the gun comes up to the eye line and in toward the centre
    this.arms.position.set(-0.1 + w.ads * 0.05, 0.24 + w.ads * 0.1, 0.02 + w.ads * 0.04);
    // reload: gun dips and rolls, the support hand goes to the magazine; sliding tips it up
    const rl = this.reloadT > 0 ? Math.sin(Math.min(1, this.reloadT / this.reloadTime) * Math.PI) : 0;
    this.arms.quaternion.multiply(_aim.setFromEuler(_e.set(rl * 0.6 + w.slide * 0.3, 0, rl * 0.5)));
    const poses = this.weapon.poses;
    gripGun(this.robot, this.gunFrame, poses, { left: rl > 0.3 ? poses.lhMag ?? poses.lhRest : poses.lhRest });

    this.flashT -= dt;
    this.flashMesh.visible = this.flashT > 0;
    this.flash = Math.max(0, (this.flash ?? 0) - dt);
    const e = this.flash > 0 ? 0.5 : 0;
    for (const mt of this.mats) mt.emissive.setScalar(e);
  }

  /** Topple away from the killing shot (fallDir), then sink and hide. */
  animateDeath(dt) {
    if (!this.root.visible) return;
    this.deathT += dt;
    const t = Math.min(1, this.deathT / 0.55);
    const ease = 1 - Math.pow(1 - t, 3);
    // topple away from the shot, knees buckle first
    this.body.rotation.set(-Math.cos(this.fallDir) * ease * 1.45, 0, Math.sin(this.fallDir) * ease * 1.45);
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
