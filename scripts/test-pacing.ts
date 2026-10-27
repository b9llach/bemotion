/**
 * Nearly empty frames and stretches that read as slides, on synthetic samples: coverage on the grid,
 * a big word alone passing, the opening and transitions left out, new content or a large picture
 * change resetting a slide, the end card and motion holds left out, and the finding lines.
 * Run: npx tsx scripts/test-pacing.ts
 */
import { coverage, findEmpty, findStale, findingLines, type Probe } from '../src/cli/check';
import type { InspectItem } from '../src/engine/engine';

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

const frame = { width: 1920, height: 1080 };
let uid = 0;
const shape = (x0: number, y0: number, x1: number, y1: number): InspectItem => ({ uid: uid++, anc: [], type: 'shape', order: 0, opacity: 1, box: { x0, y0, x1, y1 } });
const text = (t: string, px: number, box = { x0: 700, y0: 480, x1: 1220, y1: 600 }): InspectItem => ({ uid: uid++, anc: [], type: 'text', order: 0, opacity: 1, box, text: t, px });
const thumb = (v: number) => new Array(192 * 108).fill(v);
const run = (scene: string, from: number, to: number, items: InspectItem[], shade = 200, transition = false): Probe[] => {
  const out: Probe[] = [];
  for (let t = from; t < to - 1e-9; t += 0.1) out.push({ t: Math.round(t * 100) / 100, info: { scene, transition, items }, thumb: thumb(shade) });
  return out;
};

check('coverage: boxes on a 64 x 36 grid, full-frame layers left out', () => {
  const quarter = coverage([shape(0, 0, 960, 540)], frame);
  assert(Math.abs(quarter - 0.25) < 0.01, `quarter ${quarter}`);
  assert(coverage([shape(0, 0, 1920, 1080)], frame) === 0, 'full frame left out');
  assert(coverage([{ ...shape(0, 0, 960, 540), opacity: 0.3 }], frame) === 0, 'faint layers left out');
});

check('a lone sparkle for 1.5 s is nearly empty; a big word alone or a filled frame is not', () => {
  const sparkle = shape(940, 520, 980, 560);
  const e = findEmpty([...run('a', 0, 1, [text('Hello there', 120)]), ...run('a', 1, 2.5, [sparkle]), ...run('a', 2.5, 4, [text('Next', 120)])], frame);
  assert(e.length === 1 && e[0].from === 1 && Math.abs(e[0].to - 2.5) < 0.01, JSON.stringify(e));
  assert(findEmpty(run('a', 0, 3, [text('Now.', 160, { x0: 860, y0: 470, x1: 1060, y1: 610 })]), frame).length === 0, 'one big word');
  assert(findEmpty(run('a', 0, 3, [shape(300, 200, 1600, 900)]), frame).length === 0, 'a full UI');
  assert(findEmpty(run('a', 0, 1.1, [sparkle]), frame).length === 0, 'under 1.2 s, and the first 0.4 s left out');
  assert(findEmpty(run('a', 0, 3, [sparkle], 200, true), frame).length === 0, 'transitions left out');
});

check('slides: nothing new and the picture within the change limit for 2.5 s', () => {
  const card = [shape(400, 200, 1500, 900), text('Revenue', 40)];
  const s = findStale([...run('a', 0, 3, card), ...run('end', 3, 5, [text('Logo', 120)])]);
  assert(s.length === 1 && s[0].scene === 'a' && s[0].to - s[0].from >= 2.5, JSON.stringify(s));
  // New content halfway resets the stretch.
  const grows = [...run('a', 0, 1.5, card), ...run('a', 1.5, 3, [...card, text('+12%', 60)]), ...run('end', 3, 5, [text('Logo', 120)])];
  assert(findStale(grows).length === 0, 'new content');
  // A camera dive changes the picture a lot.
  const dive = [...run('a', 0, 1.5, card, 200), ...run('a', 1.5, 3, card, 150), ...run('end', 3, 5, [text('Logo', 120)])];
  assert(findStale(dive).length === 0, 'large picture change');
  // The end card may hold.
  assert(findStale(run('end', 0, 4, card)).length === 0, 'last scene');
  // Already reported as a motion hold.
  assert(findStale([...run('a', 0, 3, card), ...run('end', 3, 5, card)], [{ from: 0, to: 2.9, scene: 'a', end: false }]).length === 0, 'hold covers it');
});

check('finding lines name what is on screen and what to do', () => {
  const lines = findingLines({
    collisions: [], holds: [], rushes: [],
    empty: [{ scene: 'cta', from: 1, to: 2.4, share: 0.01, layers: ['shape (scenes[3].layers[1])'] }],
    stale: [{ scene: 'stats', from: 4, to: 7, }],
  });
  assert(lines[0].includes('nearly empty frame for 1.4s') && lines[0].includes('scenes[3].layers[1]'), lines[0]);
  assert(lines[1].includes('reads as a slide') && lines[1].includes('3.0s'), lines[1]);
});

console.log(failed ? `\n${failed} of ${n} pacing checks failed.` : `\nAll ${n} pacing checks passed.`);
process.exit(failed ? 1 : 0);
