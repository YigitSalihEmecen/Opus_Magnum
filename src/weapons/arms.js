import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { PALETTE as P, toon } from '../core/toon.js';

const glove = toon(0x2b2c30, { rim: 0.3, rimColor: 0xfff3e8 });
const knuckle = toon(P.clay, { rim: 0.2 });
const cuff = toon(P.manilla, { rim: 0.15 });
const sleeve = toon(0x5d5c48, { rim: 0.2, rimColor: 0xfff3e8 });

const seg = (r, len) => new THREE.CapsuleGeometry(r, len, 4, 8).rotateX(Math.PI / 2).translate(0, 0, -len / 2);

/**
 * Stylized gloved hand. Local frame: wrist at origin, fingers toward -Z, palm facing -Y, thumb toward -X.
 * `curl` (radians per joint) closes the fingers toward the palm. Left hands are mirrored.
 * The wrist is a ball (looks the same from any bend) and the palm tapers into it through a soft
 * heel, so bending against the forearm's wrist segment never shows a seam. Cuffs live on the forearm.
 */
export function makeHand({ left = false, curl = 1.1, thumbCurl = 0.5 } = {}) {
  const hand = new THREE.Group();
  const body = new THREE.Group();
  hand.add(body);
  if (left) body.scale.x = -1;

  const palm = new THREE.Mesh(new RoundedBoxGeometry(0.082, 0.03, 0.072, 2, 0.012), glove);
  palm.position.set(0, 0, -0.059);
  const heel = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), glove);
  heel.scale.set(0.035, 0.0148, 0.03);
  heel.position.z = -0.026;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(WRIST_R, 20, 14), glove);
  const plate = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.008, 0.026, 2, 0.003), knuckle);
  plate.position.set(0, 0.016, -0.083);
  body.add(palm, heel, ball, plate);

  const fingers = [];
  [-0.028, -0.0095, 0.0095, 0.028].forEach((x, i) => {
    const lens = [0.03, 0.022, 0.018].map((l) => l * (i === 3 ? 0.82 : i === 0 ? 0.95 : 1));
    let parent = body;
    let z = -0.094;
    const joints = [];
    lens.forEach((len, j) => {
      const joint = new THREE.Group();
      joint.position.set(j === 0 ? x : 0, j === 0 ? 0.002 : 0, z);
      joint.add(new THREE.Mesh(seg(0.0105 - j * 0.001, len), glove));
      parent.add(joint);
      joints.push(joint);
      parent = joint;
      z = -len - 0.006;
    });
    fingers.push(joints);
  });

  const thumb = [];
  {
    const base = new THREE.Group();
    base.position.set(-0.04, -0.006, -0.03);
    base.rotation.set(0, 0.75, -0.4);
    base.add(new THREE.Mesh(seg(0.0115, 0.024), glove));
    const tip = new THREE.Group();
    tip.position.z = -0.031;
    tip.add(new THREE.Mesh(seg(0.01, 0.017), glove));
    base.add(tip);
    body.add(base);
    thumb.push(base, tip);
  }

  hand.traverse((o) => { if (o.isMesh) o.castShadow = true; });

  hand.userData.setCurl = (c, tc = thumbCurl) => {
    fingers.forEach((joints, i) => joints.forEach((j, k) => (j.rotation.x = -c * (k === 0 ? 0.85 : 1) * (1 - i * 0.03))));
    thumb[1].rotation.set(-tc, 0, 0);
    thumb[0].rotation.set(-tc * 0.4, 0.75, -0.4); // full reset: aimThumb may have twisted it last frame
  };
  /** Override just the index finger (a trigger finger lying along the trigger guard). Call after setCurl. */
  /**
   * Point the thumb's two joints at world-space targets: the base segment toward `knuckle`, the tip
   * toward `tip` (e.g. wrapped behind a pistol's backstrap, then laid forward along the frame).
   */
  hand.userData.aimThumb = (knuckle, tip) => {
    for (const [joint, target] of [[thumb[0], knuckle], [thumb[1], tip]]) {
      joint.parent.updateWorldMatrix(true, false);
      const d = joint.parent.worldToLocal(_t.copy(target)).sub(joint.position).normalize();
      joint.quaternion.setFromUnitVectors(NEG_Z, d);
      joint.updateWorldMatrix(false, false);
    }
  };
  hand.userData.setIndex = (c) => fingers[0].forEach((j, k) => (j.rotation.x = -c * (k === 0 ? 0.6 : 1)));
  hand.userData.setCurl(curl, thumbCurl);
  return hand;
}

const WRIST_R = 0.026;
const WRIST_LEN = 0.058; // bare glove between the wrist ball and the sleeve cuff

/** Forearm (sleeve → cuff → gloved wrist) spanning from an elbow point to a wrist. Update every frame. */
export class Forearm {
  constructor(scene) {
    this.mesh = new THREE.Group();
    this.sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.044, 1, 14, 1).translate(0, 0.5, 0), sleeve);
    this.cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.0385, 0.0385, 0.022, 16), cuff);
    this.wrist = new THREE.Mesh(new THREE.CylinderGeometry(WRIST_R - 0.001, 0.029, WRIST_LEN, 16, 1, true).translate(0, -WRIST_LEN / 2, 0), glove);
    for (const m of [this.sleeve, this.cuff, this.wrist]) { m.castShadow = true; this.mesh.add(m); }
    scene.add(this.mesh);
    this._dir = new THREE.Vector3();
  }

  set(wrist, elbow) {
    this._dir.subVectors(wrist, elbow);
    const len = this._dir.length();
    this.mesh.position.copy(elbow);
    this.mesh.quaternion.setFromUnitVectors(UP, this._dir.normalize());
    this.sleeve.scale.y = len - WRIST_LEN;
    this.cuff.position.y = len - WRIST_LEN;
    this.wrist.position.y = len;
  }
}
const UP = new THREE.Vector3(0, 1, 0);
const NEG_Z = new THREE.Vector3(0, 0, -1);
const _t = new THREE.Vector3();
