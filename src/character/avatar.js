import * as THREE from 'three';
import { PALETTE as P } from '../core/toon.js';
import { FX_LAYER } from '../core/renderer.js';
import { gripGun, bakeFlat } from './robot.js';
import { buildCharacter } from './characters.js';
import { WEAPONS } from '../weapons/weapons.js';

/*
  A character in the world holding a gun: the robot body, the third-person gun with its muzzle flash, the
  team marker, the movement poses (run, crouch, slide, wallrun, air, aiming, reloading), the death fall and
  the hit boxes. It is only a body: something else moves it (pos, vel, aimYaw, aimPitch, poseTarget,
  reloadT) and calls pose(dt) each frame — the TDM bot's brain, or a networked player's snapshots.
*/

const NO_POSE = {};
const STANCE = -0.5; // torso bladed (left shoulder forward) behind the rifle
const G = {
  flash: new THREE.PlaneGeometry(0.34, 0.34),
  marker: new THREE.OctahedronGeometry(0.1, 0),
};
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

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
    Object.assign(this, { hips: b.hips, spine: b.spine, neck: b.neck, hipsY: b.hips.position.y });
    this.legs = ['L', 'R'].map((s) => ({ thigh: r.legs[s].thigh, knee: r.legs[s].shin }));

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

    // lower body turns toward travel; the legs run backwards when backpedalling; the torso stays bladed
    const sp = Math.hypot(this.vel.x, this.vel.z);
    let legYaw = 0, dirSign = 1;
    if (sp > 0.4) {
      legYaw = wrap(Math.atan2(this.vel.x, this.vel.z) - this.aimYaw);
      if (Math.abs(legYaw) > Math.PI / 2) { legYaw = wrap(legYaw + Math.PI); dirSign = -1; }
    }
    this.hips.rotation.y = damp(this.hips.rotation.y, THREE.MathUtils.clamp(legYaw, -1.2, 1.2), 10, dt);
    this.phase += sp * dt * 1.9 * dirSign;
    // movement poses (networked players set poseTarget; bots only hop): weights eased so state changes blend
    const w = (this.poseW ??= { crouch: 0, slide: 0, wall: 0, air: 0, ads: 0, mantle: 0 });
    const tgt = this.poseTarget ?? NO_POSE;
    for (const key in w) w[key] = damp(w[key], tgt[key] ?? 0, 12, dt);
    const air = Math.max(w.air, this.hopY > 0 ? 1 : 0, w.mantle);
    const low = Math.max(w.crouch, w.slide);
    const k = Math.min(1, sp / 4) * (1 - w.slide) * (1 - air * 0.7);
    this.legs.forEach((l, i) => {
      const ph = this.phase + i * Math.PI;
      let th = -Math.sin(ph) * 0.65 * k * (1 - w.crouch * 0.4) - 0.08 - air * 0.55 - w.crouch * 0.95;
      let kn = Math.max(0, Math.cos(ph)) * 0.9 * k + 0.14 + air * 0.95 + w.crouch * 1.55;
      // slide: lead leg stretched out front, the other folded under
      th += w.slide * (i === 0 ? -1.35 : -0.35);
      kn += w.slide * (i === 0 ? 0.15 : 1.85);
      l.thigh.rotation.x = th;
      l.knee.rotation.x = kn;
    });
    const bob = Math.abs(Math.sin(this.phase)) * 0.04 * k;
    this.hips.position.y = this.hipsY - 0.035 + bob - w.crouch * 0.3 - w.slide * 0.45 - air * 0.05;
    // wallrun: whole body leans into the wall; slide leans back; mantle/vault pitches forward
    this.body.rotation.set(0, 0, w.wall * 0.32);
    this.spine.rotation.set(-this.aimPitch * 0.35 + 0.08 * k - w.slide * 0.45 + w.mantle * 0.5 + w.crouch * 0.12, -this.hips.rotation.y + STANCE * (1 - w.ads * 0.3), 0, 'YXZ');
    this.arms.rotation.set(-this.aimPitch * 0.65 + w.slide * 0.3, 0, 0);
    // aiming: the gun comes up to the eye line and in toward the centre
    this.arms.position.set(-0.1 + w.ads * 0.05, 0.24 + w.ads * 0.1, 0.02 + w.ads * 0.04);
    this.neck.rotation.set(-this.aimPitch * 0.3 + w.slide * 0.3 + w.ads * 0.08, -STANCE * 0.8, w.ads * -0.12, 'YXZ');
    // reload: gun dips and rolls, the support hand goes to the magazine
    const rl = this.reloadT > 0 ? Math.sin(Math.min(1, this.reloadT / this.reloadTime) * Math.PI) : 0;
    this.arms.rotation.x += rl * 0.6;
    this.arms.rotation.z = rl * 0.5;
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
