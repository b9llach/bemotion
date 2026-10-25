import { readFrames, gray, probe } from './frames';

export interface CameraOptions {
  from: number;
  to: number;
  /** Frame whose layout the transforms map from (default `from`). */
  anchor?: number;
  /** Width frames are analysed at (default 960). */
  work?: number;
  designWidth?: number;
}

export interface CameraTrace {
  /** Per frame: [s, tx, ty] such that a point (x, y) of the anchor frame is at (s*x + tx, s*y + ty) in that frame (design px, y down). */
  frames: Record<number, [number, number, number]>;
  /** The same as keyframes for a group laid out in the anchor frame's design coordinates (center origin, y up). */
  keyframes: { scale: { t: number; v: number }[]; x: { t: number; v: number }[]; y: { t: number; v: number }[] };
  /** Frames where tracking lost the picture (cuts, blank frames). */
  lost: number[];
}

interface Img {
  w: number;
  h: number;
  g: Float32Array;
}

function down(a: Img): Img {
  const w = a.w >> 1;
  const h = a.h >> 1;
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 2 * y * a.w + 2 * x;
    g[y * w + x] = (a.g[i] + a.g[i + 1] + a.g[i + a.w] + a.g[i + a.w + 1]) / 4;
  }
  return { w, h, g };
}

export function pyramid(a: Img): Img[] {
  return [a, down(a), down(down(a))];
}

const R = 7;

/** Sum of absolute differences between a patch of A at (ax, ay) and B at (bx, by). */
function sad(A: Img, ax: number, ay: number, B: Img, bx: number, by: number, best: number): number {
  let s = 0;
  for (let dy = -R; dy <= R; dy++) {
    const ra = (ay + dy) * A.w + ax;
    const rb = (by + dy) * B.w + bx;
    for (let dx = -R; dx <= R; dx++) s += Math.abs(A.g[ra + dx] - B.g[rb + dx]);
    if (s >= best) return s;
  }
  return s;
}

function search(A: Img, ax: number, ay: number, B: Img, cx: number, cy: number, rad: number): [number, number, number] {
  let best = Infinity;
  let bx = cx;
  let by = cy;
  for (let y = cy - rad; y <= cy + rad; y++) {
    if (y < R || y >= B.h - R) continue;
    for (let x = cx - rad; x <= cx + rad; x++) {
      if (x < R || x >= B.w - R) continue;
      const s = sad(A, ax, ay, B, x, y, best);
      if (s < best) {
        best = s;
        bx = x;
        by = y;
      }
    }
  }
  return [bx, by, best];
}

/** Textured points of A (strongest gradient per grid cell). */
function features(A: Img, cell = 24): [number, number][] {
  const out: [number, number][] = [];
  for (let cy = R + 2; cy < A.h - R - 2 - cell; cy += cell) {
    for (let cx = R + 2; cx < A.w - R - 2 - cell; cx += cell) {
      let best = 0;
      let bx = 0;
      let by = 0;
      for (let y = cy; y < cy + cell; y += 2) for (let x = cx; x < cx + cell; x += 2) {
        const i = y * A.w + x;
        const gx = A.g[i + 1] - A.g[i - 1];
        const gy = A.g[i + A.w] - A.g[i - A.w];
        const m = Math.min(Math.abs(gx), Math.abs(gy)) + 0.25 * Math.max(Math.abs(gx), Math.abs(gy));
        if (m > best) {
          best = m;
          bx = x;
          by = y;
        }
      }
      if (best > 6) out.push([bx, by]);
    }
  }
  return out;
}

