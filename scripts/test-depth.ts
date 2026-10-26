/**
 * Depth parallax on images: the schema, finding the images that need an estimated map, the clear
 * error without Python or the model, path confinement, and renders with a synthetic depth map (a
 * near square over a far background) that show parallax under rotation, the dolly and orbit modes,
 * and no rubber-sheet smear at the square's edges. A real-model check runs when Python, torch,
 * transformers and the cached model are there.
 * Run: npx tsx scripts/test-depth.ts
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ffmpegPath } from '../src/cli/ffmpeg';
import { depthCommand, depthImages, ensureDepthMaps, estimateDepth, imageInside, pythonCommand } from '../src/cli/depth';
import { still } from '../src/cli/render';
import { validateVideo } from '../src/spec/schema';

let failed = 0;
let n = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
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
async function throws(fn: () => unknown | Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected an error');
}

/** Writes raw RGB as a PNG through ffmpeg. */
function writePng(file: string, w: number, h: number, rgb: Uint8Array): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(ffmpegPath(), ['-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-i', '-', file], { stdio: ['pipe', 'ignore', 'inherit'] });
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}`))));
    p.stdin.end(Buffer.from(rgb));
  });
}
/** Raw RGB of a PNG at its own size (1920x1080 frames here). */
function readRgb(file: string): Promise<Buffer> {
  return new Promise((res, rej) => {
    const p = spawn(ffmpegPath(), ['-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const c: Buffer[] = [];
    p.stdout.on('data', (d) => c.push(d));
    p.on('close', (code) => (code === 0 ? res(Buffer.concat(c)) : rej(new Error(`ffmpeg ${code}`))));
  });
}
const W = 1920;
/** Centroid x and pixel count of pixels matching a color test. */
function blob(px: Buffer, test: (r: number, g: number, b: number) => boolean): { x: number; count: number } {
  let sx = 0;
  let count = 0;
  for (let i = 0; i < px.length / 3; i++) {
    if (test(px[i * 3], px[i * 3 + 1], px[i * 3 + 2])) {
      sx += i % W;
      count++;
    }
  }
  return { x: count ? sx / count : NaN, count };
}
const isRed = (r: number, g: number, b: number) => r > 150 && g < 90 && b < 90;
const isBlue = (r: number, g: number, b: number) => b > 150 && r < 90 && g < 120;

const DIR = resolve('out/dev/test-depth');
await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });

// A 600x400 photo: gray, a red square in the middle, a blue mark near the left edge. The depth map
// puts the square near (white) and everything else far (black).
const IW = 600;
const IH = 400;
const img = new Uint8Array(IW * IH * 3);
const dep = new Uint8Array(IW * IH * 3);
for (let y = 0; y < IH; y++) {
  for (let x = 0; x < IW; x++) {
    const i = (y * IW + x) * 3;
    const sq = x >= 225 && x < 375 && y >= 125 && y < 275;
    const mark = x >= 40 && x < 90 && y >= 175 && y < 225;
    const c = sq ? [220, 30, 30] : mark ? [30, 60, 220] : [128, 128, 128];
    img.set(c, i);
    dep.set(sq ? [255, 255, 255] : [0, 0, 0], i);
  }
}
await writePng(join(DIR, 'photo.png'), IW, IH, img);
await writePng(join(DIR, 'photo-depth.png'), IW, IH, dep);

const spec = (layer: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  title: 'depth', fps: 30, background: '#000000', post: { bloom: false, grain: 0, vignette: 0, chromatic: 0 },
  scenes: [{ id: 's', duration: 2, layers: [{ type: 'image', src: 'photo.png', width: 1200, ...layer }], ...extra }],
});

await check('schema: depth is true or { map, amount, mode, motion, focus }', () => {
  assert(validateVideo(spec({ depth: true })).ok, 'true');
  assert(validateVideo(spec({ depth: { map: 'd.png', amount: 200, mode: 'orbit', motion: 0.5, focus: 0.3 } })).ok, 'object');
  assert(!validateVideo(spec({ depth: { mode: 'spin' } })).ok, 'bad mode');
  assert(!validateVideo(spec({ depth: { mapp: 'x' } })).ok, 'unknown field');
});

await check('images that need an estimated map are found anywhere in the spec', () => {
  const s = {
    scenes: [{ layers: [
      { type: 'image', src: 'a.png', depth: true },
      { type: 'group', children: [{ type: 'image', src: 'b.jpg', depth: { amount: 100 } }] },
      { type: 'image', src: 'c.png', depth: { map: 'c-depth.png' } },
      { type: 'image', src: 'https://example.com/d.png', depth: true },
      { type: 'image', src: 'e.png' },
    ] }],
  };
  assert(JSON.stringify(depthImages(s)) === '["a.png","b.jpg"]', JSON.stringify(depthImages(s)));
});

await check('images outside the spec folder are refused', async () => {
  assert((await throws(() => imageInside(DIR, '../../../package.json'))).includes('inside the spec'), 'outside');
  assert((await imageInside(DIR, 'photo.png')).endsWith('photo.png'), 'inside');
});

await check('without Python: a clear error that says to pass a map', async () => {
  const old = process.env.BEMOTION_PYTHON;
  process.env.BEMOTION_PYTHON = 'bemotion-no-such-python';
  try {
    const msg = await throws(() => estimateDepth(join(DIR, 'photo.png'), join(DIR, 'x.png')));
    assert(msg.includes('Python was not found') && msg.includes('"map"'), msg);
    await writeFile(join(DIR, 'auto.json'), JSON.stringify(spec({ depth: true })));
    const msg2 = await throws(() => ensureDepthMaps(join(DIR, 'auto.json'), spec({ depth: true })));
    assert(msg2.includes('depth map'), msg2);
    const msg3 = await throws(() => still(join(DIR, 'auto.json'), [0.5], join(DIR, 'auto.png')));
    assert(msg3.includes('Python was not found'), msg3);
  } finally {
    if (old === undefined) delete process.env.BEMOTION_PYTHON;
    else process.env.BEMOTION_PYTHON = old;
  }
});

await check('with a missing package: the estimator exits with code 2 and names the package', async () => {
  const py = spawnSync(pythonCommand(), ['-I', '-c', 'print(1)'], { encoding: 'utf8' });
  if (py.status !== 0) return console.log('     (skipped: no Python)');
  // -S leaves out site-packages, so torch and transformers cannot be imported.
  const r = spawnSync(pythonCommand(), ['-I', '-S', 'scripts/depth.py', join(DIR, 'photo.png'), join(DIR, 'x.png')], { encoding: 'utf8' });
  assert(r.status === 2 && /missing Python package/.test(r.stderr), `exit ${r.status}: ${r.stderr}`);
});

const depth = { map: 'photo-depth.png', amount: 400 };
await writeFile(join(DIR, 'flat.json'), JSON.stringify(spec({ rotateY: 25 })));
await writeFile(join(DIR, 'relief.json'), JSON.stringify(spec({ rotateY: 25, depth })));
await writeFile(join(DIR, 'front.json'), JSON.stringify(spec({ depth })));

await check('rotated, the near square moves against the far background (parallax)', async () => {
  const [flat] = await still(join(DIR, 'flat.json'), [1], join(DIR, 'flat.png'));
  const [relief] = await still(join(DIR, 'relief.json'), [1], join(DIR, 'relief.png'));
  const f = await readRgb(flat);
  const r = await readRgb(relief);
  const redF = blob(f, isRed);
  const redR = blob(r, isRed);
  const blueF = blob(f, isBlue);
  const blueR = blob(r, isBlue);
  assert(redF.count > 1000 && redR.count > 1000 && blueF.count > 100 && blueR.count > 100, `found ${redF.count} ${redR.count} ${blueF.count} ${blueR.count}`);
  const dRed = redR.x - redF.x;
  const dBlue = blueR.x - blueF.x;
  // The square sits in front of the plane and the mark behind it: they move opposite ways.
  assert(Math.abs(dRed) > 25 && Math.abs(dBlue) > 15 && Math.sign(dRed) !== Math.sign(dBlue), `square moved ${dRed.toFixed(1)} px, mark ${dBlue.toFixed(1)} px`);
  // Relative to each other the shift is the parallax.
  console.log(`     parallax: square ${dRed.toFixed(1)} px, background mark ${dBlue.toFixed(1)} px`);
  // No rubber sheet: the square's steep sides fade, so red does not smear far beyond the square.
  assert(redR.count < redF.count * 1.35, `red area ${redR.count} vs flat ${redF.count}`);
});

await check('head-on, the relief looks like the photo (nothing fades)', async () => {
  const [front] = await still(join(DIR, 'front.json'), [1], join(DIR, 'front.png'));
  const p = await readRgb(front);
  // Any gray (fill) where the square's edges are would show as a hole in the red; the square stays whole.
  const red = blob(p, isRed);
  // 150 px of 600 at width 1200 is 300 px, a little larger for being nearer: about 300^2 to 340^2.
  assert(red.count > 290 * 290 && red.count < 360 * 360, `red area ${red.count}`);
});

await check('dolly pushes in and orbit swings over the layer\'s life', async () => {
  await writeFile(join(DIR, 'dolly.json'), JSON.stringify(spec({ depth: { ...depth, mode: 'dolly' } })));
  await writeFile(join(DIR, 'orbit.json'), JSON.stringify(spec({ depth: { ...depth, mode: 'orbit' } })));
  const [d0, d1] = await still(join(DIR, 'dolly.json'), [0, 1.95], join(DIR, 'dolly_{t}.png'));
  const a = blob(await readRgb(d0), isRed).count;
  const b = blob(await readRgb(d1), isRed).count;
  assert(b > a * 1.15, `the square grows as the relief comes closer: ${a} -> ${b}`);
  const [o0, o1] = await still(join(DIR, 'orbit.json'), [0, 1.95], join(DIR, 'orbit_{t}.png'));
  // The near square and the far mark change places relative to each other as the view swings.
  const gap = async (f: string) => {
    const p = await readRgb(f);
    return blob(p, isRed).x - blob(p, isBlue).x;
  };
  const g0 = await gap(o0);
  const g1 = await gap(o1);
  assert(Math.abs(g1 - g0) > 30, `square to mark: ${g0.toFixed(1)} -> ${g1.toFixed(1)} px`);
});

await check('a camera orbit shows parallax without any mode', async () => {
  await writeFile(join(DIR, 'cam.json'), JSON.stringify(spec({ depth }, { camera: { moves: [{ preset: 'orbit', angle: 30, duration: 2 }] } })));
  await writeFile(join(DIR, 'camflat.json'), JSON.stringify(spec({}, { camera: { moves: [{ preset: 'orbit', angle: 30, duration: 2 }] } })));
  const [c] = await still(join(DIR, 'cam.json'), [1.9], join(DIR, 'cam.png'));
  const [cf] = await still(join(DIR, 'camflat.json'), [1.9], join(DIR, 'camflat.png'));
  const d = blob(await readRgb(c), isRed).x - blob(await readRgb(cf), isRed).x;
  assert(Math.abs(d) > 15, `square vs flat under the camera orbit: ${d.toFixed(1)} px`);
});

// Real model: only when Python, torch, transformers and the cached weights are all there.
const hub = process.env.HF_HOME ? join(process.env.HF_HOME, 'hub') : join(homedir(), '.cache', 'huggingface', 'hub');
const cached = existsSync(join(hub, 'models--depth-anything--Depth-Anything-V2-Small-hf'));
const hasPkgs = spawnSync(pythonCommand(), ['-I', '-c', 'import torch, transformers, PIL'], { encoding: 'utf8' }).status === 0;
if (cached && hasPkgs) {
  await check('real model: bemotion depth writes a 16-bit map the size of the image, using the full range', async () => {
    const out = await depthCommand(join(DIR, 'photo.png'), join(DIR, 'model-depth.png'));
    const probe = spawnSync(pythonCommand(), ['-I', '-c', `from PIL import Image; im=Image.open(r'${out}'); lo, hi = im.getextrema(); print(im.mode, im.size[0], im.size[1], lo, hi)`], { encoding: 'utf8' });
    const [mode, w, h, lo, hi] = probe.stdout.trim().split(' ');
    assert(mode.startsWith('I') && w === '600' && h === '400', probe.stdout + probe.stderr);
    assert(Number(lo) === 0 && Number(hi) === 65535, `range ${lo}..${hi}`);
  });
  await check('real model: depth: true renders through the cache', async () => {
    const [p] = await still(join(DIR, 'auto.json'), [1], join(DIR, 'auto.png'));
    assert(blob(await readRgb(p), isRed).count > 1000, 'renders');
    assert(existsSync(join(DIR, '.bemotion-cache', 'depth')), 'cached next to the spec');
  });
} else {
  console.log(`     (real-model checks skipped: ${!hasPkgs ? 'no torch/transformers' : 'model not downloaded; run bemotion depth on any image once'})`);
}

console.log(failed ? `${failed} of ${n} checks failed` : `${n} checks passed`);
process.exit(failed ? 1 : 0);
