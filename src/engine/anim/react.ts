import type { Envelope } from '../../audio/envelope';

/**
 * Audio-reactive layers (`react`): a property pulses on the music's beats or follows its loudness.
 * The engine gets the music as data (beats and envelopes, analyzed outside the engine, see
 * src/cli/envelope.ts and Engine.prepareMusic) on the output timeline; layers ask for a value at
 * their own time, which the context maps to output time first (music sync warps time).
 */
export interface MusicSignal {
  /** Beat times, output seconds. */
  beats: number[];
  /** Loudness envelopes, or null when only beats are known. */
  env: Envelope | null;
  /** Envelope time = output time + envOffset (a track placed with `at` / `trim`). */
  envOffset: number;
}

export interface ReactSpec {
  to: 'beat' | 'level' | 'bass';
  prop: string;
  amount?: number;
  decay?: number;
  attack?: number;
  every?: number;
}

/** Transform properties the base layer modulates itself (after keyframes, presets and spring). */
export const REACT_TRANSFORM = new Set(['x', 'y', 'z', 'rotate', 'rotateX', 'rotateY', 'rotateZ', 'scale', 'scaleX', 'scaleY', 'opacity', 'blur']);
/** Properties that multiply by (1 + amount * v) instead of adding (amount * v). */
const MULTIPLY = new Set(['scale', 'scaleX', 'scaleY', 'glow', 'intensity']);

const DEFAULT_AMOUNT: Record<string, number> = {
  scale: 0.08, scaleX: 0.08, scaleY: 0.08, opacity: 0.5, x: 20, y: 20, z: 60, rotate: 4, rotateX: 8, rotateY: 8, rotateZ: 4, blur: 8, glow: 1, intensity: 0.6,
};

export const reactList = (r: ReactSpec | ReactSpec[] | undefined): ReactSpec[] => (r ? (Array.isArray(r) ? r : [r]) : []);

/** Index of the last beat at or before t (-1 when none). */
function lastBeat(beats: number[], t: number): number {
  let lo = 0;
  let hi = beats.length - 1;
  if (hi < 0 || beats[0] > t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (beats[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 0..1: rises over `attack` to a peak exactly on each beat, then falls to ~5% after `decay`. */
export function beatPulse(beats: number[], t: number, attack = 0.04, decay = 0.3, every = 1): number {
  const step = Math.max(1, Math.round(every));
  let v = 0;
  const i = lastBeat(beats, t);
  // The beat just passed (decaying) and the next one (rising).
  for (let j = i; j >= 0 && j >= i - 4; j--) {
    if (j % step) continue;
    const dt = t - beats[j];
    v = Math.max(v, Math.exp((-3 * dt) / Math.max(1e-3, decay)));
    break;
  }
  for (let j = i + 1; j < beats.length && j <= i + 4; j++) {
    if (j % step) continue;
    const dt = beats[j] - t;
    if (dt < attack) {
      const u = 1 - dt / Math.max(1e-3, attack);
      v = Math.max(v, u * u * (3 - 2 * u));
    }
    break;
  }
  return v;
}

/** 0..1: an envelope that jumps up with the music and falls back over `decay` seconds (peak hold). */
export function envelopeAt(series: number[], rate: number, t: number, decay = 0.12): number {
  const x = t * rate;
  const k = Math.floor(x);
  if (k < 0 || !series.length) return 0;
  const f = x - k;
  const at = (i: number) => (i >= 0 && i < series.length ? series[i] : 0);
  let v = at(k) + (at(k + 1) - at(k)) * f;
  const span = Math.ceil(decay * 2 * rate);
  const fall = 3 / Math.max(1e-3, decay * rate);
  for (let j = k; j >= 0 && j >= k - span; j--) v = Math.max(v, at(j) * Math.exp(-fall * (x - j)));
  return Math.min(1, v);
}

/** The 0..1 value of one react entry at output time t. */
export function reactValue(m: MusicSignal, r: ReactSpec, t: number): number {
  if (r.to === 'beat') return beatPulse(m.beats, t, r.attack, r.decay ?? 0.3, r.every);
  if (!m.env) return 0;
  return envelopeAt(r.to === 'bass' ? m.env.bass : m.env.level, m.env.rate, t + m.envOffset, r.decay ?? 0.12);
}

/** Applies the entries for `prop` to a value: multiplied for scale-like props, dimmed for opacity, else added. */
export function applyReact(list: ReactSpec[], prop: string, value: number, m: MusicSignal | null | undefined, t: () => number): number {
  if (!m || !list.length) return value;
  let out = value;
  let tt: number | undefined;
  for (const r of list) {
    if (r.prop !== prop) continue;
    tt ??= t();
    const v = reactValue(m, r, tt);
    const amount = r.amount ?? DEFAULT_AMOUNT[prop] ?? 1;
    if (prop === 'opacity') out *= 1 - Math.min(1, amount) * (1 - v);
    else if (MULTIPLY.has(prop)) out *= 1 + amount * v;
    else out += amount * v;
  }
  return out;
}
