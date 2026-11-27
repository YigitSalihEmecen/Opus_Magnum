import * as THREE from 'three';

const D2R = Math.PI / 180;
const html = (s) => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content.firstElementChild; };

// hit marker arms on the diagonals: inner / outer radius and width (px). Every outline is drawn under every
// fill, so the arms never cut across each other, and the kill ring sits clear outside the arms
const ARMS = { hit: [5, 14, 2.5], head: [5, 15.5, 3], kill: [6.5, 18, 4] };
const D = Math.SQRT1_2;
const arms = ([a, b], cls) => [1, -1].flatMap((sx) => [1, -1].map((sy) => `<line class="${cls}" x1="${sx * a * D}" y1="${sy * a * D}" x2="${sx * b * D}" y2="${sy * b * D}"/>`)).join('');
const markerSvg = (kind) => {
  const [a, b, w] = ARMS[kind];
  const ring = kind === 'kill' ? '<g class="ring"><circle r="24" class="ol" stroke-width="7"/><circle r="24" class="fill" stroke-width="3.5"/></g>' : '';
  return `<svg viewBox="-32 -32 64 64" width="64" height="64">${ring}<g stroke-width="${w + 3}">${arms([a - 1.5, b + 1.5], 'ol')}</g><g stroke-width="${w}">${arms([a, b], 'fill')}</g></svg>`;
};
const MARKERS = { hit: markerSvg('hit'), head: markerSvg('head'), kill: markerSvg('kill') };
export const ARMOUR_HUD = [null, '#c4bba8', '#4f9be6', '#a477e0']; // damage-number colour by armour tier
const SHIELD = '<svg class="sh" viewBox="-11 -13 22 26"><path d="M0-12.5-9.5-9V-1c0 6.4 4.3 10.8 9.5 13 5.2-2.2 9.5-6.6 9.5-13V-9z"/></svg>';
// a broken vest: the shield split down a jagged line, the halves fly apart
const SHIELD_BROKEN = '<svg class="sh" viewBox="-11 -13 22 26"><path class="l" d="M0-12.5-9.5-9V-1c0 6.4 4.3 10.8 9.5 13l1.6-6.2-2.6-3.4 2.4-4.6-2-4.2z"/><path class="r" d="M0-12.5 9.5-9V-1C9.5 5.4 5.2 9.8 0 12l1.6-6.2-2.6-3.4 2.4-4.6-2-4.2z"/></svg>';