/** Similarity (scale and shift, no rotation) mapping frame A into frame B, or null. */
export function relate(pa: Img[], pb: Img[], seed: number, tol = 1.5): { s: number; tx: number; ty: number; inliers: number } | null {
  const pts = features(pa[0]);
  const pairs: [number, number, number, number][] = [];
  for (const [x, y] of pts) {
    const x2 = x >> 2;
    const y2 = y >> 2;
    if (x2 < R || y2 < R || x2 >= pa[2].w - R || y2 >= pa[2].h - R) continue;
    let [bx, by] = search(pa[2], x2, y2, pb[2], x2, y2, 24);
    [bx, by] = search(pa[1], x >> 1, y >> 1, pb[1], bx * 2, by * 2, 3);
    const [fx, fy, cost] = search(pa[0], x, y, pb[0], bx * 2, by * 2, 3);
    if (cost / ((2 * R + 1) ** 2) < 12) pairs.push([x, y, fx, fy]);
  }
  if (pairs.length < 8) return null;
  // RANSAC on pairs of matches, then a least-squares fit on the inliers.
  let rnd = seed >>> 0 || 1;
  const rand = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296);
  let best: number[] = [];
  for (let it = 0; it < 400; it++) {
    const a = pairs[Math.floor(rand() * pairs.length)];
    const b = pairs[Math.floor(rand() * pairs.length)];
    const da = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (da < 20) continue;
    const s = Math.hypot(b[2] - a[2], b[3] - a[3]) / da;
    const tx = a[2] - s * a[0];
    const ty = a[3] - s * a[1];
    const inl: number[] = [];
    pairs.forEach((p, i) => {
      if (Math.hypot(s * p[0] + tx - p[2], s * p[1] + ty - p[3]) < tol) inl.push(i);
    });
    if (inl.length > best.length) best = inl;
  }
  if (best.length < 8) return null;
  const P = best.map((i) => pairs[i]);
  const mx = P.reduce((s, p) => s + p[0], 0) / P.length;
  const my = P.reduce((s, p) => s + p[1], 0) / P.length;
  const nx = P.reduce((s, p) => s + p[2], 0) / P.length;
  const ny = P.reduce((s, p) => s + p[3], 0) / P.length;
  let num = 0;
  let den = 0;
  for (const p of P) {
    num += (p[0] - mx) * (p[2] - nx) + (p[1] - my) * (p[3] - ny);
    den += (p[0] - mx) ** 2 + (p[1] - my) ** 2;
  }
  const s = den > 0 ? num / den : 1;
  return { s, tx: nx - s * mx, ty: ny - s * my, inliers: P.length };
}

type M = [number, number, number];

function sample(I: Img, x: number, y: number): number {
  if (x < 0 || y < 0 || x > I.w - 1.001 || y > I.h - 1.001) return NaN;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const i = y0 * I.w + x0;
  return (I.g[i] * (1 - fx) + I.g[i + 1] * fx) * (1 - fy) + (I.g[i + I.w] * (1 - fx) + I.g[i + I.w + 1] * fx) * fy;
}

/**
 * A rough scale and shift from A to B when the frames differ too much for block matching (a fast zoom):
 * tries zooms from half to double, each with the best shift, on the smallest pyramid level.
 */
export function coarse(pa: Img[], pb: Img[]): M | null {
  const A = pa[2];
  const B = pb[2];
  const pts: [number, number, number][] = [];
  for (let y = 2; y < A.h - 2; y += 2) for (let x = 2; x < A.w - 2; x += 2) {
    const i = y * A.w + x;
    const g = Math.abs(A.g[i + 1] - A.g[i - 1]) + Math.abs(A.g[i + A.w] - A.g[i - A.w]);
    if (g > 8) pts.push([x, y, A.g[i]]);
  }
  if (pts.length < 40) return null;
  const step = Math.max(1, Math.floor(pts.length / 1500));
  const P = pts.filter((_, i) => i % step === 0);
  const cx = A.w / 2, cy = A.h / 2;
  const cost = (s: number, dx: number, dy: number) => {
    let sum = 0, n = 0;
    for (const [x, y, v] of P) {
      const b = sample(B, s * (x - cx) + cx + dx, s * (y - cy) + cy + dy);
      if (Number.isNaN(b)) continue;
      sum += Math.abs(b - v);
      n++;
    }
    return n > P.length * 0.35 ? sum / n : Infinity;
  };
  let best: [number, number, number, number] = [Infinity, 1, 0, 0];
  const R = Math.round(A.w / 4);
  for (let k = 0; k <= 28; k++) {
    const sc = Math.pow(2, -1 + k / 14);
    for (let dy = -R; dy <= R; dy += 3) for (let dx = -R; dx <= R; dx += 3) {
      const c = cost(sc, dx, dy);
      if (c < best[0]) best = [c, sc, dx, dy];
    }
  }
  // Refine around the best.
  let [c0, s0, x0, y0] = best;
  for (const st of [1, 0.5, 0.25]) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const [ds, ddx, ddy] of [[1.01, 0, 0], [1 / 1.01, 0, 0], [1, st, 0], [1, -st, 0], [1, 0, st], [1, 0, -st]]) {
        const c = cost(s0 * ds, x0 + ddx, y0 + ddy);
        if (c < c0) {
          [c0, s0, x0, y0] = [c, s0 * ds, x0 + ddx, y0 + ddy];
          improved = true;
        }
      }
    }
  }
  if (!Number.isFinite(c0)) return null;
  // Level 2 is a quarter of the working size: a point x maps to s * (x - C) + C + 4 * d.
  const C = { x: pa[0].w / 2, y: pa[0].h / 2 };
  return [s0, C.x * (1 - s0) + 4 * x0, C.y * (1 - s0) + 4 * y0];
}

