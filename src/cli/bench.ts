import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generate, pickBackend, reviewTimes, extractJson, type GenerateOptions } from './generate';
import { check, findingLines } from './check';
import { still } from './render';
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
  findings?: string[];
  judge?: JudgeScores;
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
}

/** Seconds the prompt asks for ("a 20 second ad", "30s", "15-second"). */
export function askedLength(prompt: string): number | undefined {
  const m = /(\d{1,3})\s*(?:-\s*)?(?:s\b|sec\b|secs\b|second)/i.exec(prompt);
  return m ? Number(m[1]) : undefined;
}

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

async function judgeSheet(sheet: string, prompt: string, o: BenchOptions, workDir: string): Promise<JudgeScores> {
  const backend = pickBackend({ out: '', backend: o.backend, model: o.model, effort: 'medium' }, { role: JUDGE, reference: '' }, workDir);
  const text = await backend.send(
    [
      { type: 'image', mediaType: 'image/png', data: await readFile(sheet), file: sheet },
      { type: 'text', text: `<brief>\n${prompt}\n</brief>\n\nScore this ad. Reply with the JSON object only.` },
    ],
    'Judging',
  );
  const raw = extractJson(text) ?? text;
  const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  const n = (x: unknown) => Math.max(1, Math.min(10, Number(x) || 1));
  return { hook: n(j.hook), clarity: n(j.clarity), motion: n(j.motion), craft: n(j.craft), overall: n(j.overall), note: String(j.note ?? '').slice(0, 300) };
}

async function runOne(p: BenchPrompt, dir: string, o: BenchOptions, earlier?: BenchResult): Promise<BenchResult> {
  const started = Date.now();
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
    const c = await check(specPath);
    r.duration = Number(c.duration.toFixed(2));
    r.rushes = c.rushes.length;
    r.collisions = c.collisions.length;
    r.holds = c.holds.length;
    r.small = c.small.length;
    r.findings = findingLines(c);
    const times = reviewTimes(v.video, 12).filter((s) => !s.label.includes('halfway')).map((s) => Number(s.t.toFixed(2)));
    r.sheet = join(dir, 'sheet.png');
    await still(specPath, times, join(dir, 'frames', 'f_{t}.png'), { sheet: r.sheet, cols: 4 });
    r.ok = true;
    // Measuring again without judging keeps the earlier judge's scores, so scores stay comparable.
    if (!o.judge && o.remeasure && earlier?.judge) r.judge = earlier.judge;
    if (o.judge) {
      try {
        r.judge = await judgeSheet(r.sheet, p.url ? `${p.prompt} (website: ${p.url})` : p.prompt, o, join(dir, '.judge'));
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

export function benchReport(results: BenchResult[], baseline?: BenchResult[]): string {
  const base = new Map((baseline ?? []).map((b) => [b.id, b]));
  const ok = results.filter((r) => r.ok);
  const lines = [
    '# Generate benchmark',
    '',
    `${ok.length} of ${results.length} prompts produced a valid ad. Mean score ${mean(results.map((r) => r.score)).toFixed(1)}${baseline ? ` (baseline ${mean(results.map((r) => base.get(r.id)?.score ?? 0)).toFixed(1)})` : ''}.`,
    '',
    `Mean per ad: ${mean(ok.map((r) => r.collisions ?? 0)).toFixed(2)} collisions, ${mean(ok.map((r) => r.rushes ?? 0)).toFixed(2)} rushed texts, ${mean(ok.map((r) => r.holds ?? 0)).toFixed(2)} dead stretches, ${mean(ok.map((r) => r.small ?? 0)).toFixed(2)} too small to read, ${mean(results.map((r) => r.seconds)).toFixed(0)} s to generate.`,
    '',
    '| prompt | score | change | judge | length | collisions | rushed | holds | small | note |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    const b = base.get(r.id);
    const delta = b ? r.score - b.score : undefined;
    const len = r.duration !== undefined ? `${r.duration.toFixed(1)}s${r.asked ? ` / ${r.asked}s` : ''}` : '';
    const note = r.error ? `failed: ${r.error}` : (r.judge?.note ?? '');
    lines.push(`| ${r.id} | ${r.score} | ${delta === undefined ? '' : delta > 0 ? `+${delta}` : String(delta)} | ${r.judge ? r.judge.overall : ''} | ${len} | ${r.collisions ?? ''} | ${r.rushes ?? ''} | ${r.holds ?? ''} | ${r.small ?? ''} | ${note.replace(/\|/g, '/')} |`);
  }
  return lines.join('\n') + '\n';
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
  const earlier: BenchResult[] = o.remeasure && existsSync(earlierFile) ? JSON.parse(await readFile(earlierFile, 'utf8')) : [];
  log.step(`Benchmark: ${picked.length} prompt${picked.length === 1 ? '' : 's'} into ${dir}`);
  const results = await pool(picked, o.jobs ?? 2, async (p) => {
    const r = await runOne(p, join(dir, p.id), o, earlier.find((e) => e.id === p.id));
    if (r.ok) log.success(`${p.id}: score ${r.score}${r.judge ? ` (judge ${r.judge.overall})` : ''}, ${r.findings?.length ?? 0} findings, ${r.seconds}s`);
    else log.error(`${p.id}: ${r.error}`);
    return r;
  });
  let baseline: BenchResult[] | undefined;
  if (o.baseline) baseline = JSON.parse(await readFile(join(resolve(o.baseline), 'results.json'), 'utf8'));
  const report = benchReport(results, baseline);
  await writeFile(join(dir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  await writeFile(join(dir, 'report.md'), report);
  return { dir, results, report };
}
