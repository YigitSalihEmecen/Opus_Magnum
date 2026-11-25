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

  /** Hit confirmation blips. kind: 'body' | 'head' | 'kill' */
  hit(kind) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const blip = (freq, at, dur, amp, type = 'triangle') => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(amp, t + at);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      o.connect(g).connect(this.master);
      o.start(t + at);
      o.stop(t + at + dur + 0.01);
    };
    if (kind === 'head') { blip(2600, 0, 0.05, 0.16); blip(3900, 0.03, 0.08, 0.12); }
    else if (kind === 'kill') { blip(520, 0, 0.18, 0.25, 'square'); blip(1560, 0.04, 0.2, 0.12); }
    else blip(1900, 0, 0.04, 0.12);
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
