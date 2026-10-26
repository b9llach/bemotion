/**
 * Audio-reactive layers: the beat pulse and loudness envelopes, the validate warning without music,
 * envelope analysis of a file, and renders where a layer's pulse peaks land on the beats of a click
 * track in output time (also with music sync warping time) and on a generated score's beat grid.
 * Run: npx tsx scripts/test-react.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { beatPulse, envelopeAt, applyReact } from '../src/engine/anim/react';
import { computeEnvelope } from '../src/audio/envelope';
import { analyzeEnvelope } from '../src/cli/envelope';
import { runFfmpeg } from '../src/cli/ffmpeg';
import { reactWarnings } from '../src/spec/react';
import { validateVideo, type Video } from '../src/spec/schema';
import { startServer } from '../src/cli/server';
import { BROWSER_ARGS, openPage } from '../src/cli/render';
import type { InspectInfo } from '../src/engine/engine';

let failed = 0;
let n = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  n++;
  try {
    await fn();
    console.log(`ok  ${n}. ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${n}. ${name}\n     ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

await check('the beat pulse peaks exactly on each beat and decays', () => {
  const beats = [1, 1.5, 2, 2.5];
  assert(beatPulse(beats, 1.5) === 1, 'peak on the beat');
  assert(beatPulse(beats, 1.48) < 1 && beatPulse(beats, 1.48) > 0.2, 'rises during the attack');
  assert(beatPulse(beats, 1.3) < 0.15, 'mostly gone before the next beat');
  assert(beatPulse(beats, 0.5) === 0, 'nothing before the first beat');
  assert(beatPulse(beats, 2, 0.04, 0.3, 2) === 1 && beatPulse(beats, 1.5, 0.04, 0.3, 2) < 0.2, 'every 2: only even beats');
});

await check('envelopes jump up and fall back over the decay', () => {
  const s = new Array(100).fill(0);
  s[50] = 1;
  assert(Math.abs(envelopeAt(s, 100, 0.5) - 1) < 1e-9, 'peak at its sample');
  const later = envelopeAt(s, 100, 0.5 + 0.12, 0.12);
  assert(later > 0.03 && later < 0.08, `about 5% after the decay (${later.toFixed(3)})`);
  assert(envelopeAt(s, 100, 0.3) === 0 && envelopeAt(s, 100, -1) === 0, 'silent before');
});

await check('react modulates scale and glow by multiplying, opacity by dimming, positions by adding', () => {
  const m = { beats: [1], env: null, envOffset: 0 };
  const on = () => 1;
  assert(applyReact([{ to: 'beat', prop: 'scale', amount: 0.5 }], 'scale', 2, m, on) === 3, 'scale x1.5 on the beat');
  assert(applyReact([{ to: 'beat', prop: 'y', amount: 30 }], 'y', 10, m, on) === 40, 'y + 30');
  assert(applyReact([{ to: 'beat', prop: 'opacity', amount: 0.6 }], 'opacity', 1, m, () => 0.2) === 0.4, 'dimmed between beats');
  assert(applyReact([{ to: 'beat', prop: 'glow', amount: 1 }], 'glow', 1, m, on) === 2, 'glow doubles');
  assert(applyReact([{ to: 'level', prop: 'y', amount: 30 }], 'y', 10, m, on) === 10, 'no envelope: no level');
  assert(applyReact([{ to: 'beat', prop: 'y', amount: 30 }], 'y', 10, null, on) === 10, 'no music: no-op');
});

await check('validate warns about react without music', () => {
  const v = (extra: Record<string, unknown>) => validateVideo({ ...extra, scenes: [{ duration: 1, layers: [{ type: 'shape', shape: 'rect', react: { to: 'beat', prop: 'scale' } }] }] }).video as Video;
  assert(reactWarnings(v({})).length === 1, 'no music: a warning');
  assert(reactWarnings(v({ score: {} })).length === 0, 'a score is music');
  assert(reactWarnings(v({ audio: [{ src: 'm.wav' }] })).length === 0, 'a music track');
  assert(reactWarnings(v({ audio: [{ src: 'v.wav', role: 'voice' }] })).length === 1, 'a voice is not music');
  assert(!validateVideo({ scenes: [{ duration: 1, layers: [{ type: 'shape', react: { to: 'beat', prop: 'width' } }] }] }).ok, 'unknown prop is an error');
});

await check('the bass envelope hears a low tone, not a high one', () => {
  const sr = 11025;
  const x = new Float32Array(sr * 2);
  for (let i = 0; i < sr; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 55 * i) / sr);
  for (let i = sr; i < 2 * sr; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 3000 * i) / sr);
  const e = computeEnvelope(x, sr);
  assert(e.level.length === 200, `100 per second (${e.level.length})`);
  assert(e.level[50] > 0.9 && e.level[150] > 0.9, 'level hears both');
  assert(e.bass[50] > 0.9 && e.bass[150] < 0.1, `bass hears only the low tone (${e.bass[50]}, ${e.bass[150]})`);
});

const DIR = 'out/dev/react-test';
await rm(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
await mkdir(DIR, { recursive: true });

/** Kick on every beat, hats on eighths: beats at first + k * 60 / bpm. */
function groove(file: string, bpm: number, first: number, seconds: number): Promise<void> {
  const B = (60 / bpm).toFixed(5);
  const expr = `0.9*sin(2*PI*55*t)*exp(-20*mod(t-${first},${B}))*gte(t,${first})`
    + `+0.12*sin(2*PI*8000*t+sin(2*PI*11000*t)*5)*exp(-70*mod(t-${first},${B}/2))*gte(t,${first})`;
  return runFfmpeg(['-f', 'lavfi', '-i', `aevalsrc='${expr}':s=44100:d=${seconds}`, file]);
}

