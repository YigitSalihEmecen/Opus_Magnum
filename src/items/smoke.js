import * as THREE from 'three';
import { fireMaterial, lobeGeometry, deform } from './explosion.js';

/*
  Smoke screens in the blast's cel style: a dome of lumpy grey lobes that billows out from the canister, hangs,
  then sinks away. Cheap by design: a few lobe shapes are deformed once and shared by every cloud, one material
  serves them all (the shader boils the mottling), and per frame only lobe positions and scales change.
  blocks(a, b) says whether a sight line passes through a cloud — bots can't see through smoke.
*/

export const SMOKE = { fuse: 1.4, life: 16, fade: 3.5, radius: 4.4 };
const POOL = 3, LOBES = 18, SHAPES = 4;
const COLS = [0xe9e6df, 0xe9e6df, 0xe9e6df, 0xe9e6df, 0xe9e6df, 0xe4e1da, 0xb7b3aa].map((c) => new THREE.Color(c));
const easeOut = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
const _c = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3();

export class Smokes {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.mat = fireMaterial(COLS);
    this.mat.uniforms.uHeat.value = -1; // always the two smoke tones
    const shapes = Array.from({ length: SHAPES }, (_, i) => {
      const g = lobeGeometry(3);
      deform(g, new THREE.Vector3(i * 7.3, i * 2.9, i * 4.1), 0, 0.84, 0.3, 1.4); // rounder than the fireball: billows, not rocks
      return g;
    });
    this.pool = Array.from({ length: POOL }, () => {
      const root = new THREE.Group();
      root.visible = false;
      this.group.add(root);
      const lobes = Array.from({ length: LOBES }, (_, i) => {
        const m = new THREE.Mesh(shapes[i % SHAPES], this.mat);
        root.add(m);
        return { m, at: new THREE.Vector3(), r: 1, delay: 0, spin: 0 };
      });
      return { root, lobes, t: SMOKE.life, r: 0 };
    });
    this.next = 0;
    this.time = 0;
  }

  dispose() { this.scene.remove(this.group); }

  /** A canister went off at `pos`: the cloud billows out from there. */
  spawn(pos) {
    const c = this.pool[this.next++ % POOL];
    c.t = 0;
    c.root.visible = true;
    c.root.position.copy(pos);
    c.root.rotation.y = Math.random() * Math.PI * 2;
    c.lobes.forEach((l, i) => {
      const a = Math.random() * Math.PI * 2, d = i === 0 ? 0 : 0.8 + Math.sqrt(Math.random()) * 2.8;
      l.at.set(Math.cos(a) * d, 0.7 + Math.random() * 2.2 * (1 - d / 4.2) + (i === 0 ? 0.6 : 0), Math.sin(a) * d);
      l.r = i === 0 ? 2.1 : 1.35 + Math.random() * 0.8;
      l.delay = d * 0.28 + Math.random() * 0.12;
      l.spin = (Math.random() - 0.5) * 0.3;
      l.fade = Math.random() * 1.2;
      l.m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      l.m.scale.setScalar(1e-4);
    });
  }

  /** Does the segment a → b pass through a cloud that has grown in? */
  blocks(a, b) {
    _d.subVectors(b, a);
    const len2 = _d.lengthSq();
    for (const c of this.pool) {
      if (c.r < 0.5) continue;
      _c.copy(c.root.position).setY(c.root.position.y + 1.4);
      const k = len2 ? THREE.MathUtils.clamp(_e.subVectors(_c, a).dot(_d) / len2, 0, 1) : 0;
      if (_c.distanceToSquared(_e.copy(a).addScaledVector(_d, k)) < c.r * c.r) return true;
    }
    return false;
  }

  update(dt) {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time * 0.25;
    for (const c of this.pool) {
      if (c.t >= SMOKE.life) continue;
      c.t += dt;
      if (c.t >= SMOKE.life) { c.root.visible = false; c.r = 0; continue; }
      const end = SMOKE.life - SMOKE.fade;
      c.r = SMOKE.radius * easeOut(c.t / 2.2) * (1 - THREE.MathUtils.smoothstep(c.t, end, SMOKE.life - 1));
      for (const [i, l] of c.lobes.entries()) {
        const lt = c.t - l.delay;
        const thin = THREE.MathUtils.smoothstep(c.t, end - l.fade, SMOKE.life - l.fade * 0.5);
        const k = l.r * easeOut(lt / 1.3) * (1 - thin) * (1 + 0.04 * Math.sin(c.t * 0.8 + i));
        l.m.visible = k > 0.02;
        if (!l.m.visible) continue;
        l.m.scale.setScalar(k);
        // billow out a touch past the rest spot early on, settle, then rise as it thins
        const out = 1 + 0.12 * Math.max(0, 1 - lt / 2.5);
        l.m.position.set(l.at.x * out, l.at.y * out + c.t * 0.025 + thin * 0.9, l.at.z * out);
        l.m.rotation.y += l.spin * dt;
      }
    }
  }
}
