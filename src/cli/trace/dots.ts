import { readFrames, medianColor, hexRGB, toHex, type Frame } from './frames';

export interface DotsOptions {
  from: number;
  to: number;
  /** Dot color to look for (otherwise anything that differs from the background). */
  color?: string;
  /** Color distance that still counts as the dot color (or as different from the background). */
  tolerance?: number;
  minSize?: number;
  maxSize?: number;
  /** Max px a dot may move between frames beyond its predicted position. */
  gate?: number;
  /** Width of the design space the output is in (default 1920). */
  designWidth?: number;
}

export interface DotTrack {
  color: string;
  keys: number[][];
}

interface Det {
  x: number;
  y: number;
  d: number;
  c: [number, number, number];
}

/** Connected blobs of ink in one frame: center, diameter (the short side of a motion-blurred streak), color. */
export function detectDots(f: Frame, o: DotsOptions): Det[] {
  const { width: W, height: H, data } = f;
  const tol = o.tolerance ?? (o.color ? 90 : 60);
  const target = o.color ? hexRGB(o.color) : medianColor(f);
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const dr = data[i * 3] - target[0];
    const dg = data[i * 3 + 1] - target[1];
    const db = data[i * 3 + 2] - target[2];
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    ink[i] = o.color ? +(dist < tol) : +(dist > tol);
  }
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const out: Det[] = [];
  const minS = o.minSize ?? 3;
  const maxS = o.maxSize ?? 160;
  for (let start = 0; start < W * H; start++) {
    if (!ink[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let n = 0, sx = 0, sy = 0, x0 = W, x1 = 0, y0 = H, y1 = 0, cr = 0, cg = 0, cb = 0;
    while (sp) {
      const i = stack[--sp];
      const x = i % W;
      const y = (i / W) | 0;
      n++;
      sx += x;
      sy += y;
      cr += data[i * 3];
      cg += data[i * 3 + 1];
      cb += data[i * 3 + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const j of [i - 1, i + 1, i - W, i + W]) {
        if (j < 0 || j >= W * H || seen[j] || !ink[j]) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === W - 1)) continue;
        seen[j] = 1;
        stack[sp++] = j;
      }
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    if (w < minS || h < minS || w > maxS || h > maxS) continue;
    if (n / (w * h) < 0.4) continue;
    const long = Math.max(w, h) > 1.3 * Math.min(w, h);
    out.push({ x: sx / n, y: sy / n, d: long ? Math.min(w, h) : (w + h) / 2, c: [cr / n, cg / n, cb / n] });
  }
  return out;
}

