import { basename, resolve } from 'node:path';
import { renderScore, scoreKey } from '../audio/music';
import { sfxSeed } from '../audio/sfx';
import { buildWarp, syncMoments, toOutput } from '../spec/beatsync';
import { validateVideo } from '../spec/schema';
import { scoreBeats, scorePlan, type ScorePlan, type ScoreSpec } from '../spec/score';
import { layoutScenes } from '../spec/time';
import { readSpec } from './server';
import { writeWav } from './wav';

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/**
 * Writes a spec's score alone to a WAV, without rendering the video: for trying styles, keys and
 * energies quickly. The timing matches a render unless a voiceover sets it (then render to hear it).
 */
export async function writeScoreOnly(specPath: string, out: string, override: Partial<ScoreSpec> = {}): Promise<{ plan: ScorePlan; key: string }> {
  const v = validateVideo(await readSpec(resolve(specPath)));
  if (!v.ok || !v.video) throw new Error(`Invalid spec:\n${v.errors.map((e) => `  - ${e}`).join('\n')}`);
  const video = v.video;
  // Overrides (from the command line) try a style, key or seed without editing the spec.
  if (Object.keys(override).length) video.score = { ...(video.score ?? {}), ...override };
  if (!video.score) throw new Error('This spec has no "score". Add one, e.g. "score": { "style": "warm" }, or pass --style');
  const layout = layoutScenes(video.scenes, { fps: video.fps ?? 30, bpm: video.bpm });
  let timings = layout.scenes;
  let duration = layout.duration;
  if (video.score.sync !== false && !video.audio?.some((a) => a.sync)) {
    const w = buildWarp(syncMoments(video, layout.scenes), scoreBeats(video.score, layout.duration), layout.duration);
    timings = layout.scenes.map((tm) => {
      const start = toOutput(w, tm.start);
      const end = toOutput(w, tm.end);
      return { ...tm, start, end, duration: end - start };
    });
    duration = toOutput(w, layout.duration);
  }
  const plan = scorePlan(video, timings, duration);
  const seed = video.score.seed ?? sfxSeed(video.title ?? basename(specPath));
  await writeWav(resolve(out), renderScore(video.score, plan, seed), plan.duration);
  return { plan, key: `${NAMES[scoreKey(video.score, seed)]} ${video.score.mode ?? 'major'}` };
}
