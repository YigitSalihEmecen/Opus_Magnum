import * as THREE from 'three';
import { ITEMS } from './items.js';
import { THROW } from './inventory.js';
import { sample } from '../weapons/melee.js';
import { poseArm } from '../character/robot.js';
import { characterById } from '../character/characters.js';

/*
  First-person presentation of the item in use, in the viewmodel scene while the gun is lowered: the right
  hand brings it up, works it (a wobble while healing, a pulsing core while charging), or winds up and
  throws a grenade, or throws a punch (weapons/melee.js hands over the fist's pose). Driven by an action
  { id, kind, t, time } from the inventory or the melee.
  The hand grips the item like a pistol grip (same hand frame and pose as the Lynx), so every character's
  arm fits it.
*/

const D2R = Math.PI / 180;
const HAND = [0.002, -0.068, 0.114, -14, -25, -90, 1.25];
// where each item sits in the grip frame (x, y, z, rx, ry, rz) and how big (first-person items read a bit large)
const HOLD = {
  medkit: { at: [-0.09, -0.134, 0.114, 0, 0, 0], scale: 0.6, frame: [0.15, -0.005, -0.52, 14, -14, 0] }, // by its end, cross to the camera
  bandage: { at: [-0.06, -0.1, 0.114, 0, 35, 0], scale: 0.8, frame: [0.15, -0.02, -0.5, 12, -12, 0] },
  charger: { at: [-0.06, -0.15, 0.1, 0, 0, -12], scale: 0.9, frame: [0.13, 0, -0.46, 14, -16, 0] },
  grenade: { at: [0, -0.115, 0.105, 0, 0, 0], scale: 1.15, frame: [0.15, -0.035, -0.52, 6, 6, 0] },
};
// an overhand throw on the right side: held low while the pin comes out, the arm swings back and up beside the
// head (cocked, the grenade tipped back), comes over and forward to let go high in front, then follows through down
// and across (t s → pose in the camera's frame)
const THROW_KEYS = [
  [0, HOLD.grenade.frame],
  [THROW.pin, [0.16, -0.06, -0.5, 10, 6, 0]],
  [THROW.release - 0.12, [0.2, 0.1, -0.44, -25, 20, -18]],
  [THROW.release, [0.13, 0.12, -0.68, 40, 6, -4]],
  [THROW.release + 0.12, [0.02, -0.16, -0.62, 42, -8, 12]],
  [THROW.time, [-0.02, -0.34, -0.5, 55, -10, 14]],
];
const ANCHOR = new THREE.Vector3(0.26, -0.42, 0.18);
// a raised hand (the throw's wind-up and release) lifts the shoulder anchor, so the elbow comes up and out to the
// side instead of the forearm pointing back into the lens
const ANCHOR_HIGH = new THREE.Vector3(0.36, -0.1, 0.12), _anchor = new THREE.Vector3();
// a punch reaches out from a shoulder low and far out to the right: the arm comes in from the side, the middle stays clear
const ANCHOR_PUNCH = new THREE.Vector3(0.62, -0.44, 0.05);
const MAX_BEND = 42 * D2R;
const _wr = new THREE.Vector3(), _hq = new THREE.Quaternion(), _dir = new THREE.Vector3(), _back = new THREE.Vector3();
const _q = new THREE.Quaternion(), _bq = new THREE.Quaternion(), _el = new THREE.Vector3(), _sh = new THREE.Vector3(), _pl = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const ease = (t) => t * t * (3 - 2 * t);

function setPose(obj, p) {
  obj.position.set(p[0], p[1], p[2]);
  obj.rotation.set(p[3] * D2R, p[4] * D2R, p[5] * D2R, 'YXZ');
}

export class Handheld {
  constructor(scene) {
    this.scene = scene;
    this.frame = new THREE.Group();
    this.frame.visible = false;
    scene.add(this.frame);
    this.hand = new THREE.Group();
    setPose(this.hand, HAND);
    this.frame.add(this.hand);
    this.holder = new THREE.Group();
    this.frame.add(this.holder);
    this.models = {};
    this.show = 0;
    this.last = null;
    this.setCharacter('rivet');
  }

