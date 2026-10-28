/**
 * Repeated transitions and missed cursor clicks: hand-off kinds (shared element, dive, plain type),
 * runs and majorities reported only in videos with four or more changes, clicks matched to the layer
 * they press (or the nearest button) and measured from the fingertip, and a real render where the
 * click lands below its button.
 * Run: npx tsx scripts/test-handoff.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { check, clickTimes, findMissedClicks, findSameTransitions, findingLines } from '../src/cli/check';
import { handoffs } from '../src/spec/exits';
import { validateVideo, type Video } from '../src/spec/schema';
import type { InspectInfo, InspectItem } from '../src/engine/engine';

let failed = 0;
let n = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
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
const video = (raw: unknown): Video => {
  const v = validateVideo(raw);
  if (!v.ok) throw new Error(v.errors.join('; '));
  return v.video!;
};
const scene = (id: string, transition?: string, extra: Record<string, unknown> = {}) => ({
  id, duration: 3, layers: [{ type: 'text', text: id }], ...(transition ? { transition: { type: transition, duration: 0.5 } } : {}), ...extra,
});

await test('hand-offs: a shared element and a dive are kinds of their own', () => {
  const v = video({ scenes: [
    { id: 'a', duration: 3, layers: [{ type: 'text', text: 'a', share: 'logo' }] },
    { id: 'b', duration: 3, transition: { type: 'blur' }, layers: [{ type: 'text', text: 'b', share: 'logo' }], camera: { moves: [{ preset: 'moveTo', at: 2, duration: 1, zoom: 2 }] } },
    scene('c', 'blur'),
    scene('d', 'blur'),
  ] });
  const kinds = handoffs(v, { fps: 30 }).map((h) => h.kind);
  assert(kinds.join() === 'shared element,dive + blur,blur', kinds.join());
});

await test('three of a kind in a row are reported once there are four changes', () => {
  const four = video({ scenes: [scene('a'), scene('b', 'blur'), scene('c', 'blur'), scene('d', 'blur'), scene('e', 'whip')] });
  const r = findSameTransitions(four);
  assert(r.length === 1 && r[0].run && r[0].count === 3 && r[0].kind === 'blur' && r[0].scenes.join() === 'b,c,d', JSON.stringify(r));
  assert(findingLines({ collisions: [], holds: [], rushes: [], transitions: r })[0].includes('3 scene changes in a row are "blur"'), 'line');
  // Only three changes: a short video may use one.
  assert(findSameTransitions(video({ scenes: [scene('a'), scene('b', 'blur'), scene('c', 'blur'), scene('d', 'blur')] })).length === 0, 'short');
  // Mixed: nothing.
  assert(findSameTransitions(video({ scenes: [scene('a'), scene('b', 'blur'), scene('c', 'whip'), scene('d', 'blur'), scene('e', 'push')] })).length === 0, 'mixed');
});

await test('one kind for most changes is reported even when broken up', () => {
  const v = video({ scenes: [scene('a'), scene('b', 'fade'), scene('c', 'fade'), scene('d', 'whip'), scene('e', 'fade'), scene('f', 'fade')] });
  const r = findSameTransitions(v);
  assert(r.length === 1 && !r[0].run && r[0].count === 4 && r[0].total === 5, JSON.stringify(r));
});

let uid = 0;
const item = (path: string, box: InspectItem['box'], type = 'shape'): InspectItem => ({ uid: uid++, anc: [], type, order: 0, opacity: 1, box, path });
const frame = { width: 1920, height: 1080 };

await test('a click is measured against what it presses, from the fingertip', () => {
  const v = video({ scenes: [{ id: 's', duration: 4, layers: [
    { type: 'button', label: 'Send', press: 2, x: 0, y: 0 },
    { type: 'button', label: 'Cancel', x: 400, y: 0 },
    { type: 'cursor', style: 'hand', clicks: [2], path: [{ t: 0, x: 0, y: 0 }] },
  ] }] });
  assert(clickTimes(v).length === 1 && clickTimes(v)[0].t === 2, JSON.stringify(clickTimes(v)));
  const items = [item('scenes[0].layers[0]', { x0: 860, y0: 510, x1: 1060, y1: 570 }), item('scenes[0].layers[1]', { x0: 1260, y0: 510, x1: 1460, y1: 570 })];
  const at = (x: number, y: number): InspectInfo => ({ scene: 's', transition: false, items, pointers: [{ x, y }] });
  assert(findMissedClicks(v, [{ t: 2, local: 2, scene: 's', info: at(960, 540) }], frame).length === 0, 'on the button');
  const below = findMissedClicks(v, [{ t: 2, local: 2, scene: 's', info: at(960, 610) }], frame);
  assert(below.length === 1 && below[0].off === 40 && below[0].side === 'below' && below[0].target.includes('"Send"'), JSON.stringify(below));
  // Nearer to Cancel, but Send is the one pressed at 2 s.
  const r = findMissedClicks(v, [{ t: 2, local: 2, scene: 's', info: at(1240, 540) }], frame);
  assert(r.length === 1 && r[0].target.includes('"Send"'), JSON.stringify(r));
});

await test('without a press, the nearest button within 150 px is the target; far away, nothing is', () => {
  const v = video({ scenes: [{ id: 's', duration: 4, layers: [{ type: 'button', label: 'Go', x: 0, y: 0 }, { type: 'cursor', clicks: [1], path: [{ t: 0, x: 0, y: 0 }] }] }] });
  const items = [item('scenes[0].layers[0]', { x0: 860, y0: 510, x1: 1060, y1: 570 })];
  const info = (x: number, y: number): InspectInfo => ({ scene: 's', transition: false, items, pointers: [{ x, y }] });
  assert(findMissedClicks(v, [{ t: 1, local: 1, scene: 's', info: info(1100, 540) }], frame)[0]?.side === 'right of', 'near miss');
  assert(findMissedClicks(v, [{ t: 1, local: 1, scene: 's', info: info(1500, 900) }], frame).length === 0, 'clicking something else');
});

await test('a real render: a click 60 px below its button is reported, one on it is not', async () => {
  const dir = 'out/dev/handoff-test';
  await mkdir(dir, { recursive: true });
  const spec = (y: number) => ({
    width: 960, height: 540, fps: 30,
    scenes: [{ id: 'send', duration: 2, layers: [
      { type: 'background', color: '#ffffff' },
      { type: 'button', label: 'Send', press: 1, width: 220, height: 64 },
      { type: 'cursor', style: 'hand', clicks: [1], path: [{ t: 0, x: 300, y: -200 }, { t: 0.8, x: 0, y }] },
    ] }],
  });
  await writeFile(`${dir}/miss.json`, JSON.stringify(spec(-60)));
  await writeFile(`${dir}/hit.json`, JSON.stringify(spec(0)));
  const miss = await check(`${dir}/miss.json`);
  assert(miss.clicks.length === 1 && miss.clicks[0].side === 'below' && miss.clicks[0].off > 15, JSON.stringify(miss.clicks));
  const hit = await check(`${dir}/hit.json`);
  assert(hit.clicks.length === 0, JSON.stringify(hit.clicks));
});

console.log(failed ? `\n${failed} of ${n} hand-off checks failed.` : `\nAll ${n} hand-off checks passed.`);
process.exit(failed ? 1 : 0);
