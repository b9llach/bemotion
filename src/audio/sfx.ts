/**
 * Procedural sound design. Every effect is synthesized from noise, sines, filters and envelopes,
 * so there are no samples to license and renders are deterministic.
 */

export const SR = 48000;

export interface Cue {
  kind: string;
  t: number;
  gain: number;
}

export type Stereo = { l: Float32Array; r: Float32Array };

function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RBJ biquad with per-sample coefficient updates (cheap enough at these lengths). */
class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;

  set(type: 'lp' | 'hp' | 'bp', freq: number, q: number): void {
    const w = (2 * Math.PI * Math.min(freq, SR * 0.45)) / SR;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    let b0: number;
    let b1: number;
    let b2: number;
    if (type === 'lp') {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
    } else if (type === 'hp') {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
    } else {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    }
    const a0 = 1 + alpha;
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

function buf(seconds: number): Stereo {
  const n = Math.ceil(seconds * SR);
  return { l: new Float32Array(n), r: new Float32Array(n) };
}

/** Filtered noise sweep. `curve` maps 0..1 to cutoff Hz; `env` maps 0..1 to amplitude; pan sweeps L to R. */
function noiseSweep(seconds: number, seed: number, curve: (p: number) => number, env: (p: number) => number, q: number, panFrom: number, panTo: number, type: 'bp' | 'lp' = 'bp'): Stereo {
  const out = buf(seconds);
  const r = rng(seed);
  const f = new Biquad();
  const f2 = new Biquad();
  const n = out.l.length;
  for (let i = 0; i < n; i++) {
    const p = i / n;
    if (i % 16 === 0) {
      f.set(type, curve(p), q);
      f2.set(type, curve(p), q);
    }
    const x = f2.run(f.run(r() * 2 - 1)) * env(p);
    const pan = panFrom + (panTo - panFrom) * p;
    out.l[i] = x * Math.cos(((pan + 1) * Math.PI) / 4);
    out.r[i] = x * Math.sin(((pan + 1) * Math.PI) / 4);
  }
  return out;
}

function tone(seconds: number, freq: (t: number) => number, env: (t: number) => number, pan = 0, partials: [number, number][] = [[1, 1]]): Stereo {
  const out = buf(seconds);
  const phase = partials.map(() => 0);
  for (let i = 0; i < out.l.length; i++) {
    const t = i / SR;
    const f = freq(t);
    let x = 0;
    partials.forEach(([mult, amp], k) => {
      phase[k] += (2 * Math.PI * f * mult) / SR;
      x += Math.sin(phase[k]) * amp;
    });
    x *= env(t);
    out.l[i] = x * Math.cos(((pan + 1) * Math.PI) / 4);
    out.r[i] = x * Math.sin(((pan + 1) * Math.PI) / 4);
  }
  return out;
}

function mixInto(dst: Stereo, src: Stereo, offset = 0, gain = 1): void {
  for (let i = 0; i < src.l.length; i++) {
    const j = i + offset;
    if (j < 0 || j >= dst.l.length) continue;
    dst.l[j] += src.l[i] * gain;
    dst.r[j] += src.r[i] * gain;
  }
}

const bell = (p: number, peak: number) => (p < peak ? Math.sin((p / peak) * Math.PI * 0.5) ** 2 : Math.cos(((p - peak) / (1 - peak)) * Math.PI * 0.5) ** 2);


export type Kit = 'soft' | 'classic' | 'tactile';

/** Sum of decaying sine partials, each with its own decay: bells, mallets, felt taps. */
function struck(seconds: number, f: number, partials: [number, number, number][], attack: number, pan = 0): Stereo {
  const out = buf(seconds);
  for (const [mult, amp, decay] of partials) {
    mixInto(out, tone(seconds, () => f * mult, (t) => Math.min(1, t * attack) * Math.exp(-t * decay) * amp, pan));
  }
  return out;
}

/** Airy, felt and rounded: effects that sit under a premium product film. */
function softKit(kind: string, seed: number, pitch: number): Stereo | null {
  const r = rng(seed);
  const pan = (r() - 0.5) * 0.5;
  switch (kind) {
    case 'whoosh':
      return noiseSweep(0.85, seed, (p) => 180 + 1500 * Math.sin(Math.PI * Math.min(1, p * 1.05)) ** 2, (p) => bell(p, 0.6) * 1.1, 0.5, -0.6, 0.6, 'lp');
    case 'swoosh':
      return noiseSweep(0.5, seed, (p) => 350 + 2300 * Math.sin(Math.PI * p) ** 1.5, (p) => bell(p, 0.5) * 0.7, 0.5, -0.35, 0.35, 'lp');
    case 'soft': {
      // A warm low mallet note with a breath of air, instead of a hiss.
      const out = struck(1.6, 261.63 * pitch, [[1, 0.26, 3.2], [2, 0.07, 6], [3, 0.02, 10]], 60, pan);
      mixInto(out, noiseSweep(0.6, seed, (p) => 400 + 600 * Math.sin(Math.PI * p), (p) => bell(p, 0.4) * 0.08, 0.5, -0.2, 0.2, 'lp'));
      return out;
    }
    case 'tick':
      // A felt tap on a soft key: pitched, short, no click.
      return struck(0.35, 880 * pitch, [[1, 0.32, 26], [2, 0.06, 40], [3.01, 0.025, 60]], 900, pan);
    case 'pop': {
      const f = 523.25 * pitch;
      const out = tone(0.3, (t) => f * (1 + 0.25 * Math.exp(-t * 60)), (t) => Math.min(1, t * 500) * Math.exp(-t * 16) * 0.5, pan, [[1, 1], [2, 0.12]]);
      return out;
    }
    case 'key':
      return noiseSweep(0.05, seed, () => 1700 + r() * 400, (p) => Math.exp(-p * 8) * 0.55, 0.7, pan, pan, 'lp');
    case 'click': {
      const out = noiseSweep(0.04, seed, () => 2600, (p) => Math.exp(-p * 9) * 0.8, 0.8, 0, 0, 'lp');
      mixInto(out, struck(0.12, 1100, [[1, 0.25, 70]], 3000));
      return out;
    }
    case 'impact': {
      // Cinematic low swell and thud rather than a hit.
      const out = tone(1.4, (t) => 42 + 50 * Math.exp(-t * 9), (t) => Math.min(1, t * 120) * Math.exp(-t * 3.2) * 1.0);
      mixInto(out, noiseSweep(0.6, seed, (p) => 900 * (1 - p) + 120, (p) => Math.exp(-p * 4) * 0.35, 0.5, -0.3, 0.3, 'lp'));
      return out;
    }
    case 'chime': {
      const out = buf(2.2);
      mixInto(out, struck(2.0, 659.25 * pitch, [[1, 0.2, 2.6], [2.76, 0.05, 5], [5.4, 0.015, 9]], 1200, -0.2));
      mixInto(out, struck(2.0, 987.77 * pitch, [[1, 0.17, 2.8], [2.76, 0.04, 5]], 1200, 0.2), Math.floor(0.11 * SR));
      return out;
    }
    default:
      return null;
  }
}

/** Wood and mallets: marimba pops, woodblock clicks. Playful but not cartoonish. */
function tactileKit(kind: string, seed: number, pitch: number): Stereo | null {
  const r = rng(seed);
  const pan = (r() - 0.5) * 0.6;
  switch (kind) {
    case 'tick':
      return struck(0.4, 784 * pitch, [[1, 0.3, 18], [3.93, 0.07, 45], [9.2, 0.02, 90]], 2500, pan);
    case 'pop':
      return struck(0.6, 392 * pitch, [[1, 0.5, 9], [3.93, 0.12, 30], [9.2, 0.03, 70]], 2500, pan);
    case 'key':
    case 'click': {
      const out = noiseSweep(0.04, seed, () => 1500 + r() * 300, (p) => Math.exp(-p * 10) * 0.9, 3, pan, pan);
      mixInto(out, struck(0.1, 1250 * (0.95 + r() * 0.1), [[1, 0.2, 80], [2.7, 0.06, 120]], 4000, pan));
      return out;
    }
    case 'chime':
      return struck(1.6, 784 * pitch, [[1, 0.4, 4], [3.93, 0.08, 14], [9.2, 0.02, 30]], 2500, 0);
    default:
      return null;
  }
}

/**
 * A small Schroeder reverb (parallel combs into series allpasses) so effects sit in a room instead of
 * sounding pasted on. Different comb lengths per side give width.
 */
function reverb(src: Stereo, wet: number): void {
  if (wet <= 0) return;
  const run = (x: Float32Array, combs: number[], allpasses: number[]) => {
    const n = x.length;
    const y = new Float32Array(n);
    for (const d of combs) {
      const line = new Float32Array(d);
      let lp = 0;
      for (let i = 0, k = 0; i < n; i++, k = (k + 1) % d) {
        const out = line[k];
        lp = out * 0.6 + lp * 0.4; // damping: highs die first, like a real room
        line[k] = x[i] + lp * 0.8;
        y[i] += out / combs.length;
      }
    }
    for (const d of allpasses) {
      const line = new Float32Array(d);
      for (let i = 0, k = 0; i < n; i++, k = (k + 1) % d) {
        const b = line[k];
        const v = y[i] + b * 0.5;
        line[k] = v;
        y[i] = b - v * 0.5;
      }
    }
    return y;
  };
  const ms = (v: number) => Math.round((v / 1000) * SR);
  const l = run(src.l, [29.7, 37.1, 41.1, 43.7].map(ms), [5, 1.7].map(ms));
  const r = run(src.r, [30.9, 35.9, 40.3, 45.1].map(ms), [5.3, 1.9].map(ms));
  for (let i = 0; i < src.l.length; i++) {
    src.l[i] += l[i] * wet;
    src.r[i] += r[i] * wet;
  }
}

/** Major pentatonic steps across two octaves: any run of them sounds like a phrase, never a clash. */
const PENTA = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2, 9 / 4, 5 / 2, 3, 10 / 3];

