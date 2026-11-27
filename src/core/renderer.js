import * as THREE from 'three';
import { PALETTE } from './toon.js';

/** Objects on this layer (tracers, flashes, sprites): tags for effects, which are all transparent and so leave no normals. */
export const FX_LAYER = 1;

/*
  Every built-in material also writes its view-space normal to a second colour attachment (MRT), so the outline's
  normals come from the same pass as the colour instead of drawing the whole scene again. Lit materials write
  their normal and a crease flag (alpha 1); unlit opaque ones a camera-facing normal without the flag; transparent
  ones zero, which their blending (src alpha 0) leaves the target unchanged by. Shader materials drawn into these
  targets write the attachment themselves (NORMAL_OUT_DECL).
*/
export const NORMAL_OUT_DECL = 'layout(location = 1) out highp vec4 gNormal;';
// patched once per page (a hot reload of this module must not stack a second copy onto three's chunks)
const PATCHED = THREE.ShaderChunk.fog_pars_fragment.includes(NORMAL_OUT_DECL);
if (!PATCHED) {
  THREE.ShaderChunk.fog_pars_fragment = `${NORMAL_OUT_DECL}\n${THREE.ShaderChunk.fog_pars_fragment}`;
  THREE.ShaderChunk.normal_fragment_begin += '\n#ifndef OM_NORMAL\n#define OM_NORMAL\n#endif\n';
  THREE.ShaderChunk.opaque_fragment += `
  #if defined( OPAQUE ) && defined( OM_NORMAL )
  gNormal = vec4( normalize( normal ) * 0.5 + 0.5, 1.0 );
  #elif defined( OPAQUE )
  gNormal = vec4( 0.5, 0.5, 1.0, 0.0 );
  #else
  gNormal = vec4( 0.0 );
  #endif
  `;
  // a toon surface turned away from the sun gets none of it (shadows come from back faces; see core/toon.js)
  THREE.ShaderChunk.lights_fragment_begin = THREE.ShaderChunk.lights_fragment_begin.replace(
    'directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;',
    'directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;\n\t\t#ifdef SUN_FACING\n\t\tdirectLight.color *= step( 0.0, dot( geometryNormal, directLight.direction ) );\n\t\t#endif',
  );
  if (!THREE.ShaderChunk.lights_fragment_begin.includes('SUN_FACING')) console.warn('sun-facing shadows: three.js chunk changed');

  for (const k of ['background', 'backgroundCube']) {
    const sh = THREE.ShaderLib[k];
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', `${NORMAL_OUT_DECL}\nvoid main() {\n\tgNormal = vec4( 0.0 );`);
  }
}

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
uniform float worldScale; // the world target's resolution scale (dynamic resolution); the viewmodel's is 1

float viewZ(float d, float n, float f) { return -perspectiveDepthToViewZ(d, n, f); }

// Outline from depth discontinuities + normal creases (cross-shaped kernel), lines lineWidth screen pixels wide
// (at least one texel of a target drawn at scale s). sparse: a mostly empty layer (the viewmodel): where none of
// the five depths was drawn, skip the normals.
float edge(sampler2D tD, sampler2D tN, vec2 uv, float s, float n, float f, float depthTol, bool sparse, out float z0) {
  vec2 o = texel * max(lineWidth, 1.0 / s);
  vec2 ul = uv - vec2(o.x, 0.0), ur = uv + vec2(o.x, 0.0), uu = uv + vec2(0.0, o.y), ud = uv - vec2(0.0, o.y);
  float d0 = texture2D(tD, uv).x;
  float dl = texture2D(tD, ul).x, dr = texture2D(tD, ur).x;
  float du = texture2D(tD, uu).x, dd = texture2D(tD, ud).x;
  z0 = viewZ(d0, n, f);
  if (sparse && min(min(d0, dl), min(min(dr, du), dd)) >= 1.0) return 0.0;
  float zl = viewZ(dl, n, f), zr = viewZ(dr, n, f), zu = viewZ(du, n, f), zd = viewZ(dd, n, f);
  float zmin = min(min(zl, zr), min(zu, zd));
  float lap = abs(zl + zr + zu + zd - 4.0 * z0) / max(min(z0, zmin), 1e-3);
  float de = smoothstep(depthTol, depthTol * 1.8, lap);

  vec4 n0 = texture2D(tN, uv);
  vec3 c = n0.xyz * 2.0 - 1.0;
  vec3 nl = texture2D(tN, ul).xyz * 2.0 - 1.0;
  vec3 nr = texture2D(tN, ur).xyz * 2.0 - 1.0;
  vec3 nu = texture2D(tN, uu).xyz * 2.0 - 1.0;
  vec3 nd = texture2D(tN, ud).xyz * 2.0 - 1.0;
  float dn = (1.0 - dot(c, nl)) + (1.0 - dot(c, nr)) + (1.0 - dot(c, nu)) + (1.0 - dot(c, nd));
  float ne = smoothstep(0.45, 0.8, dn) * n0.a;
  return max(de, ne);
}

