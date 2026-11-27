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

/*
  Sun shadows for every toon surface, in two layers (core/renderer.js keeps them filled):
    near  the sun's own shadow map: a small box (±16 m) that follows the view, sharp, with everything in it
    far   SUN_SHADOW: the whole level's static scenery, drawn once when the level loads
  The near map is used where it reaches and fades into the far one over its outer edge. Both are read with the
  same soft filter: 8 taps on a fixed spiral, each one filtered between the four nearest texels, so an edge is a
  smooth ramp about three texels wide instead of a staircase of texels (fixed pattern: no grain). Away from
  edges four taps settle it.
*/
export const SUN_SHADOW = {
  omFarMap: { value: null },
  omFarMatrix: { value: new THREE.Matrix4() },
  omFarSize: { value: new THREE.Vector2(1, 1) },
  omFarOn: { value: 0 },
};

const SHADOW_VERT_PARS = `
#ifdef USE_SHADOWMAP
uniform mat4 omFarMatrix;
varying vec4 vOmFar;
#endif
void main() {`;
const SHADOW_VERT = `#include <worldpos_vertex>
#ifdef USE_SHADOWMAP
vOmFar = omFarMatrix * worldPosition;
#endif`;
const SHADOW_FRAG = `#include <shadowmap_pars_fragment>
#ifdef USE_SHADOWMAP
uniform sampler2D omFarMap;
uniform vec2 omFarSize;
uniform float omFarOn;
varying vec4 vOmFar;
float omTap( sampler2D m, vec2 size, vec2 uv, float z ) {
	vec2 t = uv * size - 0.5, f = fract( t ), b = ( floor( t ) + 0.5 ) / size, d = 1.0 / size;
	return mix( mix( texture2DCompare( m, b, z ), texture2DCompare( m, b + vec2( d.x, 0.0 ), z ), f.x ),
		mix( texture2DCompare( m, b + vec2( 0.0, d.y ), z ), texture2DCompare( m, b + d, z ), f.x ), f.y );
}
vec2 omSpiral( int i ) {
	float r = sqrt( ( float( i ) + 0.5 ) / 8.0 ) * 1.5, a = float( i ) * 2.39996;
	return vec2( cos( a ), sin( a ) ) * r;
}
float omSoft( sampler2D m, vec2 size, vec4 coord, float bias ) {
	vec3 c = coord.xyz / coord.w;
	c.z += bias;
	if ( c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0 ) return 1.0;
	// the four outer taps first: where they agree the pixel is fully lit or fully shaded (most of the screen) and
	// the inner four would only agree too; only edges pay for all eight
	float s = 0.0;
	for ( int i = 7; i >= 4; i -- ) s += omTap( m, size, c.xy + omSpiral( i ) / size, c.z );
	if ( s < 0.001 || s > 3.999 ) return s * 0.25;
	for ( int i = 3; i >= 0; i -- ) s += omTap( m, size, c.xy + omSpiral( i ) / size, c.z );
	return s / 8.0;
}
float omSunShadow( sampler2D nearMap, vec2 nearSize, float bias, vec4 nearCoord, float facing ) {
	#ifdef SUN_FACING
	if ( facing <= 0.0 ) return 0.0;
	#endif
	float near = omSoft( nearMap, nearSize, nearCoord, bias );
	if ( omFarOn < 0.5 ) return near;
	vec3 c = nearCoord.xyz / nearCoord.w;
	float w = smoothstep( 0.0, 0.15, min( min( c.x, 1.0 - c.x ), min( c.y, 1.0 - c.y ) ) );
	if ( w >= 1.0 ) return near;
	return mix( omSoft( omFarMap, omFarSize, vOmFar, bias ), near, w );
}
#endif`;
const DIR_SHADOW = 'getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] )';
const SUN_SHADOW_CALL = 'omSunShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, vDirectionalShadowCoord[ i ], dot( geometryNormal, directLight.direction ) )';

/**
 * Cel-shaded material with a stepped rim highlight and the two-layer sun shadows.
 * rim: 0..1 strength, rimColor: highlight tint.
 */
export function toon(color, { rim = 0.18, rimColor = 0xffffff, soft = false, ...rest } = {}) {
  const mat = new THREE.MeshToonMaterial({ color, gradientMap: soft ? GRADIENT_SOFT : GRADIENT, ...rest });
  // shadows are cast from back faces (three's default), so a sunlit face never tests against itself (no acne at
  // any sun angle, with next to no bias, so shade under a ledge stays shut); a face turned away from the sun gets
  // none of it instead of testing against itself (core/renderer.js)
  mat.defines.SUN_FACING = '';
  const rimUniforms = rim > 0 && { rimStrength: { value: rim }, rimColor: { value: new THREE.Color(rimColor) } };
  if (rimUniforms) mat.userData.rim = rimUniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, SUN_SHADOW, rimUniforms || {});
    shader.vertexShader = shader.vertexShader.replace('void main() {', SHADOW_VERT_PARS).replace('#include <worldpos_vertex>', SHADOW_VERT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <shadowmap_pars_fragment>', SHADOW_FRAG)
      .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace(DIR_SHADOW, SUN_SHADOW_CALL));
    if (rimUniforms) {
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'uniform float rimStrength;\nuniform vec3 rimColor;\nvoid main() {')
        .replace(
          '#include <opaque_fragment>',
          `float rimF = 1.0 - saturate(dot(normalize(vViewPosition), normal));
          outgoingLight += rimColor * smoothstep(0.62, 0.68, rimF) * rimStrength * (0.4 + 0.6 * diffuseColor.rgb);
          #include <opaque_fragment>`,
        );
    }
  };
  mat.customProgramCacheKey = () => (rimUniforms ? 'toon-rim' : 'toon');
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
