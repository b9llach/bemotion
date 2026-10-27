/**
 * Text and UI cut off at the frame's edge, on synthetic samples: a cropped headline, a card pushed
 * partly off the frame, a close shot of an app wider than the frame, short slides through the edge,
 * repeated words as texture, transitions; and review frames that settle before an exit dive.
 * Run: npx tsx scripts/test-crop.ts
 */
import { findCropped, findingLines, type Probe } from '../src/cli/check';
import { exitAt, reviewTimes } from '../src/cli/generate';
import { validateVideo } from '../src/spec/schema';
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
type Box = { x0: number; y0: number; x1: number; y1: number };
const text = (t: string, box: Box, component?: number): InspectItem => ({ uid: uid++, anc: [], type: 'text', order: 0, opacity: 1, box, text: t, px: 60, component });
const shape = (box: Box, component?: number): InspectItem => ({ uid: uid++, anc: [], type: 'shape', order: 0, opacity: 1, box, component });
const run = (from: number, to: number, items: InspectItem[], transition = false): Probe[] => {
  const out: Probe[] = [];
  for (let t = from; t < to - 1e-9; t += 0.1) out.push({ t: Math.round(t * 100) / 100, info: { scene: 'a', transition, items }, thumb: [] });
  return out;
};

check('a headline running off the left edge for a second is reported', () => {
  const c = findCropped(run(0, 1, [text('Invoices in one API call.', { x0: -80, y0: 480, x1: 1500, y1: 600 })]), frame);
  assert(c.length === 1 && c[0].kind === 'text' && c[0].edges.join() === 'left' && c[0].amount === 0.05, JSON.stringify(c));
  assert(findingLines({ collisions: [], holds: [], rushes: [], cropped: c })[0].includes('cut off at the left edge (5% outside the frame)'), 'line');
});

check('inside the frame, a quick slide through the edge, or a transition pass', () => {
  assert(findCropped(run(0, 2, [text('Fine', { x0: 100, y0: 480, x1: 1500, y1: 600 })]), frame).length === 0, 'inside');
  assert(findCropped(run(0, 0.3, [text('Sliding', { x0: -200, y0: 480, x1: 600, y1: 600 })]), frame).length === 0, 'short');
  assert(findCropped(run(0, 2, [text('Moving', { x0: -200, y0: 480, x1: 600, y1: 600 })], true), frame).length === 0, 'transition');
});

check('a card that fits the frame but sits partly off it is reported; a close shot of an app is not', () => {
  const card = [shape({ x0: -150, y0: 300, x1: 500, y1: 700 }, 1), text('BP report', { x0: -120, y0: 320, x1: 200, y1: 380 }, 1), text('126/80', { x0: 40, y0: 400, x1: 300, y1: 480 }, 1)];
  const c = findCropped(run(0, 1, card), frame);
  assert(c.length === 1 && c[0].kind === 'ui' && c[0].edges.join() === 'left' && c[0].layer.includes('1 of its 2 lines'), JSON.stringify(c));
  const app = [shape({ x0: -300, y0: -100, x1: 2100, y1: 1200 }, 2), text('Revenue', { x0: -100, y0: 100, x1: 300, y1: 160 }, 2)];
  assert(findCropped(run(0, 2, app), frame).length === 0, 'app wider than the frame');
  // Cut only where no text is: the card's shadow side, not its copy.
  const edgeOnly = [shape({ x0: -100, y0: 300, x1: 500, y1: 700 }, 3), text('Inside', { x0: 50, y0: 320, x1: 300, y1: 380 }, 3)];
  assert(findCropped(run(0, 2, edgeOnly), frame).length === 0, 'no text cut');
});

check('repeated words as texture and type wider than the frame pass', () => {
  const field = [0, 1, 2, 3].map((i) => text('Big', { x0: -60 + i * 600, y0: -30, x1: 140 + i * 600, y1: 60 }));
  assert(findCropped(run(0, 2, field), frame).length === 0, 'pattern');
  assert(findCropped(run(0, 2, [text('HUGE', { x0: -400, y0: 200, x1: 2300, y1: 900 })]), frame).length === 0, 'texture');
});

check('review frames settle before an exit dive and before the next transition', () => {
  const v = validateVideo({
    width: 1920, height: 1080, fps: 30,
    scenes: [
      { id: 'hook', duration: 3, layers: [{ type: 'text', text: 'Hi' }], camera: { moves: [{ preset: 'pushIn', duration: 3 }, { preset: 'moveTo', at: 2, duration: 1, zoom: 1.9 }] } },
      { id: 'next', duration: 3, transition: { type: 'fade', duration: 0.5 }, layers: [{ type: 'text', text: 'There' }] },
    ],
  });
  assert(v.ok, String(v.errors));
  const s = v.video!.scenes;
  assert(exitAt(s[0], 3, 0.5, { fps: 30 }) === 2, 'dive start');
  assert(exitAt(s[1], 3, 0, { fps: 30 }) === 3, 'no dive');
  const late = reviewTimes(v.video!).find((x) => x.label.startsWith('hook') && x.label.includes('settled'))!;
  assert(Math.abs(late.t - 1.7) < 1e-9, late.label);
});

console.log(failed ? `\n${failed} of ${n} crop checks failed.` : `\nAll ${n} crop checks passed.`);
process.exit(failed ? 1 : 0);
