/**
 * Low-contrast text on synthetic probes: the contrast ratio, the backdrop read from the thumbnail
 * around glyphs, dark text on a dark background reported, readable text and fades passing, text
 * without one solid color left out, and the finding line.
 * Run: npx tsx scripts/test-contrast.ts
 */
import { backdropGray, contrastRatio, findLowContrast, findingLines, type Probe } from '../src/cli/check';
import type { InspectItem } from '../src/engine/engine';

let failed = 0;
let n = 0;
function check(name: string, fn: () => void): void {
  n++;
  try {
    fn();
    console.log(`ok  ${n}. ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${n}. ${name}\n     ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const frame = { width: 1920, height: 1080 };
const TW = 192;
const TH = 108;
const box = { x0: 600, y0: 480, x1: 1300, y1: 600 };
/** A thumbnail of one gray with the text's box partly filled with glyph gray (a third of its pixels). */
function thumb(bg: number, glyph: number): number[] {
  const t = new Array(TW * TH).fill(bg);
  for (let y = 48; y < 60; y++) for (let x = 60; x < 130; x++) if ((x + y) % 3 === 0) t[y * TW + x] = glyph;
  return t;
}
const text = (color: [number, number, number] | undefined, opacity = 1): InspectItem => ({ uid: 1, anc: [], type: 'text', order: 0, opacity, box, text: 'Save 38% today', px: 80, color });
const run = (items: InspectItem[], th: number[], from = 0, to = 1.5): Probe[] => {
  const out: Probe[] = [];
  for (let t = from; t < to - 1e-9; t += 0.1) out.push({ t: Math.round(t * 100) / 100, info: { scene: 'stats', transition: false, items }, thumb: th });
  return out;
};
const DARK = 40 / 255;

check('contrast ratio: black on white is 21, a color on itself is 1', () => {
  assert(Math.abs(contrastRatio(0, 255) - 21) < 0.01, String(contrastRatio(0, 255)));
  assert(contrastRatio(128, 128) === 1, 'same');
});

check('the backdrop is read around the glyphs, not from them', () => {
  const bg = backdropGray(thumb(230, 20), TW, TH, box, frame, 20);
  assert(bg === 230, `backdrop ${bg}`);
});

check('dark gray text on a near-black background is reported; white on it is not', () => {
  const low = findLowContrast(run([text([DARK, DARK, DARK])], thumb(25, 40)), frame);
  assert(low.length === 1 && low[0].ratio < 1.5 && low[0].scene === 'stats', JSON.stringify(low));
  assert(findLowContrast(run([text([1, 1, 1])], thumb(25, 250)), frame).length === 0, 'white');
});

check('fades, short moments and text without one solid color pass', () => {
  assert(findLowContrast(run([text([DARK, DARK, DARK], 0.5)], thumb(25, 40)), frame).length === 0, 'fading');
  assert(findLowContrast(run([text([DARK, DARK, DARK])], thumb(25, 40), 0, 0.4), frame).length === 0, 'short');
  assert(findLowContrast(run([text(undefined)], thumb(25, 40)), frame).length === 0, 'gradient');
});

check('the finding line names the layer, the ratio and the fix', () => {
  const lines = findingLines({ collisions: [], holds: [], rushes: [], contrast: [{ scene: 'stats', layer: 'text "Save 38%"', from: 2, to: 3.5, ratio: 1.3 }] });
  assert(lines[0].includes('low contrast') && lines[0].includes('1.3:1') && lines[0].includes('4.5:1'), lines[0]);
});

console.log(failed ? `\n${failed} of ${n} contrast checks failed.` : `\nAll ${n} contrast checks passed.`);
process.exit(failed ? 1 : 0);
