/*
  SUPERKILL lockup: Kite's head as a silhouette rising behind an extra-condensed wordmark (Saira Extra Condensed 900,
  forced to width so the layout never depends on font metrics). Ivory faces, slate extrude, ink keylines.

  The cut: one straight blade line through the word. Both halves are clipped a hair apart, the top half
  slides back along the blade, a clay edge shows only inside the letters' cut faces, and thin tapered
  splinters carry the cut-face bands past both ends of the word.
*/

const W = 960, BASE = 272, CAP = 246, DEPTH = 11;
const INK = 'var(--ink)', IVORY = 'var(--ivory)', SLATE = '#3d3d3a', CLAY = 'var(--clay)';

const A = [0, BASE - CAP * 0.3], B = [W, BASE - CAP * 0.66];
const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
const dir = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
const nrm = [dir[1], -dir[0]]; // points up-left, away from the bottom half
const at = (t, off = 0) => [A[0] + dir[0] * t + nrm[0] * off, A[1] + dir[1] * t + nrm[1] * off];
const pts = (...p) => p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

const GAP = 2.5, SLIDE = 16, LIFT = 3, FAR = 600;
const half = (side) => pts(at(-FAR, side * GAP), at(len + FAR, side * GAP), at(len + FAR, side * FAR), at(-FAR, side * FAR));
const band = (from, to) => pts(at(-FAR, from), at(len + FAR, from), at(len + FAR, to), at(-FAR, to));
const INK_EDGE = 3, CLAY_EDGE = 7, KEYLINE = 3.5; // cut-face bands: ink then clay on the bottom half, an ink keyline on the top
// where the letters meet the cut, in t along the blade (measured from Saira Extra Condensed 900 at this size)
const S_LEFT = 57.5, L_RIGHT = 929;
// splinters: needles that grow out of a cut-face band where it leaves the word, their roots tucked under the letter
const splinter = (tip, root, mid, w) => pts(at(tip, mid), at(root, mid + w / 2), at(root, mid - w / 2));
const slide = [-dir[0] * SLIDE + nrm[0] * LIFT, -dir[1] * SLIDE + nrm[1] * LIFT];

const steps = Array.from({ length: DEPTH }, (_, i) => `<use href="#sk-word" x="${DEPTH - i}" y="${DEPTH - i}"/>`).join('');

/*
  Kite's head seen from the front (src/character/kite.js, head section), in model units (metres, y up):
  a 0.14 helmet with a visor slit, two fins leaning out (the right one longer) and a whip antenna.
  Drawn as one flat ink silhouette with a clay offset, so it reads as a shape, not a drawing.
*/
const S = 2300, HX = W / 2, HY = 0.085 * S - 30; // scale; the visor slit sits just above the letters
const P = (x, y) => [HX + x * S, HY - y * S];
const box = (x, y, w, h, r = 0) => { const [px, py] = P(x - w / 2, y + h / 2); return `<rect x="${px}" y="${py}" width="${w * S}" height="${h * S}" rx="${r * S}"/>`; };
const fin = (side, scale) => {
  const a = side * 0.22, len = 0.09 * scale;
  const tip = (dx, l) => [0.052 * side + dx * Math.cos(a) + l * Math.sin(a), 0.125 - dx * Math.sin(a) + l * Math.cos(a)];
  return `<polygon points="${pts(...[tip(-0.012, -0.03), tip(0.012, -0.03), tip(0.006, len), tip(-0.004, len * 1.06)].map(([x, y]) => P(x, y)))}"/>`;
};
const kiteShape = `${box(0, 0.07, 0.14, 0.14, 0.016)}${box(0, 0.085, 0.15, 0.036, 0.008)}${fin(-1, 1)}${fin(1, 1.2)}
  ${box(-0.045, 0.185, 0.006, 0.13)}`;

function kiteHead() {
  return `<g class="logo-kite">
    <g fill="${CLAY}" transform="translate(14 14)">${kiteShape}</g>
    <g fill="${INK}">${kiteShape}</g>
    <g fill="${CLAY}">${box(0, 0.085, 0.11, 0.011, 0.004)}</g>
    <circle cx="${P(-0.045, 0.25)[0]}" cy="${P(-0.045, 0.25)[1]}" r="11" fill="${CLAY}" stroke="${INK}" stroke-width="5"/>
  </g>`;
}

const TOP = Math.ceil(0.25 * S - HY + 30);
const word = `<text class="logo-type" x="0" y="${BASE}" textLength="${W}" lengthAdjust="spacingAndGlyphs">SUPERKILL</text>`;

export function logo(tag = '') {
  const tl = tag.length * 17, tw = tl + 36;
  return `<svg class="logo" viewBox="-40 -${TOP} ${W + 90} ${BASE + 80 + TOP}" role="img" aria-label="SUPERKILL">
    <defs>
      <symbol id="sk-word" overflow="visible">${word}</symbol>
      <clipPath id="sk-glyph">${word}</clipPath>
      <filter id="sk-grain" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="5"/>
        <feColorMatrix values="0 0 0 0 0.08  0 0 0 0 0.08  0 0 0 0 0.07  0 0 0 14 -9.6"/>
        <feComposite in2="SourceGraphic" operator="in"/>
      </filter>
      <g id="sk-art">
        <use href="#sk-word" fill="${INK}" opacity="0.14" x="${DEPTH + 7}" y="${DEPTH + 9}"/>
        <g fill="${INK}" stroke="${INK}" stroke-width="7" stroke-linejoin="round">${steps}</g>
        <g fill="${SLATE}">${steps}</g>
        <use href="#sk-word" fill="${IVORY}" stroke="${INK}" stroke-width="5" stroke-linejoin="round" paint-order="stroke"/>
        <use href="#sk-word" fill="#000" filter="url(#sk-grain)" opacity="0.22"/>
      </g>
      <clipPath id="sk-top"><polygon points="${half(1)}"/></clipPath>
      <clipPath id="sk-bottom"><polygon points="${half(-1)}"/></clipPath>
    </defs>

    ${kiteHead()}

    <polygon points="${splinter(-70, S_LEFT + 6, -GAP - INK_EDGE - CLAY_EDGE / 2, CLAY_EDGE)}" fill="${CLAY}"/>
    <polygon points="${splinter(len + 60, L_RIGHT - 6, GAP + LIFT + KEYLINE / 2, KEYLINE + 1)}" fill="${INK}"/>
    <use href="#sk-art" clip-path="url(#sk-bottom)"/>
    <g clip-path="url(#sk-glyph)"><polygon points="${band(-GAP, -GAP - INK_EDGE)}" fill="${INK}"/><polygon points="${band(-GAP - INK_EDGE, -GAP - INK_EDGE - CLAY_EDGE)}" fill="${CLAY}"/></g>
    <g transform="translate(${slide[0].toFixed(1)} ${slide[1].toFixed(1)})"><use href="#sk-art" clip-path="url(#sk-top)"/><g clip-path="url(#sk-glyph)"><polygon points="${band(GAP, GAP + KEYLINE)}" fill="${INK}"/></g></g>

    ${tag ? `<g transform="translate(${W - tw} ${BASE + 24}) rotate(-4)">
      <rect x="0" y="-26" width="${tw}" height="44" fill="${CLAY}" stroke="${INK}" stroke-width="4"/>
      <text class="logo-tag" x="${tw / 2}" y="7" text-anchor="middle" textLength="${tl}" lengthAdjust="spacingAndGlyphs">${tag}</text>
    </g>` : ''}
  </svg>`;
}