void main() {
  vec2 uvW = vUv;
  float zw;
  float ew = edge(tWorldDepth, tWorldNormal, uvW, worldScale, near, far, 0.06, false, zw);
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
  float ev = edge(tVMDepth, tVMNormal, vUv, 1.0, vmNear, vmFar, 0.12, true, zv);
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

// colour (textures[0]) + normals (textures[1]) + depth. 8-bit, single-sample: the ink lines already cover every
// silhouette, so MSAA (and half-float colour, there's no HDR) only cost bandwidth, about 7 ms a frame at 2x
function makeTarget(w, h) {
  const t = new THREE.WebGLRenderTarget(w, h, { count: 2 });
  t.textures[0].colorSpace = THREE.SRGBColorSpace;
  t.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
  return t;
}

/**
 * Graphics presets. Rendering only: placement, hitboxes, view distance and silhouettes are identical on every
 * preset, so nobody gains a gameplay edge from a lower setting.
 *   ratio        pixel ratio cap for the screen, the gun and the ink lines (always crisp)
 *   minScale     how far the world alone may drop below that when the GPU runs over budget (dynamic resolution;
 *                flat toon colour upscales cleanly). A fast machine stays at full scale on every preset.
 *   fixed        the world's scale where the GPU can't be timed (Safari)
 *   shadows      on/off; shadowScale × the map size each level asks for; shadowEvery: refresh every n frames
 *   lod          × the distances characters switch to their coarser models at
 */
export const QUALITY = {
  high: { ratio: 2, minScale: 0.85, fixed: 1, shadows: true, shadowScale: 1, shadowEvery: 1, lod: 1 },
  medium: { ratio: 2, minScale: 0.7, fixed: 0.85, shadows: true, shadowScale: 0.5, shadowEvery: 2, lod: 0.6 },
  low: { ratio: 1, minScale: 0.6, fixed: 0.75, shadows: false, shadowScale: 0.5, shadowEvery: 4, lod: 0.4 },
};
const GPU_BUDGET = 8.5; // ms a frame the GPU may take: room for 100 fps with the CPU's share overlapped
const ADAPT_EVERY = 250; // ms between dynamic resolution steps (STEP of the world's scale)
const STEP = 0.05;

/**
 * Two-scene renderer: world + first-person viewmodel, each rendered in one pass to colour/normal/depth
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
    gl.autoClear = false; // #pass clears each attachment itself
    this.size = new THREE.Vector2();
    gl.getDrawingBufferSize(this.size);
    this.world = makeTarget(this.size.x, this.size.y);
    this.vm = makeTarget(this.size.x, this.size.y);

    this.composite = new THREE.ShaderMaterial({
      vertexShader: COMPOSITE_VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        tWorld: { value: this.world.textures[0] },
        tWorldDepth: { value: this.world.depthTexture },
        tWorldNormal: { value: this.world.textures[1] },
        tVM: { value: this.vm.textures[0] },
        tVMDepth: { value: this.vm.depthTexture },
        tVMNormal: { value: this.vm.textures[1] },
        texel: { value: new THREE.Vector2(1 / this.size.x, 1 / this.size.y) },
        near: { value: 0.1 }, far: { value: 500 },
        vmNear: { value: 0.01 }, vmFar: { value: 10 },
        fogNear: { value: 60 }, fogFar: { value: 220 },
        lineWidth: { value: gl.getPixelRatio() },
        ink: { value: new THREE.Color(PALETTE.ink) },
        eyeCenter: { value: new THREE.Vector2(0.5, 0.5) },
        eyeRadius: { value: 0.1 }, eyeShadow: { value: 0 },
        aspect: { value: 1 }, focus: { value: 0 },
        worldScale: { value: 1 },
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
    this.scale = 1; // the world's current resolution scale
    this.gpuMs = 0; // smoothed GPU time a frame, where the browser can measure it
    this.timer = gl.getContext().getExtension('EXT_disjoint_timer_query_webgl2'); // none in Safari: no dynamic resolution
    this.queries = [];
    this.adaptT = 0;
  }

  /** Switch preset: pixel ratio, world scale floor, shadow on/off + resolution + refresh rate, LOD distances. */
  setQuality(name) {
    const q = QUALITY[name] ?? QUALITY.high;
    if (q === this.q && this.qSet) return;
    const prev = this.q;
    this.q = q;
    this.qSet = true;
    const gl = this.gl;
    gl.setPixelRatio(Math.min(window.devicePixelRatio, q.ratio));
    this.composite.uniforms.lineWidth.value = Math.max(1, gl.getPixelRatio());
    if (prev.shadows !== q.shadows) { gl.shadowMap.enabled = q.shadows; this.recompile = true; }
    this.lightsFor = null; // re-apply shadow resolution and LOD distances on the next frame
    this.#setScale(this.timer ? Math.max(this.scale, q.minScale) : q.fixed);
    if (this.cssW) this.resize(this.cssW, this.cssH);
  }

  /** Shadow map size and LOD distances per preset (each light and LOD remembers what its builder asked for). */
  #applyPreset(scene) {
    // re-run when the scene's content changes (a level, a player or the lobby was added) or the preset changed
    if (this.lightsFor === scene && this.lightsN === scene.children.length && !this.recompile) return;
    this.followers = [];
    scene.traverse((o) => {
      if (this.recompile && o.material) for (const m of [].concat(o.material)) m.needsUpdate = true;
      if (o.isLOD) for (const l of o.levels) l.distance = (l.object.userData.lodFrom ??= l.distance) * this.q.lod;
      if (!o.isLight || !o.shadow) return;
      if (o.userData.shadowFollow) this.followers.push(o);
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
    this.vm.setSize(this.size.x, this.size.y);
    this.composite.uniforms.texel.value.set(1 / this.size.x, 1 / this.size.y);
    this.#setScale(this.scale);
  }

  /**
   * The world's target at `s` of the screen's resolution; the composite stretches it back (bilinear: flat toon
   * colour upscales cleanly) and draws the ink lines and the gun at full resolution. A real resize, not a smaller
   * viewport: a tiled GPU clears and stores the whole target either way. Steps are rare (see #adapt).
   */
  #setScale(s) {
    this.scale = s;
    this.world.setSize(Math.max(1, Math.round(this.size.x * s)), Math.max(1, Math.round(this.size.y * s)));
    this.composite.uniforms.worldScale.value = s;
  }

  /**
   * Dynamic resolution: time each frame on the GPU (results arrive a few frames late) and step the world's scale
   * down when it runs over budget, back up when there's clear room. Steps are slow and small, and a step up only
   * happens well under budget, so it settles instead of pumping.
   */
  #timeFrame(begin) {
    const ext = this.timer;
    if (!ext) return;
    const ctx = this.gl.getContext();
    if (begin) {
      while (this.queries.length && ctx.getQueryParameter(this.queries[0], ctx.QUERY_RESULT_AVAILABLE)) {
        const q = this.queries.shift();
        const ms = ctx.getQueryParameter(q, ctx.QUERY_RESULT) / 1e6;
        ctx.deleteQuery(q);
        if (!ctx.getParameter(ext.GPU_DISJOINT_EXT)) this.#adapt(ms);
      }
      if (this.queries.length >= 4) return; // results stalled: skip timing rather than pile up queries
      this.query = ctx.createQuery();
      ctx.beginQuery(ext.TIME_ELAPSED_EXT, this.query);
    } else if (this.query) {
      ctx.endQuery(ext.TIME_ELAPSED_EXT);
      this.queries.push(this.query);
      this.query = null;
    }
  }

  #adapt(ms) {
    this.gpuMs = this.gpuMs ? this.gpuMs * 0.9 + ms * 0.1 : ms;
    const now = performance.now();
    if (now - this.adaptT < ADAPT_EVERY) return;
    this.adaptT = now;
    let s = this.scale;
    if (this.gpuMs > GPU_BUDGET) s -= STEP;
    else if (this.gpuMs < GPU_BUDGET * 0.7) s += STEP;
    s = Math.round(THREE.MathUtils.clamp(s, this.q.minScale, 1) * 100) / 100;
    if (s !== this.scale) this.#setScale(s);
  }

  #pass(scene, camera, target, clearAlpha) {
    const gl = this.gl;
    gl.setRenderTarget(target);
    // a colour background is the clear colour (three would clear the normals with it too); a sky texture draws itself
    const bg = scene.background;
    if (bg?.isColor) scene.background = null;
    gl.setClearColor(bg?.isColor ? bg : 0x000000, clearAlpha);
    gl.clear();
    gl.getContext().clearBufferfv(gl.getContext().COLOR, 1, ZERO4);
    camera.layers.enable(FX_LAYER);
    gl.render(scene, camera);
    scene.background = bg;
  }

  /**
   * Compile every material in the scenes now, hidden ones too (effects, the other guns), so the first explosion
   * or weapon swap doesn't stall a frame on shader compiles. The browser finishes them in the background.
   */
  warm(world, worldCam, vm, vmCam) {
    const hidden = [];
    for (const sc of [world, vm]) sc.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    this.gl.setRenderTarget(this.world); // programs depend on the target (it's linear, the canvas sRGB)
    const done = Promise.all([this.gl.compileAsync(world, worldCam), this.gl.compileAsync(vm, vmCam)]);
    for (const o of hidden) o.visible = false; // compiling started synchronously; nothing renders in between
    this.gl.setRenderTarget(null);
    return done;
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

    this.#applyPreset(world);
    for (const l of this.followers) followShadow(l, worldCam);
    this.#timeFrame(true);
    this.gl.shadowMap.needsUpdate = this.frameN++ % this.q.shadowEvery === 0;
    this.#pass(world, worldCam, this.world, 1);
    this.#pass(vm, vmCam, this.vm, 0);
    this.gl.setRenderTarget(null);
    this.gl.render(this.quadScene, this.quadCam);
    this.#timeFrame(false);
  }
}

