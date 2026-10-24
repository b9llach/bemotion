import type { AnimRef } from '../../spec/schema';
import { clamp01, lerp, resolveEase, type EaseFn } from './easing';
import { fbm1, noise1 } from '../util/random';
import type { EngineContext } from '../context';

/** Additive offsets (position, rotation in degrees) and multiplicative factors (scale, opacity). */
export interface Delta {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  sx: number;
  sy: number;
  opacity: number;
  /** Additive blur radius in px. */
  blur: number;
}

export const identityDelta = (): Delta => ({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, opacity: 1, blur: 0 });

export function combine(into: Delta, d: Partial<Delta>): Delta {
  if (d.x) into.x += d.x;
  if (d.y) into.y += d.y;
  if (d.z) into.z += d.z;
  if (d.rx) into.rx += d.rx;
  if (d.ry) into.ry += d.ry;
  if (d.rz) into.rz += d.rz;
  if (d.sx !== undefined) into.sx *= d.sx;
  if (d.sy !== undefined) into.sy *= d.sy;
  if (d.opacity !== undefined) into.opacity *= d.opacity;
  if (d.blur) into.blur += d.blur;
  return into;
}

type Params = Record<string, any>;
/**
 * A transition preset maps q (0 = hidden state, 1 = resting state) to a delta.
 * `dir` is +1 for entrances and -1 for exits, so directional presets mirror on exit
 * (slideUp comes in from below and leaves upward).
 */
type TransitionPreset = {
  ease: string;
  duration: number;
  fn: (q: number, dir: number, p: Params, size: { w: number; h: number }) => Partial<Delta>;
};

const fadeQ = (q: number, p: Params) => (p.fade === false ? 1 : clamp01(q * (p.fadeSpeed ?? 1.6)));

function slide(dx: number, dy: number): TransitionPreset['fn'] {
  return (q, dir, p) => {
    const d = p.distance ?? 120;
    return { x: dx * (1 - q) * d * dir, y: dy * (1 - q) * d * dir, opacity: fadeQ(q, p) };
  };
}

export const TRANSITION_PRESETS: Record<string, TransitionPreset> = {
  none: { ease: 'linear', duration: 0, fn: () => ({}) },
  fade: { ease: 'outCubic', duration: 0.5, fn: (q) => ({ opacity: q }) },
  slideUp: { ease: 'outExpo', duration: 0.7, fn: slide(0, -1) },
  slideDown: { ease: 'outExpo', duration: 0.7, fn: slide(0, 1) },
  slideLeft: { ease: 'outExpo', duration: 0.7, fn: slide(1, 0) },
  slideRight: { ease: 'outExpo', duration: 0.7, fn: slide(-1, 0) },
  scaleIn: {
    ease: 'outExpo',
    duration: 0.7,
    fn: (q, _d, p) => {
      const s = lerp(p.from ?? 0.6, 1, q);
      return { sx: s, sy: s, opacity: fadeQ(q, p) };
    },
  },
  popIn: {
    ease: 'springBouncy',
    duration: 0.8,
    fn: (q, _d, p) => {
      const s = lerp(p.from ?? 0, 1, q);
      return { sx: s, sy: s, opacity: clamp01(q * 4) };
    },
  },
  zoomIn: {
    ease: 'outExpo',
    duration: 0.8,
    fn: (q, _d, p) => {
      const s = lerp(p.from ?? 0.2, 1, q);
      return { sx: s, sy: s, opacity: fadeQ(q, p) };
    },
  },
  zoomOut: {
    ease: 'outExpo',
    duration: 0.8,
    fn: (q, _d, p) => {
      const s = lerp(p.from ?? 1.8, 1, q);
      return { sx: s, sy: s, opacity: fadeQ(q, p) };
    },
  },
  slam: {
    ease: 'outExpo',
    duration: 0.45,
    fn: (q, _d, p) => {
      const s = lerp(p.from ?? 3.2, 1, q);
      return { sx: s, sy: s, opacity: clamp01(q * 5) };
    },
  },
  focusIn: {
    ease: 'outQuart',
    duration: 0.9,
    fn: (q, _d, p) => {
      const s = lerp(p.from ?? 1.08, 1, q);
      return { sx: s, sy: s, opacity: clamp01(q * 1.4), blur: (1 - q) * (p.blur ?? 28) };
    },
  },
  blurIn: {
    ease: 'outQuart',
    duration: 0.8,
    fn: (q, _d, p) => ({ opacity: clamp01(q * 1.5), blur: (1 - q) * (p.blur ?? 24) }),
  },
  flipX: {
    ease: 'outBack',
    duration: 0.8,
    fn: (q, dir, p) => ({ rx: (1 - q) * (p.angle ?? 90) * dir, opacity: fadeQ(q, p) }),
  },
  flipY: {
    ease: 'outBack',
    duration: 0.8,
    fn: (q, dir, p) => ({ ry: (1 - q) * -(p.angle ?? 90) * dir, opacity: fadeQ(q, p) }),
  },
  riseIn: {
    ease: 'outExpo',
    duration: 0.9,
    fn: (q, dir, p) => ({
      y: -(1 - q) * (p.distance ?? 140) * dir,
      rx: (1 - q) * (p.angle ?? 45) * dir,
      z: -(1 - q) * 200,
      opacity: fadeQ(q, p),
    }),
  },
  dropIn: {
    ease: 'outBounce',
    duration: 0.9,
    fn: (q, dir, p) => ({ y: (1 - q) * (p.distance ?? 400) * dir, opacity: clamp01(q * 3) }),
  },
  spinIn: {
    ease: 'outExpo',
    duration: 0.9,
    fn: (q, dir, p) => {
      const s = lerp(p.from ?? 0.2, 1, q);
      return { rz: (1 - q) * -(p.angle ?? 180) * dir, sx: s, sy: s, opacity: fadeQ(q, p) };
    },
  },
  swingIn: {
    ease: 'outBack',
    duration: 0.9,
    fn: (q, dir, p) => ({ ry: (1 - q) * (p.angle ?? 70) * dir, z: -(1 - q) * 300, opacity: fadeQ(q, p) }),
  },
  tiltIn: {
    ease: 'outExpo',
    duration: 1.0,
    fn: (q, dir, p) => ({ rx: (1 - q) * (p.angle ?? 60) * dir, z: -(1 - q) * (p.distance ?? 600), opacity: fadeQ(q, p) }),
  },
  pushIn: {
    ease: 'outExpo',
    duration: 0.9,
    fn: (q, dir, p) => ({ z: -(1 - q) * (p.distance ?? 900) * dir, opacity: fadeQ(q, p) }),
  },
  flyIn: {
    ease: 'outExpo',
    duration: 0.9,
    fn: (q, dir, p) => ({ z: (1 - q) * (p.distance ?? 1400) * dir, opacity: clamp01(q * 3) }),
  },
  growX: { ease: 'outExpo', duration: 0.7, fn: (q) => ({ sx: Math.max(q, 0.0001) }) },
  growY: { ease: 'outExpo', duration: 0.7, fn: (q) => ({ sy: Math.max(q, 0.0001) }) },
  grow: {
    ease: 'outExpo',
    duration: 0.7,
    fn: (q) => ({ sx: Math.max(q, 0.0001), sy: Math.max(q, 0.0001) }),
  },
  whip: {
    ease: 'swift',
    duration: 0.5,
    fn: (q, dir, p, size) => {
      const d = p.distance ?? Math.max(1400, size.w * 1.5);
      const sign = p.direction === 'right' ? -1 : p.direction === 'up' || p.direction === 'down' ? 0 : 1;
      const vsign = p.direction === 'up' ? -1 : p.direction === 'down' ? 1 : 0;
      return { x: sign * (1 - q) * d * dir, y: vsign * (1 - q) * d * dir };
    },
  },
};

