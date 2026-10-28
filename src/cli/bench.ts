import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generate, pickBackend, reviewTimes, extractJson, askedLength, briefTarget, type GenerateOptions } from './generate';
import { check, findingLines } from './check';
import { captureFrames, still } from './render';
import type { Part } from './backends';
import { validateVideo, type Video } from '../spec/schema';
import { log } from './log';

/**
 * Quality benchmark for `generate`: a fixed set of prompts, each run for real, then measured
 * (validation, length against the brief, check findings) and optionally scored by a judge looking
 * at a contact sheet. Runs are compared against a baseline run to see whether a change to the
 * reference, the techniques or the review loop made ads better or worse.
 */

export interface BenchPrompt {
  id: string;
  prompt: string;
  url?: string;
}

export interface JudgeScores {
  hook: number;
  clarity: number;
  motion: number;
  craft: number;
  overall: number;
  note: string;
}

export interface BenchResult {
  id: string;
  ok: boolean;
  error?: string;
  seconds: number;
  spec?: string;
  sheet?: string;
  /** The format the brief asks for when it is not 16:9; measured and judged in it. */
  format?: string;
  /** Asked-for length from the prompt (seconds), when it names one. */
  asked?: number;
  duration?: number;
  scenes?: number;
  layers?: number;
  layerTypes?: number;
  rushes?: number;
  collisions?: number;
  holds?: number;
  /** Times UI or copy stays too small to read (not part of the score, so runs stay comparable). */
  small?: number;
  /** Nearly empty stretches and stretches that read as slides (also outside the score). */
  empty?: number;
  stale?: number;
  /** Times text or UI is cut off at the frame's edge (also outside the score). */
  cropped?: number;
  /** Times text has too little contrast with what is behind it (also outside the score). */
  contrast?: number;
  findings?: string[];
  judge?: JudgeScores;
  /** Each judging when the ad was judged more than once; `judge` is then their mean. */
  judgeRuns?: JudgeScores[];
  /** What the judge looked at: full-size frames (default) or the contact sheet (runs before frames). */
  judgeMode?: JudgeMode;
  score: number;
}

export interface BenchOptions {
  prompts?: string;
  only?: string[];
  out?: string;
  review?: number;
  backend?: GenerateOptions['backend'];
  model?: string;
  effort?: GenerateOptions['effort'];
  /** Prompts run at the same time. */
  jobs?: number;
  judge?: boolean;
  baseline?: string;
  /** Skip generation: measure the specs an earlier run wrote in `out` again. */
  remeasure?: boolean;
  /** Judge each sheet this many times and keep the mean (measures how much the judge varies). */
  judgeRuns?: number;
  /** Only judge the ads an earlier run left in `out` again: no generation, no measuring. */
  judgeOnly?: boolean;
  /** What the judge looks at: `frames` (full-size frames in time order, the default) or `sheet`. */
  judgeMode?: JudgeMode;
}

export type JudgeMode = 'frames' | 'sheet';

export { askedLength };

function countLayers(v: Video): { layers: number; types: number } {
  const types = new Set<string>();
  let layers = 0;
  const walk = (list: any[] | undefined) => {
    for (const l of list ?? []) {
      layers++;
      types.add(l.type);
      walk(l.children);
      walk(l.layers);
    }
  };
  for (const s of v.scenes as any[]) walk(s.layers);
  return { layers, types: types.size };
}

/**
 * One number per ad, 0-100. With a judge, its overall score (1-10) sets the base; without one the
 * base is 100. Measured problems take points off: collisions and rushed text hurt most, then
 * dead stretches, then missing the asked length by more than 15 percent.
 */
export function benchScore(r: Pick<BenchResult, 'ok' | 'collisions' | 'rushes' | 'holds' | 'asked' | 'duration' | 'judge'>): number {
  if (!r.ok) return 0;
  let s = r.judge ? r.judge.overall * 10 : 100;
  s -= 5 * Math.min(4, r.collisions ?? 0);
  s -= 4 * Math.min(4, r.rushes ?? 0);
  s -= 3 * Math.min(3, r.holds ?? 0);
  if (r.asked && r.duration) {
    const off = Math.abs(r.duration - r.asked) / r.asked;
    if (off > 0.15) s -= Math.min(15, Math.round((off - 0.15) * 50));
  }
  return Math.max(0, Math.round(s));
}

