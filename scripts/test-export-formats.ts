/**
 * Output formats: GIF (palette, frame rate and width cap), transparent WebM (VP9 with alpha) and .mov
 * (ProRes 4444), transparent stills with straight alpha (no dark fringes on soft edges, background
 * layers dropped), MP4 refusing alpha, and the image-based Lottie export loading and drawing in
 * lottie-web. Run: npx tsx scripts/test-export-formats.ts
 */
import puppeteer from 'puppeteer';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { render, still, BROWSER_ARGS } from '../src/cli/render';
import { exportLottie } from '../src/cli/lottie';
import { ffmpegPath } from '../src/cli/ffmpeg';
import { PKG_ROOT } from '../src/cli/server';

let failed = 0;
let n = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
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

const W = 480;
const H = 270;
const work = await mkdtemp(join(tmpdir(), 'bemotion-formats-'));
const spec = {
  title: 'Formats test',
  width: W,
  height: H,
  fps: 20,
  background: '#0B0B10',
  post: { grain: 0, vignette: 0, bloom: false },
  motionBlur: false,
  scenes: [
    {
      duration: 1,
      layers: [
        { type: 'background', style: 'solid', color: '#123456' },
        // Off the pixel grid, so its edge pixels are partly covered.
        { type: 'shape', width: 121.3, height: 121.3, radius: 60.65, fill: '#FFFFFF' },
        { type: 'text', text: 'Hello', size: 44, weight: 700, color: '#FFFFFF', y: 95, keyframes: { x: [{ t: 0, v: -60 }, { t: 1, v: 60 }] } },
      ],
    },
  ],
};
const specPath = join(work, 'ad.json');
await writeFile(specPath, JSON.stringify(spec));
const transparent = join(work, 'clear.json');
await writeFile(transparent, JSON.stringify({ ...spec, background: 'transparent', scenes: [{ ...spec.scenes[0], layers: spec.scenes[0].layers.slice(1) }] }));

const ff = ffmpegPath();
/** Stream description lines from ffmpeg. */
function probe(file: string): string {
  return String(spawnSync(ff, ['-hide_banner', '-i', file]).stderr);
}
/** One frame as straight RGBA bytes (VP9 through libvpx, which decodes its alpha). */
function rgba(file: string, frame = 0): Buffer {
  const dec = file.endsWith('.webm') ? ['-c:v', 'libvpx-vp9'] : [];
  return execFileSync(ff, ['-loglevel', 'error', ...dec, '-i', file, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 64 << 20 });
}
const px = (b: Buffer, x: number, y: number) => {
  const i = (y * W + x) * 4;
  return [b[i], b[i + 1], b[i + 2], b[i + 3]];
};
/**
 * Alpha checks on a frame: corners empty (background layers dropped), the disc's center opaque white,
 * and the disc's soft edge white at partial alpha (dark fringes would mean premultiplied color).
 */
function alphaChecks(b: Buffer, lossy: boolean): void {
  for (const [x, y] of [[2, 2], [W - 3, 2], [2, H - 3], [W - 3, H - 3]]) {
    const p = px(b, x, y);
    assert(p[3] <= (lossy ? 3 : 0), `corner ${x},${y} not transparent: ${p}`);
  }
  const c = px(b, W / 2, H / 2);
  assert(c[3] >= 250 && c[0] >= 245 && c[1] >= 245 && c[2] >= 245, `center not opaque white: ${c}`);
  // Every partly covered pixel around the disc: straight color stays white.
  let edges = 0;
  for (let y = H / 2 - 70; y < H / 2 + 70; y++) {
    for (let x = W / 2 - 70; x < W / 2 + 70; x++) {
      const p = px(b, x, y);
      if (p[3] > 30 && p[3] < 225) {
        edges++;
        const min = Math.min(p[0], p[1], p[2]);
        assert(min >= (lossy ? 200 : 235), `dark fringe at ${x},${y}: ${p}`);
      }
    }
  }
  assert(edges >= 20, `only ${edges} soft edge pixels on the disc`);
}

await check('GIF: palette encode at the frame rate and width asked for', async () => {
  const out = join(work, 'ad.gif');
  await render(specPath, { out, quality: 'draft', gifFps: 10, gifWidth: 320 });
  const info = probe(out);
  assert(/Video: gif/.test(info), `not a GIF: ${info}`);
  assert(/320x180/.test(info), `expected 320x180: ${info.match(/\d+x\d+/)?.[0]}`);
  assert(/10 fps/.test(info), `expected 10 fps: ${info.match(/[\d.]+ fps/)?.[0]}`);
});