export function synth(kind: string, seed: number, kit: Kit = 'classic', pitch = 1): Stereo {
  if (kit === 'soft') return softKit(kind, seed, pitch) ?? classic(kind, seed);
  if (kit === 'tactile') return tactileKit(kind, seed, pitch) ?? softKit(kind, seed, pitch) ?? classic(kind, seed);
  return classic(kind, seed);
}

function classic(kind: string, seed: number): Stereo {
  const r = rng(seed);
  const vary = 1 + (r() - 0.5) * 0.12;
  switch (kind) {
    case 'whoosh':
      return noiseSweep(0.62, seed, (p) => 280 + 2600 * Math.sin(Math.PI * Math.min(1, p * 1.1)) ** 1.5 * vary, (p) => bell(p, 0.55) * 1.4, 0.9, -0.7, 0.7);
    case 'swoosh':
      return noiseSweep(0.36, seed, (p) => 700 + 3600 * Math.sin(Math.PI * p) * vary, (p) => bell(p, 0.45) * 0.9, 1.1, -0.4, 0.4);
    case 'soft':
      return noiseSweep(0.9, seed, (p) => 500 + 1300 * Math.sin(Math.PI * p), (p) => bell(p, 0.5) * 0.45, 0.6, -0.2, 0.2, 'lp');
    case 'pop': {
      const base = 520 * vary;
      return tone(0.16, (t) => base + 700 * Math.exp(-t * 55), (t) => Math.min(1, t * 900) * Math.exp(-t * 32) * 0.8, (r() - 0.5) * 0.3, [[1, 1], [2, 0.18]]);
    }
    case 'tick': {
      const f = 1850 * vary;
      return tone(0.07, () => f, (t) => Math.min(1, t * 3000) * Math.exp(-t * 85) * 0.45, (r() - 0.5) * 0.5, [[1, 1], [2.01, 0.25]]);
    }
    case 'key': {
      const out = noiseSweep(0.03, seed, () => 3800 * vary, (p) => Math.exp(-p * 9) * 0.9, 1.4, 0, 0);
      mixInto(out, tone(0.03, () => 1200 * vary, (t) => Math.exp(-t * 200) * 0.2));
      return out;
    }
    case 'click': {
      const out = noiseSweep(0.02, seed, () => 5200, (p) => Math.exp(-p * 7) * 1.6, 1.0, 0, 0);
      mixInto(out, tone(0.06, (t) => 1500 - t * 4000, (t) => Math.min(1, t * 4000) * Math.exp(-t * 110) * 0.55));
      return out;
    }
    case 'impact': {
      const out = tone(0.7, (t) => 48 + 90 * Math.exp(-t * 18), (t) => Math.min(1, t * 600) * Math.exp(-t * 6.5) * 1.1);
      mixInto(out, noiseSweep(0.18, seed, (p) => 2400 * (1 - p) + 200, (p) => Math.exp(-p * 6) * 0.6, 0.7, 0, 0, 'lp'));
      return out;
    }
    case 'sparkle': {
      const out = buf(1.4);
      const notes = [2093, 2637, 3136, 3520, 4186];
      for (let k = 0; k < 6; k++) {
        const f = notes[Math.floor(r() * notes.length)] * (1 + (r() - 0.5) * 0.01);
        const start = Math.floor(r() * 0.28 * SR);
        const decay = 5 + r() * 5;
        mixInto(out, tone(1.0, () => f, (t) => Math.min(1, t * 2000) * Math.exp(-t * decay) * 0.16, (r() - 0.5) * 1.4, [[1, 1], [2.76, 0.2]]), start);
      }
      return out;
    }
    case 'chime': {
      const out = buf(1.4);
      mixInto(out, tone(1.2, () => 1318.5, (t) => Math.min(1, t * 1500) * Math.exp(-t * 4) * 0.28, -0.15, [[1, 1], [2.76, 0.15], [5.4, 0.05]]));
      mixInto(out, tone(1.2, () => 1975.5, (t) => Math.min(1, t * 1500) * Math.exp(-t * 4) * 0.24, 0.15, [[1, 1], [2.76, 0.15]]), Math.floor(0.09 * SR));
      return out;
    }
    case 'glitch': {
      const out = noiseSweep(0.3, seed, (p) => 1800 + 2600 * r(), (p) => (Math.floor(p * 14) % 2 === 0 ? 0.7 : 0.12), 0.8, -0.3, 0.3);
      for (let i = 0; i < out.l.length; i++) {
        out.l[i] = Math.round(out.l[i] * 6) / 6;
        out.r[i] = Math.round(out.r[i] * 6) / 6;
      }
      return out;
    }
    default:
      return buf(0.01);
  }
}