// Aliases and the generic directional slide.
TRANSITION_PRESETS.slide = {
  ease: 'outExpo',
  duration: 0.7,
  fn: (q, dir, p, size) => {
    const map: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [1, 0], right: [-1, 0] };
    const [dx, dy] = map[p.direction ?? 'up'] ?? [0, -1];
    return slide(dx, dy)(q, dir, p, size);
  },
};
TRANSITION_PRESETS.scale = TRANSITION_PRESETS.scaleIn;
TRANSITION_PRESETS.pop = TRANSITION_PRESETS.popIn;
TRANSITION_PRESETS.zoom = TRANSITION_PRESETS.zoomIn;
TRANSITION_PRESETS.rise = TRANSITION_PRESETS.riseIn;
TRANSITION_PRESETS.drop = TRANSITION_PRESETS.dropIn;
TRANSITION_PRESETS.spin = TRANSITION_PRESETS.spinIn;
TRANSITION_PRESETS.swing = TRANSITION_PRESETS.swingIn;
TRANSITION_PRESETS.tilt = TRANSITION_PRESETS.tiltIn;
TRANSITION_PRESETS.focus = TRANSITION_PRESETS.focusIn;

type LoopPreset = (t: number, p: Params, seed: number) => Partial<Delta>;
const TAU = Math.PI * 2;

