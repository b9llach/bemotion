/**
 * Readable sizes: findSmallUi on synthetic samples (UI text under 18 px for 1.5 s, short establishing
 * shots allowed, fine print alone ignored, copy on its own under 22 px), and a real `check` run where
 * the measured font size on screen follows the layer's size and the camera's zoom.
 * Run: npx tsx scripts/test-small.ts
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { check as runCheck, findSmallUi, findingLines, type Probe } from '../src/cli/check';
import type { InspectItem } from '../src/engine/engine';

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

const frame = { width: 1920, height: 1080 };
const box = { x0: 400, y0: 200, x1: 1500, y1: 900 };
const uiText = (uid: number, px: number, component = 1): InspectItem =>
  ({ uid, anc: [], type: 'text', order: uid, opacity: 1, box, text: `row ${uid}`, px, component, path: 'scenes[0].layers[1]' });
const probes = (items: InspectItem[], from: number, to: number, step = 0.1): Probe[] => {
  const out: Probe[] = [];
  for (let t = from; t <= to + 1e-9; t += step) out.push({ t: Math.round(t * 100) / 100, info: { scene: 'product', transition: false, items }, thumb: [] });
  return out;
};

await check('a component whose text stays at 13 px for 2 s is reported with its size and share of the frame', () => {
  const r = findSmallUi(probes([uiText(1, 13), uiText(2, 12), uiText(3, 14), uiText(4, 30)], 0, 2), frame);
  assert(r.length === 1 && r[0].kind === 'ui', JSON.stringify(r));
  assert(r[0].px === 14 || r[0].px === 13, `px ${r[0].px}`);
  assert(Math.abs(r[0].share - (1100 * 700) / (1920 * 1080)) < 0.01, `share ${r[0].share}`);
  const line = findingLines({ collisions: [], holds: [], rushes: [], small: r })[0];
  assert(line.includes('UI too small to read') && line.includes('scenes[0].layers[1]'), line);
});

await check('a 1 s establishing overview, readable UI and a few fine-print labels pass', () => {
  assert(findSmallUi(probes([uiText(1, 13), uiText(2, 12), uiText(3, 14)], 0, 1), frame).length === 0, 'short overview');
  assert(findSmallUi(probes([uiText(1, 24), uiText(2, 26), uiText(3, 22)], 0, 3), frame).length === 0, 'readable');
  assert(findSmallUi(probes([uiText(1, 11), uiText(2, 26), uiText(3, 28), uiText(4, 30)], 0, 3), frame).length === 0, 'fine print');
  assert(findSmallUi(probes([uiText(1, 11), uiText(2, 12)], 0, 3), frame).length === 0, 'two lines');
});

await check('copy on its own under 22 px is reported; vertical frames measure on the shorter side', () => {
  const url = { ...uiText(9, 18), component: undefined, text: 'example.com', path: 'scenes[3].layers[2]' };
  const r = findSmallUi(probes([url], 0, 3), frame);
  assert(r.length === 1 && r[0].kind === 'text', JSON.stringify(r));
  assert(findingLines({ collisions: [], holds: [], rushes: [], small: r })[0].includes('text too small'), 'line');
  // 30 px in a 1080x1920 frame is 30 px at 1080p.
  assert(findSmallUi(probes([{ ...url, px: 30 }], 0, 3), { width: 1080, height: 1920 }).length === 0, 'vertical');
  // 18 px in a 4K frame is 9 px at 1080p.
  assert(findSmallUi(probes([{ ...url, px: 40 }], 0, 3), { width: 3840, height: 2160 }).length === 1, '4k');
});

await check('check measures font size on screen through the camera zoom', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bemotion-small-'));
  try {
    const spec = {
      title: 'small',
      scenes: [
        {
          id: 'flat',
          duration: 3,
          layers: [
            { type: 'background', color: '#ffffff' },
            { type: 'text', id: 'tiny', text: 'tiny.example', size: 16, y: -200, color: '#000000' },
            { type: 'text', id: 'big', text: 'Headline', size: 90, color: '#000000' },
          ],
        },
        {
          id: 'zoomed',
          duration: 3,
          camera: { moves: [{ preset: 'moveTo', x: 0, y: -200, zoom: 2, at: 0, duration: 0.01 }] },
          layers: [
            { type: 'background', color: '#ffffff' },
            { type: 'text', id: 'tiny2', text: 'tiny.example', size: 16, y: -200, color: '#000000' },
          ],
        },
      ],
    };
    const path = join(dir, 'small.json');
    await writeFile(path, JSON.stringify(spec));
    const r = await runCheck(path);
    const at = (scene: string, id: string) => r.probes.filter((p) => p.info.scene === scene).flatMap((p) => p.info.items.filter((it) => it.id === id).map((it) => it.px ?? 0));
    const tiny = at('flat', 'tiny');
    const big = at('flat', 'big');
    const zoomed = at('zoomed', 'tiny2');
    assert(tiny.length && Math.abs(Math.max(...tiny) - 16) < 1.5, `tiny ${Math.max(...tiny)}`);
    assert(big.length && Math.abs(Math.max(...big) - 90) < 3, `big ${Math.max(...big)}`);
    assert(zoomed.length && Math.abs(Math.max(...zoomed) - 32) < 3, `zoomed ${Math.max(...zoomed)}`);
    assert(r.small.length === 1 && r.small[0].scene === 'flat' && r.small[0].layer.includes('tiny'), JSON.stringify(r.small));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

if (failed) {
  console.log(`${failed} of ${n} small-text checks failed.`);
  process.exit(1);
}
console.log(`All ${n} small-text checks passed.`);
process.exit(0);
