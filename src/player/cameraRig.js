import * as THREE from 'three';
import { SPEED } from './movement.js';

const D2R = Math.PI / 180;
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
// recoil the player hasn't pulled against returns to where they aimed, starting this long after the last shot
const RECOVER = { delay: 0.12, rate: 9 };
// lean (Q / E): the eye swings out this far (m) and drops a little, the view rolls; a wall stops it pad short
const LEAN = { side: 0.414, drop: 0.072, roll: 12.6 * D2R, rate: 12, pad: 0.24 };
const _ray = new THREE.Ray(), _right = new THREE.Vector3();

/** Damped spring on a scalar. */
class Spring {
  constructor(k = 120, c = 14) { this.k = k; this.c = c; this.x = 0; this.v = 0; }
  update(dt) {
    this.v += (-this.k * this.x - this.c * this.v) * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

/**
 * First-person camera: mouse look, recoil, FOV, head bob, roll and landing/mantle feedback.
 * Reads movement state; never writes to it.
 */
export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    camera.rotation.order = 'YXZ';
    this.yaw = 0;
    this.pitch = 0;
    this.sensitivity = 1.0;
    this.hFov = 104;
    this.eye = 1.62;
    this.roll = 0;
    this.fovKick = 0;
    this.zoom = 1;
    this.pendingRecoil = new THREE.Vector2();
    this.recoilDebt = new THREE.Vector2(); // aim moved by recoil and not yet countered by the mouse (rad)
    this.sinceRecoil = 9;
    this.lean = 0; // -1 left … 1 right, after walls
    this.punchPitch = new Spring(220, 18);
    this.punchYaw = new Spring(220, 18);
    this.punchRoll = new Spring(180, 14);
    this.dip = new Spring(150, 15);
    this.stepY = 0;
    this.bob = new THREE.Vector2();
    this.bobWeight = 0;
  }