export const LOOP_PRESETS: Record<string, LoopPreset> = {
  float: (t, p) => ({ y: Math.sin((t / (p.period ?? 3)) * TAU + (p.phase ?? 0)) * (p.amount ?? 12) }),
  bob: (t, p) => ({ y: Math.sin((t / (p.period ?? 1.2)) * TAU + (p.phase ?? 0)) * (p.amount ?? 8) }),
  pulse: (t, p) => {
    const s = 1 + Math.sin((t / (p.period ?? 1.6)) * TAU + (p.phase ?? 0)) * (p.amount ?? 0.04);
    return { sx: s, sy: s };
  },
  spin: (t, p) => {
    const deg = t * (p.speed ?? 90);
    const axis = p.axis ?? 'z';
    return axis === 'x' ? { rx: deg } : axis === 'y' ? { ry: deg } : { rz: deg };
  },
  wobble: (t, p) => ({ rz: Math.sin((t / (p.period ?? 1.4)) * TAU + (p.phase ?? 0)) * (p.amount ?? 4) }),
  sway: (t, p) => ({
    ry: Math.sin((t / (p.period ?? 4)) * TAU + (p.phase ?? 0)) * (p.amount ?? 12),
    rx: Math.cos((t / ((p.period ?? 4) * 1.3)) * TAU) * (p.amount ?? 12) * 0.35,
  }),
  breathe: (t, p) => ({ opacity: 1 - (p.amount ?? 0.35) * (0.5 + 0.5 * Math.sin((t / (p.period ?? 2.4)) * TAU)) }),
  drift: (t, p, seed) => ({
    x: fbm1(t * (p.speed ?? 0.25), seed) * (p.amount ?? 30),
    y: fbm1(t * (p.speed ?? 0.25), seed + 7) * (p.amount ?? 30),
    rz: fbm1(t * (p.speed ?? 0.25), seed + 3) * (p.rotate ?? 0),
  }),
  shake: (t, p, seed) => ({
    x: noise1(t * (p.frequency ?? 24), seed) * (p.amount ?? 6),
    y: noise1(t * (p.frequency ?? 24), seed + 11) * (p.amount ?? 6),
  }),
  blink: (t, p) => ({ opacity: Math.floor(t / ((p.period ?? 1) / 2)) % 2 === 0 ? 1 : 0 }),
  orbit: (t, p) => {
    const a = (t / (p.period ?? 6)) * TAU + (p.phase ?? 0);
    const r = p.radius ?? 60;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r * (p.squash ?? 1) };
  },
  glitch: (t, p, seed) => {
    const slot = Math.floor(t * (p.rate ?? 12));
    const n = Math.abs(noise1(slot + 0.5, seed));
    if (n < 1 - (p.chance ?? 0.12) * 2) return {};
    return { x: noise1(slot * 3.3, seed + 5) * (p.amount ?? 18), opacity: n > 0.97 ? 0.4 : 1 };
  },
};
LOOP_PRESETS.hover = LOOP_PRESETS.float;

export interface ResolvedAnim {
  kind: 'in' | 'out' | 'loop';
  name: string;
  at: number;
  duration: number;
  ease: EaseFn;
  params: Params;
  seed: number;
  /** True when the spec set an explicit ease. Exits without one play the entrance curve in reverse. */
  customEase: boolean;
}

function normalizeRef(ref: AnimRef): { preset: string; at?: any; duration?: any; ease?: any; [k: string]: any } {
  return typeof ref === 'string' ? { preset: ref } : ref;
}

export function resolveAnims(
  list: AnimRef | AnimRef[] | undefined,
  kind: 'in' | 'out' | 'loop',
  ctx: EngineContext,
  window: { start: number; end: number },
  seed: number,
): ResolvedAnim[] {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : [list];
  return arr.map((raw, i) => {
    const r = normalizeRef(raw);
    const { preset, at, duration, ease, ...params } = r;
    if (kind === 'loop') {
      if (!LOOP_PRESETS[preset]) throw new Error(`Unknown loop preset "${preset}". Available: ${Object.keys(LOOP_PRESETS).join(', ')}`);
      const start = ctx.time(at, window.start);
      const until = params.until !== undefined ? ctx.time(params.until) : window.end;
      return { kind, name: preset, at: start, duration: until - start, ease: resolveEase('linear'), params, seed: seed + i * 31, customEase: false };
    }
    const def = TRANSITION_PRESETS[preset];
    if (!def) throw new Error(`Unknown ${kind} preset "${preset}". Available: ${Object.keys(TRANSITION_PRESETS).join(', ')}`);
    const dur = ctx.time(duration, def.duration);
    const start = kind === 'in' ? ctx.time(at, window.start) : ctx.time(at, window.end - dur);
    return { kind, name: preset, at: start, duration: dur, ease: resolveEase(ease, def.ease), params, seed: seed + i * 31, customEase: ease !== undefined };
  });
}

export function applyAnims(delta: Delta, anims: ResolvedAnim[], t: number, size: { w: number; h: number }): Delta {
  for (const a of anims) {
    if (a.kind === 'loop') {
      if (t < a.at || t > a.at + a.duration) continue;
      combine(delta, LOOP_PRESETS[a.name](t - a.at, a.params, a.seed));
      continue;
    }
    const def = TRANSITION_PRESETS[a.name];
    const p = a.duration <= 0 ? (t >= a.at ? 1 : 0) : clamp01((t - a.at) / a.duration);
    if (a.kind === 'in') {
      if (p >= 1) continue;
      combine(delta, def.fn(a.ease(p), 1, a.params, size));
    } else {
      if (p <= 0) continue;
      const q = a.customEase ? 1 - a.ease(p) : a.ease(1 - p);
      combine(delta, def.fn(q, -1, a.params, size));
    }
  }
  return delta;
}
