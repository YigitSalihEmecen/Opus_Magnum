import * as THREE from 'three';
import { PALETTE as P } from '../core/toon.js';

/*
  Painted overcast sky, flat-shaded like the rest of the game: a slate ceiling that pales into the fog colour
  at the horizon (so distant scenery melts into it), a washed-out sun where the key light comes
  from, and an industrial skyline all round the horizon (works, chimneys, cooling towers, cranes, pylons) in two
  hazed depth layers. One equirectangular canvas, shared; the clouds and the chimney smoke move, so the sky
  shader below draws those over it.
*/

const W = 4096, H = 2048;
const D = W / 360; // canvas pixels per degree, both ways
let cached;

const hex = (c) => `#${new THREE.Color(c).getHexString()}`;
/** Pixel row for an elevation in degrees (0 = horizon). */
const rowAt = (deg) => (0.5 - deg / 180) * H;
/** Pixel column for an azimuth in degrees, matching three's equirect lookup (atan2(z, x)). */
const colAt = (deg) => ((deg / 360 + 0.5) % 1) * W;
/**
 * Equirect rows shrink toward the poles on the dome: a shape at elevation e must be drawn 1/cos(e) wider on
 * the canvas to look right in the sky.
 */
const stretchAt = (deg) => 1 / Math.cos((deg * Math.PI) / 180);
const mix = (a, b, t) => `#${new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString()}`;

const HORIZON = hex(P.pampas);
const SUN = { az: 142, el: 30 }; // the key light's azimuth; drawn lower than the light so it shows in play

