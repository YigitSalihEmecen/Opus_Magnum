import * as THREE from 'three';
import { Avatar, raySegment } from '../../character/avatar.js';

export { raySegment };
import { characterById } from '../../character/characters.js';
import { ZONE } from '../../weapons/weapons.js';
import { findAttachment } from '../../weapons/attachments.js';
import { soakArmour } from '../../items/items.js';

/*
  TDM bot: an Avatar (character/avatar.js) driven by a layered brain, cheap enough for ten of them.

  Senses (5–8 Hz, staggered): sight needs a line to the head or body; inside the view cone an enemy isn't
  known at once — awareness builds, fast in the centre of view and up close, slow at the edge and far off, so
  a bot can be caught off guard. Gunfire and footsteps are heard; being hit gives the shooter away. Whatever a
  bot sees goes on its team's board (tactics.js) for the others.

  Goals (utility scores, re-weighed each think; the current one gets a bonus so bots don't dither):
    fight   take a spot with cover and a line of fire (tactics.find), then work it: rise or step out, a burst
            or two, back into cover, now and then move to a new spot; no cover close up → strafe it out
    hide    hurt or outgunned: break line of sight, crouch, let health come back
    reload  empty-ish with a threat around: reload in cover rather than in the open
    flank   a teammate is in a fight: go round to a wide angle on that enemy, on a path that avoids danger
    hunt    chase the last sighting (where it was heading), a noise, or the team's intel; check it, give up
    patrol  move between the map's hotspots, drawn toward fresh intel, apart from teammates

  Body: accelerates instead of snapping, sprints on long moves (and slides into cover), walks while
  searching, crouches and leans (Avatar.poseTarget / side) when peeking.

  Aim (deliberately human, and worse than it was): a reaction delay before it moves onto a new target, a
  first flick with a wide error that overshoots and settles (a damped spring), lag behind a target that
  moves across the view, a constant wobble that grows with range and movement, and recoil climb in a burst.

  Combatant interface (shared with the player proxy in tdm.js):
    team · alive · name · pos (feet) · vel · facing · eye(out) · aimPoint(head, out) · hitTest(ray) · takeDamage(...)
*/

const REGEN_DELAY = 5, REGEN_RATE = 30;
const EYE = 1.62;
const D2R = Math.PI / 180;
const SPEED = { sprint: 6.0, run: 4.6, walk: 2.4, strafe: 3.3, crouch: 1.9 };
const ACCEL = 22; // m/s²: weight in starts, stops and direction changes
// aim: the knobs. react (s) and err (deg) shrink with skill; freq / zeta shape the flick (zeta < 1: overshoot)
const AIM = { react: [0.32, 0.58], err: 14, errSkill: 5, freq: 7, zeta: 0.5, lag: 0.45, wobble: 0.42, recoil: 0.35, head: [0.04, 0.2] };

// any arsenal gun, by kind: how bots fire it (bursts, the range they like, how long a reload takes)
const KIND = {
  Carbine: { burst: [4, 9], range: [9, 30], spread: 1.1, reload: 2.3 },
  SMG: { burst: [6, 13], range: [4, 16], spread: 1.8, reload: 1.9 },
  Pistol: { burst: [2, 4], range: [4, 18], spread: 1.5, reload: 1.6 },
  Shotgun: { burst: [1, 1], range: [2, 9], spread: 0.6, reload: 3 },
  Sniper: { burst: [1, 1], range: [15, 60], spread: 0.3, reload: 2.8 },
  Scout: { burst: [1, 1], range: [12, 45], spread: 0.4, reload: 2.4 },
  Marksman: { burst: [1, 3], range: [12, 45], spread: 0.6, reload: 2.4 },
  Revolver: { burst: [1, 2], range: [4, 20], spread: 1.2, reload: 2.2 },
};

/** A bot's gun from an arsenal weapon (online, every round hands out a different one). */
export function botGun(def) {
  const st = def.stats, k = KIND[def.kind] ?? KIND.Carbine;
  const mag = st.magSize ?? findAttachment('mag', def.defaults?.mag)?.stats?.magSize ?? 30;
  return { label: def.name, model: def.id, rpm: st.rpm, dmg: st.damage, head: st.headMultiplier ?? 1.5, mag, reload: k.reload, spread: k.spread, burst: k.burst, range: k.range, sample: def.sound, pellets: st.pellets, pelletSpread: st.pelletSpread };
}

