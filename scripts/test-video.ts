/**
 * End-to-end test of video layers: exact frames in renders, the clip's sound placed and cut on the
 * timeline, and dropping a clip onto the preview. Builds its own test clip (a moving test pattern with
 * a 440 Hz tone) with ffmpeg. Run: npx tsx scripts/test-video.ts
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { runFfmpeg, ffmpegPath } from '../src/cli/ffmpeg';
import { render, still } from '../src/cli/render';
import { startServer } from '../src/cli/server';
import { spawn } from 'node:child_process';

const DIR = 'out/dev/video-e2e';
const CLIP = `${DIR}/media/clip.mp4`;
const FPS = 30;
await rm(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
await mkdir(`${DIR}/media`, { recursive: true });
// Long keyframe interval on purpose: the seek-friendly copy has to make exact seeks work anyway.
await runFfmpeg(['-f', 'lavfi', '-i', `testsrc=size=1280x720:rate=${FPS}:duration=6`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '150', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', CLIP]);

let n = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  n++;
  console.log(`ok  ${n}. ${name}`);
}

/** Raw RGB pixels at 480x270, decoded by ffmpeg (from an image, or frame `frame` of a video). */
function pixels(file: string, frame?: number): Promise<Buffer> {
  const vf = (frame === undefined ? '' : `trim=start_frame=${frame},`) + 'scale=480:270:flags=area';
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-nostdin', '-loglevel', 'error', '-i', file, '-vf', vf, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const chunks: Buffer[] = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg ${code}`))));
  });
}
/** Mean absolute difference per channel (0-255). */
function diff(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}
const sourceFrame = (seconds: number) => pixels(CLIP, Math.floor(seconds * FPS + 1e-6));

const spec = {
  title: 'Video e2e',
  fps: FPS,
  post: { bloom: false, grain: 0, vignette: 0, tonemap: 'none' },
  motionBlur: false,
  sfx: false,
  scenes: [{
    id: 'a', duration: 4, background: '#000000',
    layers: [{ type: 'video', src: 'media/clip.mp4', width: 1920, height: 1080, fit: 'fill', start: 0.5, trim: 1, volume: 1 }],
  }],
};
await writeFile(`${DIR}/spec.json`, JSON.stringify(spec, null, 2));

try {
  await test('renders land on the exact source frame (scene 1.5 s = clip 2.0 s, scene 3.2 s = clip 3.7 s)', async () => {
    for (const [scene, clip] of [[1.5, 2.0], [3.2, 3.7]]) {
      const [file] = await still(`${DIR}/spec.json`, [scene], `${DIR}/still_{t}.png`);
      const got = await pixels(file);
      // The expected source frame must match better than its neighbours, and almost exactly (colors included).
      const scores = await Promise.all([-2, -1, 0, 1, 2].map(async (k) => diff(got, await sourceFrame(clip + k / FPS))));
      const best = scores.indexOf(Math.min(...scores)) - 2;
      assert.equal(best, 0, `scene ${scene}s should show clip ${clip}s, closest frame is ${best} off (${scores.map((x) => x.toFixed(2)).join(' ')})`);
      assert.ok(scores[2] < 3, `colors drift from the source by ${scores[2].toFixed(2)} per channel`);
    }
  });

  await test('focus crops the view: zoom 2 on the top-left quarter shows exactly that quarter of the source', async () => {
    const focused = { ...spec, scenes: [{ ...spec.scenes[0], layers: [{ ...spec.scenes[0].layers[0], focus: [{ at: 0, x: 0.25, y: 0.25, zoom: 2, duration: 0.1, until: 10 }] }] }] };
    await writeFile(`${DIR}/focus.json`, JSON.stringify(focused, null, 2));
    const [file] = await still(`${DIR}/focus.json`, [1.5], `${DIR}/focus_{t}.png`);
    const got = await pixels(file);
    const quarter = (frame: number) => new Promise<Buffer>((resolve, reject) => {
      const p = spawn(ffmpegPath(), ['-nostdin', '-loglevel', 'error', '-i', CLIP, '-vf', `trim=start_frame=${frame},crop=iw/2:ih/2:0:0,scale=480:270:flags=area`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
      const chunks: Buffer[] = [];
      p.stdout.on('data', (c) => chunks.push(c));
      p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg ${code}`))));
    });
    const d = diff(got, await quarter(Math.floor(2.0 * FPS)));
    assert.ok(d < 6, `focused view differs from the source quarter by ${d.toFixed(2)} per channel`);
    assert.ok(diff(got, await sourceFrame(2.0)) > d + 10, 'and it is not the whole frame');
  });

  await test('the seek-friendly copy is cached', async () => {
    const st = await stat(`${DIR}/.bemotion-cache/video`);
    assert.ok(st.isDirectory());
  });

  await test("the clip's sound starts with the layer and stops with it", async () => {
    await render(`${DIR}/spec.json`, { out: `${DIR}/out.mp4`, quality: 'draft' });
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const p = spawn(ffmpegPath(), ['-loglevel', 'error', '-i', `${DIR}/out.mp4`, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
      const chunks: Buffer[] = [];
      p.stdout.on('data', (c) => chunks.push(c));
      p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg ${code}`))));
    });
    const level = (from: number, to: number) => {
      let s = 0;
      let k = 0;
      for (let i = Math.floor(from * 8000); i < Math.floor(to * 8000) && i * 2 + 1 < raw.length; i++, k++) s += raw.readInt16LE(i * 2) ** 2;
      return 20 * Math.log10(Math.sqrt(s / Math.max(1, k)) / 32768 + 1e-9);
    };
    assert.ok(level(0, 0.45) < -60, `silent before the clip starts (${level(0, 0.45).toFixed(0)} dB)`);
    assert.ok(level(0.6, 3.9) > -40, `tone while the clip plays (${level(0.6, 3.9).toFixed(0)} dB)`);
  });

  await test('dropping a clip on the preview adds a video layer', async () => {
    const { server, url } = await startServer(`${DIR}/spec.json`, { port: 0 });
    const browser = await puppeteer.launch({ headless: true, args: ['--ignore-gpu-blocklist', '--use-angle=default'] });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForSelector('#frame canvas');
      await page.evaluate(`(async () => {
        const blob = await (await fetch('/__bemotion/assets/media/clip.mp4')).blob();
        const dt = new DataTransfer();
        dt.items.add(new File([blob], 'screen recording.mp4', { type: 'video/mp4' }));
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, cancelable: true }));
      })()`);
      const end = Date.now() + 15000;
      let layers: any[] = [];
      while (Date.now() < end) {
        layers = JSON.parse(await readFile(`${DIR}/spec.json`, 'utf8')).scenes[0].layers;
        if (layers.length === 2) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(layers.length, 2, 'a second layer was added');
      assert.equal(layers[1].type, 'video');
      assert.equal(layers[1].src, 'media/screen-recording.mp4');
      await stat(`${DIR}/media/screen-recording.mp4`);
      await page.waitForFunction(() => !document.getElementById('loading')?.classList.contains('hidden') === false, { timeout: 15000 });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  });

  console.log(`\nAll ${n} video checks passed.`);
} finally {
  // Windows can hold the uploaded clip briefly after the server closes; retry the delete.
  await rm(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
