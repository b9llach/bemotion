/**
 * Tests for formats (other aspect ratios from one spec): output sizes, overrides, automatic scene
 * zoom, and a render at 9:16. Run: npx tsx scripts/test-formats.ts
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { applyFormat } from '../src/spec/formats';
import { validateVideo } from '../src/spec/schema';
import { ffmpegPath } from '../src/cli/ffmpeg';
import { still } from '../src/cli/render';

let n = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  n++;
  console.log(`ok  ${n}. ${name}`);
}

const spec = (layers: unknown[], extra: Record<string, unknown> = {}) => ({ title: 't', fps: 30, scenes: [{ id: 'a', duration: 2, layers }], ...extra });
const scene0 = (s: unknown) => (s as any).scenes[0];

await test('output sizes keep the short side', () => {
  const sizes = (['9:16', '1:1', '4:5', '16:9'] as const).map((f) => applyFormat(spec([]), f).framing).map((r) => [r.width, r.height]);
  assert.deepEqual(sizes, [[1080, 1920], [1080, 1080], [1080, 1350], [1920, 1080]]);
  assert.equal(applyFormat(spec([]), '16:9').framing.wrap, undefined, 'the design aspect does not wrap text');
  assert.throws(() => applyFormat(spec([]), '3:2'), /Unknown format/);
});

await test('the engine sees the visible design area; zoom maps it to output pixels', () => {
  const { spec: s, framing } = applyFormat(spec([]), '1:1');
  assert.equal(framing.zoom, 0.9);
  assert.equal((s as any).width, 1200);
  const custom = applyFormat(spec([], { formats: { '9:16': { zoom: 0.8 } } }), '9:16');
  assert.equal(custom.framing.zoom, 0.8);
  assert.equal((custom.spec as any).width, 1350);
  assert.ok(validateVideo(custom.spec).ok);
});

await test('layer overrides replace fields, false leaves the layer out (paths kept), groups recurse', () => {
  const layers = [
    { type: 'text', text: 'A', y: 0, formats: { '9:16': { y: 400, size: 90 } } },
    { type: 'text', text: 'B', id: 'b', formats: { '9:16': false } },
    { type: 'group', children: [{ type: 'text', text: 'C', formats: { '9:16': { x: 10 } } }] },
  ];
  const out = scene0(applyFormat(spec(layers), '9:16').spec).layers;
  assert.equal(out[0].y, 400);
  assert.equal(out[0].size, 90);
  assert.deepEqual(out[1], { type: 'group', children: [], id: 'b' });
  assert.equal(out[2].children[0].x, 10);
  assert.equal(scene0(applyFormat(spec(layers), '1:1').spec).layers[0].y, 0, 'other formats unaffected');
  assert.ok(validateVideo(applyFormat(spec(layers), '9:16').spec).ok);
});

await test('a scene with a UI frame wider than the frame zooms out as a whole; text alone does not', () => {
  const wide = scene0(applyFormat(spec([{ type: 'browser', width: 1400 }, { type: 'text', text: 'x', x: -500 }]), '9:16').spec);
  assert.ok(wide.zoom > 0.6 && wide.zoom < 0.75, `zoom ${wide.zoom}`);
  assert.equal(wide.layers[1].x, -500, 'positions are left alone');
  assert.equal(scene0(applyFormat(spec([{ type: 'text', text: 'long', x: -500 }]), '9:16').spec).zoom, undefined);
  const own = scene0(applyFormat({ ...spec([{ type: 'browser' }]), scenes: [{ id: 'a', duration: 2, zoom: 0.9, layers: [{ type: 'browser' }] }] }, '9:16').spec);
  assert.equal(own.zoom, 0.9, "a scene's own zoom wins");
});

const DIR = 'out/dev/formats-e2e';
await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });
try {
  await test('a 9:16 still is 1080x1920 and a long centered line wraps to fit', async () => {
    const s = {
      title: 'Formats e2e', fps: 30, sfx: false, motionBlur: false,
      post: { bloom: false, grain: 0, vignette: 0, tonemap: 'none' },
      scenes: [{ id: 'a', duration: 2, background: '#FFFFFF', layers: [{ type: 'text', text: 'One long line that would run off a phone screen', size: 80, color: '#000000' }] }],
    };
    await writeFile(`${DIR}/spec.json`, JSON.stringify(s));
    const [file] = await still(`${DIR}/spec.json`, [1], `${DIR}/v_{t}.png`, { format: '9:16' });
    const px = await new Promise<Buffer>((resolve, reject) => {
      const p = spawn(ffmpegPath(), ['-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
      const c: Buffer[] = [];
      p.stdout.on('data', (d) => c.push(d));
      p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(c)) : reject(new Error(`ffmpeg ${code}`))));
    });
    assert.equal(px.length, 1080 * 1920, 'frame is 1080x1920');
    // Ink in the outer 3% columns would mean the line ran off the edge; ink rows spanning a tall band means it wrapped.
    let edge = 0;
    let top = 1920;
    let bottom = 0;
    for (let y = 0; y < 1920; y++)
      for (let x = 0; x < 1080; x++) {
        if (px[y * 1080 + x] > 128) continue;
        if (x < 32 || x > 1048) edge++;
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    assert.equal(edge, 0, 'no text at the frame edges');
    assert.ok(bottom - top > 150, `text wraps onto several lines (ink spans ${bottom - top}px)`);
  });
  console.log(`\nAll ${n} format checks passed.`);
} finally {
  await rm(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
