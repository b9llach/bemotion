/**
 * Unit tests for finding focus in screen recordings (src/cli/video-focus.ts) on synthetic frames.
 * Run: npx tsx scripts/test-focus.ts
 */
import assert from 'node:assert/strict';
import { FOCUS_H as H, FOCUS_RATE as RATE, FOCUS_W as W, findFocus } from '../src/cli/video-focus';

let n = 0;
function test(name: string, fn: () => void) {
  fn();
  n++;
  console.log(`ok  ${n}. ${name}`);
}

/** Frames of a gray screen; `paint(f, set)` changes pixels in frame f. */
function clip(seconds: number, paint: (f: number, set: (x: number, y: number, v: number) => void) => void): Buffer {
  const count = seconds * RATE;
  const buf = Buffer.alloc(W * H * count, 200);
  for (let f = 0; f < count; f++) paint(f, (x, y, v) => (buf[f * W * H + y * W + x] = v));
  return buf;
}

/** Typing-like activity: a few pixels that change every frame inside a small box. */
const typing = (f: number, set: (x: number, y: number, v: number) => void, cx: number, cy: number) => {
  const x = Math.floor(cx * W) + (f % 12) * 2;
  for (let dy = 0; dy < 4; dy++) set(x, Math.floor(cy * H) + dy, 40);
};

test('typing in two places becomes two focus moves on those places', () => {
  const frames = clip(10, (f, set) => {
    if (f >= 10 && f < 30) typing(f, set, 0.2, 0.1);
    if (f >= 60 && f < 85) typing(f, set, 0.8, 0.7);
  });
  const moves = findFocus(frames);
  assert.equal(moves.length, 2, JSON.stringify(moves));
  assert.ok(Math.abs(moves[0].x - 0.22) < 0.06 && Math.abs(moves[0].y - 0.11) < 0.06, JSON.stringify(moves[0]));
  assert.ok(Math.abs(moves[1].x - 0.82) < 0.06 && Math.abs(moves[1].y - 0.71) < 0.06, JSON.stringify(moves[1]));
  assert.ok(moves[0].at < 1.0 && moves[0].until > 2.9, 'the move covers the typing with lead-in and hold');
  assert.ok(moves.every((m) => m.zoom >= 1.25 && m.zoom <= 2.4));
});

test('a one-frame flash elsewhere does not split a move', () => {
  const frames = clip(6, (f, set) => {
    if (f >= 10 && f < 40) typing(f, set, 0.2, 0.1);
    if (f === 20) for (let y = 80; y < 120; y++) for (let x = 100; x < 200; x++) set(x, y, 0);
  });
  assert.equal(findFocus(frames).length, 1);
});

test('whole-frame changes (scrolls, cuts) and idle footage give no moves', () => {
  const frames = clip(6, (f, set) => {
    if (f >= 10 && f < 40) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, (x + y + f * 7) % 256);
  });
  assert.deepEqual(findFocus(frames), []);
  assert.deepEqual(findFocus(clip(4, () => {})), []);
});

console.log(`\nAll ${n} focus checks passed.`);