/** Minimum-cost assignment (Hungarian algorithm) of rows to columns; -1 where a row stays unmatched. */
export function assign(cost: number[][]): number[] {
  const n = cost.length;
  const m = cost[0]?.length ?? 0;
  if (!n || !m) return new Array(n).fill(-1);
  const N = Math.max(n, m);
  const BIG = 1e9;
  const a = (i: number, j: number) => (i < n && j < m ? cost[i][j] : BIG / 10);
  const u = new Float64Array(N + 1);
  const v = new Float64Array(N + 1);
  const p = new Int32Array(N + 1);
  const way = new Int32Array(N + 1);
  for (let i = 1; i <= N; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(N + 1).fill(Infinity);
    const used = new Uint8Array(N + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= N; j++) {
        if (used[j]) continue;
        const cur = a(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= N; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const res = new Array(n).fill(-1);
  for (let j = 1; j <= N; j++) if (p[j] - 1 < n && j - 1 < m) res[p[j] - 1] = j - 1;
  return res;
}

/**
 * Tracks dots through a stretch of video: detection per frame, constant-acceleration prediction, a global
 * assignment per frame, then fragments joined across gaps of up to four frames. Output in design px (center
 * origin, y up), frames numbered as in the video.
 */
export async function traceDots(src: string, o: DotsOptions, onFrame?: (f: number) => void): Promise<DotTrack[]> {
  const gate = o.gate ?? 90;
  type Live = { keys: number[][]; c: number[] };
  let live: Live[] = [];
  const done: Live[] = [];
  let W = 0;
  let H = 0;
  for await (const f of readFrames(src, o.from, o.to + 1)) {
    W = f.width;
    H = f.height;
    onFrame?.(f.index);
    const det = detectDots(f, o);
    const preds = live.map((t) => {
      const k = t.keys;
      const p = k[k.length - 1];
      if (k.length >= 3) {
        const q = k[k.length - 2];
        const r = k[k.length - 3];
        const vx = p[1] - q[1];
        const vy = p[2] - q[2];
        return [p[1] + vx + 0.5 * (vx - (q[1] - r[1])), p[2] + vy + 0.5 * (vy - (q[2] - r[2]))];
      }
      if (k.length === 2) return [2 * p[1] - k[0][1], 2 * p[2] - k[0][2]];
      return [p[1], p[2]];
    });
    const matched = new Set<number>();
    const keep: Live[] = [];
    if (live.length && det.length) {
      const cost = live.map((t, i) => det.map((d) => {
        const c = Math.hypot(preds[i][0] - d.x, preds[i][1] - d.y) + 3 * Math.abs(t.keys[t.keys.length - 1][3] - d.d);
        return c > gate ? 1e7 : c;
      }));
      const a = assign(cost);
      live.forEach((t, i) => {
        const j = a[i];
        if (j >= 0 && cost[i][j] < 1e7) {
          const d = det[j];
          t.keys.push([f.index, d.x, d.y, d.d]);
          t.c = d.c;
          matched.add(j);
          keep.push(t);
        } else done.push(t);
      });
    } else done.push(...live);
    live = keep;
    det.forEach((d, j) => {
      if (!matched.has(j)) live.push({ keys: [[f.index, d.x, d.y, d.d]], c: d.c });
    });
  }
  done.push(...live);
  let tracks = done.filter((t) => t.keys.length >= 2);
  tracks = stitch(tracks);
  const k = (o.designWidth ?? 1920) / Math.max(1, W);
  return tracks.map((t) => ({
    color: toHex(t.c),
    keys: t.keys.map(([f, x, y, d]) => [f, round1((x - W / 2) * k), round1((H / 2 - y) * k), round1(d * k)]),
  }));
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Joins a track that ends to one that starts up to four frames later where its motion leads. */
function stitch<T extends { keys: number[][] }>(tracks: T[]): T[] {
  for (let pass = 0; pass < 4; pass++) {
    const n = tracks.length;
    const cost: number[][] = tracks.map((a) => {
      const k = a.keys;
      const e = k[k.length - 1];
      const prev = k.length > 1 ? k[k.length - 2] : e;
      return tracks.map((b) => {
        if (a === b) return 1e7;
        const s = b.keys[0];
        const g = s[0] - e[0];
        if (g < 1 || g > 4) return 1e7;
        const px = e[1] + (e[1] - prev[1]) * g;
        const py = e[2] + (e[2] - prev[2]) * g;
        const d = Math.hypot(px - s[1], py - s[2]);
        return d < 40 * Math.sqrt(g) ? d + 2 * Math.abs(e[3] - s[3]) : 1e7;
      });
    });
    const a = assign(cost);
    const next = new Map<number, number>();
    a.forEach((j, i) => {
      if (j >= 0 && cost[i][j] < 1e7) next.set(i, j);
    });
    if (!next.size) break;
    const hasPrev = new Set(next.values());
    const out: T[] = [];
    for (let i = 0; i < n; i++) {
      if (hasPrev.has(i)) continue;
      const keys = [...tracks[i].keys];
      const seen = new Set([i]);
      let j = next.get(i);
      while (j !== undefined && !seen.has(j)) {
        seen.add(j);
        keys.push(...tracks[j].keys);
        j = next.get(j);
      }
      out.push({ ...tracks[i], keys });
    }
    tracks = out;
  }
  return tracks;
}
