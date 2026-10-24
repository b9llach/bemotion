import type { Time } from './schema';

export interface TimeContext {
  fps: number;
  bpm?: number;
}

/** Converts a spec time value into seconds. */
export function toSeconds(v: Time | undefined, ctx: TimeContext, fallback = 0): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'number') return v;
  const m = /^(-?\d+(?:\.\d+)?)(s|ms|f|b)?$/.exec(v.trim());
  if (!m) throw new Error(`Invalid time value "${v}"`);
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case 'ms':
      return n / 1000;
    case 'f':
      return n / ctx.fps;
    case 'b':
      if (!ctx.bpm) throw new Error(`Time "${v}" uses beats but the video has no bpm`);
      return (n * 60) / ctx.bpm;
    default:
      return n;
  }
}

export interface SceneTiming {
  index: number;
  start: number;
  duration: number;
  end: number;
  /** Length of the transition that brings this scene in (overlaps the previous scene). */
  transitionIn: number;
}

/** Lays scenes on the global timeline. A scene's incoming transition overlaps the previous scene's tail. */
export function layoutScenes(scenes: { duration: Time; transition?: { type: string; duration?: Time } }[], ctx: TimeContext): { scenes: SceneTiming[]; duration: number } {
  const out: SceneTiming[] = [];
  let cursor = 0;
  scenes.forEach((s, i) => {
    const duration = toSeconds(s.duration, ctx);
    let transitionIn = 0;
    if (i > 0 && s.transition && s.transition.type !== 'cut') {
      transitionIn = toSeconds(s.transition.duration, ctx, 0.5);
      const prev = out[i - 1];
      transitionIn = Math.max(0, Math.min(transitionIn, prev.duration * 0.9, duration * 0.9));
    }
    const start = Math.max(0, cursor - transitionIn);
    out.push({ index: i, start, duration, end: start + duration, transitionIn });
    cursor = start + duration;
  });
  return { scenes: out, duration: cursor };
}
