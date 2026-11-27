import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FX_LAYER, NORMAL_OUT_DECL } from '../core/renderer.js';

/*
  Grenade blast in the game's cel style, pooled (nothing is created per explosion).
    · the fireball: a dozen lumpy lobes packed into one mass. Each lobe is a sphere pushed out by 3D noise on
      the CPU (so the outline pass sees the real shape and draws creases where lobes meet), and shaded with a
      banded, mottled fire pattern — pale yellow through orange and red — that cools into grey smoke from the
      outside in while the cloud rises, boils and sinks away
    · a soft additive flash, a dust ring racing out along the surface, ember streaks, a fading scorch mark
  Per active blast: 12 lobes (642 verts each) + 3 sprites; embers share one instanced mesh.
*/

const POOL = 4, EMBERS = 22, LIFE = 1.5, DETAIL = 3;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _z = new THREE.Vector3(0, 0, 1), _up = new THREE.Vector3(0, 1, 0);

// lobe layout in the blast's frame (+Y off the surface): [x, y, z, radius, heat, delay, drift x, drift y, drift z]
// core, a ring hugging the ground, a crown on top, and cooler smoke lumps at the edges
const LOBES = (() => {
  const out = [[0, 0.55, 0, 1.0, 1.3, 0, 0, 0.7, 0]];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4, r = 0.62;
    out.push([Math.cos(a) * r, 0.35, Math.sin(a) * r, 0.68 + (i % 2) * 0.1, 1.15, 0.02, Math.cos(a) * 0.6, 0.35, Math.sin(a) * 0.6]);
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 1.1;
    out.push([Math.cos(a) * 0.38, 1.15, Math.sin(a) * 0.38, 0.62, 0.95, 0.04, Math.cos(a) * 0.25, 1.1, Math.sin(a) * 0.25]);
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 2.2;
    out.push([Math.cos(a) * 0.95, 0.75, Math.sin(a) * 0.95, 0.55, 0.5, 0.08, Math.cos(a) * 1.0, 0.9, Math.sin(a) * 1.0]);
  }
  return out;
})();

