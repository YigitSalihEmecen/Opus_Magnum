import * as THREE from 'three';
import { findAttachment, loadoutStats } from './attachments.js';

const D2R = Math.PI / 180;

const _dir = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

/**
 * Gameplay for one weapon (tuning from its definition in weapons.js): input → fire / ADS / reload,
 * hitscan, spread, recoil, damage. Presentation is delegated to its Viewmodel; sound to the
 * AudioBank; feedback to the HUD.
 */
export class Gunplay {
  constructor(def, { viewmodel, audio, fx, hud, rig }) {
    Object.assign(this, { def, S: def.stats, vm: viewmodel, audio, fx, hud, rig });
    this.loadout = loadLoadout(def);
    for (const slot of def.slots) this.vm.equip(slot, findAttachment(slot, this.loadout[slot]), false);
    this.stats = this.#statsFor(this.loadout);
    this.ammo = this.stats.magSize;
    this.vm.flashScale = this.stats.flash;
    this.pump = !!def.vm.pump;
    this.modes = this.S.modes ?? (this.pump ? ['pump'] : ['auto', 'semi']);
    this.mode = this.modes[0];
    this.burstLeft = 0;
    this.cooldown = 0;
    this.shotIndex = 0;
    this.sinceShot = 99;
    this.ads = 0;
    this.adsEased = 0;
    this.bloom = 0;
    this.spread = this.S.spread.hip;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = this.S.range;
    this.vm.setFireMode(0);
    this.vm.onEvent = (name, data) => this.#onAnimEvent(name, data);
  }

