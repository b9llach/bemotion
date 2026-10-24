import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpegPath } from './ffmpeg';

/**
 * Finds where things happen in a screen recording, so a video layer with `"focus": "auto"` can zoom
 * in on them like an edited product demo: typing, a menu opening, a panel loading. Frames are compared
 * at 10 fps on a small grayscale copy; changes confined to one area become focus moves, while changes
 * across the whole frame (scrolling, cuts) and idle stretches leave the view zoomed out.
 *
 * Results are in clip seconds, x and y in 0-1 from the top-left, cached next to the seek-friendly copy.
 */
export interface FocusMove {
  at: number;
  until: number;
  x: number;
  y: number;
  zoom: number;
}

export const FOCUS_W = 320;
const W = FOCUS_W;
export const FOCUS_H = 180;
const H = FOCUS_H;
export const FOCUS_RATE = 10;
const RATE = FOCUS_RATE;
/** Brightness change that counts as a changed pixel (0-255). */
const THRESHOLD = 14;

function decode(file: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-nostdin', '-loglevel', 'error', '-i', file, '-vf', `fps=${RATE},scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg could not read the clip: ${err.trim().slice(-300)}`))));
  });
}

interface Event {
  t0: number;
  t1: number;
  hx: Float64Array;
  hy: Float64Array;
  cx: number;
  cy: number;
  n: number;
}

/** Value below which `p` of the histogram's mass lies, normalized to 0-1. */
function percentile(h: Float64Array, p: number): number {
  let total = 0;
  for (const v of h) total += v;
  let acc = 0;
  for (let i = 0; i < h.length; i++) {
    acc += h[i];
    if (acc >= total * p) return (i + 0.5) / h.length;
  }
  return 1;
}

/** Focus moves from raw grayscale frames (W x H, RATE per second). Pure, for tests. */
export function findFocus(frames: Buffer): FocusMove[] {
  const N = W * H;
  const count = Math.floor(frames.length / N);
  const events: Event[] = [];
  let cur: Event | null = null;
  let idle = 0;
  let away: { cx: number; cy: number; frames: number; t: number } | null = null;
  const close = () => {
    if (cur) events.push(cur);
    cur = null;
  };
  for (let f = 1; f < count; f++) {
    const a = f * N;
    const b = (f - 1) * N;
    const hx = new Float64Array(W);
    const hy = new Float64Array(H);
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (Math.abs(frames[a + i] - frames[b + i]) <= THRESHOLD) continue;
        n++;
        hx[x]++;
        hy[y]++;
        sx += x;
        sy += y;
      }
    const t = f / RATE;
    // A change over a large part of the frame is a scroll or a cut: no single place to look at.
    if (n > N * 0.3) {
      close();
      idle = 0;
      continue;
    }
    if (n < 3) {
      if (cur && ++idle > 6) close();
      continue;
    }
    idle = 0;
    const cx = sx / n / W;
    const cy = sy / n / H;
    if (cur && Math.hypot(cx - cur.cx, (cy - cur.cy) * (H / W)) > 0.22) {
      // Activity somewhere else: a one-off flash (a list refreshing) keeps the current event; activity
      // that stays there for a few frames starts a new one.
      if (!away || Math.hypot(cx - away.cx, cy - away.cy) > 0.22) away = { cx, cy, frames: 0, t };
      if (++away.frames < 3) continue;
      close();
      cur = { t0: away.t, t1: t, hx: new Float64Array(W), hy: new Float64Array(H), cx, cy, n: 0 };
      away = null;
    } else away = null;
    if (!cur) cur = { t0: t, t1: t, hx: new Float64Array(W), hy: new Float64Array(H), cx, cy, n: 0 };
    cur.t1 = t;
    for (let i = 0; i < W; i++) cur.hx[i] += hx[i];
    for (let i = 0; i < H; i++) cur.hy[i] += hy[i];
    cur.cx = (cur.cx * cur.n + cx * n) / (cur.n + n);
    cur.cy = (cur.cy * cur.n + cy * n) / (cur.n + n);
    cur.n += n;
  }
  close();

  const moves: FocusMove[] = [];
  for (const e of events) {
    if (e.t1 - e.t0 < 0.25 && e.n < 1000) continue;
    const x0 = percentile(e.hx, 0.05);
    const x1 = percentile(e.hx, 0.95);
    const y0 = percentile(e.hy, 0.05);
    const y1 = percentile(e.hy, 0.95);
    // The changed area plus margin should fill about 70% of the view.
    const span = Math.max(x1 - x0, y1 - y0, 0.08);
    const zoom = Math.min(2.4, 0.7 / span);
    if (zoom < 1.25) continue;
    moves.push({ at: Math.max(0, e.t0 - 0.35), until: e.t1 + 0.8, x: (x0 + x1) / 2, y: (y0 + y1) / 2, zoom: Math.round(zoom * 100) / 100 });
  }
  // Neighbouring moves on the same spot become one hold.
  const merged: FocusMove[] = [];
  for (const m of moves) {
    const last = merged[merged.length - 1];
    if (last && m.at - last.until < 1 && Math.hypot(m.x - last.x, m.y - last.y) < 0.12) {
      last.until = Math.max(last.until, m.until);
      last.zoom = Math.min(last.zoom, m.zoom);
    } else merged.push({ ...m });
  }
  for (let i = 0; i + 1 < merged.length; i++) merged[i].until = Math.min(merged[i].until, merged[i + 1].at);
  return merged.map((m) => ({ ...m, at: round(m.at), until: round(m.until), x: round(m.x), y: round(m.y) }));
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const building = new Map<string, Promise<FocusMove[]>>();

export async function videoFocus(file: string, specDir: string): Promise<FocusMove[]> {
  const st = await stat(file);
  const key = createHash('sha1').update(`focus2|${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20);
  const dir = join(specDir, '.bemotion-cache', 'video');
  const out = join(dir, `${key}.focus.json`);
  try {
    return JSON.parse(await readFile(out, 'utf8')) as FocusMove[];
  } catch {
    // not analyzed yet
  }
  let p = building.get(out);
  if (!p) {
    p = (async () => {
      const moves = findFocus(await decode(file));
      await mkdir(dir, { recursive: true });
      await writeFile(out, JSON.stringify(moves));
      return moves;
    })().finally(() => building.delete(out));
    building.set(out, p);
  }
  return p;
}