  setCharacter(id) {
    const ch = characterById(id);
    if (this.character === ch.id) return;
    if (this.arm) this.scene.remove(this.arm.upper);
    this.character = ch.id;
    this.arm = ch.arm(-1);
    this.arm.upper.visible = false;
    this.scene.add(this.arm.upper);
    this.hand.userData = this.arm.hand.userData;
    this.hand.userData.setCurl(HAND[6]);
  }

  #model(id) {
    if (!this.models[id]) {
      const m = ITEMS[id].build();
      const h = HOLD[id];
      setPose(m, h.at);
      m.scale.setScalar(h.scale);
      m.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; } });
      this.holder.add(m);
      this.models[id] = m;
    }
    return this.models[id];
  }

  update(dt, action, time) {
    if (action) this.last = { ...action };
    const a = this.last;
    this.show = THREE.MathUtils.clamp(this.show + (action ? dt : -dt) / (a?.kind === 'melee' ? 0.08 : 0.2), 0, 1);
    const on = this.show > 0 && !!a;
    this.frame.visible = this.arm.upper.visible = on;
    if (!on) return;

    for (const [id, m] of Object.entries(this.models)) m.visible = id === a.id;
    const melee = a.kind === 'melee'; // bare-handed: a fist, nothing in it
    const model = melee ? null : this.#model(a.id);
    let pose = melee ? a.pose : HOLD[a.id].frame;
    let shake = 0;
    if (melee) {
      this.hand.userData.setCurl(1.5, 1);
    } else if (a.kind === 'throw') {
      pose = sample(THROW_KEYS, a.t);
      model.visible = a.t < THROW.release;
      model.userData.parts.pin.visible = a.t < THROW.pin;
      this.hand.userData.setCurl(model.visible ? HAND[6] : 0.4);
    } else {
      shake = Math.sin(time * (a.kind === 'heal' ? 13 : 7)) * (a.t / a.time < 0.92 ? 1 : 0);
      this.hand.userData.setCurl(HAND[6]);
    }
    setPose(this.frame, pose);
    const rise = 1 - ease(this.show);
    this.frame.position.y -= 0.3 * rise;
    this.frame.rotation.x -= 0.5 * rise;
    this.frame.position.y += shake * 0.006;
    this.frame.rotation.z += shake * 0.05;
    if (a.kind === 'charge') {
      const core = model.children.find((c) => c.material?.isMeshBasicMaterial);
      if (core) core.scale.set(1, 0.85 + 0.15 * Math.abs(Math.sin(time * 9)), 1);
    }

    this.scene.updateMatrixWorld();
    this.#layArm(melee);
  }

  /** Same arm laying as the gun viewmodel: forearm toward the shoulder anchor, wrist bend capped. */
  #layArm(punch = false) {
    const wrist = this.hand.getWorldPosition(_wr);
    const handQ = this.hand.getWorldQuaternion(_hq);
    const anchor = punch ? _anchor.copy(ANCHOR_PUNCH) : _anchor.copy(ANCHOR).lerp(ANCHOR_HIGH, THREE.MathUtils.smoothstep(wrist.y, -0.06, 0.1));
    const dir = _dir.subVectors(anchor, wrist).normalize();
    const back = _back.set(0, 0, 1).applyQuaternion(handQ);
    const bend = dir.angleTo(back);
    if (bend > MAX_BEND) dir.applyQuaternion(_q.identity().slerp(_bq.setFromUnitVectors(dir, back), 1 - MAX_BEND / bend));
    const elbow = _el.copy(wrist).addScaledVector(dir, this.arm.dims.fore);
    const shoulder = _sh.subVectors(anchor, elbow).normalize().multiplyScalar(this.arm.dims.upper).add(elbow);
    poseArm(this.arm, shoulder, elbow, wrist, handQ, _pl.copy(elbow).add(_down));
  }
}