const JUDGE = `You are a strict creative director judging motion-graphics ads for SaaS products. You see one contact sheet of frames from an ad, in time order, with timestamps, and the brief it was made from. Score it as a finished launch ad you would or would not ship, comparing against the best launch films (Linear, Stripe, Apple).

Reply with only a JSON object:
{"hook": 1-10, "clarity": 1-10, "motion": 1-10, "craft": 1-10, "overall": 1-10, "note": "one sentence: the biggest problem, or what makes it work"}

hook: do the first frames grab attention. clarity: is it obvious what the product does and who it is for. motion: does the sequence suggest intentional movement and transitions, not slides. craft: typography, layout, contrast, spacing, nothing cut off or crowded. overall: would you ship it. Use the full range; 5 is mediocre, 8 is shippable, 10 is exceptional.`;

const JUDGE_FRAMES = JUDGE.replace(
  'You see one contact sheet of frames from an ad, in time order, with timestamps, and the brief it was made from.',
  'You see full-size frames from an ad in time order, each labelled with its time: two from the opening second and a half, then the middle and the settled end of each scene, and frames halfway through transitions that show how one scene hands off to the next. You also get the brief it was made from. Judge text at the size it is on screen; a viewer sees the ad full screen on a phone or a laptop.',
);

/** The frames the judge sees: the opening, then the review frames (middle, settled, halfway through transitions). */
export function judgeTimes(video: Video): { t: number; label: string }[] {
  const shots = [
    { t: 0.6, label: 'opening at 0.60s' },
    { t: 1.5, label: 'opening at 1.50s' },
    ...reviewTimes(video, 18),
  ].sort((a, b) => a.t - b.t);
  return shots.filter((s, i) => i === 0 || s.t - shots[i - 1].t >= 0.25);
}

/** What one judging looks at: the image parts, made once and shown to every judging. */
async function judgeParts(mode: JudgeMode, dir: string, spec: string | undefined, format: string | undefined): Promise<Part[]> {
  if (mode === 'sheet') {
    const sheet = join(dir, 'sheet.png');
    return [{ type: 'image', mediaType: 'image/png', data: await readFile(sheet), file: sheet }];
  }
  if (!spec) throw new Error('no spec to render frames from');
  const v = validateVideo(JSON.parse(await readFile(spec, 'utf8')));
  if (!v.ok || !v.video) throw new Error('invalid spec');
  const shots = judgeTimes(v.video);
  const frames = await captureFrames(spec, v.video, shots.map((s) => s.t), 0.85, format);
  const parts: Part[] = [];
  frames.forEach((data, i) => {
    parts.push({ type: 'text', text: `Frame ${i + 1}: ${shots[i].label}` });
    parts.push({ type: 'image', mediaType: 'image/jpeg', data });
  });
  return parts;
}

async function judgeOnce(images: Part[], mode: JudgeMode, prompt: string, o: BenchOptions, workDir: string): Promise<JudgeScores> {
  const backend = pickBackend({ out: '', backend: o.backend, model: o.model, effort: 'medium' }, { role: mode === 'sheet' ? JUDGE : JUDGE_FRAMES, reference: '' }, workDir);
  const text = await backend.send(
    [...images, { type: 'text', text: `<brief>\n${prompt}\n</brief>\n\nScore this ad. Reply with the JSON object only.` }],
    'Judging',
  );
  const raw = extractJson(text) ?? text;
  const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  const n = (x: unknown) => Math.max(1, Math.min(10, Number(x) || 1));
  return { hook: n(j.hook), clarity: n(j.clarity), motion: n(j.motion), craft: n(j.craft), overall: n(j.overall), note: String(j.note ?? '').slice(0, 300) };
}

/** Judges an ad `runs` times; one result, or the mean of several with each kept in `judgeRuns`. */
async function judgeMany(dir: string, spec: string | undefined, format: string | undefined, prompt: string, o: BenchOptions): Promise<{ judge: JudgeScores; runs?: JudgeScores[] }> {
  const mode = o.judgeMode ?? 'frames';
  const images = await judgeParts(mode, dir, spec, format);
  const workDir = join(dir, '.judge');
  const n = Math.max(1, o.judgeRuns ?? 1);
  const runs: JudgeScores[] = [];
  let last: Error | undefined;
  for (let i = 0; i < n; i++) {
    try {
      runs.push(await judgeOnce(images, mode, prompt, o, join(workDir, n > 1 ? `run${i + 1}` : '')));
    } catch (e) {
      last = e as Error;
    }
  }
  if (!runs.length) throw last ?? new Error('judge failed');
  if (runs.length === 1) return { judge: runs[0] };
  const avg = (k: keyof Omit<JudgeScores, 'note'>) => Number((runs.reduce((a, r) => a + r[k], 0) / runs.length).toFixed(2));
  return { judge: { hook: avg('hook'), clarity: avg('clarity'), motion: avg('motion'), craft: avg('craft'), overall: avg('overall'), note: runs[0].note }, runs };
}