/**
 * Mixes cues into a stereo buffer (runs in Node for renders and in the browser for the preview).
 * Cues of the same kind closer than `minGap` merge, so a burst of 20 staggered pops reads as a few.
 */
export interface SfxOptions {
  kit?: Kit;
  /** Varies every effect and picks the musical key; derive it from the video so each one sounds its own. */
  seed?: number;
  /** Reverb send, 0-1 (default 0.22 for soft, 0.14 for tactile, 0 for classic). */
  reverb?: number;
}

export function mixSfx(cues: Cue[], duration: number, volume = 0.7, opts: SfxOptions = {}): { audio: Stereo; used: number } {
  const kit = opts.kit ?? 'soft';
  const seed = opts.seed ?? 1;
  const master = buf(duration + 1.5);
  const last = new Map<string, number>();
  // Pick a key for this video, then let runs of pitched cues (a sentence building word by word,
  // a row of pops) walk up the pentatonic scale like a little phrase.
  const keyR = rng(seed * 31 + 7);
  const root = 2 ** ((Math.floor(keyR() * 12) - 5) / 12);
  const step = new Map<string, number>();
  const runAt = new Map<string, number>();
  const minGap: Record<string, number> = { pop: 0.07, tick: 0.06, key: 0.03, swoosh: 0.12, whoosh: 0.25, soft: 0.4, impact: 0.15, click: 0.05, sparkle: 0.5, chime: 0.5, glitch: 0.2 };
  let used = 0;
  cues.forEach((c, i) => {
    if (c.t < 0 || c.t > duration) return;
    const prev = last.get(c.kind);
    if (prev !== undefined && c.t - prev < (minGap[c.kind] ?? 0.05)) return;
    last.set(c.kind, c.t);
    let pitch = 1;
    if (c.kind === 'tick' || c.kind === 'pop' || c.kind === 'chime' || c.kind === 'soft') {
      const prevRun = runAt.get(c.kind);
      const s = prevRun !== undefined && c.t - prevRun < 0.75 ? (step.get(c.kind) ?? 0) + 1 : Math.floor(keyR() * 3);
      step.set(c.kind, s % PENTA.length);
      runAt.set(c.kind, c.t);
      pitch = root * PENTA[s % PENTA.length] * (c.kind === 'chime' || c.kind === 'soft' ? 1 : 0.5);
    }
    mixInto(master, synth(c.kind, seed * 100003 + i * 7919, kit, pitch), Math.floor(c.t * SR), c.gain * volume);
    used++;
  });
  reverb(master, opts.reverb ?? (kit === 'soft' ? 0.22 : kit === 'tactile' ? 0.14 : 0));
  return { audio: master, used };
}

/** Stable per-video seed from its title, so each video gets its own variations and musical key. */
export function sfxSeed(name: string): number {
  return [...name].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 17) % 100000;
}
