import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readSpec, startServer } from './server';
import { BROWSER_ARGS, openPage } from './render';
import { ffmpegPath } from './ffmpeg';
import { validateVideo } from '../spec/schema';

const TW = 192;
const TH = 108;

export interface CompareOptions {
  /** Samples per second. */
  rate?: number;
  from?: number;
  to?: number;
  /** How many of the worst moments to save side by side. */
  worst?: number;
  /** Folder for the side-by-side images. */
  out?: string;
}

export interface CompareSample {
  t: number;
  /** Mean absolute difference per channel, 0 (identical) to 255. */
  diff: number;
}

function run(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((res, rej) => {
    const p = spawn(ffmpegPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? res(Buffer.concat(out)) : rej(new Error(`ffmpeg failed: ${err.slice(-400)}`))));
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

/** Reference frames at the sample times, as small RGB thumbnails. */
async function referenceThumbs(ref: string, times: number[]): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  // One decode per sample keeps the times exact (the fps filter would round to its own grid).
  const chunk = 24;
  for (let i = 0; i < times.length; i += chunk) {
    const part = times.slice(i, i + chunk);
    const bufs = await Promise.all(
      part.map((t) => run(['-loglevel', 'error', '-ss', t.toFixed(3), '-i', ref, '-frames:v', '1', '-vf', `scale=${TW}:${TH}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])),
    );
    for (const b of bufs) out.push(new Uint8Array(b.buffer, b.byteOffset, Math.min(b.length, TW * TH * 3)));
  }
  return out;
}

/** Mean absolute difference of two RGB thumbnails, after a light blur so one-pixel offsets do not count. */
export function thumbDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const blur = (src: ArrayLike<number>) => {
    const o = new Float32Array(TW * TH * 3);
    for (let y = 0; y < TH; y++) {
      for (let x = 0; x < TW; x++) {
        for (let c = 0; c < 3; c++) {
          let s = 0;
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              const yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= TW || yy >= TH) continue;
              s += src[(yy * TW + xx) * 3 + c] ?? 0;
              n++;
            }
          }
          o[(y * TW + x) * 3 + c] = s / n;
        }
      }
    }
    return o;
  };
  const A = blur(a);
  const B = blur(b);
  let d = 0;
  for (let i = 0; i < A.length; i++) d += Math.abs(A[i] - B[i]);
  return d / A.length;
}

/** Renders a spec at the sample times and scores each moment against a reference video. */
export async function compare(specPath: string, refPath: string, opts: CompareOptions = {}) {
  const spec = await readSpec(resolve(specPath));
  const v = validateVideo(spec);
  if (!v.ok) throw new Error(`Invalid spec:\n${v.errors.map((e) => `  - ${e}`).join('\n')}`);
  const { server, url } = await startServer(resolve(specPath), { hmr: false });
  const browser = await puppeteer.launch({ headless: true, args: BROWSER_ARGS, protocolTimeout: 600000 });
  try {
    const { page, info } = await openPage(browser, url, v.video);
    const rate = opts.rate ?? 5;
    const from = Math.max(0, opts.from ?? 0);
    const to = Math.min(info.duration, opts.to ?? info.duration);
    const times: number[] = [];
    for (let t = from; t < to - 1e-6; t += 1 / rate) times.push(Math.round(t * 1000) / 1000);
    const refs = await referenceThumbs(resolve(refPath), times);
    const samples: CompareSample[] = [];
    for (let i = 0; i < times.length; i++) {
      const frame = Math.min(info.frameCount - 1, Math.round(times[i] * info.fps));
      const r = (await page.evaluate((f) => (window as any).bemotion.probe(f, true), frame)) as { thumb: number[] };
      samples.push({ t: times[i], diff: thumbDiff(r.thumb, refs[i]) });
    }
    // Side by side images of the worst moments, reference on the left.
    const worst = [...samples].sort((a, b) => b.diff - a.diff).slice(0, opts.worst ?? 10).sort((a, b) => a.t - b.t);
    const outDir = resolve(opts.out ?? 'out/compare');
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    const files: string[] = [];
    for (const s of worst) {
      const frame = Math.min(info.frameCount - 1, Math.round(s.t * info.fps));
      const dataUrl = (await page.evaluate((f) => (window as any).bemotion.frame(f, 'jpeg', 0.9, false), frame)) as string;
      const ours = join(outDir, `_ours.jpg`);
      await writeFile(ours, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
      const file = join(outDir, `${s.t.toFixed(2).padStart(6, '0')}.jpg`);
      await run(['-loglevel', 'error', '-y', '-ss', s.t.toFixed(3), '-i', resolve(refPath), '-i', ours, '-filter_complex',
        `[0:v]scale=960:540,trim=end_frame=1[a];[1:v]scale=960:540[b];[a][b]hstack=2`, '-frames:v', '1', file]);
      files.push(file);
    }
    await rm(join(outDir, '_ours.jpg'), { force: true });
    return { samples, worst, files, outDir };
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