function paint() {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');

  let s = 11;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const range = (a, b) => a + rnd() * (b - a);
  /** Draw at x and at its wrap-around twin so the seam at u = 0/1 never cuts a shape. */
  const wrap = (x, half, fn) => { fn(x); if (x - half < 0) fn(x + W); if (x + half > W) fn(x - W); };

  // ceiling: slate overhead, lighter and warmer down to the horizon haze
  const sky = g.createLinearGradient(0, 0, 0, H / 2);
  sky.addColorStop(0, '#5f676b');
  sky.addColorStop(0.45, '#7c8486');
  sky.addColorStop(0.72, '#a2a5a0');
  sky.addColorStop(0.9, '#cdcbc1');
  sky.addColorStop(1, HORIZON);
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H / 2);
  g.fillStyle = HORIZON;
  g.fillRect(0, H / 2, W, H / 2);

  // the sun behind thin cloud: a wide warm glow and a pale disc, no outline
  const sx = colAt(SUN.az), sy = rowAt(SUN.el), sk = stretchAt(SUN.el);
  wrap(sx, 40 * D * sk, (x) => {
    g.save();
    g.translate(x, sy);
    g.scale(sk, 1);
    const R = 40 * D;
    const glow = g.createRadialGradient(0, 0, 0, 0, 0, R);
    glow.addColorStop(0, 'rgba(246, 236, 214, 0.75)');
    glow.addColorStop(0.18, 'rgba(232, 222, 202, 0.4)');
    glow.addColorStop(1, 'rgba(220, 214, 200, 0)');
    g.fillStyle = glow;
    g.fillRect(-R, -R, R * 2, R * 2);
    g.fillStyle = 'rgba(252, 248, 238, 0.8)';
    g.beginPath(); g.arc(0, 0, 2.5 * D, 0, Math.PI * 2); g.fill();
    g.restore();
  });


  /*
    Skyline. Every piece is drawn standing on the horizon at a column x, in degrees scaled by D (up is -y), in
    one flat colour per layer; smoke is the only other tone.
  */
  const at = (x, fn) => {
    const seed = s; // a wrap-around twin redraws the same piece: replay the same random numbers
    wrap(x, 8 * D, (xx) => { s = seed; g.save(); g.translate(xx, H / 2); fn(); g.restore(); });
  };
  const rect = (x, w, h, y = 0) => g.fillRect((x - w / 2) * D, -(y + h) * D, w * D, h * D);
  const line = (pts, lw) => {
    g.lineWidth = lw * D;
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x * D, -y * D) : g.moveTo(x * D, -y * D)));
    g.stroke();
  };
  const plumes = [];
  const PIECES = {
    works(h) {
      const w = range(3, 9), base = h * range(0.4, 0.7);
      rect(0, w, base);
      // sawtooth roof
      const teeth = Math.floor(w / 0.9), tw = w / teeth;
      g.beginPath();
      for (let i = 0; i < teeth; i++) {
        const x0 = (-w / 2 + i * tw) * D;
        g.moveTo(x0, -base * D); g.lineTo(x0, -(base + 0.45) * D); g.lineTo(x0 + tw * D, -base * D);
      }
      g.fill();
      return w;
    },
    block(h) { const w = range(2, 5); rect(0, w, h * range(0.5, 1)); rect(range(-0.5, 0.5) * w, w * 0.4, h * range(0.3, 0.6), 0); return w; },
    stacks(h, x) {
      const n = 1 + Math.floor(rnd() * 3), gap = range(0.8, 1.4);
      rect(0, n * gap + 1.2, h * 0.35);
      for (let i = 0; i < n; i++) {
        const cx = (i - (n - 1) / 2) * gap, ch = h * range(1.5, 2.4), cw = range(0.28, 0.42);
        g.beginPath();
        g.moveTo((cx - cw * 0.7) * D, 0); g.lineTo((cx - cw / 2) * D, -ch * D);
        g.lineTo((cx + cw / 2) * D, -ch * D); g.lineTo((cx + cw * 0.7) * D, 0); g.fill();
        if (rnd() < 0.75) plumes.push([x + cx * D, ch, cw]);
      }
      return n * gap + 1.2;
    },
    cooling(h) {
      const w = range(2.6, 3.6), th = h * range(1.1, 1.5);
      g.beginPath();
      g.moveTo(-w / 2 * D, 0);
      g.quadraticCurveTo(-w * 0.22 * D, -th * 0.62 * D, -w * 0.32 * D, -th * D);
      g.lineTo(w * 0.32 * D, -th * D);
      g.quadraticCurveTo(w * 0.22 * D, -th * 0.62 * D, w / 2 * D, 0);
      g.fill();
      return w;
    },
    crane(h) {
      const mh = h * range(1.6, 2.4), jib = range(4, 7);
      line([[0, 0], [0, mh + 0.6]], 0.14);
      line([[-jib * 0.3, mh], [jib, mh]], 0.12);
      line([[0, mh + 0.6], [jib * 0.7, mh]], 0.05);
      line([[0, mh + 0.6], [-jib * 0.3, mh]], 0.05);
      rect(-jib * 0.25, 0.5, 0.35, mh - 0.35);
      line([[jib * 0.75, mh], [jib * 0.75, mh - range(0.6, 2)]], 0.03);
      return 2;
    },
    pylon(h) {
      const ph = h * range(1.3, 1.7), b = ph * 0.22;
      line([[-b, 0], [0, ph], [b, 0]], 0.07);
      line([[-b * 0.55, ph * 0.5], [b * 0.55, ph * 0.5]], 0.05);
      line([[-b * 0.8, ph * 0.2], [b * 0.55, ph * 0.5], [-b * 0.55, ph * 0.5], [b * 0.8, ph * 0.2]], 0.03);
      line([[-b * 1.5, ph * 0.78], [b * 1.5, ph * 0.78]], 0.07);
      line([[-b * 1.1, ph * 0.92], [b * 1.1, ph * 0.92]], 0.06);
      return 1.5;
    },
    tanks(h) {
      const n = 2 + Math.floor(rnd() * 2), r = range(0.8, 1.2);
      for (let i = 0; i < n; i++) {
        const cx = (i - (n - 1) / 2) * r * 2.3, th = h * range(0.5, 0.8);
        rect(cx, r * 2, th);
        g.beginPath(); g.ellipse(cx * D, -th * D, r * D, r * 0.35 * D, 0, Math.PI, 0); g.fill();
      }
      return n * r * 2.3;
    },
  };
  const KINDS = ['works', 'works', 'block', 'block', 'stacks', 'stacks', 'cooling', 'crane', 'pylon', 'tanks'];

  const smoke = [];
  /** Chimneys that smoke, for the sky shader: azimuth (deg), top (deg), width (deg), layer (0 far, 1 near). */
  const keep = (layerK) => {
    const seen = new Set();
    for (const [x, ch, cw] of plumes) {
      const az = ((((x / W) * 360 + 180) % 360) + 360) % 360;
      if (!seen.has(az)) { seen.add(az); smoke.push([az, ch, cw, layerK]); }
    }
    plumes.length = 0;
  };

  const layer = (color, layerK, scale, gapMax, groundH) => {
    g.fillStyle = color;
    g.fillRect(0, rowAt(groundH), W, rowAt(-0.6) - rowAt(groundH)); // low continuous sprawl
    let az = range(0, 10);
    while (az < 360) {
      const kind = KINDS[Math.floor(rnd() * KINDS.length)];
      const x = colAt(az);
      let w = 0;
      at(x, () => { g.fillStyle = g.strokeStyle = color; w = PIECES[kind](scale * range(0.8, 1.25), x); });
      az += w / 2 + range(1, gapMax);
    }
    keep(layerK);
  };
  layer(mix('#8d9291', HORIZON, 0.4), 0, 2.2, 6, 0.6);
  layer(mix('#626867', HORIZON, 0.22), 1, 3.4, 12, 0.3);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false; // read at one level: the u = 0/1 seam would pick a blurry mip
  tex.minFilter = THREE.LinearFilter;
  return { tex, smoke: smoke.slice(0, MAX_PLUMES) };
}

