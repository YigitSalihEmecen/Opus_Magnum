import * as THREE from 'three';
import { PALETTE as P } from '../core/toon.js';

/*
  Painted sky in the game's paper-and-ink look: a soft gradient that settles into the fog colour at the
  horizon (so distant scenery melts into it), flat-bottomed toon clouds with ink outlines, a warm sun
  roughly where the key light comes from, and a faint far ridge. One equirectangular canvas, shared.
*/

const W = 4096, H = 2048;
let cached;

const hex = (c) => `#${new THREE.Color(c).getHexString()}`;
/** Pixel row for an elevation in degrees (0 = horizon). */
const rowAt = (deg) => (0.5 - deg / 180) * H;
/** Pixel column for an azimuth in degrees, matching three's equirect lookup (atan2(z, x)). */
const colAt = (deg) => ((deg / 360 + 0.5) % 1) * W;
/**
 * Equirect rows shrink toward the poles on the dome: a shape at elevation e must be drawn 1/cos(e) wider on
 * the canvas to look round in the sky.
 */
const stretchAt = (deg) => 1 / Math.cos((deg * Math.PI) / 180);

function paint() {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');

  const sky = g.createLinearGradient(0, 0, 0, H / 2);
  sky.addColorStop(0, '#8fabbe');
  sky.addColorStop(0.45, '#b6c8cf');
  sky.addColorStop(0.8, '#e0e1d9');
  sky.addColorStop(1, hex(P.pampas));
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H / 2);
  g.fillStyle = hex(P.pampas);
  g.fillRect(0, H / 2, W, H / 2);

  let s = 7;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  /** Draw at x and at its wrap-around twin so the seam at u = 0/1 never cuts a shape. */
  const wrap = (x, half, fn) => { fn(x); if (x - half < 0) fn(x + W); if (x + half > W) fn(x - W); };

  // far ridge just above the horizon, tinted toward the sky so it reads as distance
  g.fillStyle = 'rgba(150, 168, 172, 0.28)';
  g.beginPath();
  g.moveTo(0, H / 2);
  for (let x = 0; x <= W; x += 16) {
    const u = (x / W) * 2048; // same silhouette at any texture size
    g.lineTo(x, rowAt(1.2 + 1.4 * Math.sin(u * 0.006) ** 2 + 0.9 * Math.sin(u * 0.017 + 1.3) ** 2));
  }
  g.lineTo(W, H / 2);
  g.fill();

  const px = W / 360; // canvas pixels per degree

  // sun: the key light sits at azimuth ~142°, high; drawn a little lower so it shows in play
  const sunEl = 38, sx = colAt(142), sy = rowAt(sunEl), sk = stretchAt(sunEl);
  wrap(sx, 28 * px * sk, (x) => {
    g.save();
    g.translate(x, sy);
    g.scale(sk, 1);
    const R = 28 * px;
    const halo = g.createRadialGradient(0, 0, 0, 0, 0, R);
    halo.addColorStop(0, 'rgba(255, 244, 220, 0.85)');
    halo.addColorStop(0.25, 'rgba(255, 236, 205, 0.35)');
    halo.addColorStop(1, 'rgba(255, 236, 205, 0)');
    g.fillStyle = halo;
    g.fillRect(-R, -R, R * 2, R * 2);
    g.fillStyle = '#fff6e4';
    g.strokeStyle = 'rgba(20, 20, 19, 0.35)';
    g.lineWidth = 5;
    g.beginPath(); g.arc(0, 0, 4.6 * px, 0, Math.PI * 2); g.fill(); g.stroke();
    g.restore();
  });

  /*
    Clouds: a row of puffs on a flat base, drawn in the cloud's own frame (base at y = 0, stretched for its
    elevation). Three passes: ink rim (puffs grown by the line width, allowed a line's depth below the base, so
    the outline — base included — is one continuous edge), the shaded underside (puffs, clipped at the base),
    then the lit top (the same puffs shifted up, clipped to the silhouette so it can never leave the outline).
  */
  const INK = 'rgba(20, 20, 19, 0.42)', SHADE = '#e2ded3', LIT = '#fbfaf5';
  const lw = 5;
  const cloud = (cx, elev, w, hgt) => {
    const n = 4 + Math.floor(w / 70);
    const puffs = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const r = hgt * (0.42 + 0.58 * Math.sin(Math.PI * (0.08 + 0.84 * t))) * (0.82 + rnd() * 0.3);
      puffs.push([-w / 2 + t * w, -r * 0.55, r]);
    }
    const left = puffs[0][0] - puffs[0][2], right = puffs[n - 1][0] + puffs[n - 1][2];
    const circles = (grow = 0, dy = 0, shrink = 0) => {
      g.beginPath();
      for (const [x, y, r] of puffs) { g.moveTo(x + r + grow, y + dy * r); g.arc(x, y + dy * r, r + grow - shrink * r, 0, Math.PI * 2); }
    };
    const k = stretchAt(elev);
    wrap(cx, ((right - left) / 2) * k + lw, (x) => {
      g.save();
      g.translate(x, rowAt(elev));
      g.scale(k, 1);
      g.save();
      g.beginPath(); g.rect(left - 50, -hgt * 4, right - left + 100, hgt * 4 + lw); g.clip();
      g.fillStyle = INK; circles(lw); g.fill();
      g.restore();
      g.save();
      g.beginPath(); g.rect(left - 50, -hgt * 4, right - left + 100, hgt * 4); g.clip();
      g.fillStyle = SHADE; circles(); g.fill();
      circles(); g.clip();
      g.fillStyle = LIT; circles(0, -0.22, 0.04); g.fill();
      g.restore();
      g.restore();
    });
  };
  // spread around the sky (stratified azimuths), then paint far (low) to near (high) so overlaps stay clean
  const list = [];
  const N = 26;
  for (let i = 0; i < N; i++) {
    const elev = 5 + rnd() ** 1.4 * 27;
    const size = (0.5 + (elev / 32) * 0.55);
    list.push({ x: ((i + 0.15 + rnd() * 0.7) / N) * W, elev, w: (110 + rnd() * 210) * size * (W / 2048) * 0.6, h: (26 + rnd() * 15) * size * (W / 2048) * 0.6 });
  }
  list.sort((a, b) => a.elev - b.elev).forEach((cl) => cloud(cl.x, cl.elev, cl.w, cl.h));

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