export const BOT_GUNS = {
  rifle: { label: 'Carbine', model: 'panther', rpm: 600, dmg: 15, head: 1.6, mag: 30, reload: 2.3, spread: 1.1, burst: [4, 9], range: [9, 30], sample: 'fire' },
  smg: { label: 'SMG', model: 'snake', rpm: 860, dmg: 11, head: 1.5, mag: 32, reload: 1.9, spread: 1.8, burst: [6, 13], range: [4, 16], sample: 'smgFire' },
};

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _dir = new THREE.Vector3(), _want = new THREE.Vector3();
const _ray = new THREE.Ray();
const _known = [];
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const randn = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const rr = (a, b) => a + Math.random() * (b - a);
const yawTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export class Bot extends Avatar {
  /** gun: a BOT_GUNS key, or weapon: an arsenal weapon (online). */
  constructor(world, { team, name, gun, weapon, skill, char = 'rivet' }) {
    const g = weapon ? botGun(weapon) : BOT_GUNS[gun];
    super({ team, name, char, weapon: g.model, reloadTime: g.reload });
    Object.assign(this, { world, skill });
    const ch = characterById(char);
    this.maxHp = ch.hp;
    this.pace = ch.pace;
    this.gun = g;
    this.aggr = rr(0.3, 0.9); // personality: pushes, flanks and peeks more, hides less
    this.poseTarget = { crouch: 0, slide: 0, ads: 0, mantle: 0, air: 0 };
    this.crouchAmt = 0;
  }

  // ── combatant interface (facing · eye · aimPoint · hitTest come from Avatar) ──

  /** Switch guns (online: each round's weapon), full magazine. */
  setWeapon(def) {
    this.gun = botGun(def);
    this.reloadTime = this.gun.reload;
    this.holdWeapon(def);
    this.ammo = this.gun.mag;
    this.reloadT = 0;
  }

  /** weapon: what did it (an arsenal id, 'fist', 'grenade'), for the kill feed. */
  takeDamage(dmg, zone, attacker, dir, weapon) {
    if (!this.alive) return false;
    const { lost, armour } = soakArmour(this, dmg);
    this.lastArmour = armour;
    this.hp -= lost;
    this.hurt(dmg, attacker);
    if (this.hp <= 0) {
      this.#die(attacker, zone === 'head', dir, weapon);
      return true;
    }
    return false;
  }

  /** Being hit (health already taken off, here or by the match server): flinch, and turn on the shooter. */
  hurt(dmg, attacker) {
    this.lastHurt = this.world.now;
    this.pain += dmg;
    this.flash = 0.08;
    // flinch: a hit knocks the aim, the spring brings it back
    this.errV.x += randn() * 22 * D2R;
    this.errV.y += Math.abs(randn()) * 16 * D2R;
    if (attacker && attacker.alive && attacker !== this) this.#notice(attacker, true);
  }

  /** Gunplay (the player's guns) talks to hitboxes through this; allies take no friendly fire. Online the hit
   *  goes to the match server (world.netHit), which owns everyone's health. */
  damage(amount, zone, point, dir, now, weapon) {
    if (!this.alive || this.team === 'ally') return null;
    if (this.world.netHit) return this.world.netHit(this, amount, zone, weapon);
    const before = this.hp + this.armour;
    const killed = this.takeDamage(amount, zone, this.world.player, dir, weapon);
    this.world.noteDealt?.(this, before - Math.max(0, this.hp) - this.armour);
    return { killed, armour: this.lastArmour };
  }

  // ── lifecycle ──

  spawn(at) {
    this.pos.copy(at.position);
    this.pos.y = this.world.nav.heightAt(this.pos.x, this.pos.z, at.position.y);
    this.vel.set(0, 0, 0);
    this.yaw = this.aimYaw = at.yaw;
    this.aimPitch = 0;
    this.hp = this.maxHp;
    this.armourMax = this.armour = this.world.spawnArmour?.() ?? 0;
    this.alive = true;
    this.lastHurt = -99;
    this.pain = 0;
    this.flash = 0;
    this.deathT = 0;
    // senses
    this.target = null;
    this.visible = false;
    this.headOnly = false;
    this.aware = new Map();
    this.lastSeen = new THREE.Vector3();
    this.seenVel = new THREE.Vector3();
    this.lastSeenT = -99;
    this.lastThink = this.world.now;
    this.heard = null;
    this.hurtBy = null;
    // goals
    this.goal = null;
    this.goalT = 0;
    this.sub = null;
    this.spot = null;
    this.dest = null;
    this.path = null;
    this.pending = null;
    this.mode = 'run';
    this.look = null;
    this.thinkT = Math.random() * 0.2;
    // aim
    this.reactT = 0;
    this.err = new THREE.Vector2();
    this.errV = new THREE.Vector2();
    this.noise = new THREE.Vector2();
    this.prevTy = undefined;
    this.aimHead = false;
    // gun
    this.ammo = this.gun.mag;
    this.reloadT = 0;
    this.cooldown = 0;
    this.burstLeft = 0;
    this.pauseT = 0;
    this.lineT = 0;
    // body
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeT = 0;
    this.hopY = 0;
    this.hopV = 0;
    this.slideT = 0;
    this.climb = null;
    this.crouchWant = 0;
    this.leanWant = 0;
    this.side = 0;
    this.crouchAmt = 0;
    this.glanceT = 0;
    this.glance = 0;
    this.stuckT = 0;
    this.lastProgress = this.pos.clone();
    this.root.visible = true;
    this.root.rotation.set(0, this.yaw, 0);
    this.body.rotation.set(0, 0, 0);
    this.body.position.y = 0;
    this.#setGoal('patrol');
  }

  #die(killer, head, dir, weapon) {
    this.fall(dir);
    this.world.onKill(killer, this, head, weapon);
  }

  /** Down (dir: the way the shot travelled). Online the server says when, through this. */
  fall(dir) {
    this.alive = false;
    this.deathT = 0;
    this.fallDir = dir ? Math.atan2(dir.x, dir.z) - this.yaw : Math.PI;
    this.reloadT = 0;
    if (this.spot) this.spot.p.claim = null;
    this.world.tactics.died(this.team, this.pos);
  }

  // ── per frame ──

  update(dt) {
    const now = this.world.now;
    if (!this.alive) { this.animateDeath(dt); return; }
    if (!this.world.netHit && now - this.lastHurt > REGEN_DELAY) this.hp = Math.min(this.maxHp, this.hp + REGEN_RATE * dt);
    this.pain *= Math.exp(-dt / 1.5);

    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = rr(0.12, 0.2);
      this.#perceive(now);
      this.#decide(now);
    }
    this.goalT += dt;
    this.crouchWant = 0;
    this.leanWant = 0;
    this.look = null;
    _want.set(0, 0, 0);
    if (this.climb) this.#climb(dt);
    else {
      this.#act(dt, now);
      this.#move(dt);
    }
    this.#aim(dt);
    if (!this.climb) this.#shoot(dt, now);
    this.#pose(dt);
    this.animateLod(dt, this.world.camera);
  }

  // ── senses ──

  #perceive(now) {
    const since = Math.min(0.5, now - this.lastThink);
    this.lastThink = now;
    const eye = this.eye(_v3);
    let best = null, bestScore = Infinity, bestHeadOnly = false;
    for (const e of this.world.enemiesOf(this.team)) {
      if (!e.alive) { this.aware.delete(e); continue; }
      const d = flat(e.pos, this.pos);
      let a = this.aware.get(e) ?? 0;
      const known = e === this.target && now - this.lastSeenT < 2;
      const off = Math.abs(wrap(yawTo(this.pos, e.pos) - this.aimYaw));
      const fade = () => { if (a > 0) this.aware.set(e, Math.max(0, a - since * 0.6)); };
      if (d > 85 || (off > 100 * D2R && d > 3 && !known)) { fade(); continue; }
      const body = this.world.los(eye, e.aimPoint(false, _v));
      const head = body || this.world.los(eye, e.aimPoint(true, _v));
      if (!head) { fade(); continue; }
      if (!known) {
        // awareness: fast in the middle of the view and up close, slow at the edge and far; movement draws the eye
        const centre = off < 25 * D2R ? 5 : off < 60 * D2R ? 2.4 : 1;
        const rate = centre * (0.6 + 9 / (d + 6)) * (e.vel && e.vel.lengthSq() > 4 ? 1.4 : 1) * (0.75 + 0.5 * this.skill) * (body ? 1 : 0.6);
        a = Math.min(1.5, a + rate * since);
        this.aware.set(e, a);
        if (a < 1) continue;
      }
      const score = d - (e === this.target ? 10 : 0) - (e === this.hurtBy && now - this.lastHurt < 2 ? 8 : 0);
      if (score < bestScore) { bestScore = score; best = e; bestHeadOnly = !body; }
    }
    this.visible = !!best;
    this.headOnly = bestHeadOnly;
    if (best) {
      if (best !== this.target || now - this.lastSeenT > 1.5) this.#acquire(best, now);
      this.lastSeen.copy(best.pos);
      this.seenVel.copy(best.vel ?? _v.set(0, 0, 0)).setY(0);
      this.lastSeenT = now;
      this.world.tactics.report(this.team, best, now);
    }
  }

  #acquire(target, now) {
    const fresh = now - this.lastSeenT > 3;
    const off = Math.abs(wrap(yawTo(this.pos, target.pos) - this.aimYaw));
    this.target = target;
    const s = this.skill;
    // reaction: slower caught off guard or turned away, quicker when already in the fight
    this.reactT = rr(...AIM.react) * (1.15 - 0.35 * s) * (fresh ? 1 : 0.5) * (off > 45 * D2R ? 1.25 : 1);
    // the flick lands wide (mostly sideways, a little low) and the spring settles it
    const err = (AIM.err - AIM.errSkill * s) * D2R * rr(0.6, 1.2) * (fresh ? 1 : 0.5);
    const a = Math.random() * Math.PI * 2;
    this.err.set(Math.cos(a) * err, Math.sin(a) * err * 0.5 - err * 0.2);
    this.errV.set(0, 0);
    this.aimHead = Math.random() < AIM.head[0] + AIM.head[1] * s;
    this.burstLeft = 0;
    this.pauseT = rr(0, 0.15);
  }

  #notice(who, hurt) {
    if (hurt) this.hurtBy = who;
    this.aware.set(who, 1.2);
    if (this.visible && this.target && this.target !== who) return;
    if (this.target !== who) this.#acquire(who, this.world.now);
    this.lastSeen.copy(who.pos);
    this.lastSeenT = this.world.now - (hurt ? 0.2 : 0.8);
  }

  /** Something loud happened at `pos` (gunfire, footsteps). */
  hear(pos, who) {
    if (!this.alive || this.visible) return;
    const blur = Math.min(6, flat(pos, this.pos) * 0.12);
    this.heard = { pos: pos.clone().add(_v.set(rr(-blur, blur), 0, rr(-blur, blur))), who, t: this.world.now };
  }

  // ── goals ──

  #decide(now) {
    const hpK = this.hp / this.maxHp;
    const t = this.target?.alive ? this.target : null;
    const age = now - this.lastSeenT;
    const threat = t && age < 6;
    const intel = this.world.tactics.known(this.team, now, _known);
    const g = this.gun;
    const S = {};
    S.fight = this.visible ? 0.8 : t && age < 1.6 ? 0.62 : 0;
    S.hide = 0;
    if (threat && hpK < 0.4) S.hide = 1.25 - hpK - 0.3 * this.aggr;
    else if (this.visible && hpK < 0.7 && this.pain > 45) S.hide = 0.9 - 0.3 * this.aggr;
    S.reload = this.ammo === 0 ? 0.92 : threat && !this.visible && this.ammo < g.mag * 0.35 ? 0.72 : 0;
    S.hunt = 0;
    if (!this.visible && threat) S.hunt = 0.55;
    else if (this.heard && now - this.heard.t < 6) S.hunt = 0.45 + 0.1 * this.aggr;
    else if (intel.length) S.hunt = 0.3 + 0.15 * this.aggr;
    S.flank = 0;
    const k = intel[0];
    if (!this.visible && k && now - k.t < 2.5 && hpK > 0.6 && k.enemy !== t) {
      const d = flat(k.pos, this.pos);
      let flankers = 0;
      for (const o of this.world.bots) if (o !== this && o.team === this.team && o.alive && o.goal === 'flank') flankers++;
      if (d > 10 && d < 50 && flankers < 2) S.flank = 0.4 + 0.3 * this.aggr;
    }
    S.patrol = 0.2;
    if (this.goal) S[this.goal] += 0.12;
    let best = 'patrol';
    for (const key in S) if (S[key] > S[best]) best = key;
    if (best !== this.goal) this.#setGoal(best);
  }

  #setGoal(goal) {
    if (this.spot && goal !== this.goal) { this.spot.p.claim = null; this.spot = null; }
    this.goal = goal;
    this.goalT = 0;
    this.sub = null;
    this.path = null;
    this.dest = null;
    this.pending = null;
    this.findT = 0;
  }

  /** Threats for position evaluation: the target first, then what the team knows nearby. */
  #threats() {
    const list = [];
    const add = (enemy, pos) => {
      if (list.length >= 3 || list.some((t) => t.enemy === enemy)) return;
      const eye = (enemy === this.target && this.visible ? enemy.eye(new THREE.Vector3()) : pos.clone().setY(pos.y + 1.5));
      list.push({ enemy, pos: pos.clone(), eye, facing: enemy.facing });
    };
    if (this.target?.alive) add(this.target, this.visible ? this.target.pos : this.lastSeen);
    for (const k of this.world.tactics.known(this.team, this.world.now, _known)) if (flat(k.pos, this.pos) < 40) add(k.enemy, k.pos);
    return list;
  }

  #act(dt, now) {
    switch (this.goal) {
      case 'fight': return this.#fight(dt, now);
      case 'hide': return this.#hide(dt, now);
      case 'reload': return this.#reloadInCover(dt, now);
      case 'flank': return this.#flank(dt, now);
      case 'hunt': return this.#hunt(dt, now);
      default: return this.#patrol(dt, now);
    }
  }

  #fight(dt, now) {
    const t = this.target;
    if (!t?.alive) return;
    const tp = this.visible ? t.pos : this.lastSeen;
    const d = flat(tp, this.pos);
    // close quarters or nowhere better: strafe it out
    if (d < 7 || this.sub === 'free') return this.#strafe(dt, tp, d);

    // find a spot (again when the fight has moved away from the one we have)
    this.findT -= dt;
    const stale = this.spot && (flat(this.spot.from, tp) > 7 || (this.sub === 'hold' && this.cycles <= 0));
    if ((!this.spot || stale) && this.findT <= 0) {
      const threats = this.#threats();
      // push: the bold, the long fight and a hurt target draw the next spot closer
      const push = THREE.MathUtils.clamp(this.aggr * 0.6 + (t.hp < t.maxHp * 0.5 ? 0.35 : 0) + Math.min(0.4, this.goalT / 40), 0, 1);
      const [near, far] = this.gun.range;
      const r = this.world.tactics.find(this, 'fight', threats, { radius: 14, near, far: THREE.MathUtils.lerp(far, near + 4, push), avoid: stale ? this.spot.p : null });
      if (r) {
        if (this.spot) this.spot.p.claim = null;
        this.spot = { ...r, from: tp.clone() };
        this.sub = 'move';
        this.cycles = 2 + ((Math.random() * 3) | 0);
        this.#go(_v.set(r.p.x, r.p.y, r.p.z), 'run');
      } else if (this.world.tactics.budget > 0 || !this.spot) {
        this.findT = 0.6;
        if (!this.spot) return this.#strafe(dt, tp, d);
      }
    }
    if (!this.spot) return this.#strafe(dt, tp, d);

    const p = this.spot.p;
    if (this.sub === 'move') {
      if (this.#follow(dt, this.visible ? 'run' : 'sprint', 2.8)) { this.sub = 'hold'; this.beat = 'out'; this.beatT = rr(1, 2.2); }
      if (!this.visible) this.look = this.lastSeen;
      return;
    }
    // hold: out (shooting) ↔ in (cover), a few times, then move on
    const cover = this.world.tactics.coverFrom(p, tp.x, tp.z);
    this.beatT -= dt;
    if (this.beatT <= 0) {
      if (this.beat === 'out') { this.beat = 'in'; this.beatT = rr(0.5, 1.3) * (1.3 - 0.6 * this.aggr) * (this.reloadT > 0 ? 2 : 1); }
      else { this.beat = 'out'; this.beatT = rr(0.9, 2.3); this.cycles--; }
    }
    // pinned: took a lot while out → duck now
    if (this.beat === 'out' && this.pain > 40 && cover) { this.beat = 'in'; this.beatT = rr(0.8, 1.5); this.pain *= 0.5; }
    let hx = p.x, hz = p.z;
    if (cover === 2 && this.spot.peek && this.beat === 'out') {
      // step out from the corner toward the open side and lean around it
      const dx = tp.x - p.x, dz = tp.z - p.z, l = Math.hypot(dx, dz) || 1;
      hx += (-dz / l) * 0.9 * this.spot.peek;
      hz += (dx / l) * 0.9 * this.spot.peek;
      this.leanWant = this.spot.peek; // the open side, as the bot faces the threat (+1 right)
    }
    if (cover === 1 && this.beat === 'in') this.crouchWant = 1;
    if (!cover) {
      // a firing spot with nothing to hide behind: keep moving on it
      if (this.beat === 'in') this.crouchWant = Math.random() < 0.02 ? 1 : this.crouchWant;
      return this.#strafe(dt, tp, d, 2.2);
    }
    const dx = hx - this.pos.x, dz = hz - this.pos.z, dl = Math.hypot(dx, dz);
    if (dl > 0.12) _want.set(dx, 0, dz).normalize().multiplyScalar(Math.min(SPEED.strafe, dl * 6));
    if (this.beat === 'in' && this.ammo < this.gun.mag * 0.6 && this.reloadT <= 0) this.#reload();
    if (!this.visible) this.look = this.lastSeen;
  }

  /** ADAD across the line of fire, opening or closing to the gun's range (around a spot when `leash` is given). */
  #strafe(dt, tp, d, leash) {
    this.strafeT -= dt;
    if (this.strafeT <= 0) {
      this.strafeDir = Math.random() < 0.72 ? -this.strafeDir : this.strafeDir;
      this.strafeT = rr(0.3, 1.0) * (1.35 - this.skill * 0.5);
      if (Math.random() < 0.08 + 0.1 * this.aggr && this.hopY === 0 && d < 15) this.hopV = 3.6;
      this.crouchBurst = Math.random() < 0.12 ? rr(0.3, 0.8) : 0;
    }
    if (this.crouchBurst > 0) { this.crouchBurst -= dt; this.crouchWant = 1; }
    const to = _v.subVectors(tp, this.pos).setY(0).normalize();
    _want.set(-to.z, 0, to.x).multiplyScalar(this.strafeDir);
    const [near, far] = this.gun.range;
    if (d > far) _want.addScaledVector(to, 0.8);
    else if (d < near) _want.addScaledVector(to, -0.6);
    if (leash && this.spot) {
      const bx = this.spot.p.x - this.pos.x, bz = this.spot.p.z - this.pos.z;
      if (Math.hypot(bx, bz) > leash) _want.x += bx * 0.5, _want.z += bz * 0.5;
    }
    _want.normalize().multiplyScalar(this.crouchWant ? SPEED.crouch : this.reloadT > 0 ? SPEED.strafe * 1.2 : SPEED.strafe);
    if (!this.visible) this.look = this.lastSeen;
  }

  #hide(dt, now) {
    const t = this.target;
    if (!this.sub) {
      const threats = this.#threats();
      if (!threats.length) { this.sub = 'wait'; return; }
      const r = this.world.tactics.find(this, 'hide', threats, { radius: 15 });
      if (!r) {
        // out of budget this frame: back off meanwhile
        if (t) { _want.subVectors(this.pos, t.pos).setY(0).normalize().multiplyScalar(SPEED.run); this.look = this.lastSeen; }
        return;
      }
      this.spot = { ...r, from: (t?.pos ?? this.pos).clone() };
      this.sub = 'move';
      this.#go(_v.set(r.p.x, r.p.y, r.p.z), 'sprint');
    }
    if (this.sub === 'move') {
      if (this.#follow(dt, 'sprint', 3.5)) this.sub = 'wait';
      return;
    }
    // in cover: crouch, top up, watch the way they'd come
    this.crouchWant = 1;
    if (this.ammo < this.gun.mag * 0.8 && this.reloadT <= 0) this.#reload();
    this.look = this.lastSeen;
  }

  #reloadInCover(dt, now) {
    if (this.reloadT <= 0 && this.ammo < this.gun.mag) this.#reload();
    if (!this.sub) {
      const threats = this.#threats();
      const r = threats.length && this.world.tactics.find(this, 'hide', threats, { radius: 8 });
      if (r) { this.spot = { ...r, from: this.pos.clone() }; this.sub = 'move'; this.#go(_v.set(r.p.x, r.p.y, r.p.z), 'run'); }
      else if (this.world.tactics.budget > 0) this.sub = 'stay';
    }
    if (this.sub === 'move' && this.#follow(dt, 'run')) this.sub = 'stay';
    if (this.sub === 'stay') this.crouchWant = 1;
    this.look = this.lastSeen;
    if (this.reloadT <= 0 && this.ammo === this.gun.mag) this.#setGoal('patrol');
  }

  #flank(dt, now) {
    const k = this.world.tactics.known(this.team, now, _known)[0];
    if (!k) return this.#setGoal('patrol');
    if (!this.sub) {
      const r = this.world.tactics.find(this, 'flank', [{ enemy: k.enemy, pos: k.pos, eye: k.pos.clone().setY(k.pos.y + 1.5), facing: k.enemy.facing }], { radius: 28, near: 8, far: 22 });
      if (!r) { if (this.world.tactics.budget > 0) this.#setGoal('hunt'); return; }
      this.spot = { ...r, from: k.pos.clone() };
      this.sub = 'move';
      this.#go(_v.set(r.p.x, r.p.y, r.p.z), 'sprint', 2.5);
    }
    if (this.sub === 'move') {
      // quieter on the last stretch
      const close = this.dest && flat(this.dest, this.pos) < 8;
      if (this.#follow(dt, close ? 'run' : 'sprint')) this.sub = 'watch';
      if (close) this.look = k.pos;
      return;
    }
    this.look = k.pos;
    this.crouchWant = this.world.tactics.coverFrom(this.spot.p, k.pos.x, k.pos.z) === 1 ? 1 : 0;
    if (this.goalT > 9) this.#setGoal('hunt');
  }

  #hunt(dt, now) {
    if (!this.sub) {
      let p = null;
      const t = this.target;
      if (t?.alive && now - this.lastSeenT < 6) {
        // where it was heading, not just where it was
        const lead = Math.min(2.5, now - this.lastSeenT);
        p = _v2.copy(this.lastSeen).addScaledVector(this.seenVel, lead);
        this.huntLook = this.lastSeen.clone();
      } else if (this.heard && now - this.heard.t < 6) {
        p = _v2.copy(this.heard.pos);
        this.huntLook = this.heard.pos.clone();
        this.heard = null;
      } else {
        const k = this.world.tactics.known(this.team, now, _known)[0];
        if (k) { p = _v2.copy(k.pos).addScaledVector(k.vel, Math.min(2, now - k.t)); this.huntLook = k.pos.clone(); }
      }
      if (!p) return this.#setGoal('patrol');
      const n = this.world.nav.nearestNode(p.x, p.z, p.y, 5);
      if (n >= 0) this.world.nav.nodePos(n, p);
      this.sub = 'move';
      this.#go(p, 'run');
    }
    if (this.sub === 'move') {
      const close = this.dest && flat(this.dest, this.pos) < 10;
      if (this.#follow(dt, close ? 'walk' : 'run')) { this.sub = 'scan'; this.scanT = rr(1.4, 2.6); this.scanYaw = this.aimYaw; }
      if (close || this.goalT < 1.5) this.look = this.huntLook;
      return;
    }
    // look around the spot, then give up on it
    this.scanT -= dt;
    this.lookYaw = this.scanYaw + Math.sin(this.scanT * 2.2) * 1.4;
    if (this.scanT <= 0) {
      this.lastSeenT = Math.min(this.lastSeenT, now - 7);
      this.#setGoal('patrol');
    }
  }

  #patrol(dt, now) {
    if (!this.sub) {
      this.sub = 'move';
      const p = this.#objective(now);
      this.#go(p, flat(p, this.pos) > 22 ? 'sprint' : 'run');
    }
    if (this.sub === 'move') {
      if (this.#follow(dt, this.dest && flat(this.dest, this.pos) > 14 ? 'sprint' : 'run')) {
        this.sub = 'hold';
        this.holdT = rr(0.8, 2.8);
        // watch toward the enemy side of the map or the fresh intel
        const k = this.world.tactics.known(this.team, now, _known)[0];
        this.watch = k ? k.pos.clone() : this.#enemyBase();
      }
      return;
    }
    this.holdT -= dt;
    this.look = this.watch;
    if (this.holdT <= 0) this.sub = null;
  }

  /** Next hotspot: near, toward fresh intel, not where teammates are going, not where we just were. */
  #objective(now) {
    const spots = this.world.arena.hotspots;
    const intel = this.world.tactics.known(this.team, now, _known);
    let best = spots[0], bestS = -Infinity;
    for (const h of spots) {
      let s = -0.035 * flat(h, this.pos) + rr(0, 1.1);
      if (this.lastObjective && flat(h, this.lastObjective) < 4) s -= 2;
      for (const k of intel) s += 1.4 * this.aggr * Math.max(0, 1 - flat(h, k.pos) / 25);
      for (const o of this.world.bots) if (o !== this && o.team === this.team && o.alive && o.dest && flat(o.dest, h) < 8) s -= 1.2;
      s -= 1.5 * this.world.tactics.danger(this.team, h.x, h.z) * (1 - this.aggr);
      if (s > bestS) { bestS = s; best = h; }
    }
    this.lastObjective = best;
    const p = this.world.nav.randomPoint(Math.random, best.x, best.z, 3) ?? best.clone();
    return p;
  }

  #enemyBase() {
    const foe = this.team === 'ally' ? 'enemy' : 'ally';
    return this.world.arena.spawns[foe][0].position.clone();
  }

  // ── getting around ──

  /** Plan a route to p (tactical: around ground the team has been dying on). Paths are rationed per frame. */
  #go(p, mode, caution = 1) {
    this.dest = p.clone();
    this.mode = mode;
    const w = this.world;
    if (w.pathBudget <= 0) { this.pending = caution; this.path = null; return; }
    w.pathBudget--;
    this.pending = null;
    const cost = w.tactics.costFor(this.team);
    this.path = w.nav.path(this.pos.x, this.pos.z, p.x, p.z, this.pos.y, p.y, caution === 1 ? cost : (x, z) => cost(x, z) * caution);
    this.pathIdx = 1;
    this.stuckT = 0;
    this.lastProgress.copy(this.pos);
  }

  /** Walk the path; returns true on arrival. slideAt: slide the last metres in when sprinting. */
  #follow(dt, mode, slideAt = 0) {
    if (this.pending !== null && this.dest) this.#go(this.dest, this.mode, this.pending);
    if (!this.path) return !this.dest || flat(this.dest, this.pos) < 0.8;
    const wp = this.path[Math.min(this.pathIdx, this.path.length - 1)];
    const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z, dl = Math.hypot(dx, dz);
    const last = this.pathIdx >= this.path.length - 1;
    // a ledge on the way (a nav link): mantle up it or hop down it
    if (Math.abs(wp.y - this.pos.y) > 0.7 && dl < 1.5) {
      const up = wp.y > this.pos.y;
      this.climb = { a: this.pos.clone(), b: new THREE.Vector3(wp.x, wp.y, wp.z), t: 0, dur: up ? 0.75 : 0.45, up, path: this.path };
      this.slideT = 0;
      return false;
    }
    if (dl < (last ? 0.45 : 0.8)) {
      this.pathIdx++;
      if (this.pathIdx >= this.path.length) { this.path = null; return true; }
      return false;
    }
    let speed = SPEED[mode] ?? SPEED.run;
    // no sprinting with an enemy in sight: run and shoot
    if (this.visible && mode === 'sprint') speed = SPEED.run;
    // ease into sharp corners and the last stop
    if (!last) {
      const nx = this.path[this.pathIdx + 1];
      const turn = Math.abs(wrap(Math.atan2(nx.x - wp.x, nx.z - wp.z) - Math.atan2(dx, dz)));
      if (dl < 1.6 && turn > 1) speed *= 0.65;
    } else speed = Math.min(speed, 1.2 + dl * 2.2);
    // slide into the spot
    if (slideAt && last && this.slideT <= 0 && mode === 'sprint' && dl < slideAt && dl > 1.5 && this.vel.length() > 5 && Math.random() < 0.3 + 0.5 * this.aggr) {
      this.slideT = 0.75;
      this.slideDir = Math.atan2(dx, dz);
    }
    _want.set(dx / dl, 0, dz / dl).multiplyScalar(speed);
    return false;
  }

  /** Over a ledge: up, the body rises first and then moves on over the top; down, out and then the fall. */
  #climb(dt) {
    const c = this.climb, ss = THREE.MathUtils.smoothstep;
    c.t += dt;
    const k = Math.min(1, c.t / c.dur);
    const kx = c.up ? ss(k, 0.35, 1) : ss(k, 0, 0.55);
    const ky = c.up ? ss(k, 0, 0.6) : (k < 0.3 ? 0 : ((k - 0.3) / 0.7) ** 2);
    this.pos.set(c.a.x + (c.b.x - c.a.x) * kx, c.a.y + (c.b.y - c.a.y) * ky, c.a.z + (c.b.z - c.a.z) * kx);
    this.vel.set((c.b.x - c.a.x) / c.dur, 0, (c.b.z - c.a.z) / c.dur);
    if (k < 1) return;
    this.climb = null;
    this.vel.multiplyScalar(0.5);
    if (this.path === c.path) {
      this.pathIdx++;
      if (this.pathIdx >= this.path.length) this.path = null;
    }
    this.stuckT = 0;
    this.lastProgress.copy(this.pos);
  }

  #move(dt) {
    const nav = this.world.nav;
    // a slide carries its speed and fades out; no steering
    if (this.slideT > 0) {
      this.slideT -= dt;
      const sp = Math.max(1.5, 7 * (this.slideT / 0.75));
      _want.set(Math.sin(this.slideDir), 0, Math.cos(this.slideDir)).multiplyScalar(sp);
      this.vel.x = _want.x; this.vel.z = _want.z;
    } else {
      // keep a little space from teammates
      for (const o of this.world.bots) {
        if (o === this || !o.alive || o.team !== this.team) continue;
        const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z, d2 = dx * dx + dz * dz;
        if (d2 < 1.6 && d2 > 1e-4) { const d = Math.sqrt(d2); _want.x += (dx / d) * (1.3 - d) * 2.5; _want.z += (dz / d) * (1.3 - d) * 2.5; }
      }
      if (this.crouchWant && _want.lengthSq() > SPEED.crouch ** 2) _want.setLength(SPEED.crouch);
      _want.multiplyScalar(this.pace);
      // accelerate toward it, capped: weight in starts, stops and turns
      const ax = _want.x - this.vel.x, az = _want.z - this.vel.z, al = Math.hypot(ax, az), cap = ACCEL * dt;
      const k = al > cap ? cap / al : 1;
      this.vel.x += ax * k;
      this.vel.z += az * k;
    }

    // integrate, sliding along unwalkable cells and walls one axis at a time
    const nx = this.pos.x + this.vel.x * dt, nz = this.pos.z + this.vel.z * dt;
    const h0 = this.pos.y;
    const fits = nav.bodyFits(this.pos.x, this.pos.z, h0); // already brushing a wall: let it step clear
    const ok = (x, z) => nav.walkable(x, z, h0) && Math.abs(nav.heightAt(x, z, h0) - h0) < 0.8 && (!fits || nav.bodyFits(x, z, h0));
    if (ok(nx, nz)) { this.pos.x = nx; this.pos.z = nz; }
    else if (ok(nx, this.pos.z)) { this.pos.x = nx; this.vel.z = 0; }
    else if (ok(this.pos.x, nz)) { this.pos.z = nz; this.vel.x = 0; }
    else { this.vel.set(0, 0, 0); this.strafeDir *= -1; this.slideT = 0; }
    this.pos.y = damp(this.pos.y, this.#ground(), 20, dt);

    // stuck on the way somewhere: replan, or give up on it
    if (this.path) {
      this.stuckT += dt;
      if (this.stuckT > 1.3) {
        if (this.pos.distanceTo(this.lastProgress) < 0.5 && this.dest) {
          this.stuck = (this.stuck ?? 0) + 1;
          if (this.stuck > 2) { this.stuck = 0; this.#setGoal(this.goal); }
          else this.#go(this.dest, this.mode);
        } else this.stuck = 0;
        this.stuckT = 0;
        this.lastProgress.copy(this.pos);
      }
    }

    if (this.hopV || this.hopY > 0) {
      this.hopV -= 18 * dt;
      this.hopY = Math.max(0, this.hopY + this.hopV * dt);
      if (this.hopY === 0) this.hopV = 0;
    }
  }

  /** The floor under the feet: the real surface (slopes, stairs), the nav cell's height if the ray finds none. */
  #ground() {
    const nav = this.world.nav, y = nav.heightAt(this.pos.x, this.pos.z, this.pos.y);
    _ray.origin.set(this.pos.x, Math.max(this.pos.y, y) + 0.7, this.pos.z);
    _ray.direction.set(0, -1, 0);
    const hit = this.world.octree.rayIntersect(_ray);
    if (!hit || hit.distance > 1.6 || hit.triangle.getNormal(_v).y < 0.5) return y;
    return _ray.origin.y - hit.distance;
  }

  #pose(dt) {
    const p = this.poseTarget;
    p.slide = this.slideT > 0 ? 1 : 0;
    p.mantle = this.climb?.up ? 1 : 0;
    p.air = this.climb && !this.climb.up ? 1 : 0;
    p.crouch = this.slideT > 0 ? 0 : this.crouchWant;
    // aiming down the sights when standing still-ish and shooting at range
    p.ads = this.visible && this.reactT <= 0 && this.wantDist > 12 && this.vel.lengthSq() < 9 ? 1 : 0;
    this.crouchAmt = damp(this.crouchAmt, Math.max(p.crouch, p.slide * 0.8), 10, dt);
    this.side = damp(this.side, this.leanWant, 10, dt);
  }

  // ── aim and gun ──

  #aim(dt) {
    let yaw, pitch = 0;
    const t = this.target;
    const tracking = this.visible && t?.alive;
    if (tracking && this.reactT <= 0) {
      const p = t.aimPoint(this.aimHead || this.headOnly, _v);
      const e = this.eye(_v2);
      const dx = p.x - e.x, dy = p.y - e.y, dz = p.z - e.z;
      const d = Math.hypot(dx, dz);
      const ty = Math.atan2(dx, dz), tp = Math.atan2(dy, d);
      const s = this.skill;
      // the error rides a damped spring: the first flick overshoots and settles, hits and recoil kick it
      const w = AIM.freq * (0.8 + 0.5 * s), z = AIM.zeta;
      this.errV.x += (-w * w * this.err.x - 2 * z * w * this.errV.x) * dt;
      this.errV.y += (-w * w * this.err.y - 2 * z * w * this.errV.y) * dt;
      this.err.x += this.errV.x * dt;
      this.err.y += this.errV.y * dt;
      // tracking lag: the aim trails a target crossing the view
      if (this.prevTy !== undefined) this.err.x -= wrap(ty - this.prevTy) * AIM.lag * (1 - 0.4 * s);
      this.prevTy = ty;
      // wobble (OU noise): worse far away, moving, hurt; better crouched
      const moving = this.vel.lengthSq() > 4 ? 1.3 : 1;
      const sigma = AIM.wobble * (1 - 0.35 * s) * D2R * (1 + d / 50) * moving * (this.crouchAmt > 0.5 ? 0.8 : 1) * (1 + this.pain / 80);
      this.noise.x += -this.noise.x * 4 * dt + randn() * sigma * Math.sqrt(8 * dt);
      this.noise.y += -this.noise.y * 4 * dt + randn() * sigma * 0.7 * Math.sqrt(8 * dt);
      yaw = ty + this.err.x + this.noise.x;
      pitch = tp + this.err.y + this.noise.y;
      this.wantYaw = ty; this.wantPitch = tp; this.wantDist = d;
    } else {
      if (tracking) this.reactT -= dt;
      this.prevTy = undefined;
      const look = this.look ?? (this.goal === 'fight' ? this.lastSeen : null);
      if (this.lookYaw !== undefined && this.goal === 'hunt' && this.sub === 'scan') yaw = this.lookYaw;
      else if (look) yaw = yawTo(this.pos, look);
      else if (this.vel.lengthSq() > 0.5) yaw = Math.atan2(this.vel.x, this.vel.z);
      else yaw = this.aimYaw;
      // glance about on the move
      this.glanceT -= dt;
      if (this.glanceT <= 0) { this.glanceT = rr(1, 2.6); this.glance = Math.random() < 0.5 ? 0 : rr(-0.8, 0.8); }
      if (!look && this.sub !== 'scan') yaw += this.glance;
    }
    const turn = tracking && this.reactT <= 0 ? 14 : this.slideT > 0 ? 3 : 7;
    this.aimYaw += wrap(yaw - this.aimYaw) * (1 - Math.exp(-turn * dt));
    this.aimPitch = damp(this.aimPitch, THREE.MathUtils.clamp(pitch, -0.9, 0.9), turn, dt);
  }

  #reload() {
    if (this.reloadT > 0 || this.ammo >= this.gun.mag) return;
    this.reloadT = this.gun.reload * rr(0.95, 1.15);
    this.burstLeft = 0;
  }

  #shoot(dt, now) {
    const g = this.gun;
    this.cooldown -= dt;
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) this.ammo = g.mag;
      return;
    }
    if (this.ammo <= 0) return this.#reload();
    // top up between fights
    if (!this.visible && this.ammo < g.mag * 0.5 && now - this.lastSeenT > 2.5) return this.#reload();

    const t = this.target;
    const hold = this.goal === 'fight' && this.sub === 'hold' && this.beat === 'in';
    if (!this.visible || !t?.alive || this.reactT > 0 || hold || this.slideT > 0.2) { this.burstLeft = 0; return; }
    if (this.pauseT > 0) { this.pauseT -= dt; return; }

    // only pull the trigger once roughly on target, and with a clear line to it (sight is only rechecked a few
    // times a second: a target that just ducked isn't worth a burst into the crate)
    const off = Math.hypot(wrap(this.aimYaw - this.wantYaw), this.aimPitch - this.wantPitch);
    const tol = Math.atan2(0.5, this.wantDist) + 2 * D2R;
    this.lineT -= dt;
    if (this.burstLeft <= 0 || this.lineT <= 0) {
      this.lineT = 0.12;
      const eye = this.eye(_v3);
      if (!this.world.los(eye, t.aimPoint(this.aimHead || this.headOnly, _v))) {
        if (!this.headOnly && this.world.los(eye, t.aimPoint(true, _v))) this.headOnly = true;
        else { this.burstLeft = 0; return; }
      }
    }
    if (this.burstLeft <= 0) {
      if (off > tol) return;
      const far = this.wantDist > 32;
      this.burstLeft = far ? 2 + ((Math.random() * 3) | 0) : (g.burst[0] + Math.random() * (g.burst[1] - g.burst[0])) | 0;
    }
    while (this.cooldown <= 0 && this.burstLeft > 0 && this.ammo > 0) {
      this.cooldown += 60 / g.rpm;
      this.#fire();
      this.burstLeft--;
      this.ammo--;
      // recoil climbs through a burst; the aim spring pulls it back down
      this.errV.y += AIM.recoil * D2R * rr(5, 9) * (1 - 0.3 * this.skill);
      this.errV.x += randn() * AIM.recoil * D2R * 4;
      if (this.burstLeft === 0) this.pauseT = rr(0.18, 0.5) * (1 + this.wantDist / 35);
    }
    if (this.cooldown < -0.1) this.cooldown = 0;
  }

  /** One shot (a shotgun: its pellets), down the aim with the gun's spread. */
  #fire() {
    const g = this.gun;
    const eye = this.eye(new THREE.Vector3());
    const moving = this.vel.lengthSq() > 6;
    const spread = g.spread * D2R * (moving ? 1.6 : 1) * (this.hopY > 0 ? 2 : 1) * (this.crouchAmt > 0.5 && !moving ? 0.8 : 1);
    const cp = Math.cos(this.aimPitch);
    const aim = new THREE.Vector3(Math.sin(this.aimYaw) * cp, Math.sin(this.aimPitch), Math.cos(this.aimYaw) * cp);
    const right = new THREE.Vector3(Math.cos(this.aimYaw), 0, -Math.sin(this.aimYaw));
    const up = new THREE.Vector3().crossVectors(right, aim);
    const n = g.pellets ?? 1;
    let end = null;
    for (let i = 0; i < n; i++) {
      // pellets: the centre one, the rest on a ring of the gun's pellet spread
      const r = n > 1 ? (i ? Math.tan(g.pelletSpread * D2R) : 0) + Math.tan(spread) * Math.random() * 0.5 : Math.tan(spread) * Math.sqrt(Math.random());
      const a = n > 1 ? (i / (n - 1)) * Math.PI * 2 + Math.random() * 0.3 : Math.random() * Math.PI * 2;
      _dir.copy(aim).addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
      _ray.set(eye, _dir);
      const worldHit = this.world.octree.rayIntersect(_ray);
      let best = null, bestD = worldHit ? worldHit.distance : 120;
      for (const e of this.world.enemiesOf(this.team)) {
        const h = e.hitTest(_ray);
        if (h && h.dist < bestD) { bestD = h.dist; best = { e, zone: h.zone }; }
      }
      const at = eye.clone().addScaledVector(_dir, bestD);
      end ??= at;
      if (best) {
        // the same falloff and body-part damage as the player's guns
        const fo = this.weapon.stats.falloff;
        const falloff = fo ? THREE.MathUtils.lerp(1, fo.min, THREE.MathUtils.smoothstep(bestD, fo.start, fo.end)) : 1;
        const dmg = Math.round(g.dmg * falloff * (best.zone === 'head' ? g.head : ZONE[best.zone] ?? 1) * 10) / 10;
        // online the match server applies it (world.hitTarget); here, straight onto the target
        if (this.world.hitTarget) this.world.hitTarget(best.e, dmg, best.zone, this, this.weapon.id);
        else best.e.takeDamage(dmg, best.zone, this, _dir.clone(), this.weapon.id);
      } else if (worldHit && i < 3) {
        this.world.fx.impact(at, worldHit.triangle.getNormal(new THREE.Vector3()));
      }
    }

    this.muzzle.getWorldPosition(_v);
    this.world.fx.tracer(_v, end);
    this.flashT = 0.045;
    this.flashMesh.rotation.z = Math.random() * Math.PI;
    this.world.gunshot(this, _v, aim);
  }
}
