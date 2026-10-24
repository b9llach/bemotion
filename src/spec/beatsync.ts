import { toSeconds, type SceneTiming } from './time';
import type { Video } from './schema';

/**
 * Cutting to the music. A spec is written in its own time ("design time"); when a music track has
 * `sync`, the video plays through a gentle time warp so that its moments land on the music's beats:
 * scene changes and transitions, and every top-level layer that starts partway into a scene (lines of
 * type, counters, confetti...). Between those moments time runs uniformly a little faster or slower
 * (at most about 20%), so everything else (keyframes, morphs, camera moves) stays in proportion.
 *
 * The warp is a list of [design, output] points, both increasing, interpolated linearly.
 */
export type Warp = [number, number][];

/** Moments worth landing on a beat, in global design time, sorted. */
export function syncMoments(video: Video, timings: SceneTiming[]): number[] {
  const out: number[] = [];
  const ctx = { fps: video.fps ?? 30, bpm: video.bpm };
  video.scenes.forEach((s, i) => {
    const tm = timings[i];
    if (i > 0) out.push(tm.start);
    for (const l of s.layers) {
      const st = (l as { start?: unknown }).start;
      if (st === undefined) continue;
      const t = toSeconds(st as never, ctx, 0);
      if (t >= 0.15 && t < tm.duration - 0.1) out.push(tm.start + t);
    }
  });
  return [...new Set(out.map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b);
}

/**
 * Builds the warp: walking through the moments in order, each one moves to the nearest beat if that
 * keeps the playback rate since the previous anchor within [minRate, maxRate]; otherwise it is left
 * alone. Moments closer than `minGap` to the previous anchor are skipped.
 */
export function buildWarp(moments: number[], beats: number[], duration: number, opts: { minRate?: number; maxRate?: number; minGap?: number } = {}): Warp {
  const minRate = opts.minRate ?? 0.82;
  const maxRate = opts.maxRate ?? 1.22;
  const minGap = opts.minGap ?? 0.3;
  const pts: Warp = [[0, 0]];
  if (!beats.length) return [[0, 0], [duration, duration]];
  const sorted = [...beats].sort((a, b) => a - b);
  const nearest = (x: number) => {
    let lo = 0;
    let hi = sorted.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < x) lo = mid;
      else hi = mid;
    }
    return Math.abs(sorted[lo] - x) <= Math.abs(sorted[hi] - x) ? sorted[lo] : sorted[hi];
  };
  for (const m of moments) {
    const [d0, o0] = pts[pts.length - 1];
    if (m - d0 < minGap || m >= duration) continue;
    const predicted = o0 + (m - d0);
    const b = nearest(predicted);
    // Output time runs (b - o0) for (m - d0) of design time: design speed = (m - d0) / (b - o0).
    const speed = (m - d0) / (b - o0);
    if (b - o0 > 0 && speed >= minRate && speed <= maxRate) pts.push([m, b]);
  }
  const [dl, ol] = pts[pts.length - 1];
  pts.push([duration, ol + (duration - dl)]);
  return pts;
}

/**
 * A warp through given [design, output] pairs (for following a voiceover): each pair is kept if it
 * comes at least `minGap` after the previous one and the playback rate in between stays within
 * [minRate, maxRate]. After the last pair, time runs at normal speed.
 */
export function buildTargetWarp(pairs: [number, number][], duration: number, opts: { minRate?: number; maxRate?: number; minGap?: number } = {}): Warp {
  const minRate = opts.minRate ?? 0.4;
  const maxRate = opts.maxRate ?? 2.5;
  const minGap = opts.minGap ?? 0.15;
  const pts: Warp = [[0, 0]];
  for (const [d, o] of [...pairs].sort((a, b) => a[0] - b[0])) {
    const [d0, o0] = pts[pts.length - 1];
    if (d - d0 < minGap || d >= duration || o <= o0) continue;
    const speed = (d - d0) / (o - o0);
    if (speed >= minRate && speed <= maxRate) pts.push([d, o]);
  }
  const [dl, ol] = pts[pts.length - 1];
  pts.push([duration, ol + (duration - dl)]);
  return pts;
}

function interp(w: Warp, x: number, from: 0 | 1): number {
  const to = from === 0 ? 1 : 0;
  if (x <= w[0][from]) return w[0][to] + (x - w[0][from]);
  for (let i = 1; i < w.length; i++) {
    if (x <= w[i][from]) {
      const a = w[i - 1];
      const b = w[i];
      const u = (x - a[from]) / Math.max(1e-9, b[from] - a[from]);
      return a[to] + (b[to] - a[to]) * u;
    }
  }
  const last = w[w.length - 1];
  return last[to] + (x - last[from]);
}

/** Output time to design time. */
export const toDesign = (w: Warp, t: number) => interp(w, t, 1);
/** Design time to output time. */
export const toOutput = (w: Warp, t: number) => interp(w, t, 0);
