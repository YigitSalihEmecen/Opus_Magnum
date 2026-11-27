import * as THREE from 'three';
import { PALETTE } from './toon.js';

/** Objects on this layer (tracers, flashes, sprites) render in colour but are skipped by the outline pass. */
export const FX_LAYER = 1;

const COMPOSITE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const COMPOSITE_FRAG = /* glsl */ `
#include <packing>
varying vec2 vUv;
uniform sampler2D tWorld, tWorldDepth, tWorldNormal;
uniform sampler2D tVM, tVMDepth, tVMNormal;
uniform vec2 texel;
uniform float near, far, vmNear, vmFar, fogNear, fogFar, lineWidth;
uniform vec3 ink;
uniform vec2 eyeCenter;
uniform float eyeRadius, eyeShadow, aspect, focus;

float viewZ(float d, float n, float f) { return -perspectiveDepthToViewZ(d, n, f); }

// Outline from depth discontinuities + normal creases (cross-shaped kernel). sparse: a mostly empty layer (the
// viewmodel): where none of the five depths was drawn, skip the normals.
float edge(sampler2D tD, sampler2D tN, vec2 uv, float n, float f, float depthTol, bool sparse, out float z0) {
  vec2 o = texel * lineWidth;
  float d0 = texture2D(tD, uv).x;
  float dl = texture2D(tD, uv - vec2(o.x, 0.0)).x, dr = texture2D(tD, uv + vec2(o.x, 0.0)).x;
  float du = texture2D(tD, uv + vec2(0.0, o.y)).x, dd = texture2D(tD, uv - vec2(0.0, o.y)).x;
  z0 = viewZ(d0, n, f);
  if (sparse && min(min(d0, dl), min(min(dr, du), dd)) >= 1.0) return 0.0;
  float zl = viewZ(dl, n, f), zr = viewZ(dr, n, f), zu = viewZ(du, n, f), zd = viewZ(dd, n, f);
  float zmin = min(min(zl, zr), min(zu, zd));
  float lap = abs(zl + zr + zu + zd - 4.0 * z0) / max(min(z0, zmin), 1e-3);
  float de = smoothstep(depthTol, depthTol * 1.8, lap);

  vec4 n0 = texture2D(tN, uv);
  vec3 c = n0.xyz * 2.0 - 1.0;
  vec3 nl = texture2D(tN, uv - vec2(o.x, 0.0)).xyz * 2.0 - 1.0;
  vec3 nr = texture2D(tN, uv + vec2(o.x, 0.0)).xyz * 2.0 - 1.0;
  vec3 nu = texture2D(tN, uv + vec2(0.0, o.y)).xyz * 2.0 - 1.0;
  vec3 nd = texture2D(tN, uv - vec2(0.0, o.y)).xyz * 2.0 - 1.0;
  float dn = (1.0 - dot(c, nl)) + (1.0 - dot(c, nr)) + (1.0 - dot(c, nu)) + (1.0 - dot(c, nd));
  float ne = smoothstep(0.45, 0.8, dn) * n0.a;
  return max(de, ne);
}

void main() {
  vec2 uvW = vUv;
  float zw;
  float ew = edge(tWorldDepth, tWorldNormal, uvW, near, far, 0.06, false, zw);
  float fog = smoothstep(fogNear, fogFar, zw);
  vec3 world = texture2D(tWorld, uvW).rgb;
  world = mix(world, ink, ew * (1.0 - fog) * 0.92 * (1.0 - focus));

  // inspect focus: soft blur, desaturate, dim
  if (focus > 0.001) {
    vec3 acc = world;
    float rad = focus * 9.0 * lineWidth;
    for (int i = 0; i < 10; i++) {
      float a = float(i) * 0.6283;
      vec2 o = vec2(cos(a), sin(a)) * texel * rad;
      acc += texture2D(tWorld, uvW + o).rgb + texture2D(tWorld, uvW + o * 0.45).rgb;
    }
    world = mix(world, acc / 21.0, focus);
    float l = dot(world, vec3(0.299, 0.587, 0.114));
    world = mix(world, vec3(l), 0.4 * focus) * (1.0 - 0.25 * focus);
  }

  // magnified optics: darken everything outside the eyepiece circle
  if (eyeShadow > 0.001) {
    vec2 d = vUv - eyeCenter; d.x *= aspect;
    world *= 1.0 - eyeShadow * 0.9 * smoothstep(1.0, 1.2, length(d) / max(eyeRadius, 1e-4));
  }

  float zv;
  float ev = edge(tVMDepth, tVMNormal, vUv, vmNear, vmFar, 0.12, true, zv);
  vec4 vm = texture2D(tVM, vUv);
  vec3 col = mix(world, vm.rgb / max(vm.a, 1e-4), vm.a);
  col = mix(col, ink, ev * 0.95);

  // gentle vignette
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * 0.28;

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

// 8-bit, single-sample: the ink lines already cover every silhouette, so MSAA (and half-float colour, there's no
// HDR) only cost bandwidth, about 7 ms a frame at 2x pixel ratio
function makeTargets(w, h) {
  const color = new THREE.WebGLRenderTarget(w, h, { colorSpace: THREE.SRGBColorSpace });
  color.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
  const normal = new THREE.WebGLRenderTarget(w, h);
  normal.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
  return { color, normal };
}

/**
 * Graphics presets. Rendering only: resolution, anti-aliasing and shadows. Geometry, placement, hitboxes and
 * view distance are identical on every preset, so nobody gains a gameplay edge from a lower setting.
 */
export const QUALITY = {
  high: { ratio: 2, scale: 1, shadows: true, shadowScale: 1, shadowEvery: 1 },
  medium: { ratio: 1.5, scale: 1, shadows: true, shadowScale: 0.5, shadowEvery: 2 },
  low: { ratio: 1, scale: 0.75, shadows: false, shadowScale: 0.5, shadowEvery: 4 },
};

/**
 * Two-scene renderer: world + first-person viewmodel, each rendered to colour/depth/normal
 * buffers and composited with an ink outline pass for the cel-shaded look.
 */
export class Renderer {
  constructor(canvas) {
    const gl = (this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' }));
    gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.NoToneMapping;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFShadowMap;
    gl.shadowMap.autoUpdate = false;

    this.normalMaterial = new THREE.MeshNormalMaterial();
    this.size = new THREE.Vector2();
    gl.getDrawingBufferSize(this.size);
    this.world = makeTargets(this.size.x, this.size.y);
    this.vm = makeTargets(this.size.x, this.size.y);

    this.composite = new THREE.ShaderMaterial({
      vertexShader: COMPOSITE_VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        tWorld: { value: this.world.color.texture },
        tWorldDepth: { value: this.world.color.depthTexture },
        tWorldNormal: { value: this.world.normal.texture },
        tVM: { value: this.vm.color.texture },
        tVMDepth: { value: this.vm.color.depthTexture },
        tVMNormal: { value: this.vm.normal.texture },
        texel: { value: new THREE.Vector2(1 / this.size.x, 1 / this.size.y) },
        near: { value: 0.1 }, far: { value: 500 },
        vmNear: { value: 0.01 }, vmFar: { value: 10 },
        fogNear: { value: 60 }, fogFar: { value: 220 },
        lineWidth: { value: gl.getPixelRatio() },
        ink: { value: new THREE.Color(PALETTE.ink) },
        eyeCenter: { value: new THREE.Vector2(0.5, 0.5) },
        eyeRadius: { value: 0.1 }, eyeShadow: { value: 0 },
        aspect: { value: 1 }, focus: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.composite);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.q = QUALITY.high;
    this.frameN = 0;
  }

  /** Switch preset: pixel ratio, shadow on/off + resolution + refresh rate. */
  setQuality(name) {
    const q = QUALITY[name] ?? QUALITY.high;
    if (q === this.q && this.qSet) return;
    const prev = this.q;
    this.q = q;
    this.qSet = true;
    const gl = this.gl;
    gl.setPixelRatio(Math.min(window.devicePixelRatio, q.ratio) * q.scale);
    this.composite.uniforms.lineWidth.value = Math.max(1, gl.getPixelRatio());
    if (prev.shadows !== q.shadows) { gl.shadowMap.enabled = q.shadows; this.recompile = true; }
    this.lightsFor = null; // re-apply shadow resolution on the next frame
    if (this.cssW) this.resize(this.cssW, this.cssH);
  }

  /** Shadow map size per preset (each light remembers the size its level asked for). */
  #applyShadows(scene) {
    // re-run when the scene's content changes (a level or the lobby was added) or the preset changed
    if (this.lightsFor === scene && this.lightsN === scene.children.length && !this.recompile) return;
    scene.traverse((o) => {
      if (this.recompile && o.material) for (const m of [].concat(o.material)) m.needsUpdate = true;
      if (!o.isLight || !o.shadow) return;
      const base = (o.userData.baseShadow ??= o.shadow.mapSize.x);
      const size = Math.max(512, base * this.q.shadowScale);
      if (o.shadow.mapSize.x !== size) { o.shadow.mapSize.set(size, size); o.shadow.map?.dispose(); o.shadow.map = null; }
    });
    this.lightsFor = scene;
    this.lightsN = scene.children.length;
    this.recompile = false;
  }

  resize(w, h) {
    this.cssW = w; this.cssH = h;
    this.gl.setSize(w, h, false);
    this.gl.getDrawingBufferSize(this.size);
    for (const t of [this.world, this.vm]) {
      t.color.setSize(this.size.x, this.size.y);
      t.normal.setSize(this.size.x, this.size.y);
    }
    this.composite.uniforms.texel.value.set(1 / this.size.x, 1 / this.size.y);
  }

  #pass(scene, camera, targets, clearAlpha) {
    const gl = this.gl;
    gl.setRenderTarget(targets.color);
    gl.setClearColor(0x000000, clearAlpha);
    gl.clear();
    camera.layers.enable(FX_LAYER);
    gl.render(scene, camera);

    const bg = scene.background;
    scene.background = null;
    scene.overrideMaterial = this.normalMaterial;
    camera.layers.disable(FX_LAYER);
    gl.setRenderTarget(targets.normal);
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.render(scene, camera);
    scene.overrideMaterial = null;
    scene.background = bg;
    camera.layers.enable(FX_LAYER);
  }

  /** opts.eyepiece: { x, y, r, shadow } in screen UV (or null); opts.focus: 0..1 inspect blur. */
  render(world, worldCam, vm, vmCam, { eyepiece = null, focus = 0 } = {}) {
    const u = this.composite.uniforms;
    u.aspect.value = this.size.x / this.size.y;
    u.focus.value = focus;
    u.eyeShadow.value = eyepiece ? eyepiece.shadow : 0;
    if (eyepiece) {
      u.eyeCenter.value.set(eyepiece.x, eyepiece.y);
      u.eyeRadius.value = eyepiece.r;
    }
    u.near.value = worldCam.near; u.far.value = worldCam.far;
    u.vmNear.value = vmCam.near; u.vmFar.value = vmCam.far;
    if (world.fog) { u.fogNear.value = world.fog.near; u.fogFar.value = world.fog.far; }

    this.#applyShadows(world);
    this.gl.shadowMap.needsUpdate = this.frameN++ % this.q.shadowEvery === 0;
    this.#pass(world, worldCam, this.world, 1);
    this.#pass(vm, vmCam, this.vm, 0);
    this.gl.setRenderTarget(null);
    this.gl.render(this.quadScene, this.quadCam);
  }
}
