import * as THREE from 'three';
import data from './motion.data.js';

/*
  Captured motion on our robots. motion.data.js holds clips from the Quaternius Universal Animation Library
  (CC0, converted by tools/anim/quaternius.py): per frame, each body bone's turn away from its rest pose in
  character space, plus the hips' bob and sway. Any rig with the same rest layout (standing, facing +Z, left
  on +X) wears it: a bone's pose is its own rest turned the same way.
    Motion(bones, root)  captures this rig's rest, then each frame:
    blend(layers)        layers: [{ clip, t (s), w, bones? }] → this.world[bone]: the blended character-space
                         rotation of every bone (the body code may turn these further: legs to travel, torso to aim)
    apply()              writes them back as local rotations, plus the hips' offset
  No arms here: the hands are solved onto the gun.
*/

export const BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulder_L', 'shoulder_R', 'thigh_L', 'shin_L', 'foot_L', 'thigh_R', 'shin_R', 'foot_R'];
const PARENT = { spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck', shoulder_L: 'chest', shoulder_R: 'chest', thigh_L: 'hips', shin_L: 'thigh_L', foot_L: 'shin_L', thigh_R: 'hips', shin_R: 'thigh_R', foot_R: 'shin_R' };
const SRC_HIPS = data.hips[1];

/** Decoded once: per clip, per bone a Float32Array of quaternions, and the hips offsets. */
const decode = (b64, scale) => { const s = atob(b64), n = s.length / 2, out = new Float32Array(n); for (let i = 0; i < n; i++) { const v = s.charCodeAt(2 * i) | (s.charCodeAt(2 * i + 1) << 8); out[i] = (v > 32767 ? v - 65536 : v) / scale; } return out; };
let clips = null;
export function motionClips() {
  return (clips ??= Object.fromEntries(Object.entries(data.clips).map(([name, c]) => [name, {
    name, frames: c.frames, loop: c.loop, speed: c.speed ?? 0, duration: (c.frames - (c.loop ? 0 : 1)) / data.fps,
    q: Object.fromEntries(BONES.map((b) => [b, decode(c.q[b], 32767)])), p: decode(c.p, 1000),
  }])));
}

const _a = new THREE.Quaternion(), _b = new THREE.Quaternion(), _q = new THREE.Quaternion(), _inv = new THREE.Quaternion();
const _k = [0, 0, 0, 0];

/** Catmull-Rom through four keys (quaternions as 4-vectors, aligned to one hemisphere, then normalised):
 *  smooth through every key, so a clip's motion has no kinks at its 30 fps samples. */
function cubic(arr, i, k, out) {
  let px = 0, py = 0, pz = 0, pw = 0;
  const o = i[1] * 4, rx = arr[o], ry = arr[o + 1], rz = arr[o + 2], rw = arr[o + 3];
  const k2 = k * k, k3 = k2 * k;
  const w = [(-k3 + 2 * k2 - k) / 2, (3 * k3 - 5 * k2 + 2) / 2, (-3 * k3 + 4 * k2 + k) / 2, (k3 - k2) / 2];
  for (let j = 0; j < 4; j++) {
    const b = i[j] * 4, x = arr[b], y = arr[b + 1], z = arr[b + 2], q = arr[b + 3];
    const s = x * rx + y * ry + z * rz + q * rw < 0 ? -w[j] : w[j];
    px += x * s; py += y * s; pz += z * s; pw += q * s;
  }
  return out.set(px, py, pz, pw).normalize();
}

export class Motion {
  /** bones: name → THREE.Bone (rest pose when this runs); root: the object character space is measured in. */
  constructor(bones, root) {
    this.clips = motionClips();
    this.bones = bones;
    root.updateWorldMatrix(true, true);
    const rootInv = root.getWorldQuaternion(new THREE.Quaternion()).invert();
    this.rest = {};
    this.world = {};
    for (const b of BONES) {
      this.rest[b] = rootInv.clone().multiply(bones[b].getWorldQuaternion(new THREE.Quaternion()));
      this.world[b] = this.rest[b].clone();
    }
    this.hipsRest = bones.hips.position.clone();
    this.scale = this.hipsRest.y / SRC_HIPS; // our hips over the source's: bob and sway scale with leg length
    this.offset = new THREE.Vector3();
    this.weights = {};
  }

  /** Blend the layers (weights need not sum to 1) into this.world and this.offset. */
  blend(layers) {
    const acc = this.weights;
    for (const b of BONES) acc[b] = 0;
    this.offset.set(0, 0, 0);
    let pw = 0;
    for (const L of layers) {
      if (L.w <= 1e-4) continue;
      const c = this.clips[L.clip];
      const f = c.loop ? ((L.t / c.duration) % 1 + 1) % 1 * c.frames : THREE.MathUtils.clamp(L.t / c.duration, 0, 1) * (c.frames - 1);
      const i0 = Math.floor(f) % c.frames, k = f - Math.floor(f), n = c.frames;
      const key = (j) => (c.loop ? ((i0 + j) % n + n) % n : THREE.MathUtils.clamp(i0 + j, 0, n - 1));
      _k[0] = key(-1); _k[1] = key(0); _k[2] = key(1); _k[3] = key(2);
      const i1 = _k[2];
      for (const b of L.bones ?? BONES) {
        cubic(c.q[b], _k, k, _a);
        // accumulate the turns (nlerp, kept in one hemisphere)
        const w = L.w, cur = this.world[b];
        if (acc[b] === 0) cur.set(_a.x * w, _a.y * w, _a.z * w, _a.w * w);
        else {
          const s = cur.x * _a.x + cur.y * _a.y + cur.z * _a.z + cur.w * _a.w < 0 ? -w : w;
          cur.set(cur.x + _a.x * s, cur.y + _a.y * s, cur.z + _a.z * s, cur.w + _a.w * s);
        }
        acc[b] += w;
      }
      if (!L.bones || L.bones.includes('hips')) {
        const p = c.p;
        this.offset.x += (p[i0 * 3] + (p[i1 * 3] - p[i0 * 3]) * k) * L.w;
        this.offset.y += (p[i0 * 3 + 1] + (p[i1 * 3 + 1] - p[i0 * 3 + 1]) * k) * L.w;
        this.offset.z += (p[i0 * 3 + 2] + (p[i1 * 3 + 2] - p[i0 * 3 + 2]) * k) * L.w;
        pw += L.w;
      }
    }
    for (const b of BONES) {
      // turn this rig's rest pose the way the clip turned the source's
      if (acc[b] === 0) this.world[b].copy(this.rest[b]);
      else this.world[b].normalize().multiply(this.rest[b]);
    }
    if (pw > 0) this.offset.multiplyScalar(this.scale / pw);
    return this;
  }

  /** Turn a set of bones about a character-space axis (each keeps its own orientation, the group swings). */
  turn(bones, axis, angle) {
    _q.setFromAxisAngle(axis, angle);
    for (const b of bones) this.world[b].premultiply(_q);
    return this;
  }

  /** Scale how far some bones are turned from rest (k < 1: smaller swings, e.g. a shorter stride). */
  swing(bones, k) {
    if (k === 1) return this;
    for (const b of bones) {
      _q.copy(this.rest[b]).invert().premultiply(this.world[b]); // world = turn · rest → turn
      _a.identity().slerp(_q, k);
      this.world[b].copy(_a).multiply(this.rest[b]);
    }
    return this;
  }

  /** Write the character-space rotations back to the bones as local rotations, and place the hips. */
  apply() {
    for (const b of BONES) {
      const p = PARENT[b];
      if (p) _inv.copy(this.world[p]).invert().multiply(this.world[b]);
      else _inv.copy(this.world[b]);
      this.bones[b].quaternion.copy(_inv);
    }
    this.bones.hips.position.copy(this.hipsRest).add(this.offset);
  }
}
