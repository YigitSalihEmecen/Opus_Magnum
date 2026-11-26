import * as THREE from 'three';
import { SPEED } from './movement.js';

const D2R = Math.PI / 180;
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));

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
    this.yaw -= input.mouseDX * k;
    this.pitch = THREE.MathUtils.clamp(this.pitch - input.mouseDY * k, -89 * D2R, 89 * D2R);
  }

  /** Permanent aim displacement (degrees), applied over a few frames for smoothness. */
  addRecoil(pitchDeg, yawDeg) { this.pendingRecoil.x += pitchDeg * D2R; this.pendingRecoil.y += yawDeg * D2R; }

  /** Visual-only kick that springs back (degrees). */
  punch(pitchDeg, yawDeg = 0, rollDeg = 0) {
    this.punchPitch.v += pitchDeg * D2R * 18;
    this.punchYaw.v += yawDeg * D2R * 18;
    this.punchRoll.v += rollDeg * D2R * 18;
  }

  land(impact) { this.dip.v -= THREE.MathUtils.clamp(impact * 0.12, 0, 2.4); }

  update(dt, mv, { ads = 0, axes = { x: 0, y: 0 }, zoom = 1.32 } = {}) {
    // recoil drains into aim
    const r = 1 - Math.exp(-dt * 38);
    this.pitch = THREE.MathUtils.clamp(this.pitch + this.pendingRecoil.x * r, -89 * D2R, 89 * D2R);
    this.yaw += this.pendingRecoil.y * r;
    this.pendingRecoil.multiplyScalar(1 - r);

    // eye height
    this.eye = damp(this.eye, mv.eyeHeight, mv.state === 'slide' || mv.state === 'vault' ? 20 : 12, dt);

    // head bob from gait
    const moving = (mv.state === 'ground' && mv.grounded) || mv.state === 'wallrun';
    const speedT = Math.min(1, mv.speed / (8 * SPEED));
    this.bobWeight = damp(this.bobWeight, moving ? speedT : 0, 10, dt);
    const ph = mv.gaitPhase;
    const amp = this.bobWeight * (1 - ads * 0.8);
    this.bob.set(Math.sin(ph) * 0.018 * amp, (Math.cos(ph * 2) - 1) * 0.5 * 0.028 * amp);

    // roll: wallrun lean, strafe lean, slide tilt
    let targetRoll = -axes.x * 1.1 * D2R;
    if (mv.state === 'wallrun') targetRoll = mv.wallSide * 12 * D2R;
    else if (mv.state === 'slide') targetRoll = 3.5 * D2R;
    targetRoll *= 1 - ads * 0.75; // aimed, keep the horizon nearly level
    this.roll = damp(this.roll, targetRoll, mv.state === 'wallrun' ? 7 : 9, dt);

    // mantle dip
    const mp = mv.mantleProgress;
    const mantlePitch = mv.state === 'mantle' ? -Math.sin(mp * Math.PI) * 5 * D2R : 0;
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
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    // step smoothing: a sudden small height change while grounded (kerb, stair, ramp lip) is absorbed and
    // eased out over a few frames instead of jolting the view; real falls and jumps pass straight through
    const dy = this.lastFeetY === undefined ? 0 : mv.feet.y - this.lastFeetY;
    if (mv.grounded && Math.abs(dy) > 0.09 && Math.abs(dy) < 0.6) this.stepY -= dy;
    this.stepY = damp(this.stepY, 0, 16, dt);
    this.lastFeetY = mv.feet.y;
    cam.position.copy(mv.feet);
    cam.position.y += this.eye + (this.bob.y + dipY * 0.08) * zk + this.stepY;
    cam.position.addScaledVector(right, this.bob.x * zk);
    cam.rotation.set(this.pitch + (pp + mantlePitch - vaultK * 3 * D2R + dipY * 0.02) * zk, this.yaw + py * zk, this.roll * zk + (pr + mantleRoll + vaultK * 4 * D2R) * zk);
  }
}
