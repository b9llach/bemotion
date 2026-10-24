/**
 * End-to-end test of the visual editor in headless Chrome. Edits examples/dev/editor-test.json in
 * place and restores it at the end. Run: npx tsx scripts/test-editor.ts
 */
import puppeteer, { type Page } from 'puppeteer';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { startServer } from '../src/cli/server';

const SPEC = 'examples/dev/editor-test.json';
const original = await readFile(SPEC, 'utf8');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const spec = async (): Promise<any> => {
  for (let i = 0; ; i++) {
    try {
      return JSON.parse(await readFile(SPEC, 'utf8'));
    } catch (e) {
      if (i > 20) throw e;
      await wait(25);
    }
  }
};
const layer = async (i: number) => (await spec()).scenes[0].layers[i];
await mkdir('out/dev', { recursive: true });

const { server, url } = await startServer(SPEC, { port: 0 });
const browser = await puppeteer.launch({ headless: true, args: ['--ignore-gpu-blocklist', '--use-angle=default'] });
const page: Page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));

let step = 0;
async function check(name: string, fn: () => Promise<void>) {
  step++;
  await fn();
  console.log(`ok  ${step}. ${name}`);
}

/** Waits until the file satisfies `pred` (edits are saved asynchronously). */
async function until<T>(get: () => Promise<T>, pred: (v: T) => boolean, what: string, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  let v = await get();
  while (!pred(v)) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await wait(80);
    v = await get();
  }
  return v;
}