/*
  The moving parts, drawn per pixel over the painted texture:
    clouds  a flat deck overhead (a plane at height 1): the view ray meets it, so near clouds are big, far ones
            crowd toward the horizon in perspective, and the deck drifts with the wind. Value noise stretched
            along the wind, cut hard into a light rim and a dark body (cel steps), hazed out toward the horizon.
    smoke   each chimney's plume rolls downwind: noise scrolling along the plume, cut into two flat tones. A
            plume's lean comes from the same wind: across the view it streams sideways, along it, it rises.
*/
const MAX_PLUMES = 48;
const WIND = 205; // azimuth (deg) the wind blows toward
const toDir = (az, el) => {
  const a = THREE.MathUtils.degToRad(az), e = THREE.MathUtils.degToRad(el);
  return new THREE.Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a));
};

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = (projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0)).xyww;
}`;
const FRAG = /* glsl */ `
layout(location = 1) out highp vec4 gNormal;
#define MAX_PLUMES ${MAX_PLUMES}
uniform sampler2D tSky;
uniform float time, windAz;
uniform vec3 sunDir, cloudBody, cloudRim, cloudWarm, smokeNear, smokeFar;
uniform vec4 plumes[MAX_PLUMES];
uniform float plumeLayer[MAX_PLUMES];
uniform int plumeCount;
varying vec3 vDir;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
float cut(float v, float at, float w) { return smoothstep(at - w, at + w, v); }
void main() {
  gNormal = vec4(0.0);
  vec3 d = normalize(vDir);
  float az = atan(d.z, d.x), el = asin(clamp(d.y, -1.0, 1.0));
  vec3 col = textureLod(tSky, vec2(az * 0.15915494 + 0.5, el * 0.31830989 + 0.5), 0.0).rgb;
  vec2 wv = vec2(cos(windAz), sin(windAz));

  if (d.y > 0.004) {
    vec2 p = d.xz / max(d.y, 0.03) * 1.4;
    vec2 q = vec2(dot(p, wv) * 0.3 - time * 0.02, dot(p, vec2(-wv.y, wv.x)));
    float n = fbm(q + vec2(0.0, time * 0.003));
    float w = fwidth(n) * 0.75 + 0.002;
    float rim = cut(n, 0.5, w), core = cut(n, 0.56, w);
    float sun = pow(max(dot(d, sunDir), 0.0), 8.0);
    vec3 c = mix(mix(cloudRim, cloudWarm, sun * 0.8), mix(cloudBody, cloudWarm * 0.82, sun * 0.35), core);
    float haze = smoothstep(0.03, 0.4, d.y);
    c = mix(col, c, 0.35 + 0.65 * haze);
    col = mix(col, c, rim * smoothstep(0.004, 0.06, d.y));
  }

  float eld = degrees(el), azd = degrees(az);
  if (eld > -1.0 && eld < 16.0) {
    for (int i = 0; i < MAX_PLUMES; i++) {
      if (i >= plumeCount) break;
      vec4 P = plumes[i]; // azimuth, top, width (deg), wind across the view (-1 … 1)
      if (eld < P.y - 0.6) continue;
      float x = (mod(azd - P.x + 540.0, 360.0) - 180.0) * sign(P.w + 1e-4);
      float len = 3.5 + 10.0 * abs(P.w);
      if (x < -2.5 || x > len + 3.0) continue;
      float t = clamp(x / len, 0.0, 1.0);
      float cy = P.y + 0.2 + t * (1.0 + 2.6 * (1.0 - abs(P.w)));
      float r = P.z * 0.6 + t * 1.5;
      float dy = (eld - cy) / r, dx = min(x, 0.0) / (P.z * 0.7);
      float body = (1.0 - dy * dy - dx * dx) * pow(1.0 - t, 1.2);
      float nn = noise(vec2(x * 0.8 - time * 1.1, eld * 1.3 + float(i) * 7.31));
      float dens = body * (0.5 + nn);
      float a = 0.6 * cut(dens, 0.16, 0.03) + 0.3 * cut(dens, 0.42, 0.03); // fixed edge: no derivatives in a branch
      col = mix(col, mix(smokeFar, smokeNear, plumeLayer[i]), a);
    }
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

/**
 * Sky behind everything: one inside-out box drawn first, at the far plane, ignoring depth (so it reads to the
 * outline pass exactly like a cleared background). Fog stays the horizon colour so far geometry fades into it.
 */
export function applySky(scene) {
  scene.background = null;
  if (scene.getObjectByName('sky')) return;
  const { tex, smoke } = (cached ??= paint());
  const plumes = Array.from({ length: MAX_PLUMES }, (_, i) => {
    const [az, top, w] = smoke[i] ?? [0, 0, 0];
    return new THREE.Vector4(az, top, w, Math.sin(THREE.MathUtils.degToRad(WIND - az)));
  });
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      tSky: { value: tex },
      time: { value: 0 },
      windAz: { value: THREE.MathUtils.degToRad(WIND) },
      sunDir: { value: toDir(SUN.az, SUN.el) },
      cloudBody: { value: new THREE.Color('#5b6367') },
      cloudRim: { value: new THREE.Color('#a3a7a4') },
      cloudWarm: { value: new THREE.Color('#efe3cb') },
      smokeNear: { value: new THREE.Color('#7b7e7a') },
      smokeFar: { value: new THREE.Color('#a3a49e') },
      plumes: { value: plumes },
      plumeLayer: { value: Array.from({ length: MAX_PLUMES }, (_, i) => smoke[i]?.[3] ?? 0) },
      plumeCount: { value: smoke.length },
    },
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
  sky.name = 'sky';
  sky.frustumCulled = false;
  sky.renderOrder = -1e6;
  sky.raycast = () => {};
  sky.onBeforeRender = () => { mat.uniforms.time.value = performance.now() / 1000; };
  scene.add(sky);
}
