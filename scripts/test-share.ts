/**
 * Tests for shared elements: which layers pair up, which animations the flight replaces, and that a
 * render places the element between its two spots mid-flight with nothing left behind.
 * Run: npx tsx scripts/test-share.ts
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolveShared, sharedNames } from '../src/spec/share';
import { ffmpegPath } from '../src/cli/ffmpeg';
import { still } from '../src/cli/render';
import type { Video } from '../src/spec/schema';

let n = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  n++;
  console.log(`ok  ${n}. ${name}`);
}

const box = (extra: Record<string, unknown>) => ({ type: 'shape', shape: 'rect', width: 100, height: 100, fill: '#FF0000', ...extra });
const video = (transition: unknown, a: unknown[], b: unknown[]) =>
  ({ title: 't', fps: 30, scenes: [{ id: 'a', duration: 2, layers: a }, { id: 'b', duration: 2, transition, layers: b }] }) as unknown as Video;

await test('layers pair by name across a transition, and only across one', () => {
  const v = video({ type: 'fade', duration: 1 }, [box({ share: 'm' }), box({ share: 'x' })], [{ type: 'group', children: [box({ share: 'm' })] }]);
  assert.deepEqual(sharedNames(v, 1), ['m']);
  assert.deepEqual(sharedNames(video({ type: 'cut' }, [box({ share: 'm' })], [box({ share: 'm' })]), 1), []);
});

await test('the flight replaces the exit of the outgoing copy and the entrance of the incoming one', () => {
  const v = video({ type: 'fade', duration: 1 },
    [box({ share: 'm', out: { preset: 'fade' }, in: { preset: 'fade' } })],
    [box({ share: 'm', in: { preset: 'popIn' }, out: { preset: 'fade' } })]);
  const r = resolveShared(v) as any;
  assert.equal(r.scenes[0].layers[0].out, undefined);
  assert.deepEqual(r.scenes[0].layers[0].in, { preset: 'fade' });
  assert.equal(r.scenes[1].layers[0].in, undefined);
  assert.deepEqual(r.scenes[1].layers[0].out, { preset: 'fade' });
  assert.ok((v.scenes[0].layers[0] as any).out, 'the input spec is not changed');
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
/** Center of the red pixels, in frame pixels with the origin at the center and +y up, or null. */
function redCenter(px: Buffer): [number, number] | null {
  let sx = 0, sy = 0, k = 0;
  for (let y = 0; y < 108; y++)
    for (let x = 0; x < 192; x++) {
      const i = (y * 192 + x) * 3;
      if (px[i] > 180 && px[i + 1] < 80 && px[i + 2] < 80) (sx += x, sy += y, k++);
    }
  return k ? [((sx / k + 0.5) / 192 - 0.5) * 1920, (0.5 - (sy / k + 0.5) / 108) * 1080] : null;
}

const DIR = 'out/dev/share-e2e';
await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });
try {
  await test('mid-flight the element sits halfway along its path, with no copy left at either end', async () => {
    // Linear ease so the halfway point is exact; same size at both ends.
    const spec = {
      title: 'Share e2e', fps: 30, motionBlur: false, sfx: false,
      post: { bloom: false, grain: 0, vignette: 0, tonemap: 'none' },
      scenes: [
        { id: 'a', duration: 2, background: '#FFFFFF', layers: [box({ share: 'm', x: -600, y: 300 })] },
        { id: 'b', duration: 2, background: '#FFFFFF', transition: { type: 'fade', duration: 1, ease: 'linear' }, layers: [box({ share: 'm', x: 600, y: -300 })] },
      ],
    };
    await writeFile(`${DIR}/spec.json`, JSON.stringify(spec));
    // Scene b starts at 1.0; the flight runs 1.0-2.0.
    const [f0, f1, f2] = await still(`${DIR}/spec.json`, [0.5, 1.5, 2.5], `${DIR}/s_{t}.png`);
    const near = (got: [number, number] | null, want: [number, number]) =>
      assert.ok(got && Math.abs(got[0] - want[0]) < 25 && Math.abs(got[1] - want[1]) < 25, `expected red near ${want}, got ${got}`);
    near(redCenter(await pixels(f0)), [-600, 300]);
    near(redCenter(await pixels(f1)), [0, 0]);
    near(redCenter(await pixels(f2)), [600, -300]);
  });
  console.log(`\nAll ${n} shared element checks passed.`);
} finally {
  await rm(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
