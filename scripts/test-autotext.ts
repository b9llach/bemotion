/**
 * Unit tests for automatic text styles (`"preset": "auto"`). Run: npx tsx scripts/test-autotext.ts
 */
import assert from 'node:assert/strict';
import { resolveAutoText } from '../src/spec/autotext';
import { validateVideo, type Video } from '../src/spec/schema';
import { TEXT_PRESETS } from '../src/engine/layers/text';

function video(lines: [string, number][], title = 'Test'): Video {
  let t = 0;
  const layers = lines.map(([text, d]) => {
    const l = { type: 'text', text, start: t, end: t + d, animate: { preset: 'auto' }, animateOut: { preset: 'auto' } };
    t += d;
    return l;
  });
  const v = validateVideo({ title, scenes: [{ duration: t, layers }] });
  assert.ok(v.ok, v.errors.join('\n'));
  return v.video!;
}

const LINES: [string, number][] = [
  ['When you run a', 1.2], ['small', 0.8], ['team,', 0.8], ['every device', 1.1], ['is your', 0.9], ['problem.', 0.9],
  ['Updates.', 0.7], ['Passwords.', 0.7], ['Lost laptops.', 1.0], ['There has to be', 1.2], ['a better way.', 1.3], ['IT', 0.5],
];

let n = 0;
function test(name: string, fn: () => void) {
  fn();
  n++;
  console.log(`ok  ${n}. ${name}`);
}

const out = resolveAutoText(video(LINES));
const layers = out.scenes[0].layers as any[];

test('every auto preset resolves to a real text preset', () => {
  for (const l of layers) {
    assert.ok(TEXT_PRESETS[l.animate.preset], `entrance ${l.animate.preset}`);
    if (l.animateOut) assert.ok(TEXT_PRESETS[l.animateOut.preset], `exit ${l.animateOut.preset}`);
  }
});

test('no two lines in a row arrive the same way', () => {
  for (let i = 1; i < layers.length; i++) assert.notEqual(layers[i].animate.preset, layers[i - 1].animate.preset, `lines ${i - 1} and ${i}`);
});

test('a video uses many different entrances', () => {
  assert.ok(new Set(layers.map((l) => l.animate.preset)).size >= 6);
});

test('exits carry on the entrance', () => {
  for (const l of layers) {
    if (!l.animateOut) continue;
    if (l.animate.preset === 'fromLeft') assert.equal(l.animateOut.preset, 'exitRight');
    if (l.animate.preset === 'fromRight') assert.equal(l.animateOut.preset, 'exitLeft');
    if (l.animate.preset === 'depth') assert.equal(l.animateOut.preset, 'recede');
  }
});

test('entrance and exit fit inside the line window without overlapping', () => {
  for (const l of layers) {
    const window = l.end - l.start;
    const t = TEXT_PRESETS[l.animate.preset];
    const by = l.animate.by ?? t.by;
    const units = by === 'char' ? l.text.replace(/\s+/g, '').length : by === 'word' ? l.text.split(/\s+/).length : 1;
    const inTotal = (l.animate.duration ?? t.duration) + (l.animate.stagger ?? t.stagger) * (units - 1);
    const outTotal = l.animateOut ? l.animateOut.duration ?? TEXT_PRESETS[l.animateOut.preset].duration : 0;
    assert.ok(inTotal + outTotal <= window + 1e-6, `"${l.text}": ${inTotal.toFixed(2)} + ${outTotal.toFixed(2)} > ${window}`);
  }
});

test('very short beats cut instead of exiting', () => {
  const it = layers.find((l) => l.text === 'IT');
  assert.equal(it.animateOut, undefined);
});

test('resolution is deterministic', () => {
  assert.deepEqual(resolveAutoText(video(LINES)), out);
});

test('different videos start the rotation in different places', () => {
  const firsts = new Set(['A', 'B', 'C', 'D', 'E', 'F'].map((t) => (resolveAutoText(video(LINES, t)).scenes[0].layers[0] as any).animate.preset));
  assert.ok(firsts.size >= 3, [...firsts].join(','));
});

test('own settings win over the automatic ones', () => {
  const v = video([['Hello there friend', 1.5]]);
  (v.scenes[0].layers[0] as any).animate = { preset: 'auto', stagger: 0.3, at: 0.2 };
  const l = resolveAutoText(v).scenes[0].layers[0] as any;
  assert.equal(l.animate.stagger, 0.3);
  assert.equal(l.animate.at, 0.2);
});

test('a spec without auto is returned untouched', () => {
  const v = validateVideo({ scenes: [{ duration: 2, layers: [{ type: 'text', text: 'Hi', animate: { preset: 'lift' } }] }] }).video!;
  assert.equal(resolveAutoText(v), v);
});

console.log(`\nAll ${n} auto text tests passed.`);
