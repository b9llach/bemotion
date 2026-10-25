import type { SceneTiming } from './time';
import type { Video } from './schema';
import { sceneIndex } from './schema';

/**
 * A generated score (`score` on the video): music composed for the video instead of a recorded track.
 * This file holds the parts that need no audio: the beat grid the cuts snap to and the plan the
 * composer follows (one section per scene, each with an energy). `src/audio/music.ts` composes and
 * synthesizes it.
 */
export type ScoreSpec = NonNullable<Video['score']>;
export type ScoreStyle = NonNullable<ScoreSpec['style']>;

export const STYLE_TEMPO: Record<ScoreStyle, number> = { warm: 84, ambient: 72, bright: 104 };

export function scoreTempo(score: ScoreSpec): number {
  return score.tempo ?? STYLE_TEMPO[score.style ?? 'warm'];
}

/** Beat times from 0 to past `duration` (the warp can stretch the video a little). */
export function scoreBeats(score: ScoreSpec, duration: number): number[] {
  const spb = 60 / scoreTempo(score);
  const n = Math.ceil((duration * 1.3 + 4) / spb);
  return Array.from({ length: n }, (_, k) => k * spb);
}

export interface ScoreSection {
  index: number;
  id?: string;
  /** Output seconds, on a beat. */
  start: number;
  end: number;
  /** 0 (still) to 1 (full band). */
  energy: number;
}

export interface ScorePlan {
  bpm: number;
  duration: number;
  sections: ScoreSection[];
}

/**
 * Default energy over the video: quiet at the start, building to the last third, settling for the
 * final scene (the logo), so the music resolves as the ad lands.
 */
export function defaultEnergy(i: number, n: number): number {
  if (n === 1) return 0.5;
  if (i === n - 1) return 0.45;
  const pos = i / Math.max(1, n - 2);
  return 0.25 + 0.6 * Math.min(1, pos / 0.85);
}

/**
 * The plan the composer follows: a section per scene starting where the scene cuts in (on the
 * nearest beat), with its energy from `score.energy` (by scene id or index) or the default arc.
 */
export function scorePlan(video: Video, timings: SceneTiming[], duration: number): ScorePlan {
  const score = video.score ?? {};
  const bpm = scoreTempo(score);
  const spb = 60 / bpm;
  const energy = new Map<number, number>();
  for (const [ref, e] of Object.entries(score.energy ?? {})) {
    const i = sceneIndex(video, /^\d+$/.test(ref) && sceneIndex(video, ref) < 0 ? Number(ref) : ref);
    if (i >= 0) energy.set(i, e);
  }
  const n = video.scenes.length;
  const sections: ScoreSection[] = [];
  timings.forEach((tm, i) => {
    const start = i === 0 ? 0 : Math.round(tm.start / spb) * spb;
    const prev = sections[sections.length - 1];
    // Two cuts on the same beat: the later scene takes over.
    if (prev && start <= prev.start + 1e-6) sections.pop();
    sections.push({ index: i, id: video.scenes[i].id, start, end: duration, energy: energy.get(i) ?? defaultEnergy(i, n) });
  });
  for (let i = 0; i < sections.length - 1; i++) sections[i].end = sections[i + 1].start;
  return { bpm, duration, sections };
}
