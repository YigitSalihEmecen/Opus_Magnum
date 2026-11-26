import * as THREE from 'three';
import { ITEMS, ARMOUR_TIERS } from '../items/items.js';
import { MAX_HP } from '../player/vitals.js';
import { itemIcons } from './itemIcons.js';
import './vitals.css';

/*
  Bottom-left: health and armour (armour in its tier colour, one cell per 25), the carried items with their
  keys, and centre-screen the pickup prompt and the progress ring of the item being used. Pure DOM, reads
  state each frame.
*/

const CHIPS = [['bandage', 'Q'], ['medkit', 'Q'], ['charger', 'X'], ['grenade', 'G']];
const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

export class VitalsHud {
  constructor(parent) {
    const root = (this.root = document.createElement('div'));
    root.className = 'vitals-hud';
    root.innerHTML = `
      <div class="items">${CHIPS.map(([id, key]) => `<div class="chip" data-id="${id}"><span class="key">${key}</span><span class="ic"></span><b>0</b></div>`).join('')}</div>
      <div class="vitals card">
        <div class="row"><span class="label">Health</span><span class="num">150</span></div>
        <div class="bar hp"><b></b><i></i></div>
        <div class="armour">
          <div class="row"><span class="label tier">No armour</span><span class="anum"></span></div>
          <div class="bar ar"><b></b></div>
        </div>
      </div>
      <div class="prompt card" hidden><kbd>E</kbd><span></span></div>
      <div class="use" hidden><div class="ring"></div><span class="label"></span></div>`;
    parent.appendChild(root);
    const $ = (s) => root.querySelector(s);
    this.el = {
      num: $('.num'), hp: $('.bar.hp b'), ghost: $('.bar.hp i'), armour: $('.armour'), tier: $('.tier'), anum: $('.anum'), ar: $('.bar.ar'), arFill: $('.bar.ar b'),
      chips: Object.fromEntries([...root.querySelectorAll('.chip')].map((c) => [c.dataset.id, c])),
      prompt: $('.prompt'), promptText: $('.prompt span'), use: $('.use'), ring: $('.use .ring'), useLabel: $('.use .label'),
    };
    this.ghost = 1;
    this.last = {};
    const icons = itemIcons(CHIPS.map(([id]) => id));
    CHIPS.forEach(([id], i) => { if (icons[i]) this.el.chips[id].querySelector('.ic').style.backgroundImage = `url(${icons[i]})`; });
  }

  #set(key, value, fn) { if (this.last[key] !== value) { this.last[key] = value; fn(value); } }

  update(dt, { vitals, inv, prompt }) {
    const hp = Math.max(0, vitals.hp) / MAX_HP;
    this.ghost = Math.max(hp, this.ghost - dt * 0.5);
    this.el.hp.style.width = `${hp * 100}%`;
    this.el.ghost.style.width = `${this.ghost * 100}%`;
    this.#set('hp', Math.ceil(Math.max(0, vitals.hp)), (v) => { this.el.num.textContent = v; });
    this.el.hp.parentElement.classList.toggle('low', hp < 0.35);

    const tier = ARMOUR_TIERS.find((t) => t?.cap === vitals.armourMax);
    this.#set('tier', tier?.tier ?? 0, () => {
      this.el.armour.classList.toggle('none', !tier);
      this.el.tier.textContent = tier ? tier.name : 'No armour';
      this.el.ar.style.setProperty('--tier', tier ? hex(tier.color) : 'transparent');
      this.el.ar.style.setProperty('--cells', String(Math.max(1, (tier?.cap ?? 25) / 25)));
    });
    this.el.arFill.style.width = `${tier ? (vitals.armour / tier.cap) * 100 : 0}%`;
    this.#set('anum', tier ? `${Math.ceil(vitals.armour)} / ${tier.cap}` : '', (v) => { this.el.anum.textContent = v; });

    for (const [id] of CHIPS) {
      this.#set(`c-${id}`, inv.counts[id], (n) => {
        const c = this.el.chips[id];
        c.querySelector('b').textContent = n;
        c.classList.toggle('empty', !n);
      });
    }

    this.#set('prompt', prompt ?? '', (t) => { this.el.prompt.hidden = !t; this.el.promptText.textContent = t; });

    const a = inv.action;
    const use = a && a.kind !== 'throw';
    this.el.use.hidden = !use;
    if (use) {
      this.el.ring.style.setProperty('--p', `${THREE.MathUtils.clamp(a.t / a.time, 0, 1) * 360}deg`);
      this.el.ring.style.setProperty('--c', hex(ITEMS[a.id].kind === 'charge' ? ITEMS.charger.accent : 0xd97757));
      this.#set('useLabel', `${ITEMS[a.id].name} · ${Math.max(0, a.time - a.t).toFixed(1)}s`, (t) => { this.el.useLabel.textContent = t; });
    }
  }
}