const setInput = (selector: string, value: string) =>
  page.evaluate(
    (sel, v) => {
      const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(sel);
      if (!el) throw new Error(`missing ${sel}`);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    selector,
    value,
  );

const clickRow = (i: number) => page.evaluate((i) => document.querySelectorAll<HTMLElement>('#layer-tree .layer-row')[i].click(), i);

try {
  await page.evaluateOnNewDocument(() => localStorage.setItem('bemotion:time', '1'));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('#frame canvas');
  await until(() => page.$eval('#status-text', (e) => e.textContent), (t) => t === 'Live', 'first build', 15000);
  // Tag the canvas: a full reload would replace it.
  await page.$eval('#frame canvas', (c) => ((c as HTMLCanvasElement).dataset.tag = 'first'));

  const rect = await page.$eval('#frame canvas', (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const toPage = (x: number, y: number) => ({ x: rect.x + (x / 1920 + 0.5) * rect.w, y: rect.y + (0.5 - y / 1080) * rect.h });

  await check('select the card by clicking it', async () => {
    await page.keyboard.press('e');
    await wait(200);
    const c = toPage(-250, 40);
    await page.mouse.click(c.x, c.y);
    await wait(300);
    assert.equal(await page.$eval('#layer-path', (e) => e.textContent), 'scenes.0.layers.1');
    await page.screenshot({ path: 'out/dev/editor_select.png' });
  });

  await check('drag the gizmo moves the card', async () => {
    const c = toPage(-250, 40);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(c.x + i * 12, c.y - i * 6);
      await wait(25);
    }
    await page.mouse.up();
    const l = await until(() => layer(1), (l) => l.x !== -250, 'card x to change');
    assert.ok(l.x > -250 && l.y > 40, `moved right and up: ${l.x}, ${l.y}`);
  });

  await check('typing a transform value', async () => {
    await setInput('#layer-props .prop:nth-child(5) input', '40');
    await until(() => layer(1), (l) => l.rotateY === 40, 'rotateY 40');
  });

  await check('select a layer from the layers list', async () => {
    // Listed top-most first: title, card, background.
    await clickRow(0);
    await wait(200);
    assert.equal(await page.$eval('#layer-path', (e) => e.textContent), 'scenes.0.layers.2');
  });

  await check('edit text and color in the Properties section', async () => {
    await setInput('#layer-fields [data-field="text"] textarea', 'Edited live');
    await until(() => layer(2), (l) => l.text === 'Edited live', 'text change');
    await setInput('#layer-fields [data-field="color"] input[type="text"]', '#7C5CFF');
    await until(() => layer(2), (l) => l.color === '#7C5CFF', 'color change');
    await setInput('#layer-fields [data-field="color"] input[type="color"]', '#ff3366');
    await until(() => layer(2), (l) => l.color === '#FF3366', 'color picker change');
  });

  await check('add a property from the schema', async () => {
    await setInput('#add-field', 'letterSpacing');
    await page.waitForSelector('#layer-fields [data-field="letterSpacing"] input');
    await setInput('#layer-fields [data-field="letterSpacing"] input', '-0.02');
    await until(() => layer(2), (l) => l.letterSpacing === -0.02, 'letterSpacing');
    await page.screenshot({ path: 'out/dev/editor_props.png' });
  });

  await check('invalid values are rejected and the file stays valid', async () => {
    await setInput('#add-field', 'align');
    await page.waitForSelector('#layer-fields [data-field="align"] select');
    await setInput('#layer-fields [data-field="align"] select', 'center');
    await until(() => layer(2), (l) => l.align === 'center', 'align');
    // A JSON edit with an unknown field must be refused.
    await page.$eval('.json-edit', (d) => ((d as HTMLDetailsElement).open = true));
    await setInput('#layer-json', JSON.stringify({ type: 'text', text: 'x', bogus: 1 }));
    await page.click('#layer-json-apply');
    await wait(400);
    assert.equal((await layer(2)).text, 'Edited live');
    assert.match(await page.$eval('#status-text', (e) => e.textContent ?? ''), /invalid/i);
    await page.$eval('.json-edit', (d) => ((d as HTMLDetailsElement).open = false));
  });

  await check('add a layer from the Add menu', async () => {
    await page.click('#add-layer');
    await page.waitForSelector('#add-menu .menu-item');
    const items = await page.$$('#add-menu .menu-item');
    await items[1].click(); // Rectangle
    await until(() => spec(), (s) => s.scenes[0].layers.length === 4, 'new layer');
    assert.equal((await layer(3)).type, 'shape');
    await wait(300);
    assert.equal(await page.$eval('#layer-path', (e) => e.textContent), 'scenes.0.layers.3');
  });

  await check('duplicate, reorder and delete', async () => {
    await page.keyboard.down('Control');
    await page.keyboard.press('d');
    await page.keyboard.up('Control');
    await until(() => spec(), (s) => s.scenes[0].layers.length === 5, 'duplicate');
    assert.equal((await layer(4)).x, 40);
    await page.click('#act-backward');
    await until(() => layer(3), (l) => l.x === 40, 'moved backward');
    await page.click('#act-delete');
    await until(() => spec(), (s) => s.scenes[0].layers.length === 4, 'deleted');
    assert.equal((await layer(3)).x, undefined);
  });

  // Keyframes on the card.
  const seek = async (t: number) => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Home');
    for (let i = 0; i < Math.round(t * 30); i++) await page.keyboard.press('ArrowRight');
    await wait(150);
  };

  await check('auto-key writes keyframes at the playhead', async () => {
    await clickRow(2); // card
    await wait(150);
    assert.equal(await page.$eval('#layer-path', (e) => e.textContent), 'scenes.0.layers.1');
    await page.keyboard.press('k');
    await seek(1);
    await setInput('#layer-props .prop:nth-child(7) input', '1');
    await until(() => layer(1), (l) => l.keyframes?.scale?.length === 1, 'first scale key');
    await seek(2.5);
    await setInput('#layer-props .prop:nth-child(7) input', '1.3');
    await until(() => layer(1), (l) => l.keyframes?.scale?.length === 2, 'second scale key');
    await page.keyboard.press('k');
    await wait(200);
    assert.equal(await page.$$eval('#keys .key-row', (r) => r.length), 2, 'summary row plus scale row');
  });

  await check('drag a keyframe along the timeline', async () => {
    const kf = await page.$('#keys .key-row:nth-child(3) .kf:last-of-type');
    const box = (await kf!.boundingBox())!;
    const tl = (await (await page.$('#keys'))!.boundingBox())!;
    const dx = (0.5 / 4) * tl.width; // half a second on a 4 s timeline
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(box.x + box.width / 2 + (dx * i) / 8, box.y + box.height / 2);
      await wait(20);
    }
    await page.mouse.up();
    const l = await until(() => layer(1), (l) => l.keyframes.scale[1].t !== 2.5, 'retime');
    assert.ok(Math.abs(l.keyframes.scale[1].t - 3) < 0.04, `moved to ~3s: ${l.keyframes.scale[1].t}`);
  });

  await check('select a keyframe and edit its ease', async () => {
    const kf = await page.$('#keys .key-row:nth-child(3) .kf:last-of-type');
    await kf!.click();
    await page.waitForSelector('#key-panel:not(.hidden)');
    await setInput('#key-ease .ease-select', 'outBack');
    await until(() => layer(1), (l) => l.keyframes.scale[1].ease === 'outBack', 'ease outBack');
    // Drag the second bezier handle to make a custom curve.
    const handle = (await page.$$('#key-ease .ease-handle'))[1];
    await handle.scrollIntoView();
    const hb = (await handle.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x - 30, hb.y + 20, { steps: 6 });
    await page.mouse.up();
    const l = await until(() => layer(1), (l) => Array.isArray(l.keyframes.scale[1].ease), 'custom bezier');
    assert.equal(l.keyframes.scale[1].ease.length, 4);
    await page.screenshot({ path: 'out/dev/editor_keys.png' });
  });

  await check('change a keyframe value in the Keyframe panel', async () => {
    await setInput('#key-value', '1.5');
    await until(() => layer(1), (l) => l.keyframes.scale[1].v === 1.5, 'key value');
  });

  await check('delete the selected keyframe', async () => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Delete');
    await until(() => layer(1), (l) => l.keyframes.scale.length === 1, 'key removed');
  });

  await check('undo and redo', async () => {
    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    await until(() => layer(1), (l) => l.keyframes.scale.length === 2, 'undo');
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('z');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await until(() => layer(1), (l) => l.keyframes.scale.length === 1, 'redo');
  });

  await check('external file edits update the preview in place', async () => {
    const s = await spec();
    s.scenes[0].layers[2].id = 'renamedOnDisk';
    await writeFile(SPEC, JSON.stringify(s, null, 2) + '\n');
    await until(
      () => page.$eval('#layer-tree', (e) => e.textContent ?? ''),
      (t) => t.includes('renamedOnDisk'),
      'preview to pick up the file change',
    );
  });

  await check('edits never rebuilt the whole preview', async () => {
    assert.equal(await page.$eval('#frame canvas', (c) => (c as HTMLCanvasElement).dataset.tag), 'first');
    const times = await page.evaluate(() => performance.getEntriesByName('bemotion:patched').map((e) => Math.round(e.duration)));
    assert.ok(times.length > 5, 'scene patches happened');
    const sorted = [...times].sort((a, b) => a - b);
    console.log(`    ${times.length} in-place updates, median ${sorted[sorted.length >> 1]} ms, max ${sorted[sorted.length - 1]} ms`);
  });

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`\n${step} editor checks passed`);
} finally {
  await browser.close();
  await server.close();
  await writeFile(SPEC, original);
}
