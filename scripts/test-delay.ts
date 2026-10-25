/**
 * Tests for `delay` on layers with children: the time shift itself, the editor's view of it, and a
 * render where a delayed group matches the same layers written with later times.
 * Run: npx tsx scripts/test-delay.ts
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { delayAt, shiftTimes } from '../src/spec/delay';
import { toSeconds } from '../src/spec/time';
import { ffmpegPath } from '../src/cli/ffmpeg';
import { still } from '../src/cli/render';
import { validateVideo } from '../src/spec/schema';

let n = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  n++;
  console.log(`ok  ${n}. ${name}`);
}
const sec = (v: unknown) => toSeconds(v as never, { fps: 30 });

await test('moments move, durations and staggers stay', () => {
  const l = {
    type: 'text', text: 'Hi', start: 0.5, end: '2s', in: { preset: 'fade', at: 0.6, duration: 0.4 }, out: ['fade'],
    animate: { preset: 'lift', at: 0.7, stagger: 0.05, times: [0, 0.1] }, keyframes: { x: [{ t: 0, v: 0 }, { t: '30f', v: 9 }] },
  };
  const s = shiftTimes(l, 1, sec);
  assert.deepEqual([s.start, s.end, s.in.at, s.in.duration, s.out], [1.5, 3, 1.6, 0.4, ['fade']]);
  assert.deepEqual([s.animate.at, s.animate.stagger, s.animate.times], [1.7, 0.05, [0, 0.1]]);
  assert.deepEqual(s.keyframes.x.map((k: any) => k.t), [1, 2]);
  assert.equal(l.start, 0.5, 'the input is not changed');
  const c = shiftTimes({ type: 'cursor', path: [{ t: 0, x: 0, y: 0 }], clicks: [0.4], press: 1 }, 2, sec);
  assert.deepEqual([c.path[0].t, c.clicks[0], c.press], [2, 2.4, 3]);
});

await test('delays add up through nested groups for the editor', () => {
  const v = { scenes: [{ layers: [{ type: 'group', delay: 1, children: [{ type: 'group', delay: '15f', children: [{ type: 'text', text: 'x' }] }] }] }] };
  assert.equal(delayAt(v, ['scenes', 0, 'layers', 0, 'children', 0, 'children', 0], sec), 1.5);
  assert.equal(delayAt(v, ['scenes', 0, 'layers', 0], sec), 0);
  assert.ok(validateVideo({ title: 't', scenes: [{ duration: 1, layers: v.scenes[0].layers }] }).ok);
});

/** Raw RGB at 192x108. */
function pixels(file: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-loglevel', 'error', '-i', file, '-vf', 'scale=192:108:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const c: Buffer[] = [];
    p.stdout.on('data', (d) => c.push(d));
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(c)) : reject(new Error(`ffmpeg ${code}`))));
  });
}
const diff = (a: Buffer, b: Buffer) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

await test('a delayed group renders like the same layers with later times', async () => {
  const DIR = 'out/dev/test-delay';
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  const kids = (d: number) => [
    { type: 'shape', width: 200, height: 200, fill: '#E2601F', x: -500, keyframes: { x: [{ t: 0.2 + d, v: -500 }, { t: 1 + d, v: 500, ease: 'inOutCubic' }] } },
    { type: 'text', text: 'Delayed words', size: 90, y: 250, start: 0.3 + d, animate: { preset: 'lift', at: 0.3 + d } },
    { type: 'chart', kind: 'bar', data: [3, 5, 2, 6], y: -280, width: 600, height: 220, at: 0.4 + d },
  ];
  const spec = (layers: unknown[]) => ({ title: 'delay', fps: 30, background: '#F4F1EA', scenes: [{ id: 's', duration: 3, layers }] });
  await writeFile(`${DIR}/a.json`, JSON.stringify(spec([{ type: 'group', delay: 1, children: kids(0) }])));
  await writeFile(`${DIR}/b.json`, JSON.stringify(spec([{ type: 'group', children: kids(1) }])));
  const ts = [0.9, 1.4, 1.7, 2.5];
  const a = await still(`${DIR}/a.json`, ts, `${DIR}/a_{t}.png`);
  const b = await still(`${DIR}/b.json`, ts, `${DIR}/b_{t}.png`);
  for (let i = 0; i < ts.length; i++) {
    const d = diff(await pixels(a[i]), await pixels(b[i]));
    assert.ok(d < 0.5, `frames at ${ts[i]}s differ by ${d.toFixed(2)}`);
  }
  // And it does move: before the delay nothing has happened yet.
  const early = diff(await pixels(a[0]), await pixels(a[2]));
  assert.ok(early > 1, 'the group animates after its delay');
});

console.log(`${n} tests passed`);