/** B resampled through M (B'(x) = B(M x)), so whatever is left between A and B' is small. */
function warp(pb: Img[], m: M): Img[] {
  const B = pb[0];
  const g = new Float32Array(B.w * B.h);
  let mean = 0;
  for (let i = 0; i < B.g.length; i++) mean += B.g[i] / B.g.length;
  for (let y = 0; y < B.h; y++) for (let x = 0; x < B.w; x++) {
    const v = sample(B, m[0] * x + m[1], m[0] * y + m[2]);
    g[y * B.w + x] = Number.isNaN(v) ? mean : v;
  }
  return pyramid({ w: B.w, h: B.h, g });
}
const compose = (b: M, a: M): M => [b[0] * a[0], b[0] * a[1] + b[1], b[0] * a[2] + b[2]];

/**
 * Follows the camera through a stretch of video: a scale-and-shift per frame relative to the anchor frame,
 * chained frame to frame. A cut ends the chain (reported in `lost`).
 */
export async function traceCamera(src: string, o: CameraOptions, onFrame?: (f: number) => void): Promise<CameraTrace> {
  const work = o.work ?? 960;
  const pyr = new Map<number, Img[]>();
  let H = 0;
  for await (const f of readFrames(src, o.from, o.to + 1, { width: work })) {
    onFrame?.(f.index);
    H = f.height;
    pyr.set(f.index, pyramid({ w: f.width, h: f.height, g: gray(f) }));
  }
  const anchor = o.anchor ?? o.from;
  const T = new Map<number, M>([[anchor, [1, 0, 0]]]);
  const lost: number[] = [];
  for (const dir of [1, -1]) {
    let f = anchor;
    const ok = (r: ReturnType<typeof relate>) => !!r && r.inliers >= 12 && r.s > 0.4 && r.s < 2.5;
    while (pyr.has(f + dir)) {
      let r = relate(pyr.get(f)!, pyr.get(f + dir)!, f * 7919 + dir);
      // A frame where the motion changes (a scroll turning into a zoom, motion blur) can fail the strict fit.
      if (!ok(r)) r = relate(pyr.get(f)!, pyr.get(f + dir)!, f * 7919 + dir, 3);
      if (!ok(r)) {
        // Too different for block matching (a fast zoom): find the rough zoom and shift, warp the next
        // frame back by it, and match what is left.
        const a = pyr.get(f)!;
        const b = pyr.get(f + dir)!;
        const g = coarse(a, b);
        if (g) {
          const rr = relate(a, warp(b, g), f * 7919 + dir + 1, 3);
          if (ok(rr)) {
            // x_B = g(rr(x)).
            r = { s: g[0] * rr!.s, tx: g[0] * rr!.tx + g[1], ty: g[0] * rr!.ty + g[2], inliers: rr!.inliers };
          }
        }
      }
      if (!ok(r) && pyr.has(f + 2 * dir)) {
        // Skip it: relate to the frame after and put this one halfway (geometric in scale).
        const r2 = relate(pyr.get(f)!, pyr.get(f + 2 * dir)!, f * 7919 + 2 * dir, 3);
        if (ok(r2)) {
          const sh = Math.sqrt(r2!.s);
          const half: M = [sh, r2!.tx / (1 + sh), r2!.ty / (1 + sh)];
          T.set(f + dir, compose(half, T.get(f)!));
          T.set(f + 2 * dir, compose([r2!.s, r2!.tx, r2!.ty], T.get(f)!));
          f += 2 * dir;
          continue;
        }
      }
      if (!ok(r)) {
        lost.push(f + dir);
        break;
      }
      T.set(f + dir, compose([r!.s, r!.tx, r!.ty], T.get(f)!));
      f += dir;
    }
  }
  const k = (o.designWidth ?? 1920) / work;
  const DW = o.designWidth ?? 1920;
  const DH = (H * k) | 0;
  const out: CameraTrace = { frames: {}, keyframes: { scale: [], x: [], y: [] }, lost };
  const fps = (await probe(src)).fps;
  for (const f of [...T.keys()].sort((a, b) => a - b)) {
    const [s, tx, ty] = T.get(f)!;
    const m: M = [s, tx * k, ty * k];
    out.frames[f] = [round(m[0], 5), round(m[1], 2), round(m[2], 2)];
    const t = round((f - o.from) / fps, 4);
    out.keyframes.scale.push({ t, v: round(s, 5) });
    out.keyframes.x.push({ t, v: round(s * (DW / 2) + m[1] - DW / 2, 2) });
    out.keyframes.y.push({ t, v: round(DH / 2 - (DH / 2) * s - m[2], 2) });
  }
  return out;
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
