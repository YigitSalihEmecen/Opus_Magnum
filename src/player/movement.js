import * as THREE from 'three';
import { Capsule } from 'three/examples/jsm/math/Capsule.js';

/** Global horizontal pace: every ground/air/wall speed below is scaled by it (jumps and falls are not). */
export const SPEED = 0.7;

/** All movement tuning lives here. Units: metres, seconds. */
export const MOVE = {
  radius: 0.35,
  standHeight: 1.8,
  crouchHeight: 1.1,
  standEye: 1.62,
  crouchEye: 0.98,

  gravity: 21,
  jumpSpeed: 7.1,
  coyoteTime: 0.12,
  jumpBuffer: 0.14,
  maxSpeed: 24 * SPEED,

  walkSpeed: 5.2 * SPEED,
  sprintSpeed: 7.8 * SPEED,
  crouchSpeed: 2.9 * SPEED,
  groundAccel: 13,
  friction: 7.5,
  stopSpeed: 2.4 * SPEED,
  airAccel: 2.4,
  airWishSpeed: 4.4 * SPEED,

  slideMinSpeed: 5.6 * SPEED,
  slideBoost: 2.8 * SPEED,
  slideBoostCap: 11.5 * SPEED,
  slideBoostCooldown: 1.8,
  slideDecel: 3.2 * SPEED,
  slideSlopeScale: 1.05,
  slideEndSpeed: 3.0 * SPEED,
  slideSteerAccel: 4,

  wallrunMinSpeed: 4.6 * SPEED,
  wallrunSpeed: 9.2 * SPEED,
  wallrunAccel: 9,
  wallrunMaxTime: 1.85,
  wallrunGravity: 2.6,
  wallrunReach: 0.55,
  wallrunEntryLift: 1.6,
  wallJumpOut: 6.4 * SPEED,
  wallJumpUp: 6.8,
  wallrunCooldown: 0.3,

  mantleReach: 0.55,
  mantleMinHeight: 0.45,
  mantleMaxHeight: 1.75,
  mantleRiseTime: 0.2,
  mantleRisePerMetre: 0.09,
  mantleForwardTime: 0.14,
  mantleExitSpeed: 4.2 * SPEED,

  vaultMinHeight: 0.45,
  vaultMaxHeight: 1.35, // cover, rails, half walls, window sills
  vaultMaxDepth: 1.7, // anything thicker is climbed onto instead
  vaultReach: 0.55, // + vaultReachPerSpeed × speed: sprinting spots the obstacle earlier
  vaultReachPerSpeed: 0.11,
  vaultMinSpeed: 5.4 * SPEED, // carried over the top; faster approaches keep their speed
  vaultClear: 0.06, // feet over the top
  vaultTuck: 1.0, // body height while vaulting (legs tucked): what has to fit through a window
};

const UP = new THREE.Vector3(0, 1, 0);
const STEP_UP = 0.45; // ledges this low are walked up, not bumped into (a stair, a kerb, a slab edge)
const SNAP_DOWN = 0.45; // grounded, we stay glued to floors this far below (down stairs and slopes)
const STEP = 1 / 120;
const _ray = new THREE.Ray();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _testCap = new Capsule();

const horiz = (v, out = _v) => out.set(v.x, 0, v.z);

/**
 * Pilot-style character controller on top of a triangle Octree.
 * States: ground · air · slide · wallrun · mantle · vault
 * Emits events via this.onEvent(name, data).
 */
export class Movement {
  constructor(octree, spawn) {
    this.octree = octree;
    this.feet = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.capsule = new Capsule();
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.wallNormal = new THREE.Vector3();
    this.lastWallNormal = new THREE.Vector3();
    this.onEvent = () => {};
    this.respawn(spawn);
  }