const ZERO4 = [0, 0, 0, 0];

const _c = new THREE.Vector3(), _f = new THREE.Vector3(), _lx = new THREE.Vector3(), _ly = new THREE.Vector3(), _lz = new THREE.Vector3();
/**
 * A sun with userData.shadowFollow = r keeps its shadow box (±r m) on the view instead of on the whole map, so
 * the same map size gives sharp shadows on any level, and keeps its bias tiny (see core/toon.js). The box sits a little ahead of the view and moves in
 * whole shadow texels, so standing shadows don't shimmer as you walk.
 */
function followShadow(light, cam) {
  const r = light.userData.shadowFollow, c = light.shadow.camera;
  const offset = (light.userData.sunOffset ??= light.position.clone().sub(light.target.position));
  if (c.right !== r) { c.left = c.bottom = -r; c.right = c.top = r; c.updateProjectionMatrix(); }
  cam.getWorldDirection(_f).setY(0).normalize();
  _c.setFromMatrixPosition(cam.matrixWorld).addScaledVector(_f, r * 0.35);
  _lz.copy(offset).normalize();
  _lx.set(0, 1, 0).cross(_lz).normalize();
  _ly.crossVectors(_lz, _lx);
  const texel = (2 * r) / light.shadow.mapSize.x;
  // surfaces cast from their back faces, so a lit face never tests against itself and needs next to no bias;
  // any offset (sideways or toward the sun) bigger than a ledge's overhang leaks a lit strip under it
  light.shadow.normalBias = 0;
  light.shadow.bias = -0.00002;
  const x = Math.round(_c.dot(_lx) / texel) * texel, y = Math.round(_c.dot(_ly) / texel) * texel, z = _c.dot(_lz);
  _c.set(0, 0, 0).addScaledVector(_lx, x).addScaledVector(_ly, y).addScaledVector(_lz, z);
  light.target.position.copy(_c);
  light.position.copy(_c).add(offset);
  light.target.updateMatrixWorld();
  light.updateMatrixWorld();
}
