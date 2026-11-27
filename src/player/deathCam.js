import * as THREE from 'three';

/*
  The view after you die: it drops and topples onto its side where you fell, holds a beat on the floor, then
  swings over to follow whoever the level says to watch (your killer, or a teammate once they're down too) from
  behind and above their shoulder, pulled in short of walls, until you're back. With nobody to watch it rises
  over the spot you fell.
*/

const FALL = 0.6, HOLD = 1.1;
const CHASE = { back: 3.1, up: 0.75, side: 0.8, head: 1.4 };
const _ray = new THREE.Ray(), _v = new THREE.Vector3(), _t = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
const _e = new THREE.Euler(), _up = new THREE.Vector3(0, 1, 0);
const damp = (k, dt) => 1 - Math.exp(-k * dt);

export class DeathCam {
  constructor(camera) {
    this.camera = camera;
    this.t = -1;
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.from = new THREE.Vector3();
    this.q0 = new THREE.Quaternion();
    this.feet = new THREE.Vector3();
    this.floor = new THREE.Vector3();
  }

  get active() { return this.t >= 0; }

  /** Down at `feet`: the camera is still where the eye was. */
  start(feet) {
    const c = this.camera;
    this.t = 0;
    this.side = Math.random() < 0.5 ? -1 : 1;
    this.from.copy(c.position);
    this.q0.copy(c.quaternion);
    this.feet.copy(feet);
    _v.setFromMatrixColumn(c.matrixWorld, 0).setY(0).normalize();
    this.floor.copy(feet).addScaledVector(_v, this.side * 0.22).setY(feet.y + 0.3);
    this.yaw = Math.atan2(-c.matrixWorld.elements[8], -c.matrixWorld.elements[10]);
    this.pos.copy(c.position);
    this.quat.copy(c.quaternion);
  }

  stop() { this.t = -1; }

  /** watch: a combatant ({ pos, facing }) to follow, or null. */
  update(dt, { watch, octree }) {
    if (this.t < 0) return;
    this.t += dt;
    const t = this.t, c = this.camera;
    if (t < FALL + HOLD) {
      // the drop speeds up like a fall; the view rolls onto its side and tips up a little as it lands
      const k = Math.min(1, t / FALL), e = k * k * (3 - 2 * k);
      this.pos.lerpVectors(this.from, this.floor, k * k);
      this.quat.copy(this.q0).multiply(_q.setFromEuler(_e.set(0.18 * e, 0, this.side * 1.05 * e)));
      // a small bounce as the head hits the floor
      if (k >= 1) this.pos.y = this.floor.y + Math.max(0, Math.sin((t - FALL) * 14) * 0.05 * Math.exp(-(t - FALL) * 6));
    } else {
      let target, want;
      if (watch) {
        target = _t.copy(watch.pos).setY(watch.pos.y + CHASE.head);
        const f = watch.facing;
        want = _v.set(-Math.sin(f) * CHASE.back + Math.cos(f) * CHASE.side, CHASE.up, -Math.cos(f) * CHASE.back - Math.sin(f) * CHASE.side).add(target);
      } else {
        target = _t.copy(this.feet);
        want = _v.set(Math.sin(this.yaw) * 2.6, 4.2, Math.cos(this.yaw) * 2.6).add(this.feet);
      }
      // keep the camera out of walls: pull it in along the line from the target
      if (octree) {
        _ray.origin.copy(target);
        _ray.direction.subVectors(want, target);
        const len = _ray.direction.length();
        _ray.direction.divideScalar(len || 1);
        const hit = octree.rayIntersect(_ray);
        if (hit && hit.distance < len + 0.3) want.copy(target).addScaledVector(_ray.direction, Math.max(0.4, hit.distance - 0.35));
      }
      this.pos.lerp(want, damp(watch ? 4 : 2, dt));
      _m.lookAt(this.pos, target, _up);
      this.quat.slerp(_q.setFromRotationMatrix(_m), damp(watch ? 7 : 3, dt));
    }
    c.position.copy(this.pos);
    c.quaternion.copy(this.quat);
    c.updateMatrixWorld();
  }
}
