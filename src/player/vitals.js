/*
  Player health and armour. Armour soaks damage before health; its capacity comes from the vest's tier
  (25 / 50 / 75) and chargers refill it. Health regenerates slowly after a quiet spell, so heals matter.
  Online, the server owns these numbers: `sync` receives each change for it to confirm (see net/online.js),
  and server updates come back through set().
*/

export const MAX_HP = 150;
export const REGEN = { delay: 8, rate: 10 };

export class Vitals {
  constructor() {
    this.sync = null;
    this.serverOwned = false;
    this.reset();
  }

  reset() {
    this.hp = MAX_HP;
    this.armour = 0;
    this.armourMax = 0;
    this.quiet = 0;
  }

  get dead() { return this.hp <= 0; }
  get hurt() { return this.hp < MAX_HP; }
  get armourMissing() { return this.armourMax - this.armour; }

  /** Takes a hit; returns the health actually lost (armour soaks first). */
  damage(amount) {
    const soak = Math.min(this.armour, amount);
    this.armour -= soak;
    const lost = Math.min(this.hp, amount - soak);
    this.hp -= lost;
    this.quiet = 0;
    return lost;
  }

  heal(amount) {
    this.hp = Math.min(MAX_HP, this.hp + amount);
    this.sync?.('heal', amount);
  }

  /** Put on a vest: full protection at its capacity. */
  wear(cap) {
    this.armourMax = cap;
    this.armour = cap;
    this.sync?.('wear', cap);
  }

  charge() {
    this.armour = this.armourMax;
    this.sync?.('charge');
  }

  /** Authoritative values from the server. */
  set({ hp, armour, armourMax }) {
    if (hp !== undefined) this.hp = hp;
    if (armour !== undefined) this.armour = armour;
    if (armourMax !== undefined) this.armourMax = armourMax;
  }

  update(dt) {
    this.quiet += dt;
    if (!this.serverOwned && !this.dead && this.quiet > REGEN.delay) this.hp = Math.min(MAX_HP, this.hp + REGEN.rate * dt);
  }
}
