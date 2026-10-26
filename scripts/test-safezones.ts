/**
 * Platform safe zones: the zone table scaled to a frame, platform parsing, findUnsafe on synthetic
 * samples, and a real `check --platform` run on a small spec with a line under the caption area.
 * Run: npx tsx scripts/test-safezones.ts
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SAFE_ZONES, parsePlatforms, platformNames, zoneRects } from '../src/spec/safezones';
import { check as runCheck, findUnsafe, findingLines, type Probe } from '../src/cli/check';
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

const item = (uid: number, type: string, box: InspectItem['box'], extra: Partial<InspectItem> = {}): InspectItem =>
  ({ uid, anc: [], type, order: uid, opacity: 1, box, text: type === 'text' ? `line ${uid}` : undefined, ...extra });
const probes = (items: InspectItem[], from = 0, to = 1, step = 0.1): Probe[] => {
  const out: Probe[] = [];
  for (let t = from; t <= to + 1e-9; t += step) out.push({ t: Math.round(t * 100) / 100, info: { scene: 'end', transition: false, items }, thumb: [] });
  return out;
};
const frame = { width: 1080, height: 1920 };

await check('three platforms, each with top, bottom and a right rail inside the frame', () => {
  assert(platformNames().join(',') === 'tiktok,reels,shorts', platformNames().join(','));
  for (const p of platformNames()) {
    const z = SAFE_ZONES[p];
    assert(z.top > 0 && z.bottom > z.top && z.right > 0 && z.railTop > z.top && z.railTop < 1920 - z.bottom, p);
  }
});

await check('zones scale with the frame (a 720x1280 render gets two thirds)', () => {
  const big = zoneRects('tiktok', 1080, 1920);
  const small = zoneRects('tiktok', 720, 1280);
  for (let i = 0; i < big.length; i++) {
    for (const k of ['x0', 'y0', 'x1', 'y1'] as const) assert(Math.abs(small[i][k] - (big[i][k] * 2) / 3) < 1e-6, `${big[i].name}.${k}`);
  }
  const bottom = big.find((r) => r.name === 'caption and username')!;
  assert(bottom.y0 === 1920 - SAFE_ZONES.tiktok.bottom && bottom.y1 === 1920, JSON.stringify(bottom));
});

await check('platform lists: comma separated, case-insensitive, "all", unknown names refused', () => {
  assert(parsePlatforms('TikTok, reels').join(',') === 'tiktok,reels', parsePlatforms('TikTok, reels').join(','));
  assert(parsePlatforms('all').length === 3, 'all');
  assert(parsePlatforms(undefined).length === 0, 'none');
  let threw = false;
  try { parsePlatforms('snapchat'); } catch { threw = true; }
  assert(threw, 'snapchat accepted');
});

await check('text in the caption area and under the buttons is reported; centered text is not', () => {
  const items = [
    item(1, 'text', { x0: 200, y0: 1600, x1: 880, y1: 1680 }),
    item(2, 'text', { x0: 300, y0: 900, x1: 780, y1: 1000 }),
    item(3, 'text', { x0: 900, y0: 1000, x1: 1060, y1: 1060 }),
  ];
  const u = findUnsafe(probes(items), frame, ['tiktok']);
  assert(u.length === 2, JSON.stringify(u));
  const caption = u.find((x) => x.layer.includes('line 1'))!;
  assert(caption.zones.includes('caption and username') && caption.amount > 0.99, JSON.stringify(caption));
  const rail = u.find((x) => x.layer.includes('line 3'))!;
  assert(rail.zones.includes('action buttons'), JSON.stringify(rail));
  assert(findingLines({ collisions: [], holds: [], rushes: [], unsafe: u }).some((l) => l.includes('TikTok caption and username')), 'finding line');
});

await check('platforms differ: a line at y 1300 is clear on TikTok but under the Reels caption', () => {
  const items = [item(1, 'text', { x0: 300, y0: 1300, x1: 780, y1: 1360 })];
  assert(findUnsafe(probes(items), frame, ['tiktok']).length === 0, 'tiktok');
  assert(findUnsafe(probes(items), frame, ['reels']).length === 1, 'reels');
});

await check('logos and buttons count, plain shapes, faint text and brief passes do not', () => {
  const low = { x0: 300, y0: 1700, x1: 780, y1: 1800 };
  const items = [
    item(1, 'image', low, { id: 'logo' }),
    item(2, 'button', low),
    item(3, 'shape', low),
    item(4, 'text', low, { opacity: 0.3 }),
  ];
  const u = findUnsafe(probes(items), frame, ['shorts']);
  assert(u.length === 2 && u.every((x) => /logo|button/.test(x.layer)), JSON.stringify(u.map((x) => x.layer)));
  assert(findUnsafe(probes([item(1, 'text', low)], 0, 0.1), frame, ['shorts']).length === 0, 'a 0.2 s pass was reported');
});

const root = await mkdtemp(join(tmpdir(), 'bemotion-safe-'));
try {
  await check('check --platform renders at 9:16 and flags a line placed in the caption area', async () => {
    const spec = join(root, 'safe.json');
    await writeFile(spec, JSON.stringify({
      title: 'Safe zones', fps: 30,
      scenes: [{ id: 'end', duration: 2, layers: [
        { type: 'background', color: '#101018' },
        { type: 'text', text: 'Centered headline', size: 90, y: 60, color: '#ffffff' },
        { type: 'text', text: 'Footer line here', size: 48, y: -470, color: '#ffffff', formats: { '9:16': { y: -820 } } },
      ] }],
    }));
    const r = await runCheck(spec, { platforms: ['tiktok'], rate: 5 });
    assert(r.unsafe.length === 1 && r.unsafe[0].layer.includes('Footer line'), JSON.stringify(r.unsafe));
    assert(r.unsafe[0].zones.includes('caption and username'), r.unsafe[0].zones.join(','));
    let threw = false;
    try { await runCheck(spec, { platforms: ['tiktok'], format: '1:1' }); } catch { threw = true; }
    assert(threw, 'a 1:1 check with a platform was accepted');
  });
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} of ${n} failed` : `\nall ${n} passed`);
process.exit(failed ? 1 : 0);
