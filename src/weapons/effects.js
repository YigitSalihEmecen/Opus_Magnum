import * as THREE from 'three';
import { PALETTE as P } from '../core/toon.js';
import { FX_LAYER } from '../core/renderer.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _p = new THREE.Vector3();
const _spin = new THREE.Quaternion();
const _hidden = new THREE.Matrix4().makeScale(0, 0, 0);
const _color = new THREE.Color();

/** World-space shot feedback: tracers, bullet decals, spark bursts, dust puffs. */
export class WorldFX {
  constructor(scene) {
    this.scene = scene;

    // tracers
    const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd29a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const tracerGeo = new THREE.BoxGeometry(0.014, 0.014, 1).translate(0, 0, -0.5);
    this.tracers = Array.from({ length: 24 }, () => this.#fx(new THREE.Mesh(tracerGeo, tracerMat), { from: new THREE.Vector3(), dir: new THREE.Vector3(), dist: 0, t: 0 }));

    // decals: one instanced ring of them, one draw call however many are up
    const decalMat = new THREE.MeshBasicMaterial({ map: decalTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    this.decalCount = 96;
    this.decals = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.1, 0.1), decalMat, this.decalCount);
    for (let i = 0; i < this.decalCount; i++) this.decals.setMatrixAt(i, _hidden);
    this.decals.frustumCulled = false;
    this.decals.layers.set(FX_LAYER);
    scene.add(this.decals);
    this.decalIndex = 0;

    // sparks (instanced)
    this.sparkCount = 240;
    this.sparks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.012, 0.012, 0.07), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }), this.sparkCount);
    this.sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sparks.frustumCulled = false;
    this.sparks.layers.set(FX_LAYER);
    this.sparkData = Array.from({ length: this.sparkCount }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0 }));
    this.sparkIndex = 0;
    const black = new THREE.Color(0);
    for (let i = 0; i < this.sparkCount; i++) { this.sparks.setMatrixAt(i, _hidden); this.sparks.setColorAt(i, black); }
    this.sparksLive = false;
    scene.add(this.sparks);

    // dust puffs
    const puffMat = new THREE.MeshBasicMaterial({ map: puffTexture(), transparent: true, depthWrite: false, color: P.oat });
    this.puffs = Array.from({ length: 24 }, () => this.#fx(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), puffMat.clone()), { t: 0, life: 0, v: new THREE.Vector3() }));
  }

  #fx(mesh, data) {
    mesh.visible = false;
    mesh.userData = data;
    mesh.layers.set(FX_LAYER);
    this.scene.add(mesh);
    return mesh;
  }

  tracer(from, to) {
    const tr = this.tracers.find((t) => !t.visible) ?? this.tracers[0];
    const u = tr.userData;
    u.from.copy(from);
    u.dir.subVectors(to, from);
    u.dist = u.dir.length();
    u.dir.normalize();
    u.t = 0;
    tr.visible = true;
  }

  impact(point, normal, { flesh = false } = {}) {
    if (!flesh) {
      _q.setFromUnitVectors(_z, normal).multiply(_spin.setFromAxisAngle(_z, Math.random() * Math.PI * 2));
      const sc = 0.7 + Math.random() * 0.5;
      this.decals.setMatrixAt(this.decalIndex++ % this.decalCount, _m.compose(_p.copy(point).addScaledVector(normal, 0.004), _q, _s.set(sc, sc, 1)));
      this.decals.instanceMatrix.needsUpdate = true;
      this.#puff(point, normal);
    }
    const color = _color.set(flesh ? P.clay : 0xffe2b0);
    const n = flesh ? 7 : 9;
    for (let i = 0; i < n; i++) {
      const idx = this.sparkIndex++ % this.sparkCount;
      const s = this.sparkData[idx];
      s.p.copy(point);
      s.v.copy(normal).multiplyScalar(2 + Math.random() * 3).addScaledVector(_p.randomDirection(), 2.5);
      s.life = 0.18 + Math.random() * 0.2;
      this.sparks.setColorAt(idx, color);
    }
    this.sparks.instanceColor.needsUpdate = true;
    this.sparksLive = true;
  }

  #puff(point, normal) {
    const p = this.puffs.find((x) => !x.visible) ?? this.puffs[0];
    p.position.copy(point).addScaledVector(normal, 0.05);
    p.userData.v.copy(normal).multiplyScalar(0.6);
    p.userData.t = 0;
    p.userData.life = 0.45;
    p.visible = true;
  }

  update(dt, camera) {
    for (const tr of this.tracers) {
      if (!tr.visible) continue;
      const u = tr.userData;
      u.t += dt;
      const head = Math.min(u.dist, u.t * 420);
      const len = Math.min(6, head);
      tr.position.copy(u.from).addScaledVector(u.dir, head);
      tr.quaternion.setFromUnitVectors(_z, u.dir);
      tr.scale.set(1, 1, len);
      if (head >= u.dist) tr.visible = false;
    }

    // the spark buffer only goes to the GPU while some are flying (and once more to clear the last)
    const wasLive = this.sparksLive;
    this.sparksLive = false;
    for (let i = 0; i < this.sparkCount; i++) {
      const s = this.sparkData[i];
      if (s.life <= 0) continue;
      this.sparksLive = true;
      s.life -= dt;
      s.v.y -= 12 * dt;
      s.p.addScaledVector(s.v, dt);
      const k = Math.max(0, s.life) * 4;
      _q.setFromUnitVectors(_z, _s.copy(s.v).normalize());
      this.sparks.setMatrixAt(i, _m.compose(s.p, _q, _s.set(k, k, k * (0.5 + s.v.length() * 0.15))));
    }
    if (wasLive) this.sparks.instanceMatrix.needsUpdate = true;

    for (const p of this.puffs) {
      if (!p.visible) continue;
      const u = p.userData;
      u.t += dt;
      const k = u.t / u.life;
      p.position.addScaledVector(u.v, dt);
      p.quaternion.copy(camera.quaternion);
      const sc = 0.15 + k * 0.45;
      p.scale.set(sc, sc, 1);
      p.material.opacity = (1 - k) * 0.8;
      if (k >= 1) p.visible = false;
    }
  }
}

function decalTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(20,20,19,0.35)';
  g.beginPath(); g.arc(64, 64, 34, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(20,20,19,0.95)';
  g.beginPath(); g.arc(64, 64, 15, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(20,20,19,0.6)';
  g.lineWidth = 3;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + Math.random() * 0.4;
    g.beginPath(); g.moveTo(64 + Math.cos(a) * 15, 64 + Math.sin(a) * 15); g.lineTo(64 + Math.cos(a) * (36 + Math.random() * 18), 64 + Math.sin(a) * (36 + Math.random() * 18)); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function puffTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