  respawn(spawn) {
    this.feet.copy(spawn.position);
    this.vel.set(0, 0, 0);
    this.state = 'ground';
    this.grounded = true;
    this.crouched = false;
    this.sprinting = false;
    this.height = MOVE.standHeight;
    this.coyote = 0;
    this.jumpBufferT = 0;
    this.jumpLock = 0;
    this.slideBoostT = 0;
    this.wallrunT = 0;
    this.wallrunCooldownT = 0;
    this.wallSide = 0;
    this.hasLastWall = false;
    this.sprintBlockT = 0;
    this.stepDist = 0;
    this.steps = 0;
    this.mantle = null;
    this.vault = null;
    this.vaultWindowT = 0;
    this.airTime = 0;
    this.#syncCapsule();
  }

  get speed() { return Math.hypot(this.vel.x, this.vel.z); }
  // vaulting ducks the head, so a window's header never clips the view
  get eyeHeight() { return this.crouched || this.state === 'vault' ? MOVE.crouchEye : MOVE.standEye; }

  /** Weapon calls this while aiming/firing so sprint drops out. */
  blockSprint(t = 0.2) { this.sprintBlockT = Math.max(this.sprintBlockT, t); this.sprinting = false; }

  update(dt, input, yaw) {
    const axes = input.axes();
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const wish = fwd.clone().multiplyScalar(axes.y).addScaledVector(right, axes.x);
    if (wish.lengthSq() > 0) wish.normalize();

    const ctrl = {
      axes, fwd, right, wish,
      crouchHeld: input.down('KeyC') || input.down('ControlLeft'),
      crouchPressed: input.pressed('KeyC') || input.pressed('ControlLeft'),
    };
    if (input.pressed('Space')) this.jumpBufferT = MOVE.jumpBuffer;
    if (input.pressed('ShiftLeft')) this.sprinting = true;
    if (input.down('ShiftLeft') && this.sprintBlockT <= 0) this.sprinting = true;
    if (axes.y <= 0 || this.sprintBlockT > 0 || (this.crouched && this.state !== 'slide')) this.sprinting = false;

    let remaining = Math.min(dt, 0.1);
    while (remaining > 1e-6) {
      const h = Math.min(STEP, remaining);
      this.#step(h, ctrl);
      ctrl.crouchPressed = false;
      remaining -= h;
    }

    this.sprintBlockT -= dt;
    if (this.feet.y < -40) { this.onEvent('fellOut'); }
  }

  #step(dt, c) {
    this.jumpBufferT -= dt;
    this.coyote -= dt;
    this.jumpLock -= dt;
    this.slideBoostT -= dt;
    this.wallrunCooldownT -= dt;
    this.vaultWindowT -= dt;

    if (this.state === 'mantle') return this.#updateMantle(dt);
    if (this.state === 'vault') return this.#updateVault(dt);
    if (this.state === 'wallrun') this.#updateWallrun(dt, c);
    else if (this.grounded) this.#updateGround(dt, c);
    else this.#updateAir(dt, c);

    if (this.state === 'mantle') return;

    // jump (buffered + coyote); running at something low and thin turns the jump into a vault
    if (this.jumpBufferT > 0 && this.state !== 'wallrun' && (this.grounded || this.coyote > 0)) {
      if (this.#tryVault(c)) return;
      this.#jump(c);
    }

    const vh = Math.hypot(this.vel.x, this.vel.z);
    if (vh > MOVE.maxSpeed) { this.vel.x *= MOVE.maxSpeed / vh; this.vel.z *= MOVE.maxSpeed / vh; }

    // on the ground, travel along the floor plane: down a slope rather than off it, up it without a
    // leftover upward speed to launch us at the top
    if (this.grounded && (this.state === 'ground' || this.state === 'slide') && this.jumpLock <= 0) {
      const n = this.groundNormal;
      this.vel.y = n.y > 0.55 ? -(this.vel.x * n.x + this.vel.z * n.z) / n.y : 0;
    }

    this.#integrate(dt);
    this.#footsteps(dt);
  }

  // ───────────────────────── ground / slide ─────────────────────────

  #updateGround(dt, c) {
    this.coyote = MOVE.coyoteTime;
    this.airTime = 0;
    this.hasLastWall = false;

    if (this.state === 'slide') return this.#updateSlide(dt, c);

    const canSlide = this.speed > MOVE.slideMinSpeed;
    if ((c.crouchPressed || (c.crouchHeld && this.justLanded)) && canSlide) return this.#startSlide(c);

