/**
 * Loudness envelopes of a music track for audio-reactive layers (`react`): overall level (RMS) and
 * low-band energy (bass and kick, under ~150 Hz), sampled ENV_RATE times per second and normalized so
 * that loud passages reach 1. Pure, shared by the CLI (files, src/cli/envelope.ts) and the engine
 * (a generated score, synthesized in the browser).
 */
export const ENV_RATE = 100;

export interface Envelope {
  /** Samples per second. */
  rate: number;
  /** 0..1, overall loudness. */
  level: number[];
  /** 0..1, energy under ~150 Hz. */
  bass: number[];
}

/** The value below which `q` of the samples fall (ignores near-silence). */
function quantile(xs: Float64Array, q: number): number {
  const v = Array.from(xs).filter((x) => x > 1e-6).sort((a, b) => a - b);
  if (!v.length) return 0;
  return v[Math.min(v.length - 1, Math.floor(q * (v.length - 1)))];
}

/** Envelopes of a mono signal at `sr` samples per second. */
export function computeEnvelope(x: ArrayLike<number>, sr: number, rate = ENV_RATE): Envelope {
  const hop = sr / rate;
  const frames = Math.max(0, Math.floor(x.length / hop));
  const win = Math.round(sr * 0.03);
  // Low band: two one-pole low-passes at 150 Hz.
  const a = 1 - Math.exp((-2 * Math.PI * 150) / sr);
  const low = new Float64Array(x.length);
  let l1 = 0;
  let l2 = 0;
  for (let i = 0; i < x.length; i++) {
    l1 += a * (x[i] - l1);
    l2 += a * (l1 - l2);
    low[i] = l2;
  }
  // Running sums of squares, so each frame's RMS over a 30 ms window ending at the frame is O(1).
  const cs = new Float64Array(x.length + 1);
  const cl = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) {
    cs[i + 1] = cs[i] + x[i] * x[i];
    cl[i + 1] = cl[i] + low[i] * low[i];
  }
  const level = new Float64Array(frames);
  const bass = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const c = Math.round(f * hop);
    const lo = Math.max(0, c - (win >> 1));
    const hi = Math.min(x.length, c + (win >> 1) + 1);
    const n = Math.max(1, hi - lo);
    level[f] = Math.sqrt((cs[hi] - cs[lo]) / n);
    bass[f] = Math.sqrt((cl[hi] - cl[lo]) / n);
  }
  const norm = (v: Float64Array) => {
    const top = quantile(v, 0.97) || 1;
    return Array.from(v, (y) => Math.round(Math.min(1, y / top) * 1000) / 1000);
  };
  return { rate, level: norm(level), bass: norm(bass) };
}
