import { SLOT_LABEL, findAttachment, statChips, loadoutStats } from '../weapons/attachments.js';

/** Where each callout card sits relative to its attachment point (px). */
const OFFSETS = { muzzle: [-30, -150], scope: [0, -165], stock: [-40, -150], mag: [170, 70], grip: [-170, 80] };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const STAT_ROWS = [
  ['Recoil control', (s) => (1.15 - (s.vRecoil * 0.65 + s.hRecoil * 0.35)) / 0.5],
  ['Handling', (s) => (1.4 - s.ads) / 0.65],
  ['Capacity', (s) => s.magSize / 50],
  ['Reload speed', (s) => (1.5 - s.reload) / 0.75],
  ['Zoom', (s) => (s.zoom - 1) / 2],
  ['Stealth', (s) => (s.suppressed ? 1 : s.flash < 0.5 ? 0.5 : 0.15)],
];

/**
 * In-world attachment editor for the active weapon, worked with the system cursor (the mouse is let out while it's
 * open); Tab cycles sections, 1–N picks an attachment, wheel cycles.
 * getGun() returns the active Gunplay (def, loadout, options(slot), setAttachment).
 */
export class Gunsmith {
  constructor(root, { getGun, anchor }) {
    Object.assign(this, { root, getGun, anchor });
    this.open = false;
    this.active = 'scope';
    this.cursor = { x: innerWidth / 2, y: innerHeight / 2 };
    // the system cursor (main.js lets the mouse out while the gunsmith is open): where it is, for hover and clicks
    addEventListener('mousemove', (e) => { this.cursor.x = e.clientX; this.cursor.y = e.clientY; });
  }

  /** Build the overlay for the active weapon's slots. */
  #render() {
    const gun = this.getGun();
    this.slots = gun.def.slots;
    if (!this.slots.includes(this.active)) this.active = this.slots[0];
    const root = this.root;
    root.innerHTML = `
      <svg class="smith-lines">${this.slots.map((s) => `<line data-line="${s}"/>`).join('')}</svg>
      <header class="smith-head card">
        <span class="eyebrow">Gunsmith</span>
        <span class="title">${gun.def.name}</span>
        <span class="label">H close · Tab section · 1–N attachment</span>
      </header>
      ${this.slots.map((s, i) => `
        <i class="dot" data-dot="${s}"></i>
        <button class="callout" data-slot="${s}" style="--i:${i}" tabindex="-1">
          <span class="label">${SLOT_LABEL[s]}</span><b></b>
        </button>`).join('')}
      <aside class="smith-stats card">
        <div class="label">Build</div>
        ${STAT_ROWS.map(([n]) => `<div class="srow"><span>${n}</span><div class="sbar"><b></b></div></div>`).join('')}
      </aside>
      <section class="tray card">
        <div class="tray-head"><span class="label tray-slot"></span><span class="label tray-count"></span></div>
        <div class="opts"></div>
      </section>
`;
    const $ = (s) => root.querySelector(s);
    this.el = { opts: $('.opts'), traySlot: $('.tray-slot'), trayCount: $('.tray-count'), bars: [...root.querySelectorAll('.sbar b')] };
    const pick = (attr) => Object.fromEntries(this.slots.map((s) => [s, root.querySelector(`[data-${attr}="${s}"]`)]));
    this.callouts = pick('slot');
    this.dots = pick('dot');
    this.lines = pick('line');
    this.hover = null;
  }

  setOpen(on) {
    if (on) {
      this.#render();
      void this.root.offsetWidth; // let the entrance transitions run from the closed state
      this.refresh();
    }
    this.open = on;
    this.root.classList.toggle('open', on);
  }

  setActive(slot) {
    if (this.active === slot) return;
    this.active = slot;
    this.refresh();
  }

  /** Re-render labels, tray and stats from the current loadout. */
  refresh() {
    const gun = this.getGun();
    const lo = gun.loadout;
    for (const s of this.slots) {
      this.callouts[s].querySelector('b').textContent = findAttachment(s, lo[s]).name;
      for (const el of [this.callouts[s], this.dots[s], this.lines[s]]) el.classList.toggle('active', s === this.active);
    }
    const list = gun.options(this.active);
    this.el.traySlot.textContent = SLOT_LABEL[this.active];
    this.el.trayCount.textContent = `${list.length} options`;
    this.el.opts.innerHTML = list.map((a, i) => `
      <button class="opt${a.id === lo[this.active] ? ' on' : ''}" data-opt="${a.id}" tabindex="-1">
        ${a.id === lo[this.active] ? '<span class="tag">Equipped</span>' : ''}
        <kbd>${i + 1}</kbd>
        <b>${a.name}</b>
        <p>${a.blurb}</p>
        <div class="chips">${statChips(a).map((c) => `<span class="${c.good === true ? 'good' : c.good === false ? 'bad' : ''}">${c.text}</span>`).join('')}</div>
      </button>`).join('');
    const st = loadoutStats(lo);
    STAT_ROWS.forEach(([, fn], i) => { this.el.bars[i].style.width = `${clamp(fn(st), 0.04, 1) * 100}%`; });
  }

  #cycle(dir) {
    const gun = this.getGun();
    const list = gun.options(this.active);
    const i = list.findIndex((a) => a.id === gun.loadout[this.active]);
    this.#equip(list[(i + dir + list.length) % list.length].id);
  }

  #equip(id) {
    this.getGun().setAttachment(this.active, id);
    this.refresh();
  }

  update(dt, input) {
    if (!this.open) return;
    const w = innerWidth, h = innerHeight;


    // callouts follow their parts on screen
    for (const s of this.slots) {
      const a = this.anchor(s, w, h);
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
      const [ox, oy] = OFFSETS[s];
      const cx = clamp(a.x + ox, 110, w - 360), cy = clamp(a.y + oy, 100, h - 280);
      this.dots[s].style.transform = `translate(${a.x}px, ${a.y}px)`;
      this.callouts[s].style.left = `${cx}px`;
      this.callouts[s].style.top = `${cy}px`;
      const l = this.lines[s];
      l.setAttribute('x1', a.x); l.setAttribute('y1', a.y);
      l.setAttribute('x2', cx); l.setAttribute('y2', cy);
    }

    // hover + input
    const hit = document.elementFromPoint(this.cursor.x, this.cursor.y)?.closest('[data-slot],[data-opt]');
    if (hit !== this.hover) {
      this.hover?.classList.remove('hover');
      hit?.classList.add('hover');
      this.hover = hit;
    }
    if (input.clicked(0) && hit) {
      if (hit.dataset.slot) this.setActive(hit.dataset.slot);
      else this.#equip(hit.dataset.opt);
    }
    if (input.wheel) this.#cycle(input.wheel > 0 ? 1 : -1);
    if (input.pressed('Tab')) {
      const dir = input.down('ShiftLeft') || input.down('ShiftRight') ? -1 : 1;
      this.setActive(this.slots[(this.slots.indexOf(this.active) + dir + this.slots.length) % this.slots.length]);
    }
    const opts = this.getGun().options(this.active);
    opts.forEach((a, i) => { if (input.pressed(`Digit${i + 1}`)) this.#equip(a.id); });
  }
}
