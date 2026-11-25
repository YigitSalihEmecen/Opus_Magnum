import * as THREE from 'three';
import { MOVE } from '../player/movement.js';

const D2R = Math.PI / 180;
const html = (s) => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content.firstElementChild; };

/** In-game overlay. Pure DOM; reads state each frame, never mutates gameplay. */
export class HUD {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="brand card"><span class="title">Opus Magnum</span><span class="label">Test range · 0.1</span></div>
      <div class="fps card">— FPS</div>
      <div class="xhair"><i class="t"></i><i class="b"></i><i class="l"></i><i class="r"></i><i class="o"></i><i class="d"></i></div>
      <div class="hitmarker"><i></i><i></i><i></i><i></i></div>
      <div class="dmgs"></div>
      <div class="move card">
        <div class="row"><div class="speed">0.0<small>m/s</small></div><div class="state" data-s="ground">GROUND</div></div>
        <div class="label"><span>Wallrun</span><span class="wr-t">—</span></div>
        <div class="meter wall"><b></b></div>
        <div class="label"><span>Slide boost</span><span class="sb-t">ready</span></div>
        <div class="meter boost"><b></b></div>
      </div>
      <div class="weapon card">
        <div class="wrow"><span class="label kind">Primary</span><span class="wslots"></span></div>
        <div class="name"></div>
        <div class="ammo"><span class="mag">28</span><span class="res">/ ∞</span></div>
        <div class="pips"></div>
        <div class="modes"></div>
      </div>
      <div class="toast card"></div>`;
    const $ = (s) => root.querySelector(s);
    this.el = {
      fps: $('.fps'), xhair: $('.xhair'), hit: $('.hitmarker'), dmgs: $('.dmgs'),
      speed: $('.speed'), state: $('.state'), wall: $('.meter.wall > b'), wallT: $('.wr-t'),
      boost: $('.meter.boost > b'), boostT: $('.sb-t'),
      weapon: $('.weapon'), mag: $('.mag'), pipsBox: $('.pips'), pips: [],
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

  /** Active weapon name/class; `slots` = [{ key, name, active }] for the 1/2 indicator. */
  setWeapon(name, kind, slots) {
    this.root.querySelector('.weapon .name').textContent = name;
    this.root.querySelector('.weapon .kind').textContent = kind;
    if (slots) this.root.querySelector('.wslots').innerHTML = slots.map((s) => `<span class="${s.active ? 'on' : ''}">${s.key}</span>`).join('');
  }

  /** Fire modes the active weapon cycles with B (e.g. ['semi', 'burst']). */
  setModes(list) {
    const label = { auto: 'AUTO', semi: 'SEMI', burst: 'BURST ×3', pump: 'PUMP' };
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

  hitmarker(kind) {
    const h = this.el.hit;
    h.className = `hitmarker ${kind}`;
    void h.offsetWidth;
    h.classList.add('on');
  }

  damageNumber(point, amount, head) {
    const el = html(`<div class="dmg${head ? ' head' : ''}">${amount}</div>`);
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

    // movement panel
    this.el.speed.firstChild.nodeValue = mv.speed.toFixed(1);
    if (this.el.state.dataset.s !== mv.state) { this.el.state.dataset.s = mv.state; this.el.state.textContent = mv.state.toUpperCase(); }
    const wr = mv.state === 'wallrun' ? 1 - mv.wallrunT / MOVE.wallrunMaxTime : 0;
    this.el.wall.style.width = `${(wr * 100).toFixed(1)}%`;
    this.el.wallT.textContent = mv.state === 'wallrun' ? `${(MOVE.wallrunMaxTime - mv.wallrunT).toFixed(2)}s` : '—';
    const boost = 1 - Math.max(0, mv.slideBoostT) / MOVE.slideBoostCooldown;
    this.el.boost.style.width = `${(boost * 100).toFixed(1)}%`;
    this.el.boostT.textContent = boost >= 1 ? 'ready' : `${Math.max(0, mv.slideBoostT).toFixed(1)}s`;

    // weapon panel
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
