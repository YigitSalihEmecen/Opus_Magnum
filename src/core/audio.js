const range = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}_${i}`);

const MANIFEST = {
  fire: range('weapon/fire', 4),
  smgFire: range('weapon/smg_fire', 4),
  shotgunFire: range('weapon/shotgun_fire', 4),
  pistolFire: range('weapon/pistol_fire', 4),
  pumpBack: ['weapon/pump_back'],
  pumpForward: ['weapon/pump_forward'],
  magOut: range('weapon/mag_out', 2),
  magIn: range('weapon/mag_in', 2),
  magSeat: ['weapon/mag_seat'],
  magDrop: ['weapon/mag_drop'],
  boltBack: ['weapon/bolt_back'],
  boltForward: ['weapon/bolt_forward'],
  click: range('weapon/click', 5),
  step: range('player/step', 10),
  cloth: range('player/cloth', 4),
  land: ['player/land'],
};

const pick = (arr) => arr[(Math.random() * arr.length) | 0];

/** WebAudio sound bank: sample playback with variation + a few synthesized layers. */
export class AudioBank {
  constructor() {
    this.buffers = {};
    this.ready = false;
    this.fireVoices = [];
  }

  async init() {
    if (this.ctx) return this.ctx.resume();
    const ctx = (this.ctx = new AudioContext({ latencyHint: 'interactive' }));
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 4;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.volume ?? 0.8;
    this.master.connect(comp);

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.wind = this.#noiseLoop('lowpass', 500, 0.7);
    this.scrape = this.#noiseLoop('bandpass', 1400, 1.2);

    await Promise.all(
      Object.entries(MANIFEST).map(async ([key, files]) => {
        this.buffers[key] = await Promise.all(
          files.map(async (f) => ctx.decodeAudioData(await (await fetch(`${import.meta.env.BASE_URL}audio/${f}.wav`)).arrayBuffer())),
        );
      }),
    );
    this.ready = true;
  }

  #noiseLoop(type, freq, q) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    return { gain, filter };
  }

  play(name, { volume = 1, rate = 1, jitter = 0.05, delay = 0, pan = 0 } = {}) {
    if (!this.ready || !this.buffers[name]) return null;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = pick(this.buffers[name]);
    src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * jitter);
    const gain = ctx.createGain();
    gain.gain.value = volume;
    let node = src.connect(gain);
    if (pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      node = node.connect(p);
    }
    node.connect(this.master);
    src.start(ctx.currentTime + delay);
    return { src, gain };
  }

  /** Gunshot: recorded report + synthesized sub thump + mechanical tick. Suppressed = muffled, mostly mechanism. */
  fire({ ads = false, suppressed = false, sample = 'fire' } = {}) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const v = suppressed ? this.#muffled(sample, 0.2, 1100) : this.play(sample, { volume: { fire: 0.55, shotgunFire: 0.6 }[sample] ?? 0.42, jitter: 0.035 });
    if (v) {
      this.fireVoices.push(v);
      if (this.fireVoices.length > 8) {
        const old = this.fireVoices.shift();
        old.gain.gain.setTargetAtTime(0, t, 0.03);
        old.src.stop(t + 0.2);
      }
    }
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    g.gain.setValueAtTime((ads ? 0.55 : 0.45) * (suppressed ? 0.4 : 1) * (sample === 'shotgunFire' ? 1.6 : 1), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.15);
    this.play('click', { volume: suppressed ? 0.3 : 0.12, rate: 1.6, jitter: 0.1 });
    if (sample !== 'shotgunFire' && Math.random() < 0.35) this.brass(0.32 + Math.random() * 0.15);
  }

  #muffled(name, volume, cutoff) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = pick(this.buffers[name]);
    src.playbackRate.value = 0.92 + Math.random() * 0.06;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    lp.Q.value = 0.4;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(lp).connect(gain).connect(this.master);
    src.start();
    return { src, gain };
  }

  /** Spent casing hitting the floor: a cluster of short high partials. */
  brass(delay) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    for (let b = 0; b < 2; b++) {
      const t = t0 + b * (0.06 + Math.random() * 0.05);
      const amp = b === 0 ? 0.008 : 0.004;
      for (const f of [3100, 4700, 6900]) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = f * (0.94 + Math.random() * 0.12);
        g.gain.setValueAtTime(amp, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        o.connect(g).connect(this.master);
        o.start(t);
        o.stop(t + 0.1);
      }
    }
  }

  /** Gently saturating bus for hit feedback: glues the layers into one solid transient. */
  #hitBus() {
    if (this.bus) return this.bus;
    const ctx = this.ctx;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) { const x = (i / 511.5) - 1; curve[i] = Math.tanh(x * 1.6) / Math.tanh(1.6); }
    shaper.curve = curve;
    shaper.oversample = '2x';
    const out = ctx.createGain();
    out.gain.value = 1.1;
    shaper.connect(out).connect(this.master);
    return (this.bus = shaper);
  }

  /**
   * Hit confirmation, made only from shaped noise (no pitched partials, so nothing rings like a can):
   *   body — "thwip": a ~35 ms noise burst whose band-pass sweeps fast downward, over a short meaty thud
   *   head — the thwip plus a crisp, dry high tick, so it reads differently at a glance-free listen
   *   kill — "thwip-THUD": a heavier, lower thwip, a big low-passed body impact with a sub drop, a grainy
   *          crunch (a few micro-bursts), and a short airy tail that makes it feel final
   * Approach after Call of Duty's hit sound (moved from "tick" toward "a bullet hitting somebody") and
   * Valorant's distinct headshot / kill layers.
   */
  hit(kind, head = kind === 'head') {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const bus = this.#hitBus();
    const kill = kind === 'kill';
    const burst = (at, dur, type, f0, f1, q, amp, attack = 0.001) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.Q.value = q;
      f.frequency.setValueAtTime(f0, t + at);
      f.frequency.exponentialRampToValueAtTime(f1, t + at + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(amp, t + at + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      src.connect(f).connect(g).connect(bus);
      src.start(t + at, Math.random() * 1.5);
      src.stop(t + at + dur + 0.02);
    };
    const sub = (at, f0, f1, dur, amp) => {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(f0, t + at);
      o.frequency.exponentialRampToValueAtTime(f1, t + at + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(amp, t + at + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      o.connect(g).connect(bus);
      o.start(t + at);
      o.stop(t + at + dur + 0.02);
    };
    const v = 0.9 + Math.random() * 0.2; // small per-hit variation

    if (kill) {
      burst(0, 0.05, 'bandpass', 3000 * v, 600, 1.3, 0.9);          // heavy thwip
      burst(0.012, 0.13, 'lowpass', 900, 160, 0.8, 1.1, 0.003);     // body impact (meat of it)
      sub(0.012, 95 * v, 38, 0.2, 0.75);                             // weight
      for (let i = 0; i < 4; i++) burst(0.02 + i * 0.011, 0.012, 'bandpass', 1700 + i * 260, 1200, 1.8, 0.55 - i * 0.1); // crunch grains
      burst(0.03, 0.26, 'highpass', 2400, 1600, 0.5, 0.12, 0.01);   // short airy tail
    } else {
      burst(0, 0.035, 'bandpass', 3600 * v, 1000, 1.5, 1.05);       // thwip
      burst(0.006, 0.05, 'lowpass', 700, 220, 0.8, 0.85, 0.002);     // thud under it
      sub(0.006, 120, 70, 0.045, 0.5);
    }
    if (head) burst(0.002, 0.009, 'highpass', 5200, 5200, 0.8, 0.7); // dry tick
  }

  /**
   * Armour shattering: a dry crack, a few narrow inharmonic rings (the plate splitting), a scatter of fine
   * shards falling off and a short low thunk. Heavier tiers sit lower. volume < 1 for our own vest.
   */
  armourBreak(tier = 1, { volume = 1 } = {}) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime, k = [1, 1.08, 0.9, 0.74][tier] ?? 1;
    const out = ctx.createGain();
    out.gain.value = volume;
    out.connect(this.#hitBus());
    const burst = (at, dur, type, f0, f1, q, amp) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.Q.value = q;
      f.frequency.setValueAtTime(f0, t + at);
      f.frequency.exponentialRampToValueAtTime(f1, t + at + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(amp, t + at + 0.0015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      src.connect(f).connect(g).connect(out);
      src.start(t + at, Math.random() * 1.5);
      src.stop(t + at + dur + 0.02);
    };
    burst(0, 0.025, 'highpass', 3800 * k, 2600 * k, 0.7, 0.9);                          // crack
    for (const [f, a] of [[2300, 0.5], [3450, 0.42], [5100, 0.3]]) burst(0.004, 0.16, 'bandpass', f * k, f * k * 0.93, 22, a); // plate rings
    for (let i = 0; i < 7; i++) burst(0.03 + Math.random() * 0.2, 0.02, 'bandpass', (3200 + Math.random() * 4200) * k, 2400 * k, 6, 0.18 + Math.random() * 0.14); // shards
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(260 * k, t);
    o.frequency.exponentialRampToValueAtTime(90 * k, t + 0.07);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.55, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.1);
  }

  /** A fist landing: a slap on top, a low meaty thud and a sub drop under it. wall: harder, drier, no flesh. */
  punch({ wall = false } = {}) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime, bus = this.#hitBus(), v = 0.9 + Math.random() * 0.2;
    const burst = (at, dur, type, f0, f1, q, amp) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.Q.value = q;
      f.frequency.setValueAtTime(f0, t + at);
      f.frequency.exponentialRampToValueAtTime(f1, t + at + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(amp, t + at + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      src.connect(f).connect(g).connect(bus);
      src.start(t + at, Math.random() * 1.5);
      src.stop(t + at + dur + 0.02);
    };
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime((wall ? 140 : 105) * v, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.16);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(wall ? 0.6 : 0.95, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + 0.2);
    burst(0, 0.03, 'bandpass', (wall ? 2400 : 1500) * v, 700, 1.1, wall ? 0.9 : 1.1); // the slap
    burst(0.004, wall ? 0.06 : 0.12, 'lowpass', 1100, 140, 0.9, wall ? 0.7 : 1.2); // the meat of it
    if (!wall) burst(0.02, 0.09, 'lowpass', 500, 120, 0.7, 0.5); // body give
  }

  /**
   * Explosion, from noise and one sub: a dry crack, a low-passed body that sweeps down as it decays, a sub
   * drop for weight, and a rumbling tail. `near` (0..1) adds the close-up crack and more sub.
   */
  explosion({ volume = 1, pan = 0, near = 0 } = {}) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = volume;
    let node = out;
    if (pan) { const p = ctx.createStereoPanner(); p.pan.value = pan; out.connect(p); node = p; }
    node.connect(this.#hitBus());
    const burst = (at, dur, type, f0, f1, q, amp, attack = 0.002) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.Q.value = q;
      f.frequency.setValueAtTime(f0, t + at);
      f.frequency.exponentialRampToValueAtTime(f1, t + at + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(amp, t + at + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      src.connect(f).connect(g).connect(out);
      src.start(t + at, Math.random() * 1.5);
      src.stop(t + at + dur + 0.05);
    };
    burst(0, 0.06, 'highpass', 3000, 1200, 0.6, 0.35 + near * 0.6);   // crack
    burst(0.004, 0.9, 'lowpass', 2400, 120, 0.7, 1.2, 0.006);         // body
    burst(0.05, 1.8, 'lowpass', 500, 60, 0.9, 0.45, 0.08);            // rumble tail
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(78, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.7 + near * 0.5, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.75);
    this.play('land', { volume: 0.5 * volume, rate: 0.55 });
  }

  /** Taking a hit (k 0..1 with the damage): a dull body thump under a short muffled smack. */
  hurt(k = 0.5) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.16);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35 + 0.45 * k, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.22);
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), n = ctx.createGain();
    src.buffer = this.noise;
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1600, t);
    f.frequency.exponentialRampToValueAtTime(200, t + 0.09);
    n.gain.setValueAtTime(0.0001, t);
    n.gain.exponentialRampToValueAtTime(0.3 + 0.3 * k, t + 0.002);
    n.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    src.connect(f).connect(n).connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.12);
  }

  /** Low health: lub-dub, k (0..1) louder as it gets worse. */
  heartbeat(k = 0.5) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    for (const [at, amp] of [[0, 1], [0.17, 0.7]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(68, t + at);
      o.frequency.exponentialRampToValueAtTime(38, t + at + 0.12);
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime((0.25 + 0.35 * k) * amp, t + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.16);
      o.connect(g).connect(this.master);
      o.start(t + at);
      o.stop(t + at + 0.18);
    }
  }

  /** Smoke canister going off: a soft pop, then a long airy hiss that settles as the cloud fills out. */
  smoke({ volume = 1, pan = 0 } = {}) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = volume;
    let node = out;
    if (pan) { const p = ctx.createStereoPanner(); p.pan.value = pan; out.connect(p); node = p; }
    node.connect(this.master);
    const burst = (at, dur, type, f0, f1, q, amp, attack) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.Q.value = q;
      f.frequency.setValueAtTime(f0, t + at);
      f.frequency.exponentialRampToValueAtTime(f1, t + at + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(amp, t + at + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      src.connect(f).connect(g).connect(out);
      src.start(t + at, Math.random() * 1.5);
      src.stop(t + at + dur + 0.05);
    };
    burst(0, 0.08, 'lowpass', 1400, 300, 0.8, 0.5, 0.003);     // pop
    burst(0.03, 2.6, 'bandpass', 5200, 2600, 0.6, 0.16, 0.12); // hiss
    burst(0.05, 2.2, 'lowpass', 900, 200, 0.7, 0.12, 0.3);      // the rush of the cloud
    this.play('click', { volume: 0.35 * volume, rate: 0.7 });
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setLoops({ wind = 0, scrape = 0 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.wind.gain.gain.setTargetAtTime(wind * 0.22, t, 0.12);
    this.wind.filter.frequency.setTargetAtTime(300 + wind * 900, t, 0.2);
    this.scrape.gain.gain.setTargetAtTime(scrape * 0.12, t, 0.05);
  }
}