/** Beats at 0.3 + 0.5 k. */
const BEATS = Array.from({ length: 12 }, (_, k) => 0.3 + 0.5 * k);
await groove(`${DIR}/g120.wav`, 120, 0.3, 6);

await check('envelope analysis of a file: loud on the kicks, quiet between', async () => {
  const e = await analyzeEnvelope(`${DIR}/g120.wav`);
  const on = BEATS.slice(1, 8).map((b) => envelopeAt(e.bass, e.rate, b + 0.02, 0.01));
  const off = BEATS.slice(1, 8).map((b) => envelopeAt(e.bass, e.rate, b + 0.35, 0.01));
  assert(Math.min(...on) > 0.6, `bass on the kicks (${Math.min(...on).toFixed(2)})`);
  assert(Math.max(...off) < 0.15, `quiet between (${Math.max(...off).toFixed(2)})`);
});

const base = { fps: 50, motionBlur: false, sfx: false, post: { bloom: false, grain: 0, vignette: 0, tonemap: 'none' } };
const pulser = (id: string) => ({ type: 'shape', shape: 'rect', id, width: 200, height: 200, fill: '#7C5CFF', react: { to: 'beat', prop: 'scale', amount: 0.5, decay: 0.25 } });
const leveler = { type: 'shape', shape: 'rect', id: 'lv', x: 500, width: 100, height: 100, fill: '#22D3EE', react: [{ to: 'bass', prop: 'y', amount: 200, decay: 0.1 }] };

