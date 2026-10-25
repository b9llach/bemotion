import opentype from 'opentype.js';
import { readFile } from 'node:fs/promises';
import { readFrame, readFrames, medianColor, parseRegion, toHex, hexRGB, type Frame } from './frames';

export interface TextFit {
  text: string;
  /** Font size in design px (fitted to the ink width). */
  size: number;
  /** Left edge of the first letter's ink and the baseline, design px from the top-left (y down). */
  inkLeft: number;
  baseline: number;
  color: string;
  background: string;
  /** A text layer (center origin, y up) that lands on the measured ink with the engine's layout. */
  layer: Record<string, unknown>;
}

async function loadFont(path: string): Promise<opentype.Font> {
  const buf = await readFile(path);
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** Ink box of a region (pixels that differ from its background). */
function inkBox(f: Frame, r: [number, number, number, number], thr = 40) {
  const bg = medianColor(f, ...r);
  let x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1;
  const ink: number[][] = [];
  for (let y = r[1]; y < r[3]; y++) for (let x = r[0]; x < r[2]; x++) {
    const i = (y * f.width + x) * 3;
    const d = Math.max(Math.abs(f.data[i] - bg[0]), Math.abs(f.data[i + 1] - bg[1]), Math.abs(f.data[i + 2] - bg[2]));
    if (d > thr) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      ink.push([f.data[i], f.data[i + 1], f.data[i + 2], d]);
    }
  }
  if (x1 < 0) throw new Error('no text found in the region (try a larger region or check the frame)');
  ink.sort((a, b) => b[3] - a[3]);
  const top = ink.slice(0, Math.max(1, Math.floor(ink.length / 10)));
  const color = [0, 1, 2].map((c) => top.reduce((s, p) => s + p[c], 0) / top.length);
  return { x0, x1: x1 + 1, y0, y1: y1 + 1, color, bg };
}

/**
 * Fits a line of text in a frame: finds its ink in the region, sizes the font so the ink is as wide, and
 * returns the baseline, color and a text layer that reproduces it. Coordinates are scaled to the design width.
 */
export async function traceText(src: string, o: { frame?: number; region?: string; text: string; font: string; family?: string; weight?: number; lineHeight?: number; designWidth?: number }): Promise<TextFit> {
  const f = await readFrame(src, o.frame ?? 0);
  const k = (o.designWidth ?? 1920) / f.width;
  const box = inkBox(f, parseRegion(o.region, f));
  const font = await loadFont(o.font);
  const unit = font.getPath(o.text, 0, 0, 100).getBoundingBox();
  const size = (100 * (box.x1 - box.x0)) / Math.max(1e-6, unit.x2 - unit.x1);
  const bb = font.getPath(o.text, 0, 0, size).getBoundingBox();
  // bb is relative to the baseline (y down): its top is at bb.y1 above (negative).
  const baseline = box.y0 - bb.y1;
  const inkLeft = box.x0;
  const S = size * k;
  const lh = o.lineHeight ?? 1.2;
  const upm = font.unitsPerEm;
  const asc = font.ascender / upm;
  const desc = -font.descender / upm;
  // The engine centers ascent + descent in the line box; the baseline sits `asc` below the content top.
  const baseFromTop = (lh * S - (asc + desc) * S) / 2 + asc * S;
  const DW = o.designWidth ?? 1920;
  const DH = f.height * k;
  const centerY = baseline * k - baseFromTop + (lh * S) / 2;
  const x = inkLeft * k - (bb.x1 / size) * S;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    text: o.text,
    size: r2(S),
    inkLeft: r2(inkLeft * k),
    baseline: r2(baseline * k),
    color: toHex(box.color),
    background: toHex(box.bg),
    layer: {
      type: 'text', text: o.text, ...(o.family ? { font: o.family } : {}), weight: o.weight ?? 400, size: r2(S), color: toHex(box.color),
      align: 'left', anchor: 'left', letterSpacing: 0, lineHeight: lh, x: r2(x - DW / 2), y: r2(DH / 2 - centerY),
    },
  };
}