  look(input, sensMult = 1) {
    const k = 0.0022 * this.sensitivity * sensMult;
    const dy = -input.mouseDX * k, dp = -input.mouseDY * k;
    this.yaw += dy;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dp, -89 * D2R, 89 * D2R);
    // pulling against the kick settles that much of it: recovery only returns what wasn't countered
    const d = this.recoilDebt;
    if (d.x * dp < 0) d.x -= Math.sign(d.x) * Math.min(Math.abs(d.x), Math.abs(dp));
    if (d.y * dy < 0) d.y -= Math.sign(d.y) * Math.min(Math.abs(d.y), Math.abs(dy));
  }

  /** Permanent aim displacement (degrees), applied over a few frames for smoothness. */
  addRecoil(pitchDeg, yawDeg) { this.pendingRecoil.x += pitchDeg * D2R; this.pendingRecoil.y += yawDeg * D2R; this.sinceRecoil = 0; }

  /** Visual-only kick that springs back (degrees). */
  punch(pitchDeg, yawDeg = 0, rollDeg = 0) {
    this.punchPitch.v += pitchDeg * D2R * 18;
    this.punchYaw.v += yawDeg * D2R * 18;
    this.punchRoll.v += rollDeg * D2R * 18;
  }

  /**
   * Taking a hit: the view jolts back (harder for bigger hits, k 0..1), twists and rolls away from the side it
   * came from (side: -1 left … 1 right), and the aim takes a small kick that settles back on its own.
   */
  flinch(k, side = 0) {
    const s = side + (Math.random() - 0.5) * 0.4;
    this.punch(-(1.4 + 3.6 * k), s * (1.2 + 2.8 * k), -s * (2.5 + 5 * k));
    this.addRecoil(0.3 + 1.1 * k, (Math.random() - 0.5) * 0.8 * k);
  }

  land(impact) { this.dip.v -= THREE.MathUtils.clamp(impact * 0.12, 0, 2.4); }

  update(dt, mv, { ads = 0, axes = { x: 0, y: 0 }, zoom = 1.32, lean = 0 } = {}) {
    // recoil drains into aim, then (once the shooting stops) back out to where the player was aiming
    const r = 1 - Math.exp(-dt * 38);
    const d = this.recoilDebt;
    d.addScaledVector(this.pendingRecoil, r);
    this.sinceRecoil += dt;
    const back = this.sinceRecoil > RECOVER.delay ? 1 - Math.exp(-dt * RECOVER.rate) : 0;
    this.pitch = THREE.MathUtils.clamp(this.pitch + this.pendingRecoil.x * r - d.x * back, -89 * D2R, 89 * D2R);
    this.yaw += this.pendingRecoil.y * r - d.y * back;
    d.multiplyScalar(1 - back);
    this.pendingRecoil.multiplyScalar(1 - r);

    // eye height
    this.eye = damp(this.eye, mv.eyeHeight, mv.state === 'slide' || mv.state === 'vault' ? 20 : 12, dt);

    // head bob from gait
    const moving = mv.state === 'ground' && mv.grounded;
    const speedT = Math.min(1, mv.speed / (8 * SPEED));
    this.bobWeight = damp(this.bobWeight, moving ? speedT : 0, 10, dt);
    const ph = mv.gaitPhase;
    const amp = this.bobWeight * (1 - ads * 0.8);
    this.bob.set(Math.sin(ph) * 0.018 * amp, (Math.cos(ph * 2) - 1) * 0.5 * 0.028 * amp);

    // roll: strafe lean, slide tilt
    let targetRoll = -axes.x * 1.1 * D2R;
    if (mv.state === 'slide') targetRoll = 3.5 * D2R;
    targetRoll *= 1 - ads * 0.75; // aimed, keep the horizon nearly level
    this.roll = damp(this.roll, targetRoll, 9, dt);

    // mantle dip
    const mp = mv.mantleProgress;
    const mantlePitch = mv.state === 'mantle' ? -Math.sin(mp * Math.PI) * 12 * D2R : 0; // a look down at the hands on the ledge
    const mantleRoll = mv.state === 'mantle' ? Math.sin(mp * Math.PI) * 2.5 * D2R : 0;
    // vault: a quick dip of the head and a lean toward the planted hand
    const vaultK = mv.state === 'vault' ? Math.sin(mp * Math.PI) : 0;

    const dipY = this.dip.update(dt);
    const pp = this.punchPitch.update(dt);
    const py = this.punchYaw.update(dt);
    const pr = this.punchRoll.update(dt);

    // FOV: speed kick, ADS zoom
    const fast = THREE.MathUtils.clamp((mv.speed / SPEED - 6) / 6, 0, 1);
    this.fovKick = damp(this.fovKick, fast * 7 + (mv.state === 'slide' ? 3 : 0), 5, dt);
    this.zoom = 1 + ads * (zoom - 1);
    const cam = this.camera;
    // angular camera motion (punch, bob, roll, dips) is magnified on screen by the zoom: past a red dot's
    // zoom, scale it down so a 6x scope shakes about as much on screen as a red dot does
    const zk = Math.min(1, 1.32 / this.zoom);
    const hFov = (this.hFov + this.fovKick * (1 - ads)) * D2R;
    const vFov = 2 * Math.atan(Math.tan(hFov / 2) / cam.aspect / this.zoom);
    const fovDeg = vFov / D2R;
    if (Math.abs(cam.fov - fovDeg) > 1e-3) { cam.fov = fovDeg; cam.updateProjectionMatrix(); }

    // compose
    const right = _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    // step smoothing: a sudden small height change while grounded (kerb, stair, ramp lip) is absorbed and
    // eased out over a few frames instead of jolting the view; real falls and jumps pass straight through
    const dy = this.lastFeetY === undefined ? 0 : mv.feet.y - this.lastFeetY;
    if (mv.grounded && Math.abs(dy) > 0.09 && Math.abs(dy) < 0.6) this.stepY -= dy;
    this.stepY = damp(this.stepY, 0, 16, dt);
    this.lastFeetY = mv.feet.y;
    cam.position.copy(mv.feet);
    cam.position.y += this.eye + (this.bob.y + dipY * 0.08) * zk + this.stepY;
    cam.position.addScaledVector(right, this.bob.x * zk);
    // lean: as far toward the asked side as the wall there allows
    let reach = 1;
    if (lean && mv.octree) {
      _ray.origin.copy(cam.position);
      _ray.direction.copy(right).multiplyScalar(Math.sign(lean));
      const hit = mv.octree.rayIntersect(_ray);
      if (hit) reach = THREE.MathUtils.clamp((hit.distance - LEAN.pad) / LEAN.side, 0, 1);
    }
    this.lean = damp(this.lean, lean * reach, LEAN.rate, dt);
    if (Math.abs(this.lean) < 1e-4) this.lean = 0;
    cam.position.addScaledVector(right, this.lean * LEAN.side);
    cam.position.y -= Math.abs(this.lean) * LEAN.drop;
    // wall jump: the head swings out away from the wall and tilts with it, then settles
    const wl = mv.wallLean;
    cam.position.addScaledVector(right, wl * 0.06);
    cam.rotation.set(this.pitch + (pp + mantlePitch - vaultK * 3 * D2R + dipY * 0.02) * zk, this.yaw + py * zk, (this.roll - this.lean * LEAN.roll - wl * 9 * D2R) * zk + (pr + mantleRoll + vaultK * 4 * D2R) * zk);
  }
}