    this.state = 'ground';
    this.#setCrouch(c.crouchHeld);
    const target = this.crouched ? MOVE.crouchSpeed : this.sprinting ? MOVE.sprintSpeed : MOVE.walkSpeed;
    this.#friction(dt, MOVE.friction);
    this.#accelerate(c.wish, target, MOVE.groundAccel, dt);
    this.justLanded = false;
  }

  #startSlide(c) {
    this.state = 'slide';
    this.#setCrouch(true, true);
    this.justLanded = false;
    const dir = horiz(this.vel, _v2).normalize();
    if (this.slideBoostT <= 0) {
      const s = this.speed;
      const boosted = Math.min(s + MOVE.slideBoost, Math.max(s, MOVE.slideBoostCap));
      this.vel.x = dir.x * boosted;
      this.vel.z = dir.z * boosted;
      this.slideBoostT = MOVE.slideBoostCooldown;
    }
    this.onEvent('slideStart', { speed: this.speed });
  }

  #updateSlide(dt, c) {
    const n = this.groundNormal;
    // gravity along the slope (downhill acceleration / uphill braking)
    const gx = n.x * n.y * MOVE.gravity * MOVE.slideSlopeScale;
    const gz = n.z * n.y * MOVE.gravity * MOVE.slideSlopeScale;
    this.vel.x += gx * dt;
    this.vel.z += gz * dt;

    const s = this.speed;
    if (s > 1e-3) {
      const slopeAlong = (gx * this.vel.x + gz * this.vel.z) / s;
      const decel = slopeAlong > 0.5 ? MOVE.slideDecel * 0.15 : MOVE.slideDecel;
      const ns = Math.max(0, s - decel * dt);
      this.vel.x *= ns / s;
      this.vel.z *= ns / s;
    }
    this.#accelerate(c.wish, 1.6 * SPEED, MOVE.slideSteerAccel, dt);

    if (this.speed < MOVE.slideEndSpeed || !c.crouchHeld) {
      this.state = 'ground';
      this.#setCrouch(c.crouchHeld);
      this.onEvent('slideEnd');
    }
  }

  // ───────────────────────── air ─────────────────────────

  #updateAir(dt, c) {
    if (this.state !== 'air') {
      if (this.state === 'slide') this.onEvent('slideEnd');
      this.state = 'air';
    }
    this.airTime += dt;
    this.vel.y -= MOVE.gravity * dt;
    this.#accelerate(c.wish, MOVE.airWishSpeed, MOVE.airAccel, dt);
    this.#setCrouch(c.crouchHeld);

    // jumped a little early at something vaultable: the jump becomes the vault when we get there
    if (this.vaultWindowT > 0 && c.axes.y > 0 && this.#tryVault(c, true)) return;
    if (c.axes.y > 0 && this.#tryMantle(c)) return;
    if (this.jumpLock <= 0 || this.airTime > 0.06) this.#tryWallrun(c);
  }

  #jump(c) {
    const wasSlide = this.state === 'slide';
    this.vel.y = Math.max(this.vel.y, 0) + MOVE.jumpSpeed;
    this.grounded = false;
    this.coyote = 0;
    this.jumpBufferT = 0;
    this.jumpLock = 0.12;
    this.vaultWindowT = 0.45;
    this.state = 'air';
    if (wasSlide) this.onEvent('slideEnd');
    this.#setCrouch(c.crouchHeld && !wasSlide);
    this.onEvent('jump', { slide: wasSlide });
  }

  // ───────────────────────── wallrun ─────────────────────────

  #probeWall(origin, dir, reach) {
    const hit = this.#cast(origin, dir, MOVE.radius + reach);
    if (!hit || Math.abs(hit.normal.y) > 0.3) return null;
    return hit;
  }

  #tryWallrun(c) {
    if (this.wallrunCooldownT > 0 || c.axes.y <= 0 || this.speed < MOVE.wallrunMinSpeed) return false;
    if (this.#cast(this.feet, new THREE.Vector3(0, -1, 0), 0.7)) return false; // too close to the floor

    const center = _v2.copy(this.feet).setY(this.feet.y + this.height * 0.55);
    const vdir = horiz(this.vel, new THREE.Vector3()).normalize();
    const vright = new THREE.Vector3(-vdir.z, 0, vdir.x);
    let best = null;
    for (const d of [c.right, c.right.clone().negate(), vright, vright.clone().negate()]) {
      const hit = this.#probeWall(center, d, MOVE.wallrunReach);
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
    if (!best) return false;
    const n = best.normal;
    n.y = 0;
    n.normalize();
    if (-vdir.dot(n) > 0.8) return false; // running straight into it: that's a mantle, not a wallrun
    if (this.hasLastWall && n.dot(this.lastWallNormal) > 0.92) return false;

    this.state = 'wallrun';
    this.wallNormal.copy(n);
    this.wallrunT = 0;
    this.wallSide = Math.sign(-n.dot(c.right)) || 1;
    // shed velocity into the wall, give a small lift
    const into = this.vel.dot(n);
    if (into < 0) this.vel.addScaledVector(n, -into);
    this.vel.y = Math.max(this.vel.y * 0.4, 0) + MOVE.wallrunEntryLift;
    this.onEvent('wallrunStart', { side: this.wallSide });
    return true;
  }

  #updateWallrun(dt, c) {
    this.wallrunT += dt;
    const center = _v2.copy(this.feet).setY(this.feet.y + this.height * 0.55);
    const hit = this.#probeWall(center, this.wallNormal.clone().negate(), MOVE.wallrunReach + 0.25);
    if (hit) {
      hit.normal.y = 0;
      this.wallNormal.copy(hit.normal.normalize());
    }
    this.wallSide = Math.sign(-this.wallNormal.dot(c.right)) || this.wallSide;

    const n = this.wallNormal;
    const along = horiz(this.vel, new THREE.Vector3()).addScaledVector(n, -this.vel.dot(n));
    along.y = 0;
    if (along.lengthSq() < 1e-4) along.crossVectors(UP, n).multiplyScalar(c.fwd.dot(_v.crossVectors(UP, n)) >= 0 ? 1 : -1);
    along.normalize();

    let s = Math.max(0, this.vel.x * along.x + this.vel.z * along.z);
    if (c.axes.y > 0) s += Math.max(0, MOVE.wallrunSpeed - s) * Math.min(1, MOVE.wallrunAccel * dt);
    this.vel.x = along.x * s - n.x * 1.5;
    this.vel.z = along.z * s - n.z * 1.5;

    const t = this.wallrunT / MOVE.wallrunMaxTime;
    const g = MOVE.wallrunGravity * (0.4 + t * t * 4);
    this.vel.y -= g * dt;
    if (this.vel.y > 0) this.vel.y -= this.vel.y * Math.min(1, 3.5 * dt);
    this.vel.y = Math.max(this.vel.y, -4);

    const end = (why) => {
      this.state = 'air';
      this.wallrunCooldownT = MOVE.wallrunCooldown;
      this.lastWallNormal.copy(n);
      this.hasLastWall = true;
      this.onEvent('wallrunEnd', { why });
    };

    if (this.jumpBufferT > 0) {
      this.jumpBufferT = 0;
      this.vel.addScaledVector(n, MOVE.wallJumpOut).addScaledVector(c.wish, 1.6);
      this.vel.y = MOVE.wallJumpUp;
      this.jumpLock = 0.15;
      end('jump');
      this.onEvent('jump', { wall: true });
      return;
    }
    if (c.axes.y > 0 && this.#tryMantle(c)) return;
    if (!hit) return end('lost');
    if (this.grounded) return end('ground');
    if (this.wallrunT > MOVE.wallrunMaxTime || c.axes.y <= 0 || c.crouchPressed || s < MOVE.wallrunMinSpeed * 0.6) {
      this.vel.addScaledVector(n, 1.2);
      return end('timeout');
    }
  }

  // ───────────────────────── mantle ─────────────────────────

  #tryMantle(c) {
    const look = c.wish.lengthSq() > 0 ? c.wish : c.fwd;
    // a wall in front of us at waist height…
    const chest = _v2.copy(this.feet).setY(this.feet.y + 0.55);
    const wall = this.#probeWall(chest, look, MOVE.mantleReach);
    if (!wall) return false;
    const n = wall.normal.setY(0).normalize();
    if (look.dot(n) > -0.5) return false;

    // …and a walkable top within reach
    const top = wall.position.clone().addScaledVector(n, -0.3);
    top.y = this.feet.y + MOVE.mantleMaxHeight + 0.05;
    const ledge = this.#cast(top, new THREE.Vector3(0, -1, 0), MOVE.mantleMaxHeight - MOVE.mantleMinHeight + 0.05);
    if (!ledge || ledge.normal.y < 0.7) return false;
    const h = ledge.position.y - this.feet.y;
    if (h < MOVE.mantleMinHeight || h > MOVE.mantleMaxHeight) return false;

    const rise = this.feet.clone().setY(ledge.position.y + 0.02);
    const target = wall.position.clone().addScaledVector(n, -(MOVE.radius + 0.12)).setY(ledge.position.y + 0.02);
    if (this.#blocked(rise, MOVE.crouchHeight)) return false;
    let crouch = false;
    if (this.#blocked(target, MOVE.standHeight)) {
      if (this.#blocked(target, MOVE.crouchHeight)) return false;
      crouch = true;
    }

    const prev = this.state;
    if (prev === 'wallrun') this.onEvent('wallrunEnd', { why: 'mantle' });
    this.state = 'mantle';
    this.mantle = {
      t: 0,
      from: this.feet.clone(),
      rise,
      target,
      riseTime: MOVE.mantleRiseTime + h * MOVE.mantleRisePerMetre,
      fwdTime: MOVE.mantleForwardTime,
      dir: n.clone().negate(),
      crouch,
      height: h,
    };
    this.vel.set(0, 0, 0);
    this.onEvent('mantle', { height: h });
    return true;
  }

  #updateMantle(dt) {
    const m = this.mantle;
    m.t += dt;
    const ease = (x) => 1 - Math.pow(1 - Math.min(1, x), 3);
    if (m.t < m.riseTime) {
      const k = ease(m.t / m.riseTime);
      this.feet.lerpVectors(m.from, m.rise, k);
      // drift slightly toward the ledge while rising
      const drift = Math.min(1, m.t / m.riseTime) * 0.25;
      this.feet.x += (m.target.x - m.from.x) * drift;
      this.feet.z += (m.target.z - m.from.z) * drift;
    } else {
      const k = ease((m.t - m.riseTime) / m.fwdTime);
      const start = _v.copy(m.rise).lerp(m.target, 0.25);
      this.feet.lerpVectors(start, m.target, k);
      if (k >= 1) {
        this.state = 'ground';
        this.grounded = true;
        this.#setCrouch(m.crouch, true);
        this.vel.copy(m.dir).multiplyScalar(MOVE.mantleExitSpeed);
        this.mantle = null;
        this.onEvent('mantleEnd');
      }
    }
    this.#syncCapsule();
  }

  /** 0..1 progress for camera/viewmodel animation (mantles and vaults). */
  get mantleProgress() {
    const m = this.mantle, v = this.vault;
    if (v) return Math.min(1, v.t / v.T);
    return m ? Math.min(1, m.t / (m.riseTime + m.fwdTime)) : 0;
  }

  // ───────────────────────── vault ─────────────────────────

  /**
   * Over, not onto: a low obstacle (cover, rail, half wall, window sill) with open floor beyond it.
   * The path is planned up front as (distance along, height) keys — rise to the top, cross at the top,
   * drop to the far floor — and checked with a crouched body along its length; off-centre approaches
   * (a window you didn't line up) slide sideways onto the nearest clear line.
   */
  #tryVault(c, air = false) {
    if (c.axes.y <= 0 || this.state === 'slide' && this.speed < 3 * SPEED) return false;
    // airborne, heights count from the floor below us (an early jump mustn't make tall things vaultable)
    const base = air ? this.#cast(_v2.copy(this.feet).setY(this.feet.y + 0.05), new THREE.Vector3(0, -1, 0), 3)?.position.y : this.feet.y;
    if (base === undefined) return false;
    const dir = horiz(c.wish.lengthSq() > 0 ? c.wish : c.fwd, new THREE.Vector3()).normalize();
    const reach = MOVE.vaultReach + MOVE.radius + this.speed * MOVE.vaultReachPerSpeed;
    // a facing surface at knee or hip height (a barrier's sloped foot hides its upright face from the knee ray)
    const wallLike = (f) => f && Math.abs(f.normal.y) < 0.3 && -dir.dot(_v.copy(f.normal).setY(0).normalize()) >= 0.55;
    let face = this.#cast(this.feet.clone().setY(base + 0.3), dir, reach);
    if (!wallLike(face)) face = this.#cast(this.feet.clone().setY(base + 0.6), dir, reach);
    if (!wallLike(face)) return false;
    const sFace = face.distance;

    // height: cast down just past the face from above the highest vaultable top (inside a window opening)
    const probe = (s) => this.#cast(_v2.copy(this.feet).addScaledVector(dir, s).setY(base + MOVE.vaultMaxHeight + 0.12), new THREE.Vector3(0, -1, 0), MOVE.vaultMaxHeight + 3);
    const topHit = probe(sFace + 0.08);
    if (!topHit || topHit.normal.y < 0.7) return false;
    const top = topHit.position.y, h = top - base;
    if (h < MOVE.vaultMinHeight || h > MOVE.vaultMaxHeight) return false;

    // depth: walk along until the top drops away
    let depth = -1;
    for (let d = 0.15; d <= MOVE.vaultMaxDepth + 0.01; d += 0.1) {
      const hit = probe(sFace + d);
      if (!hit || hit.position.y < top - 0.3) { depth = d; break; }
    }
    if (depth < 0) return false;

    // landing: floor beyond, or open air (we drop off the far side)
    const sLand = sFace + depth + MOVE.radius + 0.3;
    const floor = probe(sLand);
    const landY = floor && floor.normal.y > 0.7 && floor.position.y > top - 2.4 ? floor.position.y : null;
    if (air && this.feet.y > top + 0.5) return false; // already sailing over it
    if (landY !== null && landY > top - 0.05) return false; // a step up onto something, not over it

    const yTop = top + MOVE.vaultClear;
    const keys = [
      [0, this.feet.y],
      [Math.max(0.05, sFace - MOVE.radius - 0.04), yTop],
      [sFace + depth + MOVE.radius * 0.5, yTop + 0.04],
      [sLand, landY ?? yTop - 0.35],
    ];
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const at = (k, lateral, out) => out.copy(this.feet).addScaledVector(dir, k[0]).addScaledVector(side, lateral).setY(k[1]);
    const clear = (lateral) => {
      const pts = [];
      for (let i = 1; i < keys.length; i++) for (let t = 0.25; t <= 1.001; t += 0.25) pts.push([keys[i - 1][0] + (keys[i][0] - keys[i - 1][0]) * t, Math.max(keys[i - 1][1], keys[i][1]) + 0.01]);
      // ramp in from no offset to the full sideways shift over the rise
      return pts.every((k, i) => !this.#blocked(at(k, lateral * Math.min(1, (i + 1) / 4), _v), MOVE.vaultTuck));
    };
    const lateral = [0, 0.12, -0.12, 0.24, -0.24, 0.36, -0.36].find(clear);
    if (lateral === undefined) return false;

    const v = Math.max(this.speed, MOVE.vaultMinSpeed);
    const seg = keys.slice(1).map((k, i) => Math.hypot(k[0] - keys[i][0], k[1] - keys[i][1]) / v);
    seg[0] = Math.max(seg[0], 0.1 + h * 0.1); // getting up there always takes a moment
    seg[2] = Math.max(seg[2], 0.12);
    const prev = this.state;
    this.state = 'vault';
    this.vault = { t: 0, T: seg[0] + seg[1] + seg[2], seg, keys, dir, side, lateral, from: this.feet.clone(), v, air: landY === null };
    this.jumpBufferT = 0;
    this.vaultWindowT = 0;
    this.grounded = false;
    if (prev === 'slide') this.onEvent('slideEnd');
    this.onEvent('vault', { height: h, depth, window: lateral !== 0 || this.#blocked(at(keys[2], 0, _v), MOVE.standHeight) });
    return true;
  }

  #updateVault(dt) {
    const V = this.vault;
    V.t += dt;
    let t = V.t, i = 0;
    while (i < 2 && t > V.seg[i]) t -= V.seg[i++];
    const u = Math.min(1, t / V.seg[i]);
    const a = V.keys[i], b = V.keys[i + 1];
    // rise eases out (a hand plants and pushes), the crossing is flat, the drop eases in like a fall
    const ky = i === 0 ? 1 - (1 - u) ** 2 : i === 2 ? u * u : u;
    const s = a[0] + (b[0] - a[0]) * u;
    const lat = V.lateral * Math.min(1, V.t / V.seg[0]);
    this.feet.copy(V.from).addScaledVector(V.dir, s).addScaledVector(V.side, lat).setY(a[1] + (b[1] - a[1]) * ky);
    this.#syncCapsule();
    if (V.t < V.T) return;

    this.vault = null;
    this.vel.copy(V.dir).multiplyScalar(V.v * 0.96);
    if (V.air) {
      this.state = 'air';
      this.grounded = false;
      this.vel.y = -2.5;
    } else {
      this.state = 'ground';
      this.grounded = true;
      this.coyote = MOVE.coyoteTime;
    }
    this.airTime = 0;
    if (this.#blocked(this.feet, MOVE.standHeight)) this.#setCrouch(true, true);
    this.onEvent('vaultEnd');
  }

  // ───────────────────────── physics core ─────────────────────────

  #integrate(dt) {
    const wasGrounded = this.grounded;
    const fallSpeed = -this.vel.y;
    this.capsule.translate(_v.copy(this.vel).multiplyScalar(dt));
    let onFloor = this.#resolve();

    // stick to ground on slopes / step-downs
    // (also when cresting a ramp/stairs: the slope left some upward speed that would launch us)
    if (!onFloor && wasGrounded && this.jumpLock <= 0) {
      this.capsule.translate(_v.set(0, -SNAP_DOWN, 0));
      if (this.#resolve(true)) { onFloor = true; if (this.vel.y > 0) this.vel.y = 0; }
      else this.capsule.translate(_v.set(0, SNAP_DOWN, 0));
    }

    this.grounded = onFloor;
    this.feet.copy(this.capsule.start).y -= MOVE.radius;

    if (onFloor && !wasGrounded) {
      if (this.state === 'air') this.state = 'ground';
      // a frame or two off the ground (cresting a slope, a stair lip) is not a landing: no thud, no dip
      if (this.airTime > 0.1) {
        this.justLanded = true;
        this.onEvent('land', { impact: fallSpeed, airTime: this.airTime });
      }
      this.airTime = 0;
    }
  }

  /**
   * Push the capsule out of the level one triangle at a time (deepest first). Two kinds of contact are
   * treated specially so tiled floors feel like one surface:
   *  · seams: side faces / edges whose top is level with the feet (between road tiles, slabs, kerbs)
   *    are ignored, the floor face beside them holds the capsule;
   *  · low ledges: while grounded, a vertical face up to STEP_UP tall lifts the capsule onto it.
   */
  /** snapping: a downward probe for the floor — walls met on the way down are ignored, not pushed against. */
  #resolve(snapping = false) {
    let onFloor = false;
    const tris = [];
    for (let i = 0; i < 5; i++) {
      tris.length = 0;
      this.octree.getCapsuleTriangles(this.capsule, tris);
      const feetY = this.capsule.start.y - this.capsule.radius;
      let best = null, bestDepth = 0, step = 0;
      for (const tri of tris) {
        const r = this.octree.triangleCapsuleIntersect(this.capsule, tri);
        if (!r || r.depth < 1e-5) continue;
        if (r.normal.y < 0.55) {
          if (snapping) continue;
          const top = Math.max(tri.a.y, tri.b.y, tri.c.y) - feetY;
          if (top < 0.04 && r.normal.y > -0.3) continue; // seam at floor level
          if (this.grounded && top <= STEP_UP && r.normal.y > -0.2) { step = Math.max(step, top); continue; }
        }
        if (r.depth > bestDepth) { bestDepth = r.depth; best = r; }
      }
      if (step > 0) {
        this.capsule.translate(_v.set(0, step + 0.005, 0));
        onFloor = true;
        continue;
      }
      if (!best) break;
      const n = best.normal;
      if (n.y > 0.55) {
        // walkable floor: lift straight up out of it, so slopes never push us sideways (no creeping
        // downhill when standing still, no bounce off stair noses)
        onFloor = true;
        this.groundNormal.copy(n);
        this.capsule.translate(_v.set(0, Math.min(best.depth / n.y, best.depth * 3), 0));
        if (this.vel.y < 0) this.vel.y = 0;
        continue;
      }
      this.capsule.translate(_v.copy(n).multiplyScalar(best.depth));
      const vn = this.vel.dot(n);
      if (vn < 0) this.vel.addScaledVector(n, -vn);
    }
    return onFloor;
  }

  #friction(dt, f) {
    const s = this.speed;
    if (s < 1e-4) return;
    const drop = Math.max(s, MOVE.stopSpeed) * f * dt;
    const ns = Math.max(0, s - drop) / s;
    this.vel.x *= ns;
    this.vel.z *= ns;
  }

  /** Quake-style accelerate: only adds speed along wishdir up to wishSpeed. */
  #accelerate(wish, wishSpeed, accel, dt) {
    if (wish.lengthSq() === 0) return;
    const current = this.vel.x * wish.x + this.vel.z * wish.z;
    const add = wishSpeed - current;
    if (add <= 0) return;
    const a = Math.min(accel * wishSpeed * dt, add);
    this.vel.x += wish.x * a;
    this.vel.z += wish.z * a;
  }

  #setCrouch(want, force = false) {
    if (want === this.crouched) return;
    if (!want && !force && this.#blocked(this.feet, MOVE.standHeight)) return;
    if (!want && force && this.#blocked(this.feet, MOVE.standHeight)) want = true;
    this.crouched = want;
    this.height = want ? MOVE.crouchHeight : MOVE.standHeight;
    this.#syncCapsule();
  }

  #blocked(feet, height) {
    _testCap.start.set(feet.x, feet.y + MOVE.radius + 0.06, feet.z);
    _testCap.end.set(feet.x, feet.y + height - MOVE.radius, feet.z);
    _testCap.radius = MOVE.radius - 0.02;
    const r = this.octree.capsuleIntersect(_testCap);
    return !!r && r.depth > 0.01;
  }

  #syncCapsule() {
    this.capsule.start.set(this.feet.x, this.feet.y + MOVE.radius, this.feet.z);
    this.capsule.end.set(this.feet.x, this.feet.y + this.height - MOVE.radius, this.feet.z);
    this.capsule.radius = MOVE.radius;
  }

  #cast(origin, dir, max) {
    _ray.set(origin, dir);
    const r = this.octree.rayIntersect(_ray);
    if (!r || r.distance > max) return null;
    r.normal = r.triangle.getNormal(new THREE.Vector3());
    return r;
  }

  #footsteps(dt) {
    let stride = 0, s = 0;
    if (this.state === 'ground' && this.grounded) { s = this.speed; stride = this.sprinting ? 2.3 : this.crouched ? 1.3 : 1.8; }
    else if (this.state === 'wallrun') { s = this.speed; stride = 2.1; }
    if (stride === 0 || s < 0.8) return;
    this.stepDist += s * dt;
    if (this.stepDist > stride) {
      this.stepDist -= stride;
      this.steps++;
      this.onEvent('step', { speed: s, wall: this.state === 'wallrun' });
    }
  }

  /** Continuous gait phase (radians) for head bob / weapon bob. */
  get gaitPhase() {
    const stride = this.sprinting ? 2.3 : this.crouched ? 1.3 : 1.8;
    return (this.steps + Math.min(1, this.stepDist / stride)) * Math.PI;
  }
}