await writeFile(`${DIR}/plain.json`, JSON.stringify({ scenes: [{ duration: 1, layers: [] }] }));
const { server, url } = await startServer(`${DIR}/plain.json`, { hmr: false });
const browser = await puppeteer.launch({ headless: true, args: BROWSER_ARGS, protocolTimeout: 600000 });
try {
  /** Widths (and the level square's y) per frame, from the engine's own inspection. */
  const probe = async (spec: unknown) => {
    const { page, info } = await openPage(browser, url, spec);
    const rows: { t: number; w: number; y: number }[] = [];
    for (let f = 0; f < info.frameCount; f++) {
      const r = (await page.evaluate((i) => (window as any).bemotion.probe(i), f)) as { info: InspectInfo };
      const p = r.info.items.find((it) => it.id === 'p');
      const lv = r.info.items.find((it) => it.id === 'lv');
      rows.push({ t: f / info.fps, w: p ? p.box.x1 - p.box.x0 : 0, y: lv ? 540 - (lv.box.y0 + lv.box.y1) / 2 : 0 });
    }
    const cut = (await page.evaluate(() => (window as any).bemotion.when('b', 0))) as number | null;
    await page.close();
    return { rows, cut };
  };
  const peaks = (rows: { t: number; w: number }[]) => rows.filter((r, i) => i > 0 && i < rows.length - 1 && r.w > 230 && r.w >= rows[i - 1].w && r.w > rows[i + 1].w).map((r) => r.t);
  const near = (t: number, beats: number[]) => Math.min(...beats.map((b) => Math.abs(b - t)));

  await check('pulse peaks land on the beats of a music track', async () => {
    const spec = { ...base, title: 'React', audio: [{ src: 'g120.wav' }], scenes: [{ id: 'a', duration: 5, background: '#000000', layers: [pulser('p'), leveler] }] };
    const { rows } = await probe(spec);
    const pk = peaks(rows);
    assert(pk.length >= 8, `a peak per beat (${pk.length}: ${pk.map((t) => t.toFixed(2)).join(' ')})`);
    for (const t of pk) assert(near(t, BEATS) <= 0.045, `peak at ${t.toFixed(2)} s is on a beat`);
    const between = rows.filter((r) => near(r.t, BEATS) > 0.2 && r.t > 0.5).map((r) => r.w);
    assert(Math.max(...between) < 215, `back to size between beats (${Math.max(...between).toFixed(0)})`);
    // Bass: the level square jumps on the kicks.
    const at = (t: number) => rows[Math.round(t * 50)].y;
    assert(at(1.32) > 120 && at(1.7) < 40, `bass lifts the square on a kick (${at(1.32).toFixed(0)}, ${at(1.7).toFixed(0)})`);
  });

  await check('with sync on, the warp moves the cut onto a beat and pulses stay on the beats', async () => {
    const spec = {
      ...base, title: 'React sync', audio: [{ src: 'g120.wav', sync: true }],
      scenes: [
        { id: 'a', duration: 1.9, background: '#000000', layers: [pulser('p')] },
        { id: 'b', duration: 2.6, background: '#000000', transition: { type: 'cut' }, layers: [pulser('p')] },
      ],
    };
    const { rows, cut } = await probe(spec);
    assert(cut !== null && Math.abs(cut - 1.8) < 0.03, `the cut moved to the beat at 1.8 s (${cut})`);
    const pk = peaks(rows);
    assert(pk.length >= 7, `a peak per beat (${pk.length})`);
    for (const t of pk) assert(near(t, BEATS) <= 0.045, `peak at ${t.toFixed(2)} s is on a beat`);
  });

  await check('a generated score: pulses on its beat grid', async () => {
    const spec = { ...base, title: 'React score', score: { tempo: 100, style: 'bright' }, scenes: [{ id: 'a', duration: 4, background: '#000000', layers: [pulser('p'), { ...leveler, react: { to: 'level', prop: 'y', amount: 200 } }] }] };
    const { rows } = await probe(spec);
    const grid = Array.from({ length: 10 }, (_, k) => k * 0.6);
    const pk = peaks(rows);
    assert(pk.length >= 5, `a peak per beat (${pk.length})`);
    for (const t of pk) assert(near(t, grid) <= 0.021, `peak at ${t.toFixed(2)} s is on the grid`);
    const ys = rows.filter((r) => r.t > 0.5 && r.t < 3).map((r) => r.y);
    assert(Math.max(...ys) - Math.min(...ys) > 30, 'the level of the synthesized score moves the square');
  });

  await check('without music, react leaves the layer alone', async () => {
    const spec = { ...base, title: 'React none', scenes: [{ id: 'a', duration: 1, background: '#000000', layers: [pulser('p')] }] };
    const { rows } = await probe(spec);
    assert(rows.every((r) => Math.abs(r.w - 200) < 0.5), 'constant size');
  });
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
  await rm(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

console.log(failed ? `\n${failed} of ${n} react checks failed.` : `\nAll ${n} react checks passed.`);
process.exit(failed ? 1 : 0);