  /** Attachment stats; guns without a mag slot (tube-fed shotgun) keep their own capacity. */
  #statsFor(loadout) {
    const st = loadoutStats(loadout);
    if (!this.def.slots.includes('mag')) st.magSize = this.S.magSize;
    return st;
  }

  /** Called when this weapon is drawn. */
  activate() {
    this.ads = this.adsEased = 0;
    this.hud.setWeapon(this.def.name, this.def.kind);
    this.hud.setMagSize(this.stats.magSize);
    this.hud.setModes(this.modes);
    this.vm.setFireMode(this.modes.indexOf(this.mode));
    this.burstLeft = 0;
    this.loading = null;
    this.vm.playEquip();
  }

  /** Attachment options this weapon accepts for a slot. */
  options(slot) { return this.def.attachments[slot].map((id) => findAttachment(slot, id)); }

  get magSize() { return this.stats.magSize; }
  get zoom() { return this.stats.zoom; }

  /** Swap one attachment (called from the gunsmith). Mag swaps hand you a fresh mag. */
  setAttachment(slot, id) {
    if (this.loadout[slot] === id) return;
    this.loadout = { ...this.loadout, [slot]: id };
    saveLoadout(this.def, this.loadout);
    this.vm.equip(slot, findAttachment(slot, id));
    this.stats = this.#statsFor(this.loadout);
    this.vm.flashScale = this.stats.flash;
    if (slot === 'mag') {
      this.ammo = this.stats.magSize;
      this.vm.boltLocked = false;
      this.hud.setMagSize(this.stats.magSize);
    }
  }

  update(dt, { input, mv, camera, targets, now, blocked = false }) {
    this.cooldown -= dt;
    this.sinceShot += dt;
    if (this.sinceShot > this.S.recoil.resetTime) this.shotIndex = 0;
    this.bloom = Math.max(0, this.bloom - this.S.bloom.recovery * dt);

    const canAct = mv.state !== 'mantle' && !blocked;
    const reloading = this.vm.reloading;

    // ADS
    const wantAds = input.mouse(2) && !reloading && canAct;
    if (wantAds) mv.blockSprint(0.1);
    const step = dt / (this.S.adsTime * this.stats.ads);
    this.ads = THREE.MathUtils.clamp(this.ads + (wantAds ? step : -step * 1.3), 0, 1);
    this.adsEased = this.ads * this.ads * (3 - 2 * this.ads);

    // fire mode
    if (input.pressed('KeyB') && this.modes.length > 1) {
      const i = (this.modes.indexOf(this.mode) + 1) % this.modes.length;
      this.mode = this.modes[i];
      this.vm.setFireMode(i);
      this.audio.play('click', { volume: 0.5, rate: 1.3 });
      this.hud.toast({ auto: 'Full auto', semi: 'Semi auto', burst: 'Three-round burst' }[this.mode]);
    }

    // shell-by-shell loading: a trigger pull stops after the current shell
    if (this.loading && input.clicked(0) && this.ammo > 0) this.loading.stop = true;

    // reload
    if (input.pressed('KeyR') && this.ammo < this.magSize && !reloading && canAct) this.#reload();

    // trigger
    const held = input.mouse(0);
    const pressed = input.clicked(0);
    this.triggerHeld = (held || this.burstLeft > 0) && this.ammo > 0 && !reloading && canAct;
    if (held && canAct) mv.blockSprint(0.3);
    const ready = canAct && !this.vm.busy && this.vm.w.sprint < 0.3;
    if (this.burstLeft > 0) {
      // a burst finishes on its own once started
      if (!ready || this.ammo === 0) this.burstLeft = 0;
      else if (this.cooldown <= 0) this.#shot(mv, camera, targets, now);
    } else if (held && ready) {
      if (this.ammo === 0) {
        if (pressed) { this.audio.play('click', { volume: 0.7, rate: 0.9 }); this.#reload(); }
      } else if (this.cooldown <= 0 && (this.mode === 'auto' || pressed)) {
        if (this.cooldown < -0.05) this.cooldown = 0;
        if (this.mode === 'burst') this.burstLeft = this.S.burst;
        this.#shot(mv, camera, targets, now);
      }
    }

    this.spread = this.#spread(mv);
  }

  #spread(mv) {
    const s = this.S.spread, a = this.adsEased;
    const lerp = THREE.MathUtils.lerp;
    let deg = lerp(s.hip, s.ads, a);
    deg += Math.min(1, mv.speed / 7.8) * lerp(s.move, s.moveAds, a);
    if (mv.state === 'air') deg += lerp(s.air, s.airAds, a);
    if (mv.state === 'slide') deg += s.slide * (1 - a);
    deg += this.bloom * (1 - a * 0.85);
    return deg;
  }

  /** One trigger pull's worth of timing: burst shots chain fast, then wait out the burst delay. */
  #shot(mv, camera, targets, now) {
    if (this.burstLeft > 0) {
      this.burstLeft--;
      this.cooldown += this.burstLeft > 0 ? 60 / this.S.burstRpm : this.S.burstDelay;
    } else this.cooldown += 60 / this.S.rpm;
    this.#fire(mv, camera, targets, now);
  }

  /** Pellet ring radius (deg) right now; 0 for bullets. ADS tightens it a little. */
  get pelletSpread() { return (this.S.pelletSpread ?? 0) * (1 - 0.2 * this.adsEased); }

  #fire(mv, camera, targets, now) {
    this.ammo--;
    this.sinceShot = 0;

    // one random offset inside the spread cone for the whole shot (uniform over disc)
    const r = Math.tan(this.spread * D2R) * Math.sqrt(Math.random());
    const th = Math.random() * Math.PI * 2;
    camera.getWorldDirection(_aim);
    _right.setFromMatrixColumn(camera.matrixWorld, 0);
    _up.setFromMatrixColumn(camera.matrixWorld, 1);
    _aim.addScaledVector(_right, Math.cos(th) * r).addScaledVector(_up, Math.sin(th) * r).normalize();

    // pellets: centre + a fixed ring (slightly rotated each shot) so the pattern is learnable
    const n = this.S.pellets ?? 1;
    const ring = Math.tan(this.pelletSpread * D2R);
    const spin = Math.random() * 0.4;
    const muzzle = this.vm.muzzleWorld(camera);
    const tally = new Map();
    for (let i = 0; i < n; i++) {
      _dir.copy(_aim);
      if (i > 0) {
        const a = spin + ((i - 1) / (n - 1)) * Math.PI * 2, k = ring * (0.9 + Math.random() * 0.2);
        _dir.addScaledVector(_right, Math.cos(a) * k).addScaledVector(_up, Math.sin(a) * k).normalize();
      }
      this.#trace(camera, targets, now, muzzle, tally);
    }
    for (const [, t] of tally) {
      this.hud.hitmarker(t.killed ? 'kill' : t.head ? 'head' : 'body');
      this.hud.damageNumber(t.point, t.dmg, t.head);
      this.audio.hit(t.killed ? 'kill' : t.head ? 'head' : 'body');
    }

    // recoil: permanent aim kick + visual punch
    const [p, y] = this.def.pattern(Math.min(this.shotIndex, 60));
    const k = THREE.MathUtils.lerp(1, this.S.recoil.adsScale, this.adsEased);
    const j = this.S.recoil.jitter;
    const kv = k * this.stats.vRecoil, kh = k * this.stats.hRecoil;
    this.rig.addRecoil((p + (Math.random() * 2 - 1) * j) * kv, -(y + (Math.random() * 2 - 1) * j) * kh);
    this.rig.punch(p * this.S.recoil.punch * k, 0, (Math.random() * 2 - 1) * 0.5);
    this.shotIndex++;
    this.bloom = Math.min(this.S.bloom.max, this.bloom + this.S.bloom.perShot);

    this.vm.fire(this.adsEased > 0.5);
    this.audio.fire({ ads: this.adsEased > 0.5, suppressed: this.stats.suppressed, sample: this.def.sound });
    if (this.ammo === 0) this.vm.boltLocked = !this.pump;
    else if (this.pump) this.vm.playPump();
    this.hud.recoilPulse();
  }

  /** One hitscan ray along _dir; dummy damage is summed per dummy in `tally` so pellets report once. */
  #trace(camera, targets, now, muzzle, tally) {
    this.raycaster.set(camera.position, _dir);
    this.raycaster.camera = camera;
    const hits = this.raycaster.intersectObjects(targets, false);
    const hit = hits.find((h) => !h.object.userData.dummy?.dead && h.object.layers.test(this.raycaster.layers));
    const end = hit ? hit.point : camera.position.clone().addScaledVector(_dir, this.S.range);

    if (hit) {
      const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : _dir.clone().negate();
      const dummy = hit.object.userData.dummy;
      if (dummy) {
        const head = hit.object.userData.zone === 'head';
        const dmg = Math.round(this.S.damage * (head ? this.S.headMultiplier : 1));
        const res = dummy.damage(dmg, hit.object.userData.zone, hit.point, _dir, now);
        if (res) {
          const t = tally.get(dummy) ?? { dmg: 0, head: false, killed: false, point: hit.point };
          t.dmg += dmg;
          t.head ||= head;
          t.killed ||= res.killed;
          tally.set(dummy, t);
        }
        this.fx.impact(hit.point, normal, { flesh: true });
      } else {
        this.fx.impact(hit.point, normal);
      }
    }
    this.fx.tracer(muzzle, end);
  }

  #reload() {
    const empty = this.ammo === 0;
    if (this.pump) {
      this.loading = { empty, stop: false };
      this.vm.playClip('reloadStart', this.S.reloadRate / this.stats.reload);
      this.hud.toast('Loading shells');
      return;
    }
    this.vm.playReload(empty, this.S.reloadRate / this.stats.reload);
    this.hud.toast(empty ? 'Reloading — empty' : 'Reloading');
  }

  /** Shell loop: keep loading until full (or the trigger was pulled), then roll back — or toss and rack if it ran dry. */
  #nextLoadStep(finished) {
    if (finished !== 'reloadStart' && finished !== 'reloadShell') { this.loading = null; return; }
    const more = this.ammo < this.magSize && !this.loading.stop;
    const next = more ? 'reloadShell' : this.loading.empty ? 'reloadEndEmpty' : 'reloadEnd';
    this.vm.playClip(next, this.S.reloadRate / this.stats.reload);
  }

  #onAnimEvent(name, data) {
    const a = this.audio;
    switch (name) {
      case 'magOut': a.play('magOut', { volume: 0.8 }); break;
      case 'magRelease': a.play('click', { volume: 0.5, rate: 0.8 }); break;
      case 'magDrop': a.play('magOut', { volume: 0.6 }); a.play('magDrop', { volume: 0.5, delay: 0.42 }); break;
      case 'magIn': a.play('magIn', { volume: 0.7 }); break;
      case 'magSeat': a.play('magSeat', { volume: 0.9 }); this.ammo = this.magSize; break;
      case 'slap': a.play('click', { volume: 0.6, rate: 0.7 }); break;
      case 'boltBack': a.play('boltBack', { volume: 0.9 }); break;
      case 'boltForward': a.play('boltForward', { volume: 1.0 }); break;
      case 'cloth': a.play('cloth', { volume: 0.35 }); break;
      case 'shellGrab': a.play('click', { volume: 0.2, rate: 1.6 }); break;
      case 'shellIn':
        a.play('magIn', { volume: 0.55, rate: 1.45 });
        this.ammo = Math.min(this.magSize, this.ammo + 1);
        break;
      case 'clipEnd': if (this.loading) this.#nextLoadStep(data); break;
      case 'pumpBack': a.play('pumpBack', { volume: 0.9 }); break;
      case 'pumpForward': a.play('pumpForward', { volume: 0.9 }); break;
      case 'eject': if (a.ready) a.brass(0.35); break;
      case 'flip': a.play('cloth', { volume: 0.4, rate: 1.25 }); break;
      case 'toss': a.play('cloth', { volume: 0.55, rate: 0.8 }); break;
      case 'catch': a.play('magSeat', { volume: 0.7, rate: 0.75 }); a.play('cloth', { volume: 0.4 }); break;
      case 'click': a.play('click', { volume: 0.4 }); break;
      case 'inspectOpen': a.play('cloth', { volume: 0.4, rate: 1.1 }); a.play('click', { volume: 0.25, rate: 0.8, delay: 0.3 }); break;
      case 'inspectClose': a.play('cloth', { volume: 0.35, rate: 0.95 }); break;
      case 'attachOut': a.play('click', { volume: 0.5, rate: 1.2 }); a.play('cloth', { volume: 0.15, rate: 1.3 }); break;
      case 'attachIn':
        if (data === 'mag') a.play('magSeat', { volume: 0.8 });
        else if (data === 'muzzle') for (let i = 0; i < 4; i++) a.play('click', { volume: 0.3, rate: 1.6, delay: i * 0.045 });
        else if (data === 'stock') a.play('boltForward', { volume: 0.5, rate: 1.2 });
        else a.play('magIn', { volume: 0.55, rate: 1.15 });
        break;
    }
  }
}

/** Saved loadout for a weapon, dropping anything that no longer fits it. */
function loadLoadout(def) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(`om.loadout.${def.id}`) ?? '{}'); } catch { /* private mode */ }
  return Object.fromEntries(def.slots.map((slot) => [slot, def.attachments[slot].includes(saved[slot]) ? saved[slot] : def.defaults[slot]]));
}
function saveLoadout(def, l) {
  try { localStorage.setItem(`om.loadout.${def.id}`, JSON.stringify(l)); } catch { /* not persisted in private mode */ }
}