/**
 * When each letter of a line of text appears: the first frame its ink reaches half of its strongest. The
 * line is placed like `trace text` measured it (same font, size, ink left, baseline in design px).
 * Returns frames per visible letter and a `times` array for a text animation starting at the first.
 */
export async function traceReveal(src: string, o: { from: number; to: number; text: string; font: string; size: number; inkLeft: number; baseline: number; color?: string; designWidth?: number }, onFrame?: (f: number) => void) {
  const font = await loadFont(o.font);
  const glyphs: { ch: string; x0: number; x1: number }[] = [];
  const base = font.getPath(o.text, 0, 0, o.size).getBoundingBox().x1;
  let x = 0;
  const g = font.stringToGlyphs(o.text);
  g.forEach((gl, i) => {
    const adv = (gl.advanceWidth ?? 0) * (o.size / font.unitsPerEm);
    const ch = o.text[i];
    if (ch && ch.trim()) glyphs.push({ ch, x0: o.inkLeft + x - base, x1: o.inkLeft + x + adv - base });
    let kern = 0;
    if (i + 1 < g.length) kern = font.getKerningValue(gl, g[i + 1]) * (o.size / font.unitsPerEm);
    x += adv + kern;
  });
  const series: number[][] = glyphs.map(() => []);
  const frames: number[] = [];
  let bg: number[] | null = null;
  const ink = o.color ? hexRGB(o.color) : null;
  let span = 1;
  for await (const f of readFrames(src, o.from, o.to + 1)) {
    onFrame?.(f.index);
    const k = f.width / (o.designWidth ?? 1920);
    frames.push(f.index);
    const y0 = Math.max(0, Math.floor((o.baseline - o.size * 0.75) * k));
    const y1 = Math.min(f.height, Math.ceil(o.baseline * k));
    bg ??= medianColor(f, 0, y0, f.width, y1);
    span = ink ? Math.max(1, Math.hypot(bg[0] - ink[0], bg[1] - ink[1], bg[2] - ink[2])) : 1;
    glyphs.forEach((gl, j) => {
      const a = Math.max(0, Math.floor(gl.x0 * k));
      const b = Math.min(f.width, Math.ceil(gl.x1 * k));
      const vals: number[] = [];
      for (let y = y0; y < y1; y++) for (let xx = a; xx < b; xx++) {
        const i = (y * f.width + xx) * 3;
        if (ink) {
          // How far the pixel has moved from the background toward the text color (other colors do not count).
          // Pixels on the blend between background and text color only: project onto that line.
          const px = f.data[i] - bg![0], py = f.data[i + 1] - bg![1], pz = f.data[i + 2] - bg![2];
          const ax = ink[0] - bg![0], ay = ink[1] - bg![1], az = ink[2] - bg![2];
          const t = (px * ax + py * ay + pz * az) / (span * span);
          const off = Math.hypot(px - t * ax, py - t * ay, pz - t * az);
          vals.push(off < 40 ? Math.max(0, Math.min(1, t)) * 255 : 0);
        } else vals.push(Math.max(Math.abs(f.data[i] - bg![0]), Math.abs(f.data[i + 1] - bg![1]), Math.abs(f.data[i + 2] - bg![2])));
      }
      vals.sort((p, q) => p - q);
      series[j].push(vals.length ? vals[Math.floor(vals.length * 0.95)] : 0);
    });
  }
  const appear = series.map((v) => {
    const mx = Math.max(...v);
    const i = v.findIndex((s) => s > 0.5 * mx);
    return mx > 10 && i >= 0 ? frames[i] : null;
  });
  const first = Math.min(...appear.filter((v): v is number => v !== null));
  return {
    letters: glyphs.map((gl, i) => ({ ch: gl.ch, frame: appear[i] })),
    first,
    times: appear.map((f) => (f === null ? null : Math.round(((f - first) / 30) * 10000) / 10000)),
  };
}
