/**
 * Minimal keyframe animation: multi-channel tracks sampled with cubic Hermite splines
 * (non-uniform Catmull-Rom tangents) so motion flows through keys instead of stopping at each one.
 * A key flagged 'hold' gets a zero tangent — use it for hard stops (mag seating, bolt slamming home).
 */
export class Track {
  /** keys: [[time, [values...], 'hold'?], ...] sorted by time */
  constructor(keys) {
    this.keys = keys;
    this.n = keys[0][1].length;
    this.tangents = keys.map((k, i) => {
      const prev = keys[i - 1], next = keys[i + 1];
      if (!prev || !next || k[2] === 'hold') return new Array(this.n).fill(0);
      return k[1].map((v, c) => 0.5 * ((next[1][c] - v) / (next[0] - k[0]) + (v - prev[1][c]) / (k[0] - prev[0])));
    });
  }

  sample(t, out = new Array(this.n)) {
    const k = this.keys;
    if (t <= k[0][0]) return copyInto(out, k[0][1]);
    const last = k[k.length - 1];
    if (t >= last[0]) return copyInto(out, last[1]);
    let i = 0;
    while (k[i + 1][0] < t) i++;
    const [t0, p0] = k[i], [t1, p1] = k[i + 1];
    const h = t1 - t0, s = (t - t0) / h;
    const s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    const m0 = this.tangents[i], m1 = this.tangents[i + 1];
    for (let c = 0; c < this.n; c++) out[c] = h00 * p0[c] + h10 * h * m0[c] + h01 * p1[c] + h11 * h * m1[c];
    return out;
  }
}

function copyInto(out, src) {
  for (let i = 0; i < src.length; i++) out[i] = src[i];
  return out;
}

const FADE = 0.16;

/**
 * clip = { duration, tracks: { name: Track }, events: [[time, name, data?]], readyAt? }
 * Starting or stopping a clip mid-way crossfades from the pose it was in, so interruptions never snap.
 */
export class ClipPlayer {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.clip = null;
    this.time = 0;
    this.rate = 1;
    this.from = null;
    this.fade = 0;
  }

  #hold(fade) {
    if (this.clip) { this.from = { clip: this.clip, time: this.time }; this.fade = fade; }
  }

  play(clip) {
    this.#hold(FADE);
    this.clip = clip;
    this.time = 0;
    this.nextEvent = 0;
  }

  stop(fade = FADE) { this.#hold(fade); this.clip = null; }

  get playing() { return !!this.clip; }

  update(dt) {
    if (this.fade > 0) this.fade = Math.max(0, this.fade - dt);
    const c = this.clip;
    if (!c) return;
    this.time += dt * this.rate;
    while (this.nextEvent < c.events.length && c.events[this.nextEvent][0] <= this.time) {
      const [, name, data] = c.events[this.nextEvent++];
      this.onEvent(name, data);
    }
    if (this.time >= c.duration) { this.clip = null; this.onEvent('clipEnd', c.name); }
  }

  /** Sample a named track, or return fallback when no clip / track is active. */
  get(name, fallback) {
    const tr = this.clip?.tracks[name];
    const v = tr ? tr.sample(this.time) : fallback;
    const old = this.fade > 0 && this.from.clip.tracks[name];
    if (!old) return v;
    const a = old.sample(this.from.time);
    const s = this.fade / FADE, w = s * s * (3 - 2 * s);
    for (let i = 0; i < a.length; i++) a[i] += ((v?.[i] ?? 0) - a[i]) * (1 - w);
    return a;
  }
}
