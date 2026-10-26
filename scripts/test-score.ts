/**
 * Generated scores (`score` on the video): the plan, the composition and the synthesis.
 * Run: npx tsx scripts/test-score.ts
 */
import { composeScore, renderScore, scoreKey } from '../src/audio/music';
import { buildWarp, syncMoments, toOutput } from '../src/spec/beatsync';
import { validateVideo, type Video } from '../src/spec/schema';
import { scoreBeats, scorePlan } from '../src/spec/score';
import { layoutScenes } from '../src/spec/time';

let failed = 0;
let n = 0;
function check(name: string, fn: () => void): void {
  n++;
  try {
    fn();
    console.log(`ok  ${n}. ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${n}. ${name}\n     ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function video(score: Record<string, unknown>): Video {
  const spec = {
    title: 'Score test',
    score,
    scenes: [
      { id: 'hook', duration: 6.3, layers: [{ type: 'text', text: 'One', start: 1.1 }] },
      { id: 'build', duration: 7.6, transition: { type: 'fade', duration: 0.6 }, layers: [{ type: 'text', text: 'Two', start: 0.9 }, { type: 'text', text: 'Three', start: 3.2 }] },
      { id: 'peak', duration: 8.2, layers: [{ type: 'text', text: 'Four' }] },
      { id: 'logo', duration: 5.5, transition: { type: 'fade', duration: 0.6 }, layers: [{ type: 'text', text: 'Five' }] },
    ],
  };
  const v = validateVideo(spec);
  if (!v.ok || !v.video) throw new Error(v.errors.join('\n'));
  return v.video;
}

/** The plan as the engine builds it: cuts warped onto the score's beats. */
function planFor(v: Video) {
  const layout = layoutScenes(v.scenes, { fps: 30 });
  const w = buildWarp(syncMoments(v, layout.scenes), scoreBeats(v.score!, layout.duration), layout.duration);
  const timings = layout.scenes.map((tm) => ({ ...tm, start: toOutput(w, tm.start), end: toOutput(w, tm.end) }));
  return { plan: scorePlan(v, timings, toOutput(w, layout.duration)), timings };
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const PITCHED = new Set(['keys', 'piano', 'pad', 'pluck', 'stab', 'bass', 'bell']);

check('validation: score fields, and energy names real scenes', () => {
  const bad = validateVideo({ score: { style: 'warm', energy: { nowhere: 0.5 } }, scenes: [{ id: 'a', duration: 2, layers: [] }] });
  assert(!bad.ok && bad.errors.some((e) => e.includes('no scene "nowhere"')), `expected an energy error, got ${bad.errors.join('; ')}`);
  const unknown = validateVideo({ score: { style: 'jazz' }, scenes: [{ duration: 2, layers: [] }] });
  assert(!unknown.ok, 'an unknown style should fail');
  assert(validateVideo({ score: { energy: { '1': 0.9 } }, scenes: [{ duration: 2, layers: [] }, { duration: 2, layers: [] }] }).ok, 'an index should work');
});

check('cuts land on the beats of the score (sync)', () => {
  const v = video({ style: 'warm', tempo: 90 });
  const { timings } = planFor(v);
  const spb = 60 / 90;
  for (const tm of timings.slice(1)) {
    const off = Math.abs(tm.start / spb - Math.round(tm.start / spb));
    assert(off < 1e-6, `scene at ${tm.start.toFixed(3)}s is ${off.toFixed(3)} beats off the grid`);
  }
});

check('plan: a section per scene, the default arc builds and settles, overrides win', () => {
  const { plan } = planFor(video({ style: 'warm' }));
  assert(plan.sections.length === 4, `${plan.sections.length} sections`);
  const e = plan.sections.map((s) => s.energy);
  assert(e[0] < e[1] && e[1] < e[2] && e[3] < e[2], `energy ${e.join(', ')}`);
  const over = planFor(video({ energy: { peak: 0.3, '0': 0.9 } })).plan.sections;
  assert(over[2].energy === 0.3 && over[0].energy === 0.9, 'overrides by id and index');
});

for (const style of ['warm', 'ambient', 'bright', 'cinematic', 'lofi', 'piano'] as const) {
  for (const mode of ['major', 'minor'] as const) {
    check(`${style} ${mode}: every note in key, chords change on the cuts, no drums over the ending`, () => {
      const v = video({ style, mode });
      const { plan } = planFor(v);
      const seed = 4242;
      const notes = composeScore(v.score!, plan, seed);
      const key = scoreKey(v.score!, seed);
      const scale = (mode === 'minor' ? MINOR : MAJOR).map((x) => (x + key) % 12);
      for (const nt of notes) {
        if (PITCHED.has(nt.inst)) assert(scale.includes(((nt.midi % 12) + 12) % 12), `${nt.inst} ${nt.midi} at ${nt.t.toFixed(2)} is out of key`);
      }
      for (const s of plan.sections) {
        assert(notes.some((nt) => nt.inst === 'pad' && Math.abs(nt.t - s.start) < 1e-6), `no chord at the ${s.id} cut (${s.start.toFixed(2)}s)`);
      }
      const end = plan.sections[plan.sections.length - 1].start;
      const drums = notes.filter((nt) => ['kick', 'snare', 'clap', 'shaker'].includes(nt.inst));
      assert(drums.every((d) => d.t < end), 'drums play over the final scene');
      if (style === 'ambient' || style === 'cinematic' || style === 'piano') assert(drums.length === 0, `${style} has drums`);
      else assert(drums.length > 0, `${style} has no drums`);
    });
  }
}

check('synthesis: deterministic, finite, at a steady level, below full scale', () => {
  const v = video({ style: 'warm' });
  const { plan } = planFor(v);
  const a = renderScore(v.score!, plan, 7);
  const b = renderScore(v.score!, plan, 7);
  assert(a.l.length === Math.ceil(plan.duration * 48000), 'length');
  let same = true;
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < a.l.length; i++) {
    if (a.l[i] !== b.l[i] || a.r[i] !== b.r[i]) same = false;
    assert(Number.isFinite(a.l[i]) && Number.isFinite(a.r[i]), `sample ${i} is not finite`);
    peak = Math.max(peak, Math.abs(a.l[i]), Math.abs(a.r[i]));
    sum += a.l[i] ** 2;
  }
  const rmsDb = 10 * Math.log10(sum / a.l.length);
  assert(same, 'two renders differ');
  assert(peak < 0.95, `peak ${peak.toFixed(3)}`);
  assert(rmsDb > -24 && rmsDb < -15, `RMS ${rmsDb.toFixed(1)} dB`);
  const other = renderScore(v.score!, plan, 8);
  assert(other.l.some((x, i) => x !== a.l[i]), 'a different seed gives the same music');
});

check('under a voiceover: no melody or backbeat while it speaks, the band plays on around it', () => {
  const v = video({ style: 'warm', energy: { hook: 0.9, build: 0.9, peak: 0.9 } });
  const { plan } = planFor(v);
  const quiet = composeScore(v.score!, plan, 11);
  const spans: [number, number][] = [[2, 8]];
  const voiced = composeScore(v.score!, { ...plan, voice: spans }, 11);
  const inSpan = (n: { t: number; dur: number }) => n.t < 8.15 && n.t + n.dur > 1.85;
  assert(!voiced.some((n) => inSpan(n) && (n.inst === 'snare' || (n.inst === 'bell' && n.midi >= 72))), 'melody or backbeat under the voice');
  assert(quiet.some((n) => inSpan(n) && n.inst === 'snare'), 'the plain score has a backbeat there');
  assert(voiced.some((n) => n.t > 9 && n.inst === 'snare'), 'the backbeat returns after the voice');
  assert(voiced.some((n) => inSpan(n) && n.inst === 'pad'), 'the pad keeps playing under the voice');
});

check('styles sound different: lofi is darker and slower than bright, cinematic has strings and booms', () => {
  const plans = Object.fromEntries((['bright', 'lofi', 'cinematic'] as const).map((st) => [st, planFor(video({ style: st }))]));
  assert(plans.lofi.plan.bpm < plans.bright.plan.bpm, 'tempo');
  const cine = composeScore({ style: 'cinematic' }, plans.cinematic.plan, 5);
  assert(cine.some((n) => n.inst === 'stab') && cine.some((n) => n.inst === 'boom'), 'cinematic parts');
  const lofi = renderScore({ style: 'lofi' }, plans.lofi.plan, 5);
  const bright = renderScore({ style: 'bright' }, plans.bright.plan, 5);
  // Energy above 8 kHz relative to the whole, in dB (four cascaded one-pole high-passes).
  const hf = (x: Float32Array) => {
    const k = Math.exp((-2 * Math.PI * 8000) / 48000);
    const st = [0, 0, 0, 0];
    let hi = 0;
    let all = 0;
    for (const v of x) {
      let h = v;
      for (let j = 0; j < 4; j++) {
        st[j] = (1 - k) * h + k * st[j];
        h -= st[j];
      }
      hi += h * h;
      all += v * v;
    }
    return 10 * Math.log10(hi / all);
  };
  assert(hf(lofi.l) < hf(bright.l) - 6, `above 8 kHz: lofi ${hf(lofi.l).toFixed(1)} dB vs bright ${hf(bright.l).toFixed(1)} dB`);
});

console.log(failed ? `\n${failed} of ${n} score checks failed.` : `\nAll ${n} score checks passed.`);
process.exit(failed ? 1 : 0);
