/**
 * Rastered groups: children keep real positions (the editor picks them, check sees their boxes), a mask
 * works inside the image, and the image matches the children drawn directly.
 * Run: npx tsx scripts/test-raster.ts
 */
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer';
import { startServer } from '../src/cli/server';
import { BROWSER_ARGS, openPage } from '../src/cli/render';

const dir = resolve('out/test-raster');
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });

const child = { type: 'shape', shape: 'rect', x: 100, y: 50, width: 120, height: 80, fill: '#E11D48' };
const label = { type: 'text', text: 'Raster', size: 40, color: '#111111', x: -100, y: -60 };
const group = (extra: Record<string, unknown>) => ({ type: 'group', x: -300, y: 100, scale: 1.5, children: [child, label], ...extra });
const spec = {
  fps: 30, width: 1920, height: 1080,
  post: { grain: 0, vignette: 0, bloom: false, tonemap: 'none' },
  scenes: [
    { id: 'plain', duration: 1, background: '#FFFFFF', layers: [group({})] },
    { id: 'raster', duration: 1, background: '#FFFFFF', layers: [group({ raster: { width: 500, height: 300 } })] },
    { id: 'masked', duration: 1, background: '#FFFFFF', layers: [group({ raster: { width: 500, height: 300 }, mask: { type: 'shape', shape: 'circle', x: 100, y: 50, width: 60, height: 60 } })] },
  ],
};
const specPath = resolve(dir, 'spec.json');
await writeFile(specPath, JSON.stringify(spec));
const { server, url } = await startServer(specPath, { hmr: false });
const browser = await puppeteer.launch({ headless: true, args: BROWSER_ARGS });
let n = 0;
const ok = (name: string) => console.log(`ok  ${++n}. ${name}`);
try {
  const { page } = await openPage(browser, url, spec);
  const api = (fn: string, ...args: unknown[]) => page.evaluate((f, a) => (window as any).bemotion[f](...a), fn, args);
  // The child sits at group (-300, 100) + 1.5 * (100, 50) = (-150, 175) in design px: frame (810, 365).
  const at = (scene: number) => scene * 30 + 10;

  const boxes = async (scene: number) => ((await api('probe', at(scene))) as any).info.items;
  const plain = await boxes(0);
  const raster = await boxes(1);
  assert.equal(raster.length, plain.length, 'check sees the same layers inside a rastered group');
  for (let i = 0; i < plain.length; i++) {
    for (const k of ['x0', 'y0', 'x1', 'y1']) assert.ok(Math.abs(raster[i].box[k] - plain[i].box[k]) < 1, `box ${k} matches: ${raster[i].box[k]} vs ${plain[i].box[k]}`);
  }
  ok('check reads the children of a rastered group where they are drawn');

  const picked = await api('pick', at(1), 810, 365);
  assert.deepEqual(picked, ['scenes', 1, 'layers', 0, 'children', 0], `picked ${JSON.stringify(picked)}`);
  const empty = await api('pick', at(1), 810 - 200, 365 + 80);
  assert.deepEqual(empty, ['scenes', 1, 'layers', 0], 'an empty part of the image selects the group');
  ok('the editor picks a child inside a rastered group, and the group around it');

  const pixel = async (scene: number, x: number, y: number) => {
    const data = (await api('frame', at(scene), 'png', 1, false)) as string;
    return page.evaluate(async (src, px, py) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      return Array.from(g.getImageData(px, py, 1, 1).data.slice(0, 3));
    }, data, x, y);
  };
  const red = (c: number[]) => c[0] > 180 && c[1] < 90 && c[2] < 120;
  assert.ok(red(await pixel(0, 810, 365)) && red(await pixel(1, 810, 365)), 'the child is drawn the same in the image');
  assert.ok(red(await pixel(2, 810, 365)), 'inside the mask the child shows');
  const outside = await pixel(2, 810 + 70, 365);
  assert.ok(!red(outside), `outside the mask the child is cut away (got ${outside})`);
  ok('a mask works inside a rastered group');
} finally {
  await browser.close();
  await server.close();
}
console.log(`\nAll ${n} raster checks passed.`);