/** In-game overlay. Pure DOM; reads state each frame, never mutates gameplay. */
export class HUD {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="fps card">— FPS</div>
      <div class="xhair"><i class="t"></i><i class="b"></i><i class="l"></i><i class="r"></i><i class="o"></i><i class="d"></i></div>
      <div class="hitmarker"></div>
      <div class="killflash"></div>
      <div class="dmgs"></div>
      <div class="weapon card">
        <div class="wrow"><span class="label kind">Primary</span></div>
        <div class="name"></div>
        <div class="ammo"><span class="mag">28</span><span class="res">/ ∞</span></div>
        <div class="pips"></div>
        <div class="modes"></div>
      </div>
      <div class="toast card"></div>
      <div class="loadout"></div>`;
    const $ = (s) => root.querySelector(s);
    this.el = {
      fps: $('.fps'), xhair: $('.xhair'), hit: $('.hitmarker'), killflash: $('.killflash'), dmgs: $('.dmgs'),
      weapon: $('.weapon'), mag: $('.mag'), res: $('.res'), pipsBox: $('.pips'), pips: [],
      modesBox: $('.modes'), modes: [], toast: $('.toast'),
      bars: ['.t', '.b', '.l', '.r'].map((s) => root.querySelector(`.xhair ${s}`)),
      ring: root.querySelector('.xhair .o'),
    };
    this.numbers = [];
    this.frames = 0;
    this.fpsTime = 0;
    this.lastAmmo = -1;
    this._v = new THREE.Vector3();
  }

  show(on) { this.root.hidden = !on; }

  /** Active weapon name/class; `slots` = [{ key, name, kind, icon, active }] for the loadout bar. */
  setWeapon(name, kind, slots) {
    this.root.querySelector('.weapon .name').textContent = name;
    this.root.querySelector('.weapon .kind').textContent = kind;
    if (slots) this.setLoadout(slots);
  }

  /** Bottom-centre loadout bar: one card per weapon with its key, silhouette and name; the drawn one is lifted. */
  setLoadout(slots) {
    this.root.querySelector('.loadout').innerHTML = slots.map((s) => `
      <div class="slot${s.active ? ' on' : ''}">
        <span class="key">${s.key}</span>
        <span class="sil"${s.icon ? ` style="--icon:url(${s.icon})"` : ''}></span>
        <span class="sname">${s.name}</span>
      </div>`).join('');
  }

  /** Fire modes the active weapon cycles with B (e.g. ['semi', 'burst']). */
  setModes(list) {
    const label = { auto: 'AUTO', semi: 'SEMI', burst: 'BURST ×3', pump: 'PUMP', bolt: 'BOLT' };
    this.el.modesBox.innerHTML = list.map((m) => `<span data-m="${m}">${label[m]}</span>`).join('')
      + (list.length > 1 ? '<span class="label" style="margin-left:auto;align-self:center">B</span>' : '');
    this.el.modes = [...this.el.modesBox.querySelectorAll('span[data-m]')];
  }

  setInspecting(on) { this.root.classList.toggle('inspecting', on); }

  setMagSize(n) {
    this.magSize = n;
    const box = this.el.pipsBox;
    box.style.gridTemplateColumns = `repeat(${Math.ceil(n / 2)}, 1fr)`;
    box.innerHTML = '<i></i>'.repeat(n);
    this.el.pips = [...box.children];
    this.lastAmmo = -1;
  }

  /** kind: 'hit' | 'kill'; head colours it amber. Kills also pulse a tinted vignette. */
  hitmarker(kind, head = false) {
    const h = this.el.hit;
    const shape = kind === 'kill' ? 'kill' : head ? 'head' : 'hit';
    if (h.dataset.shape !== shape) { h.innerHTML = MARKERS[shape]; h.dataset.shape = shape; }
    h.className = `hitmarker ${kind}${head ? ' head' : ''}`;
    void h.offsetWidth;
    h.classList.add('on');
    if (kind !== 'kill') return;
    const f = this.el.killflash;
    f.className = `killflash${head ? ' head' : ''}`;
    void f.offsetWidth;
    f.classList.add('on');
  }

  /** armour: { tier, broke } when the hit landed on armour — the number takes the tier's colour and a shield,
   *  which splits apart when the hit broke it. */
  damageNumber(point, amount, head, armour = null) {
    const tier = armour?.tier ?? 0;
    const el = html(`<div class="dmg${head ? ' head' : ''}${tier ? ' ar' : ''}${armour?.broke ? ' brk' : ''}"${tier ? ` style="--ar:${ARMOUR_HUD[tier]}"` : ''}>${tier ? (armour.broke ? SHIELD_BROKEN : SHIELD) : ''}${amount}</div>`);
    this.el.dmgs.appendChild(el);
    this.numbers.push({ el, pos: point.clone(), t: 0, dx: (Math.random() - 0.5) * 40 });
    if (this.numbers.length > 24) this.numbers.shift().el.remove();
  }

  recoilPulse() {
    const w = this.el.weapon;
    w.classList.remove('kick');
    void w.offsetWidth;
    w.classList.add('kick');
  }

  toast(text) {
    const t = this.el.toast;
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('on'), 1100);
  }

  update(dt, { mv, gun, camera }) {
    // fps
    this.frames++;
    this.fpsTime += dt;
    if (this.fpsTime > 0.5) { this.el.fps.textContent = `${Math.round(this.frames / this.fpsTime)} FPS`; this.frames = 0; this.fpsTime = 0; }

    // crosshair gap from true spread cone
    const h = innerHeight;
    const gap = (Math.tan((gun.spread + gun.pelletSpread) * D2R) / Math.tan((camera.fov * D2R) / 2)) * (h / 2) + 4;
    // pellet guns: a ring that traces the pattern instead of four bars
    const ring = !!gun.S.pellets;
    this.el.xhair.classList.toggle('ring', ring);
    if (ring) {
      const d = 2 * Math.max(6, gap - 2);
      Object.assign(this.el.ring.style, { width: `${d}px`, height: `${d}px`, left: `${-d / 2}px`, top: `${-d / 2}px` });
    }
    const [t, b, l, r] = this.el.bars;
    t.style.transform = `translateY(${-gap - 9}px)`;
    b.style.transform = `translateY(${gap}px)`;
    l.style.transform = `translateX(${-gap - 9}px)`;
    r.style.transform = `translateX(${gap}px)`;
    this.el.xhair.style.opacity = String(Math.max(0, 1 - gun.adsEased * 2.5) * (mv.sprinting ? 0.35 : 1));

    // weapon panel
    if (gun.reserve !== this.lastReserve) {
      this.lastReserve = gun.reserve;
      this.el.res.textContent = `/ ${gun.reserve === Infinity ? '∞' : gun.reserve}`;
      this.el.res.classList.toggle('low', gun.reserve === 0);
    }
    if (gun.ammo !== this.lastAmmo) {
      this.lastAmmo = gun.ammo;
      this.el.mag.textContent = String(gun.ammo).padStart(2, '0');
      this.el.mag.classList.toggle('low', gun.ammo <= this.magSize * 0.25);
      this.el.pips.forEach((p, i) => p.classList.toggle('spent', i >= gun.ammo));
    }
    this.el.modes.forEach((m) => m.classList.toggle('on', m.dataset.m === gun.mode));

    // floating damage numbers
    this.numbers = this.numbers.filter((n) => {
      n.t += dt;
      if (n.t > 0.8) { n.el.remove(); return false; }
      const v = this._v.copy(n.pos).project(camera);
      if (v.z > 1) { n.el.style.opacity = '0'; return true; }
      const x = (v.x * 0.5 + 0.5) * innerWidth + n.dx * n.t;
      const y = (-v.y * 0.5 + 0.5) * innerHeight - 40 * n.t - 18;
      n.el.style.left = `${x}px`;
      n.el.style.top = `${y}px`;
      n.el.style.opacity = String(Math.min(1, (0.8 - n.t) * 4));
      return true;
    });
  }
}