// ── value noise (CPU, for the lobe shapes) ──
const PERM = new Uint8Array(512);
{
  let s = 1337;
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}
const fade = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const h3 = (x, y, z) => PERM[PERM[PERM[x & 255] + (y & 255)] + (z & 255)] / 255;
function noise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
  return lerp(
    lerp(lerp(h3(xi, yi, zi), h3(xi + 1, yi, zi), u), lerp(h3(xi, yi + 1, zi), h3(xi + 1, yi + 1, zi), u), v),
    lerp(lerp(h3(xi, yi, zi + 1), h3(xi + 1, yi, zi + 1), u), lerp(h3(xi, yi + 1, zi + 1), h3(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}
const fbm = (x, y, z) => noise(x, y, z) * 0.62 + noise(x * 2.1, y * 2.1, z * 2.1) * 0.28 + noise(x * 4.3, y * 4.3, z * 4.3) * 0.1;

// ── fire shading: banded heat from a mottled noise field, cooling to two-tone smoke ──
const FIRE_VERT = /* glsl */`
  varying vec3 vP;
  varying vec3 vWN;
  varying vec3 vVN;
  void main() {
    vP = position;
    vWN = normalize(mat3(modelMatrix) * normal);
    vVN = normalMatrix * normal;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const FIRE_FRAG = /* glsl */`
  ${NORMAL_OUT_DECL}
  varying vec3 vVN;
  uniform float uHeat;
  uniform float uTime;
  uniform vec3 uSeed;
  uniform vec3 uCol[7];
  varying vec3 vP;
  varying vec3 vWN;
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  void main() {
    float L = dot(normalize(vWN), normalize(vec3(0.35, 1.0, 0.25))) * 0.5 + 0.5;
    vec3 p = vP * 3.2 + uSeed + vec3(0.0, -uTime * 1.6, 0.0);
    float n = noise(p) * 0.55 + noise(p * 2.3 + 7.1) * 0.3 + noise(p * 5.2 + 3.7) * 0.15;
    float heat = uHeat + (n - 0.5) * 0.95 + (L - 0.5) * 0.4;
    vec3 c = heat > 0.98 ? uCol[0] : heat > 0.74 ? uCol[1] : heat > 0.52 ? uCol[2] : heat > 0.34 ? uCol[3] : heat > 0.2 ? uCol[4]
      : (L + (n - 0.5) * 0.3 > 0.52 ? uCol[5] : uCol[6]);
    gl_FragColor = vec4(c, 1.0);
    gNormal = vec4(normalize(vVN) * 0.5 + 0.5, 1.0);
    #include <colorspace_fragment>
  }`;
const FIRE_COLS = [0xfff2b0, 0xffd447, 0xff9b2f, 0xe4552a, 0x8e3b2b, 0xaaa59c, 0x7b766f].map((c) => new THREE.Color(c));

function fireMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: FIRE_VERT, fragmentShader: FIRE_FRAG,
    uniforms: { uHeat: { value: 1 }, uTime: { value: 0 }, uSeed: { value: new THREE.Vector3() }, uCol: { value: FIRE_COLS } },
  });
}

function lobeGeometry() {
  const g = mergeVertices(new THREE.IcosahedronGeometry(1, DETAIL).deleteAttribute('normal').deleteAttribute('uv'));
  g.userData.dirs = Float32Array.from(g.attributes.position.array);
  g.attributes.position.setUsage(THREE.DynamicDrawUsage);
  g.computeVertexNormals();
  return g;
}

/** Push a lobe's vertices out along their directions by boiling noise: lumpy, never spiky. */
function deform(geo, seed, t) {
  const dirs = geo.userData.dirs, pos = geo.attributes.position.array;
  const sx = seed.x, sy = seed.y - t * 0.9, sz = seed.z;
  for (let i = 0; i < dirs.length; i += 3) {
    const x = dirs[i], y = dirs[i + 1], z = dirs[i + 2];
    const r = 0.7 + 0.62 * fbm(x * 2 + sx, y * 2 + sy, z * 2 + sz);
    pos[i] = x * r; pos[i + 1] = y * r; pos[i + 2] = z * r;
  }
  geo.attributes.position.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
}

function radial(stops) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [t, col] of stops) grad.addColorStop(t, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const fxMat = (map, opts = {}) => new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, fog: false, toneMapped: false, ...opts });
const easeOut = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

const SIZE = 1.3;

export class Explosions {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.scene = scene;
    const flashTex = radial([[0, 'rgba(255,250,230,1)'], [0.25, 'rgba(255,200,120,0.85)'], [0.6, 'rgba(240,120,60,0.25)'], [1, 'rgba(217,119,87,0)']]);
    const ringTex = radial([[0, 'rgba(255,255,255,0)'], [0.7, 'rgba(255,255,255,0)'], [0.86, 'rgba(255,236,200,0.9)'], [1, 'rgba(255,236,200,0)']]);
    const scorchTex = radial([[0, 'rgba(20,20,19,0.85)'], [0.45, 'rgba(20,20,19,0.6)'], [0.8, 'rgba(20,20,19,0.15)'], [1, 'rgba(20,20,19,0)']]);
    const plane = new THREE.PlaneGeometry(1, 1);

    this.pool = Array.from({ length: POOL }, () => {
      const root = new THREE.Group();
      root.scale.setScalar(SIZE);
      this.group.add(root);
      const cloud = new THREE.Group(); // the fireball, turned so +Y leaves the surface
      root.add(cloud);
      const lobes = LOBES.map((spec) => {
        const m = new THREE.Mesh(lobeGeometry(), fireMaterial());
        m.castShadow = true;
        m.frustumCulled = false;
        cloud.add(m);
        return { m, seed: new THREE.Vector3(), pos: new THREE.Vector3(), spec };
      });
      const flash = new THREE.Mesh(plane, fxMat(flashTex, { blending: THREE.AdditiveBlending }));
      const ring = new THREE.Mesh(plane, fxMat(ringTex, { color: 0xb89a74, side: THREE.DoubleSide })); // dust, so it reads on light floors
      for (const o of [flash, ring]) { o.layers.set(FX_LAYER); root.add(o); }
      const scorch = new THREE.Mesh(plane, fxMat(scorchTex, { polygonOffset: true, polygonOffsetFactor: -4 }));
      scorch.layers.set(FX_LAYER);
      scorch.visible = false;
      this.group.add(scorch);
      // drawn once at a speck of a size so the shaders compile with the level, not on the first blast
      for (const o of [...lobes.map((l) => l.m), flash, ring]) o.scale.setScalar(1e-4);
      return { root, cloud, lobes, flash, ring, scorch, t: LIFE - 1e-4, scorchT: 0, normal: new THREE.Vector3() };
    });
    this.next = 0;

    this.embers = new THREE.InstancedMesh(new THREE.BoxGeometry(0.03, 0.03, 0.22), new THREE.MeshBasicMaterial({ color: 0xffd08a, fog: false, toneMapped: false }), POOL * EMBERS);
    this.embers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.embers.frustumCulled = false;
    this.embers.layers.set(FX_LAYER);
    this.emberData = Array.from({ length: POOL * EMBERS }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0 }));
    for (let i = 0; i < POOL * EMBERS; i++) this.embers.setMatrixAt(i, _m.makeScale(0, 0, 0));
    this.group.add(this.embers);
  }

  dispose() { this.scene.remove(this.group); }

  /** A blast at `pos` on a surface facing `normal` (up when it went off in the air). */
  spawn(pos, normal = _up) {
    const slot = this.next++ % POOL;
    const e = this.pool[slot];
    e.t = 0;
    e.root.visible = true;
    e.root.position.copy(pos);
    e.normal.copy(normal);
    // lean the cloud only part-way toward a wall's normal: fire and smoke still rise
    e.cloud.quaternion.setFromUnitVectors(_up, _s.copy(normal).lerp(_up, 0.5).normalize());
    e.cloud.rotateY(Math.random() * Math.PI * 2);
    const spin = Math.random() * 100;
    for (const [i, l] of e.lobes.entries()) {
      l.seed.set(spin + i * 3.7, i * 1.9, spin * 0.5 + i * 5.3);
      l.pos.set(l.spec[0], l.spec[1], l.spec[2]);
      l.m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      l.m.material.uniforms.uSeed.value.copy(l.seed);
    }
    e.ring.quaternion.setFromUnitVectors(_z, normal);
    e.ring.position.copy(normal).multiplyScalar(0.06);
    e.scorch.position.copy(pos).addScaledVector(normal, 0.01);
    e.scorch.quaternion.setFromUnitVectors(_z, normal);
    e.scorch.rotateZ(Math.random() * Math.PI * 2);
    e.scorch.scale.setScalar((2.6 + Math.random() * 0.6) * SIZE);
    e.scorch.visible = true;
    e.scorch.material.opacity = 1;
    e.scorchT = 9;

    for (let k = 0; k < EMBERS; k++) {
      const d = this.emberData[slot * EMBERS + k];
      d.p.copy(pos).addScaledVector(normal, 0.15);
      d.v.randomDirection().addScaledVector(normal, 0.8).normalize().multiplyScalar((6 + Math.random() * 9) * SIZE);
      d.life = 0.35 + Math.random() * 0.45;
    }
  }

  update(dt, camera) {
    for (const e of this.pool) {
      if (e.scorchT > 0) {
        e.scorchT -= dt;
        e.scorch.material.opacity = Math.min(1, e.scorchT / 3);
        if (e.scorchT <= 0) e.scorch.visible = false;
      }
      if (e.t >= LIFE) continue;
      e.t += dt;
      const t = e.t;
      if (t >= LIFE) { e.root.visible = false; continue; }

      for (const l of e.lobes) {
        const [, , , radius, heat, delay, vx, vy, vz] = l.spec;
        const lt = Math.max(0, t - delay);
        // burst out, swell slowly, then sink away as the smoke thins; the cloud drifts out and up
        const thin = THREE.MathUtils.smoothstep(lt, 0.4 * heat + 0.2, LIFE - 0.1);
        const k = radius * easeOut(lt / 0.13) * (1 + lt * 0.3) * (1 - thin);
        l.m.visible = k > 0.01;
        if (!l.m.visible) continue;
        const drift = 1 - Math.exp(-lt * 2.2);
        // as the lobes thin out the cloud pulls together, so it never breaks into separate balls
        const pull = 1 - 0.5 * thin;
        l.m.position.set((l.pos.x + vx * drift) * pull, (l.pos.y + vy * drift) * pull + lt * lt * 0.9, (l.pos.z + vz * drift) * pull);
        l.m.scale.setScalar(k);
        deform(l.m.geometry, l.seed, lt);
        const u = l.m.material.uniforms;
        u.uTime.value = lt;
        u.uHeat.value = heat - lt * 1.35; // cools from the edges in: outer lobes start cooler
      }

      const f = Math.max(0, 1 - t / 0.16);
      e.flash.visible = f > 0;
      e.flash.quaternion.copy(camera.quaternion);
      e.flash.scale.setScalar(2.5 + 4 * (1 - f));
      e.flash.material.opacity = f;

      const r = Math.min(1, t / 0.38);
      e.ring.visible = r < 1;
      e.ring.scale.setScalar(0.6 + 7 * (1 - Math.pow(1 - r, 2)));
      e.ring.material.opacity = (1 - r) * 0.75;
    }

    let any = false;
    for (let i = 0; i < this.emberData.length; i++) {
      const d = this.emberData[i];
      if (d.life <= 0) continue;
      any = true;
      d.life -= dt;
      d.v.y -= 14 * dt;
      d.v.multiplyScalar(Math.exp(-1.5 * dt));
      d.p.addScaledVector(d.v, dt);
      const k = Math.max(0, Math.min(1, d.life * 3));
      _q.setFromUnitVectors(_z, _s.copy(d.v).normalize());
      this.embers.setMatrixAt(i, _m.compose(d.p, _q, _s.set(k, k, k * (0.6 + d.v.length() * 0.08))));
    }
    if (any || this.embersLive) this.embers.instanceMatrix.needsUpdate = true;
    this.embersLive = any;
  }
}
