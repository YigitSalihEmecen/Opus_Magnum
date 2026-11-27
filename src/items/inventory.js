import { ITEMS } from './items.js';

/*
  What the player carries: guns (arsenal indices, up to maxGuns), consumables, spare ammo, and the action in
  progress (healing, charging armour, throwing a grenade). Keys:
    Z item wheel (use(id): bandage, medkit, charger, grenade) · G throw a grenade
    F pick up / swap the weapon or armour you're looking at · T drop the drawn weapon
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

  /** Start using an item (from the wheel), or say why it can't be. */
  use(id) {
    if (this.action) return;
    const it = ITEMS[id];
    if (!this.counts[id]) this.hud.toast(`No ${it.name.toLowerCase()}`);
    else if (it.kind === 'heal' && this.vitals.hp >= this.vitals.max) this.hud.toast('Health full');
    else if (it.kind === 'charge' && !this.vitals.armourMax) this.hud.toast('No armour');
    else if (it.kind === 'charge' && !this.vitals.armourMissing) this.hud.toast('Armour full');
    else this.#start(id);
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
      if (!blocked && input.pressed('KeyG')) this.use('grenade');
      return;
    }
    if (a.kind !== 'throw' && (input.clicked(0) || input.clicked(2) || input.wheel || input.pressed('KeyZ'))) { this.cancel(); return; }
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