async function runOne(p: BenchPrompt, dir: string, o: BenchOptions, earlier?: BenchResult): Promise<BenchResult> {
  const started = Date.now();
  const brief = p.url ? `${p.prompt} (website: ${p.url})` : p.prompt;
  if (o.judgeOnly) {
    const need = (o.judgeMode ?? 'frames') === 'sheet' ? join(dir, 'sheet.png') : join(dir, 'ad.json');
    if (!earlier?.ok || !existsSync(need)) return { ...(earlier ?? { id: p.id, ok: false, seconds: 0, score: 0 }), error: earlier?.error ?? `no ${need.endsWith('.png') ? 'contact sheet' : 'spec'} from an earlier run` };
    const r: BenchResult = { ...earlier, judge: undefined, judgeRuns: undefined, judgeMode: o.judgeMode ?? 'frames' };
    try {
      const j = await judgeMany(dir, join(dir, 'ad.json'), briefTarget(p.prompt).format, brief, o);
      r.judge = j.judge;
      r.judgeRuns = j.runs;
    } catch (e) {
      log.warn(`${p.id}: judge failed: ${(e as Error).message}`);
    }
    r.score = benchScore(r);
    return r;
  }
  const specPath = join(dir, 'ad.json');
  const r: BenchResult = { id: p.id, ok: false, seconds: 0, score: 0, asked: askedLength(p.prompt) };
  try {
    if (!o.remeasure) {
      await mkdir(dir, { recursive: true });
      await generate(p.prompt, { out: specPath, url: p.url, review: o.review ?? 2, backend: o.backend, model: o.model, effort: o.effort });
    } else if (!existsSync(specPath)) throw new Error('no spec from an earlier run');
    r.seconds = Math.round((Date.now() - started) / 1000);
    r.spec = specPath;
    const v = validateVideo(JSON.parse(await readFile(specPath, 'utf8')));
    if (!v.ok || !v.video) throw new Error(`invalid spec: ${v.errors.slice(0, 3).join('; ')}`);
    const counts = countLayers(v.video);
    r.scenes = v.video.scenes.length;
    r.layers = counts.layers;
    r.layerTypes = counts.types;
    // A brief for vertical (or square) video is measured and judged in that format.
    const target = briefTarget(p.prompt);
    r.format = target.format;
    const c = await check(specPath, { format: target.format, platforms: target.platforms });
    r.duration = Number(c.duration.toFixed(2));
    r.rushes = c.rushes.length;
    r.collisions = c.collisions.length;
    r.holds = c.holds.length;
    r.small = c.small.length;
    r.empty = c.empty.length;
    r.stale = c.stale.length;
    r.cropped = c.cropped.length;
    r.contrast = c.contrast.length;
    r.findings = findingLines(c);
    const times = reviewTimes(v.video, 12).filter((s) => !s.label.includes('halfway')).map((s) => Number(s.t.toFixed(2)));
    r.sheet = join(dir, 'sheet.png');
    await still(specPath, times, join(dir, 'frames', 'f_{t}.png'), { sheet: r.sheet, cols: target.format === '9:16' ? 6 : 4, format: target.format });
    r.ok = true;
    // Measuring again without judging keeps the earlier judge's scores, so scores stay comparable.
    if (!o.judge && o.remeasure && earlier?.judge) {
      r.judge = earlier.judge;
      r.judgeRuns = earlier.judgeRuns;
      r.judgeMode = earlier.judgeMode;
    }
    if (o.judge) {
      try {
        const j = await judgeMany(dir, specPath, target.format, brief, o);
        r.judge = j.judge;
        r.judgeRuns = j.runs;
        r.judgeMode = o.judgeMode ?? 'frames';
      } catch (e) {
        log.warn(`${p.id}: judge failed: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    r.error = (e as Error).message.split('\n')[0].slice(0, 300);
    if (!r.seconds) r.seconds = Math.round((Date.now() - started) / 1000);
  }
  r.score = benchScore(r);
  return r;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Which judge scored the run, and a warning when the baseline's judge looked at something else. */
function judgeNote(results: BenchResult[], baseline?: BenchResult[]): string[] {
  const modes = (rs: BenchResult[]) => new Set(rs.filter((r) => r.judge).map((r) => r.judgeMode ?? 'sheet'));
  const mine = modes(results);
  if (!mine.size) return [];
  const say = (m: Set<string>) => [...m].map((x) => (x === 'sheet' ? 'contact sheets' : 'full-size frames')).join(' and ');
  let line = `Judged from ${say(mine)}.`;
  const theirs = baseline ? modes(baseline) : new Set<string>();
  if (theirs.size && [...theirs].sort().join() !== [...mine].sort().join()) {
    line += ` The baseline was judged from ${say(theirs)}, so judge scores do not compare; judge one run again with --judge-only --judge-mode ${[...mine][0]}.`;
  }
  return [line, ''];
}

export function benchReport(results: BenchResult[], baseline?: BenchResult[]): string {
  const base = new Map((baseline ?? []).map((b) => [b.id, b]));
  const ok = results.filter((r) => r.ok);
  const lines = [
    '# Generate benchmark',
    '',
    `${ok.length} of ${results.length} prompts produced a valid ad. Mean score ${mean(results.map((r) => r.score)).toFixed(1)}${baseline ? ` (baseline ${mean(results.map((r) => base.get(r.id)?.score ?? 0)).toFixed(1)})` : ''}.`,
    '',
    ...judgeNote(results, baseline),
    `Mean per ad: ${mean(ok.map((r) => r.collisions ?? 0)).toFixed(2)} collisions, ${mean(ok.map((r) => r.rushes ?? 0)).toFixed(2)} rushed texts, ${mean(ok.map((r) => r.holds ?? 0)).toFixed(2)} dead stretches, ${mean(ok.map((r) => r.small ?? 0)).toFixed(2)} too small to read, ${mean(ok.map((r) => r.empty ?? 0)).toFixed(2)} nearly empty, ${mean(ok.map((r) => r.stale ?? 0)).toFixed(2)} slides, ${mean(ok.map((r) => r.cropped ?? 0)).toFixed(2)} cut off at the edge, ${mean(ok.map((r) => r.contrast ?? 0)).toFixed(2)} low contrast, ${mean(results.map((r) => r.seconds)).toFixed(0)} s to generate.`,
    '',
    '| prompt | score | change | judge | length | collisions | rushed | holds | small | empty | slides | cropped | contrast | note |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    const b = base.get(r.id);
    const delta = b ? r.score - b.score : undefined;
    const len = r.duration !== undefined ? `${r.duration.toFixed(1)}s${r.asked ? ` / ${r.asked}s` : ''}` : '';
    const note = r.error ? `failed: ${r.error}` : (r.judge?.note ?? '');
    lines.push(`| ${r.id} | ${r.score} | ${delta === undefined ? '' : delta > 0 ? `+${delta}` : String(delta)} | ${r.judge ? r.judge.overall : ''} | ${len} | ${r.collisions ?? ''} | ${r.rushes ?? ''} | ${r.holds ?? ''} | ${r.small ?? ''} | ${r.empty ?? ''} | ${r.stale ?? ''} | ${r.cropped ?? ''} | ${r.contrast ?? ''} | ${note.replace(/\|/g, '/')} |`);
  }
  const noise = judgeNoise(results);
  if (noise) {
    lines.push('', '## Judge noise', '');
    lines.push(`Each sheet was judged ${noise.runs} times. Between judgings of the same ad, the overall score (1-10) has a standard deviation of ${noise.sd.toFixed(2)} (hook ${noise.dims.hook.toFixed(2)}, clarity ${noise.dims.clarity.toFixed(2)}, motion ${noise.dims.motion.toFixed(2)}, craft ${noise.dims.craft.toFixed(2)}); the widest spread was ${noise.widest.spread} on ${noise.widest.id}.`);
    lines.push('');
    lines.push(`For two runs of ${noise.ads} ads judged once each, a change in the mean score under about ${noise.once.toFixed(1)} points is within the judge's noise alone (two standard errors); judged ${noise.runs} times each, under about ${noise.averaged.toFixed(1)}. Generation varies from run to run as well, so the real thresholds are higher.`);
  }
  return lines.join('\n') + '\n';
}

/**
 * How much the judge varies on the same sheet, from results judged more than once: the pooled
 * standard deviation per dimension, and the smallest change in a run's mean score (0-100) that
 * stands out from that noise at two standard errors.
 */
export function judgeNoise(results: BenchResult[]): { runs: number; ads: number; sd: number; dims: Record<'hook' | 'clarity' | 'motion' | 'craft', number>; widest: { id: string; spread: number }; once: number; averaged: number } | undefined {
  const multi = results.filter((r) => (r.judgeRuns?.length ?? 0) > 1);
  if (!multi.length) return undefined;
  const pooled = (k: keyof Omit<JudgeScores, 'note'>) => {
    let ss = 0;
    let df = 0;
    for (const r of multi) {
      const xs = r.judgeRuns!.map((j) => j[k]);
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      ss += xs.reduce((a, x) => a + (x - m) ** 2, 0);
      df += xs.length - 1;
    }
    return Math.sqrt(ss / Math.max(1, df));
  };
  const sd = pooled('overall');
  let widest = { id: '', spread: -1 };
  for (const r of multi) {
    const xs = r.judgeRuns!.map((j) => j.overall);
    const spread = Math.max(...xs) - Math.min(...xs);
    if (spread > widest.spread) widest = { id: r.id, spread };
  }
  const runs = Math.round(multi.reduce((a, r) => a + r.judgeRuns!.length, 0) / multi.length);
  const ads = results.filter((r) => r.ok).length || multi.length;
  // Score = overall x 10; the mean of a difference over `ads` ads, each side judged once or `runs` times.
  const se = (k: number) => 10 * sd * Math.sqrt(2 / (ads * k));
  return { runs, ads, sd, dims: { hook: pooled('hook'), clarity: pooled('clarity'), motion: pooled('motion'), craft: pooled('craft') }, widest, once: 2 * se(1), averaged: 2 * se(runs) };
}

async function pool<T, R>(items: T[], jobs: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function bench(o: BenchOptions = {}): Promise<{ dir: string; results: BenchResult[]; report: string }> {
  const all: BenchPrompt[] = JSON.parse(await readFile(resolve(o.prompts ?? 'bench/prompts.json'), 'utf8'));
  const picked = o.only?.length ? all.filter((p) => o.only!.includes(p.id)) : all;
  if (!picked.length) throw new Error(`No prompts match ${o.only?.join(', ')}. Ids: ${all.map((p) => p.id).join(', ')}`);
  const dir = resolve(o.out ?? join('out/bench', new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')));
  await mkdir(dir, { recursive: true });
  const earlierFile = join(dir, 'results.json');
  const saved: BenchResult[] = existsSync(earlierFile) ? JSON.parse(await readFile(earlierFile, 'utf8')) : [];
  // Remeasuring and judging again build on the earlier results; a fresh run starts over.
  const earlier = o.remeasure || o.judgeOnly ? saved : [];
  log.step(`Benchmark: ${picked.length} prompt${picked.length === 1 ? '' : 's'} into ${dir}`);
  const results = await pool(picked, o.jobs ?? 2, async (p) => {
    const r = await runOne(p, join(dir, p.id), o, earlier.find((e) => e.id === p.id));
    if (r.ok) log.success(`${p.id}: score ${r.score}${r.judge ? ` (judge ${r.judge.overall})` : ''}, ${r.findings?.length ?? 0} findings, ${r.seconds}s`);
    else log.error(`${p.id}: ${r.error}`);
    return r;
  });
  let baseline: BenchResult[] | undefined;
  if (o.baseline) baseline = JSON.parse(await readFile(join(resolve(o.baseline), 'results.json'), 'utf8'));
  // Prompts not run this time keep their earlier results in the folder, in prompt order.
  const ran = new Set(results.map((r) => r.id));
  const order = new Map(all.map((p, i) => [p.id, i]));
  const merged = [...saved.filter((r) => !ran.has(r.id)), ...results].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
  const report = benchReport(merged, baseline);
  await writeFile(join(dir, 'results.json'), JSON.stringify(merged, null, 2) + '\n');
  await writeFile(join(dir, 'report.md'), report);
  return { dir, results, report };
}
