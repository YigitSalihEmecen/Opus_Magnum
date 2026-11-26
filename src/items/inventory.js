import { ITEMS } from './items.js';
import { MAX_HP } from '../player/vitals.js';

/*
  What the player carries: guns (arsenal indices, up to maxGuns), consumables, spare ammo, and the action in
  progress (healing, charging armour, throwing a grenade). Keys:
    Q heal (a bandage for small wounds, the medkit for big ones) · X charge armour · G throw a grenade
    E pick up / swap the weapon or armour you're looking at · T drop the drawn weapon
  Consumables and ammo are picked up by walking over them; guns and armour upgrades take E.
  A mode hands out a loadout through reset(); main.js draws whatever gun the inventory says is held.
*/

export const RESERVE_CAP = 5; // spare mags per gun
export const THROW = { time: 0.85, pin: 0.22, release: 0.52 };

export class Inventory {
  constructor({ arsenal, vitals, audio, hud }) {
    Object.assign(this, { arsenal, vitals, audio, hud });
    this.guns = arsenal.map((_, i) => i);
    this.maxGuns = arsenal.length;
    this.counts = { medkit: 0, bandage: 0, charger: 0, grenade: 0 };
    this.action = null; // { id, kind, t, time, done? }
    this.onThrow = () => {};
    this.onDrop = () => {};
  }

  /** loadout: { guns: [arsenal index], maxGuns, mags (spare mags; Infinity = endless), items: { id: n } } */
  reset({ guns = this.arsenal.map((_, i) => i), maxGuns = guns.length, mags = Infinity, items = {} } = {}) {
    this.guns = [...guns];
    this.maxGuns = Math.max(maxGuns, this.guns.length);
    this.mags = mags;
    for (const k in this.counts) this.counts[k] = Math.min(ITEMS[k].max, items[k] ?? 0);
    for (const { gun } of this.arsenal) { gun.ammo = gun.magSize; gun.reserve = mags === Infinity ? Infinity : mags * gun.magSize; }
    this.action = null;
  }

  get busy() { return !!this.action; }
  carries(i) { return this.guns.includes(i); }
  reserveCap(gun) { return gun.reserve === Infinity ? Infinity : RESERVE_CAP * gun.magSize; }

  // ── pickups ──

  /** 'auto' (walk over it), 'prompt' (needs E), or null (nothing to gain). */
  wants(p) {
    const it = ITEMS[p.type];
    if (p.type === 'gun') {
      if (this.carries(p.gun)) { const g = this.arsenal[p.gun].gun; return g.reserve < this.reserveCap(g) ? 'auto' : null; }
      return 'prompt';
    }
    if (!it) return null;
    switch (it.kind) {
      case 'armour': return this.vitals.armourMax === 0 ? 'auto' : it.cap > this.vitals.armour ? 'prompt' : null;
      case 'ammo': return this.guns.some((i) => { const g = this.arsenal[i].gun; return g.reserve < this.reserveCap(g); }) ? 'auto' : null;
      default: return this.counts[p.type] < it.max ? 'auto' : null;
    }
  }

  /** What E would do with this pickup, for the prompt. */
  promptFor(p) {
    if (p.type === 'gun') {
      const name = this.arsenal[p.gun].gun.def.name;
      return this.guns.length < this.maxGuns ? `Pick up ${name}` : `Swap for ${name}`;
    }
    return `Wear ${ITEMS[p.type].name.toLowerCase()} · ${ITEMS[p.type].cap}`;
  }

