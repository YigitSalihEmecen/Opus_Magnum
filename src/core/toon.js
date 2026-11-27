import * as THREE from 'three';

export const PALETTE = {
  ink: 0x141413,
  ivory: 0xfaf9f5,
  pampas: 0xf0eee6,
  oat: 0xe3dacc,
  manilla: 0xebdbbc,
  kraft: 0xd4a27f,
  clay: 0xd97757,
  bookcloth: 0xcc785c,
  cloud: 0x87867f,
  slate: 0x3d3d3a,
  sage: 0x8a9a7b,
  sky: 0x9fb4c7,
  olive: 0x6b6a4f,
};

function gradientMap(levels) {
  const data = new Uint8Array(levels.length * 4);
  levels.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  const tex = new THREE.DataTexture(data, levels.length, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const GRADIENT = gradientMap([90, 170, 255]);
const GRADIENT_SOFT = gradientMap([120, 190, 235, 255]);

/**
 * Cel-shaded material with a stepped rim highlight.
 * rim: 0..1 strength, rimColor: highlight tint.
 */
export function toon(color, { rim = 0.18, rimColor = 0xffffff, soft = false, ...rest } = {}) {
  const mat = new THREE.MeshToonMaterial({ color, gradientMap: soft ? GRADIENT_SOFT : GRADIENT, ...rest });
  // shadows are cast from back faces (three's default), so a sunlit face never tests against itself (no acne at
  // any sun angle, with next to no bias, so shade under a ledge stays shut); a face turned away from the sun gets
  // none of it instead of testing against itself (core/renderer.js)
  mat.defines.SUN_FACING = '';
  if (rim > 0) {
    const rimUniforms = { rimStrength: { value: rim }, rimColor: { value: new THREE.Color(rimColor) } };
    mat.userData.rim = rimUniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, rimUniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'uniform float rimStrength;\nuniform vec3 rimColor;\nvoid main() {')
        .replace(
          '#include <opaque_fragment>',
          `float rimF = 1.0 - saturate(dot(normalize(vViewPosition), normal));
          outgoingLight += rimColor * smoothstep(0.62, 0.68, rimF) * rimStrength * (0.4 + 0.6 * diffuseColor.rgb);
          #include <opaque_fragment>`,
        );
    };
    mat.customProgramCacheKey = () => 'toon-rim';
  }
  return mat;
}

/** Grid texture for the map editor's ground: white field, 1 m minor and 4 m major lines. */
export function gridTexture({ base = '#ffffff', minor = 'rgba(20,20,19,0.10)', major = 'rgba(20,20,19,0.22)', size = 512, cells = 4 } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  const step = size / cells;
  g.strokeStyle = minor;
  g.lineWidth = 2;
  for (let i = 1; i < cells; i++) {
    g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step, size); g.stroke();
    g.beginPath(); g.moveTo(0, i * step); g.lineTo(size, i * step); g.stroke();
  }
  g.strokeStyle = major;
  g.lineWidth = 4;
  g.strokeRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Text drawn onto a canvas texture — used for range signage. */
export function textTexture(lines, { width = 1024, height = 256, bg = '#141413', fg = '#faf9f5', font = '600 120px "Space Grotesk", sans-serif', align = 'left', pad = 48, accent } = {}) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d');
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, width, height); }
  if (accent) { g.fillStyle = accent; g.fillRect(0, 0, 24, height); }
  g.fillStyle = fg;
  g.textBaseline = 'middle';
  g.textAlign = align;
  const list = Array.isArray(lines) ? lines : [lines];
  list.forEach((l, i) => {
    g.font = l.font ?? font;
    const x = align === 'center' ? width / 2 : pad + (accent ? 24 : 0);
    g.fillStyle = l.color ?? fg;
    g.fillText(l.text ?? l, x, (height / (list.length + 1)) * (i + 1));
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