await check('WebM --alpha: VP9 with an alpha channel, clean edges', async () => {
  const out = join(work, 'ad.webm');
  await render(specPath, { out, alpha: true });
  const info = probe(out);
  assert(/vp9/.test(info) && /alpha_mode\s*:\s*1/.test(info), `no VP9 alpha: ${info}`);
  alphaChecks(rgba(out, 5), true);
});

await check('MOV --alpha: ProRes 4444 with alpha, clean edges', async () => {
  const out = join(work, 'ad.mov');
  await render(specPath, { out, alpha: true, quality: 'draft' });
  const info = probe(out);
  assert(/prores \(4444\)/.test(info) && /yuva444p/.test(info), `not ProRes 4444 with alpha: ${info}`);
  alphaChecks(rgba(out, 5), true);
});

await check('MP4 refuses --alpha', async () => {
  let msg = '';
  try {
    await render(specPath, { out: join(work, 'ad.mp4'), alpha: true });
  } catch (e) {
    msg = (e as Error).message;
  }
  assert(/no alpha/i.test(msg), `expected an alpha error, got "${msg}"`);
});

await check('still --alpha: straight RGBA PNG, background layers dropped, no dark fringes', async () => {
  const [file] = await still(specPath, [0.5], join(work, 'still.png'), { alpha: true });
  const b = execFileSync(ff, ['-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 64 << 20 });
  assert(/rgba/.test(probe(file)), 'PNG has no alpha channel');
  alphaChecks(b, false);
  // Without --alpha the same still is opaque.
  const [solid] = await still(specPath, [0.5], join(work, 'solid.png'));
  const s = execFileSync(ff, ['-loglevel', 'error', '-i', solid, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 64 << 20 });
  assert(px(s, 2, 2)[3] === 255, 'opaque still has transparent corners');
});

await check('a "transparent" spec background renders with alpha without the flag', async () => {
  const [file] = await still(transparent, [0.5], join(work, 'clear.png'));
  const b = execFileSync(ff, ['-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 64 << 20 });
  alphaChecks(b, false);
});

await check('Lottie: image frames with in and out points, plays in lottie-web', async () => {
  const out = join(work, 'ad.lottie.json');
  const r = await exportLottie(specPath, { out, fps: 10, width: 240 });
  const j = JSON.parse(await readFile(out, 'utf8'));
  assert(j.w === 240 && j.h === 135 && j.fr === 10 && j.op === 10, `header ${j.w}x${j.h} @ ${j.fr}, op ${j.op}`);
  assert(r.frames === 10 && j.layers.length === 10 && j.assets.length === 10, `${j.layers.length} layers, ${j.assets.length} assets`);
  assert(j.layers.every((l: any, i: number) => l.ty === 2 && l.ip === i && l.op === i + 1 && l.refId === j.assets[i].id), 'layers do not show one frame each');
  assert(j.assets.every((a: any) => a.e === 1 && /^data:image\/jpeg;base64,/.test(a.p)), 'frames are not embedded JPEG');
  const browser = await puppeteer.launch({ headless: true, args: BROWSER_ARGS });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><body style="margin:0"><div id="a" style="width:240px;height:136px"></div></body>');
    await page.addScriptTag({ path: join(PKG_ROOT, 'node_modules/lottie-web/build/player/lottie.min.js') });
    const sums = (await page.evaluate(async (data) => {
      const lottie = (window as any).lottie;
      const anim = lottie.loadAnimation({ container: document.getElementById('a'), renderer: 'canvas', loop: false, autoplay: false, animationData: data });
      await new Promise<void>((res) => (anim.isLoaded ? res() : anim.addEventListener('DOMLoaded', () => res())));
      const canvas = document.querySelector('#a canvas') as HTMLCanvasElement;
      const out: number[] = [];
      for (const f of [0, 9]) {
        anim.goToAndStop(f, true);
        // Images decode asynchronously: wait until the frame is on the canvas.
        let s = 0;
        for (let k = 0; k < 50 && s === 0; k++) {
          await new Promise((r) => setTimeout(r, 50));
          anim.goToAndStop(f, true);
          const d = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
          s = 0;
          for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
        }
        out.push(s);
      }
      return { frames: anim.totalFrames, out };
    }, j)) as { frames: number; out: number[] };
    assert(sums.frames === 10, `lottie-web sees ${sums.frames} frames`);
    assert(sums.out[0] > 0 && sums.out[1] > 0, `blank frames in lottie-web: ${sums.out}`);
    assert(sums.out[0] !== sums.out[1], 'first and last frames look the same');
  } finally {
    await browser.close();
  }
});

await rm(work, { recursive: true, force: true }).catch(() => {});
console.log(failed ? `\n${failed} of ${n} format checks failed.` : `\nAll ${n} format checks passed.`);
process.exit(failed ? 1 : 0);
