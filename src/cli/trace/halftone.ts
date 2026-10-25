import { writeFile } from 'node:fs/promises';
import { zlibSync } from 'fflate';
import { readFrame, parseRegion, hexRGB, toHex } from './frames';

/** Minimal grayscale PNG encoder. */
export function encodeGrayPNG(w: number, h: number, px: Uint8Array): Uint8Array {
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) raw.set(px.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}

/** Period of a 1-D signal from its autocorrelation (the first strong peak after zero lag). */
function period(v: Float64Array, minP = 3): number {
  const n = v.length;
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const d = v.map((x) => x - mean);
  let best = -Infinity;
  let bp = minP;
  const ac: number[] = [];
  for (let p = 0; p < n / 2; p++) {
    let s = 0;
    for (let i = 0; i + p < n; i++) s += d[i] * d[i + p];
    ac.push(s / (n - p));
  }
  for (let p = minP; p < ac.length - 1; p++) {
    if (ac[p] > ac[p - 1] && ac[p] >= ac[p + 1] && ac[p] > best * 1.0001) {
      // The first local maximum that holds most of the zero-lag power is the dot pitch.
      if (ac[p] > 0.3 * ac[0]) {
        best = ac[p];
        bp = p;
        break;
      }
    }
  }
  // Sub-pixel refinement by a parabola through the peak.
  const a = ac[bp - 1], b = ac[bp], c = ac[bp + 1];
  const off = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  return bp + Math.max(-0.5, Math.min(0.5, off));
}

/**
 * Reads a halftone (a grid of dots) from a frame region: its pitch and phase, and each dot's size, as a
 * grayscale image with one pixel per dot (255 = full dot). Use it as an image with `halftone` set to
 * `columns` = image width and `levels` [0, 1] to redraw exactly those dots.
 */
export async function traceHalftone(src: string, o: { frame?: number; region?: string; color?: string; pitch?: number; out: string }) {
  const f = await readFrame(src, o.frame ?? 0);
  const [x0, y0, x1, y1] = parseRegion(o.region, f);
  const W = x1 - x0;
  const H = y1 - y0;
  // Two colors fill a halftone: split the pixels into two groups (2-means). The lighter is the paper,
  // unless a dot color is given.
  const pix: number[][] = [];
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    const i = (y * f.width + x) * 3;
    pix.push([f.data[i], f.data[i + 1], f.data[i + 2]]);
  }
  const lum = (c: number[]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  pix.sort((a, b) => lum(a) - lum(b));
  let A = pix[Math.floor(pix.length * 0.05)].slice();
  let B = pix[Math.floor(pix.length * 0.95)].slice();
  for (let it = 0; it < 8; it++) {
    const sa = [0, 0, 0, 0];
    const sb = [0, 0, 0, 0];
    for (const p of pix) {
      const da = (p[0] - A[0]) ** 2 + (p[1] - A[1]) ** 2 + (p[2] - A[2]) ** 2;
      const db = (p[0] - B[0]) ** 2 + (p[1] - B[1]) ** 2 + (p[2] - B[2]) ** 2;
      const t = da < db ? sa : sb;
      t[0] += p[0];
      t[1] += p[1];
      t[2] += p[2];
      t[3]++;
    }
    if (sa[3]) A = [sa[0] / sa[3], sa[1] / sa[3], sa[2] / sa[3]];
    if (sb[3]) B = [sb[0] / sb[3], sb[1] / sb[3], sb[2] / sb[3]];
  }
  const dot: number[] = o.color ? hexRGB(o.color) : lum(A) < lum(B) ? A : B;
  const bg = lum(A) < lum(B) ? B : A;
  const axis = [dot[0] - bg[0], dot[1] - bg[1], dot[2] - bg[2]];
  const norm = axis.reduce((s, v) => s + v * v, 0) || 1;
  const ink = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = ((y + y0) * f.width + x + x0) * 3;
    const v = ((f.data[i] - bg[0]) * axis[0] + (f.data[i + 1] - bg[1]) * axis[1] + (f.data[i + 2] - bg[2]) * axis[2]) / norm;
    ink[y * W + x] = Math.max(0, Math.min(1, v));
  }
  const colMean = new Float64Array(W);
  const rowMean = new Float64Array(H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    colMean[x] += ink[y * W + x] / H;
    rowMean[y] += ink[y * W + x] / W;
  }
  const pitch = o.pitch ?? (period(colMean) + period(rowMean)) / 2;
  // Phase: the offset that puts the most ink at cell centers.
  const phase = (prof: Float64Array) => {
    let best = -1;
    let bo = 0;
    for (let off = 0; off < pitch; off += 0.25) {
      let s = 0;
      for (let c = off + pitch / 2; c < prof.length - 1; c += pitch) {
        const i = Math.floor(c);
        s += prof[i] + (prof[i + 1] - prof[i]) * (c - i);
      }
      if (s > best) {
        best = s;
        bo = off;
      }
    }
    return bo;
  };
  const ox = phase(colMean);
  const oy = phase(rowMean);
  const nx = Math.floor((W - ox) / pitch);
  const ny = Math.floor((H - oy) / pitch);
  const radius = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let s = 0;
    const ya = Math.round(oy + j * pitch), yb = Math.round(oy + (j + 1) * pitch);
    const xa = Math.round(ox + i * pitch), xb = Math.round(ox + (i + 1) * pitch);
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) s += ink[y * W + x];
    radius[j * nx + i] = Math.sqrt(s / Math.PI);
  }
  const sorted = [...radius].sort((a, b) => a - b);
  const rmax = sorted[Math.floor(sorted.length * 0.99)] || 1;
  const px = new Uint8Array(nx * ny);
  for (let i = 0; i < px.length; i++) px[i] = Math.round(Math.min(1, radius[i] / rmax) * 255);
  await writeFile(o.out, encodeGrayPNG(nx, ny, px));
  return {
    out: o.out,
    columns: nx,
    rows: ny,
    pitch: Math.round(pitch * 1000) / 1000,
    origin: [Math.round((x0 + ox) * 100) / 100, Math.round((y0 + oy) * 100) / 100],
    color: toHex(dot),
    background: toHex(bg),
    /** Full dot diameter as a fraction of the pitch (the halftone `size`). */
    size: Math.round(((rmax * 2) / pitch) * 1000) / 1000,
  };
}
