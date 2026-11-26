import * as THREE from 'three';

/*
  Keeping bodies from ever snapping.
    Spring        a critically damped spring: follows its goal with continuous position and velocity, so a
                  goal that jumps (a state flips, a speed steps) still eases in and out. Every value that
                  drives the pose goes through one.
    Inertializer  the safety net on the finished pose. Each frame it predicts each bone from its last two
                  frames; when the new pose breaks from that prediction by more than real motion could (a
                  one-shot clip restarts, a layer pops in, the aim snaps), it keeps showing the old pose and
                  decays the difference away on a spring. What counts as "more than real motion" is learned
                  per bone: each keeps an envelope of its own recent frame-to-frame surprise (a sprinting
                  foot strikes hard, a spine barely moves), and only a jump well past it is caught. Smooth
                  motion passes through untouched, so the run cycle keeps its full swing and timing.
  Halflives are in seconds: the time to close half the gap.
*/

const LN2 = Math.LN2;
const ENV = 2.5, RETAIN = 0.5;
const decay = (x, v, halflife, dt) => {
  const y = (2 * LN2) / Math.max(halflife, 1e-4), j1 = v + x * y, e = Math.exp(-y * dt);
  return [e * (x + j1 * dt), e * (v - j1 * y * dt)];
};

export class Spring {
  constructor(x = 0) { this.x = x; this.v = 0; }
  to(goal, halflife, dt) {
    [this.x, this.v] = decay(this.x - goal, this.v, halflife, dt);
    this.x += goal;
    return this.x;
  }
  /** For angles: chases the goal the short way round. */
  toAngle(goal, halflife, dt) {
    return this.to(this.x + Math.atan2(Math.sin(goal - this.x), Math.cos(goal - this.x)), halflife, dt);
  }
  snap(x) { this.x = x; this.v = 0; return x; }
}

const _v = new THREE.Quaternion(), _p = new THREE.Quaternion(), _d = new THREE.Quaternion(), _o = new THREE.Quaternion(), _r = new THREE.Vector3();
const toVec = (q, out) => {
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  const s = Math.hypot(q.x, q.y, q.z), a = 2 * Math.atan2(s, q.w);
  return s < 1e-8 ? out.set(0, 0, 0) : out.set(q.x, q.y, q.z).multiplyScalar(a / s);
};
const toQuat = (v, out) => {
  const a = v.length();
  return a < 1e-8 ? out.identity() : out.setFromAxisAngle(_r.copy(v).divideScalar(a), a);
};

export class Inertializer {
  /** names: the bones; halflife: how fast a caught jump fades. */
  constructor(names, halflife = 0.11) {
    this.halflife = halflife;
    this.b = Object.fromEntries(names.map((n) => [n, { o: new THREE.Vector3(), v: new THREE.Vector3(), t1: new THREE.Quaternion(), t2: new THREE.Quaternion(), env: 0 }]));
    this.offset = { o: new THREE.Vector3(), v: new THREE.Vector3(), t1: new THREE.Vector3(), t2: new THREE.Vector3(), env: 0 };
    this.frames = 0;
  }

  /** Forget the history (a respawn or a teleport is meant to cut). */
  reset() {
    this.frames = 0;
    for (const s of [...Object.values(this.b), this.offset]) { s.o.set(0, 0, 0); s.v.set(0, 0, 0); s.env = 0; }
  }

  /** world: bone → character-space quaternion (smoothed in place); offset: the hips' offset (same). */
  apply(world, offset, dt) {
    if (dt <= 0) return;
    if (dt > 0.15) this.frames = 0; // a stall (hidden tab): nothing to predict from
    // how far a bone may stray from a straight-line guess in one frame: a floor that grows with dt² (motion
    // bends more between slower frames), or ENV × its own recent surprise, which fades over ~half a second
    const floor = 0.06 + 150 * dt * dt, floorP = 0.02 + 30 * dt * dt, fade = Math.exp(-dt / 0.5);
    const ready = this.frames >= 2;
    for (const name in this.b) {
      const s = this.b[name], q = world[name];
      let caught = false;
      if (ready) {
        _v.copy(s.t2).invert().premultiply(s.t1); // last frame's turn
        _p.copy(_v).multiply(s.t1); // … once more
        _d.copy(q).invert().premultiply(_p); // what takes the new pose to the predicted one
        if (_d.w < 0) _d.set(-_d.x, -_d.y, -_d.z, -_d.w);
        const jump = 2 * Math.acos(Math.min(1, _d.w)), slack = Math.max(floor, ENV * s.env);
        if (jump <= slack) s.env = Math.max(jump, s.env * fade);
        else {
          // take on only the part beyond what motion could do, so a borderline frame isn't over-corrected
          toQuat(s.o, _o).multiply(_d.slerp(_p.identity(), slack / jump));
          toVec(_o, s.o);
          caught = true;
        }
      }
      // after a catch the history carries on at half the old turn rate (the next guess mustn't repeat the
      // jump, and halving each time means a caught stop eases out rather than being chased forever)
      if (caught) s.t2.copy(_v.slerp(_p.identity(), 1 - RETAIN)).invert().multiply(q);
      else s.t2.copy(s.t1);
      s.t1.copy(q);
      for (const k of ['x', 'y', 'z']) [s.o[k], s.v[k]] = decay(s.o[k], s.v[k], this.halflife, dt);
      q.premultiply(toQuat(s.o, _o));
    }
    const s = this.offset;
    if (ready) {
      _r.copy(s.t1).multiplyScalar(2).sub(s.t2).sub(offset); // predicted − new
      const jump = _r.length(), slackP = Math.max(floorP, ENV * s.env);
      if (jump <= slackP) { s.env = Math.max(jump, s.env * fade); s.t2.copy(s.t1); }
      else {
        s.o.addScaledVector(_r, 1 - slackP / jump);
        s.t2.lerp(s.t1, 1 - RETAIN).sub(s.t1).add(offset); // offset − RETAIN·(t1 − t2)
      }
    } else s.t2.copy(s.t1);
    s.t1.copy(offset);
    for (const k of ['x', 'y', 'z']) [s.o[k], s.v[k]] = decay(s.o[k], s.v[k], this.halflife, dt);
    offset.add(s.o);
    this.frames++;
  }
}