  /**
   * Take a pickup (already granted). Returns the arsenal index of a newly carried gun to draw, else null.
   * held: the drawn gun, which a full-handed swap drops (onDrop).
   */
  receive(p, held) {
    const it = ITEMS[p.type];
    this.audio.play('magIn', { volume: 0.5, rate: 1.3 });
    this.audio.play('cloth', { volume: 0.3, rate: 1.2 });
    if (p.type === 'gun') {
      const g = this.arsenal[p.gun].gun;
      if (this.carries(p.gun)) {
        g.reserve = Math.min(this.reserveCap(g), g.reserve + (p.ammo ?? 0) + (p.reserve ?? 0));
        this.hud.toast(`+ ${g.def.name} ammo`);
        return null;
      }
      if (this.guns.length >= this.maxGuns) this.drop(held, { swap: true });
      this.guns.push(p.gun);
      g.ammo = Math.min(g.magSize, p.ammo ?? g.magSize);
      g.reserve = this.mags === Infinity ? Infinity : Math.min(this.reserveCap(g), p.reserve ?? 2 * g.magSize);
      this.hud.toast(g.def.name);
      return p.gun;
    }
    switch (it.kind) {
      case 'armour': this.vitals.wear(it.cap); this.audio.play('magSeat', { volume: 0.6, rate: 0.8 }); break;
      case 'ammo':
        for (const i of this.guns) { const g = this.arsenal[i].gun; g.reserve = Math.min(this.reserveCap(g), g.reserve + it.mags * g.magSize); }
        break;
      default: this.counts[p.type] = Math.min(it.max, this.counts[p.type] + 1);
    }
    this.hud.toast(`+ ${it.name}`);
    return null;
  }

  /** Drop a carried gun (never the last one unless swapping it for another). */
  drop(i, { swap = false } = {}) {
    if (!this.carries(i) || (this.guns.length < 2 && !swap)) return false;
    const g = this.arsenal[i].gun;
    this.guns.splice(this.guns.indexOf(i), 1);
    this.onDrop({ gun: i, ammo: g.ammo, reserve: g.reserve === Infinity ? 2 * g.magSize : g.reserve });
    this.audio.play('cloth', { volume: 0.45, rate: 0.9 });
    return true;
  }

  // ── using items ──

  #start(id) {
    const it = ITEMS[id];
    this.action = { id, kind: it.kind, t: 0, time: it.kind === 'throw' ? THROW.time : it.time };
    this.audio.play('cloth', { volume: 0.4, rate: 1.1 });
  }

  /** Q: a bandage when it covers the wound (or there's no medkit), else the medkit. */
  #healChoice() {
    const missing = MAX_HP - this.vitals.hp;
    const { medkit, bandage } = this.counts;
    if (missing <= 0) return null;
    if (bandage && (missing <= ITEMS.bandage.heal + 10 || !medkit)) return 'bandage';
    return medkit ? 'medkit' : null;
  }

  cancel() {
    if (!this.action || this.action.kind === 'throw') return; // a pulled pin can't go back in
    this.action = null;
  }

  /**
   * Per frame while alive. ctx: { input, blocked } (blocked = mid-mantle, gunsmith, weapon switch).
   * Fire, aim or switching cancels a heal; the item is consumed only when it finishes.
   */
  update(dt, { input, blocked }) {
    const a = this.action;
    if (!a) {
      if (blocked) return;
      if (input.pressed('KeyQ')) {
        const id = this.#healChoice();
        if (id) this.#start(id); else this.hud.toast(this.vitals.hurt ? 'No heals' : 'Health full');
      } else if (input.pressed('KeyX')) {
        if (!this.counts.charger) this.hud.toast('No chargers');
        else if (!this.vitals.armourMax) this.hud.toast('No armour');
        else if (!this.vitals.armourMissing) this.hud.toast('Armour full');
        else this.#start('charger');
      } else if (input.pressed('KeyG')) {
        if (this.counts.grenade) this.#start('grenade'); else this.hud.toast('No grenades');
      }
      return;
    }
    if (a.kind !== 'throw' && (input.clicked(0) || input.clicked(2) || input.wheel || input.pressed('KeyQ') || input.pressed('KeyX'))) { this.cancel(); return; }
    const prev = a.t;
    a.t += dt;
    if (a.kind === 'throw') {
      if (prev < THROW.pin && a.t >= THROW.pin) this.audio.play('click', { volume: 0.6, rate: 1.4 });
      if (prev < THROW.release && a.t >= THROW.release) {
        this.counts.grenade--;
        this.audio.play('cloth', { volume: 0.6, rate: 0.85 });
        this.onThrow();
      }
    }
    if (a.t < a.time) return;
    this.action = null;
    if (a.kind === 'heal') {
      this.counts[a.id]--;
      this.vitals.heal(ITEMS[a.id].heal);
      this.audio.play('magSeat', { volume: 0.4, rate: 1.4 });
    } else if (a.kind === 'charge') {
      this.counts.charger--;
      this.vitals.charge();
      this.audio.play('magSeat', { volume: 0.6, rate: 0.7 });
    }
  }
}
