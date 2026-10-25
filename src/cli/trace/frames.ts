import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { ffmpegPath } from '../ffmpeg';

/** An RGB frame (row-major, 3 bytes per pixel). */
export interface Frame {
  index: number;
  width: number;
  height: number;
  data: Uint8Array;
}

/** Width, height and frame rate of a video (or image), from ffmpeg's stream line. */
export async function probe(src: string): Promise<{ width: number; height: number; fps: number }> {
  const err = await new Promise<string>((res) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-i', src], { stdio: ['ignore', 'ignore', 'pipe'] });
    let s = '';
    p.stderr.on('data', (d) => (s += d));
    p.on('close', () => res(s));
  });
  const m = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(err);
  if (!m) throw new Error(`could not read the video size of ${src}`);
  const f = /(\d+(?:\.\d+)?) fps/.exec(err) ?? /(\d+(?:\.\d+)?) tbr/.exec(err);
  return { width: +m[1], height: +m[2], fps: f ? +f[1] : 30 };
}

/**
 * Decodes frames f0..f1-1 of a video (frame-exact: seeks a quarter frame early, like compare). `width`
 * scales the frames down (height follows the aspect).
 */
export async function* readFrames(src: string, f0: number, f1: number, opts: { width?: number } = {}): AsyncGenerator<Frame> {
  const info = await probe(src);
  const W = opts.width ?? info.width;
  const H = Math.round((info.height * W) / info.width / 2) * 2;
  const size = W * H * 3;
  const args = ['-loglevel', 'error', '-ss', Math.max(0, (f0 - 0.25) / info.fps).toFixed(4), '-i', src, '-frames:v', String(Math.max(1, f1 - f0))];
  if (W !== info.width) args.push('-vf', `scale=${W}:${H}:flags=area`);
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
  const p = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let buf: Buffer = Buffer.alloc(0);
  let index = f0;
  for await (const chunk of p.stdout as AsyncIterable<Buffer>) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= size) {
      yield { index: index++, width: W, height: H, data: new Uint8Array(buf.subarray(0, size)) };
      buf = buf.subarray(size);
    }
  }
}

/** One frame of a video, or an image file. */
export async function readFrame(src: string, frame = 0, opts: { width?: number } = {}): Promise<Frame> {
  for await (const f of readFrames(src, frame, frame + 1, opts)) return f;
  throw new Error(`no frame ${frame} in ${src}`);
}

/** Grayscale copy (0-255 floats). */
export function gray(f: Frame): Float32Array {
  const g = new Float32Array(f.width * f.height);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * f.data[i * 3] + 0.587 * f.data[i * 3 + 1] + 0.114 * f.data[i * 3 + 2];
  return g;
}

/** Parses "#RRGGBB". */
export function hexRGB(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`expected a color like #2A5FE4, got ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex(c: ArrayLike<number>): string {
  return '#' + [0, 1, 2].map((i) => Math.max(0, Math.min(255, Math.round(c[i]))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Median color of a frame region (the background around ink). */
export function medianColor(f: Frame, x0 = 0, y0 = 0, x1 = f.width, y1 = f.height): [number, number, number] {
  const ch: number[][] = [[], [], []];
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 40000)));
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) for (let c = 0; c < 3; c++) ch[c].push(f.data[(y * f.width + x) * 3 + c]);
  return ch.map((v) => v.sort((a, b) => a - b)[v.length >> 1]) as [number, number, number];
}

/** Parses "x0,y0,x1,y1". */
export function parseRegion(s: string | undefined, f: { width: number; height: number }): [number, number, number, number] {
  if (!s) return [0, 0, f.width, f.height];
  const v = s.split(',').map(Number);
  if (v.length !== 4 || v.some((n) => !Number.isFinite(n))) throw new Error(`expected a region like 100,200,900,400, got ${s}`);
  return [Math.max(0, v[0]), Math.max(0, v[1]), Math.min(f.width, v[2]), Math.min(f.height, v[3])];
}

export async function readJSON<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
