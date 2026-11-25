import * as THREE from 'three';
import { PALETTE as P } from '../core/toon.js';

/*
  Painted sky in the game's paper-and-ink look: a soft gradient that settles into the fog colour at the
  horizon (so distant scenery melts into it), flat-bottomed toon clouds with ink outlines, a warm sun
  roughly where the key light comes from, and a faint far ridge. One equirectangular canvas, shared.
*/

const W = 2048, H = 1024;
let cached;

const hex = (c) => `#${new THREE.Color(c).getHexString()}`;
/** Pixel row for an elevation in degrees (0 = horizon). */
const rowAt = (deg) => (0.5 - deg / 180) * H;
/** Pixel column for an azimuth in degrees, matching three's equirect lookup (atan2(z, x)). */
const colAt = (deg) => ((deg / 360 + 0.5) % 1) * W;

function paint() {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');

  const sky = g.createLinearGradient(0, 0, 0, H / 2);
  sky.addColorStop(0, '#93aebf');
  sky.addColorStop(0.45, '#b9cad0');
  sky.addColorStop(0.78, '#e2e2da');
  sky.addColorStop(1, hex(P.pampas));
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H / 2);
  g.fillStyle = hex(P.pampas);
  g.fillRect(0, H / 2, W, H / 2);

  let s = 7;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  /** Draw at x and its wrap-around twin so the seam at u = 0/1 never cuts a shape. */
  const wrap = (x, w, fn) => { fn(x); if (x - w < 0) fn(x + W); if (x + w > W) fn(x - W); };

  // far ridge just above the horizon, tinted toward the sky so it reads as distance
  g.fillStyle = 'rgba(150, 168, 172, 0.28)';
  g.beginPath();
  g.moveTo(0, H / 2);
  for (let x = 0; x <= W; x += 16) {
    const y = rowAt(1.2 + 1.4 * Math.sin(x * 0.006) ** 2 + 0.9 * Math.sin(x * 0.017 + 1.3) ** 2);
    g.lineTo(x, y);
  }
  g.lineTo(W, H / 2);
  g.fill();

  // sun: the key light sits at azimuth ~142°, high; the disc is placed a little lower so it shows in play
  const sx = colAt(142), sy = rowAt(38);
  wrap(sx, 160, (x) => {
    const halo = g.createRadialGradient(x, sy, 0, x, sy, 160);
    halo.addColorStop(0, 'rgba(255, 244, 220, 0.85)');
    halo.addColorStop(0.25, 'rgba(255, 236, 205, 0.35)');
    halo.addColorStop(1, 'rgba(255, 236, 205, 0)');
    g.fillStyle = halo;
    g.fillRect(x - 160, sy - 160, 320, 320);
    g.fillStyle = '#fff6e4';
    g.strokeStyle = 'rgba(20, 20, 19, 0.35)';
    g.lineWidth = 3;
    g.beginPath(); g.arc(x, sy, 26, 0, Math.PI * 2); g.fill(); g.stroke();
  });

  // clouds: puff clusters cut flat along their base. Ink rim first (slightly larger puffs), then a shade
  // layer, then the lit tops, so the union of puffs gets one clean outline
  const cloud = (cx, base, w, hgt) => {
    const puffs = [];
    const n = 4 + Math.floor(w / 46);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const r = hgt * (0.45 + 0.55 * Math.sin(Math.PI * t)) * (0.8 + rnd() * 0.35);
      puffs.push([cx - w / 2 + t * w, base - r * 0.55, r]);
    }
    wrap(cx, w, (ox) => {
      const dx = ox - cx;
      g.save();
      g.beginPath(); g.rect(dx + cx - w, 0, w * 2, base); g.clip();
      for (const [pad, col] of [[3, 'rgba(20, 20, 19, 0.38)'], [0, '#e4e0d6'], [-0.1, '#fbfaf5']]) {
        g.fillStyle = col;
        for (const [x, y, r] of puffs) {
          g.beginPath();
          // the lit layer sits a little higher, leaving a shaded underside band
          g.arc(x + dx, y - (pad < 0 ? r * 0.18 : 0), r + pad - (pad < 0 ? r * 0.08 : 0), 0, Math.PI * 2);
          g.fill();
        }
      }
      g.restore();
      g.fillStyle = 'rgba(20, 20, 19, 0.38)';
      g.fillRect(dx + puffs[0][0] - puffs[0][2] * 0.6, base - 1.5, w + puffs[0][2] * 1.2, 3);
    });
  };
  for (let i = 0; i < 30; i++) {
    const elev = 5 + rnd() ** 1.5 * 28;
    const scale = (0.45 + (elev / 33) * 0.5) * 0.75;
    cloud(rnd() * W, rowAt(elev), (90 + rnd() * 170) * scale, (22 + rnd() * 16) * scale);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Sky behind everything; fog stays the horizon colour so far geometry fades into the sky's base. */
export function applySky(scene) {
  scene.background = cached ??= paint();
}
