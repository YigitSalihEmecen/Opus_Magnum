import { ITEMS } from '../items/items.js';

/*
  Z: the item wheel. Held, it opens over the crosshair and the mouse (which stops turning the view) points at an
  item; letting go hands the pick back to be used. A small flick is enough: the pick follows the direction the
  mouse has moved since the wheel opened, past a dead zone.
*/

const SLOTS = ['bandage', 'charger', 'medkit', 'grenade']; // clockwise from the top
const DEAD = 18, REACH = 90; // px of mouse travel
const STEP = (Math.PI * 2) / SLOTS.length;

export class ItemWheel {
  constructor(parent, icons = {}) {
    const root = (this.root = document.createElement('div'));
    root.className = 'wheel';
    root.innerHTML = `<div class="wheel-dial"></div>${SLOTS.map((id, i) => `
      <div class="wheel-slot" data-id="${id}" style="--a:${i * STEP}rad">
        <span class="ic" style="${icons[id] ? `background-image:url(${icons[id]})` : ''}"></span><b>0</b>
      </div>`).join('')}<div class="wheel-name"></div>`;
    parent.appendChild(root);
    this.slots = Object.fromEntries([...root.querySelectorAll('.wheel-slot')].map((el) => [el.dataset.id, el]));
    this.name = root.querySelector('.wheel-name');
    this.open = false;
    this.sel = null;
    this.x = this.y = 0;
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('on');
  }

  /** Per frame while playing. Returns the item picked on the frame Z is let go, else null. */
  update(input, { inv, can }) {
    if (!this.open) {
      if (!can || !input.pressed('KeyZ')) return null;
      this.open = true;
      this.sel = null;
      this.x = this.y = 0;
      this.root.classList.add('on');
      for (const id of SLOTS) {
        const n = inv.counts[id];
        this.slots[id].querySelector('b').textContent = n;
        this.slots[id].classList.toggle('empty', !n);
      }
    }
    if (!input.down('KeyZ') || !can) {
      const pick = can ? this.sel : null;
      this.close();
      return pick;
    }
    this.x += input.mouseDX;
    this.y += input.mouseDY;
    const len = Math.hypot(this.x, this.y);
    if (len > REACH) { this.x *= REACH / len; this.y *= REACH / len; }
    const sel = len < DEAD ? this.sel : SLOTS[(Math.round(Math.atan2(this.x, -this.y) / STEP) + SLOTS.length) % SLOTS.length];
    if (sel !== this.sel) {
      this.sel = sel;
      for (const id of SLOTS) this.slots[id].classList.toggle('sel', id === sel);
      this.root.style.setProperty('--sel', `${SLOTS.indexOf(sel) * STEP}rad`);
      this.root.classList.toggle('picked', !!sel);
      this.name.textContent = sel ? ITEMS[sel].name : '';
    }
    return null;
  }
}
