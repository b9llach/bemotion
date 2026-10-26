/**
 * Assets: SVG files drawn on element by element (shapes, groups, paints, color override, fillAfter,
 * the draw entrance), Lucide icons by name (served by the server, searchable), and stock photos
 * (search, download, credits, the "stock:" sidecar, size and type limits, the spec folder only),
 * all offline: the stock providers are a mocked fetch.
 * Run: npx tsx scripts/test-assets.ts
 */
import { copyFile, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';
import { startServer } from '../src/cli/server';
import { BROWSER_ARGS, openPage } from '../src/cli/render';
import { lucideIcon, lucideNames, searchIcons } from '../src/cli/icons';
import { MAX_IMAGE_BYTES, NO_KEY, resolveStock, stockCommand, stockProvider, stockQueries, downloadStock, type StockPhoto } from '../src/cli/stock';

let failed = 0;
let n = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
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

// Never reach a real provider from a test, whatever keys the shell has.
delete process.env.UNSPLASH_ACCESS_KEY;
delete process.env.PEXELS_API_KEY;

const dir = resolve('out/test-assets');
await rm(dir, { recursive: true, force: true });
await mkdir(join(dir, 'media/svg'), { recursive: true });
for (const f of ['shapes.svg', 'logo.svg']) await copyFile(resolve('examples/dev/media/svg', f), join(dir, 'media/svg', f));
const PNG = await readFile(resolve('examples/dev/media/portrait.png'));

// ---------------------------------------------------------------- stock photos (mocked providers)

type Call = { url: string; headers: Record<string, string> };
const KEY = 'test-key-123';
function mockFetch(o: { type?: string; body?: Buffer; length?: number; results?: number; failFirst?: boolean } = {}) {
  const calls: Call[] = [];
  let images = 0;
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
    if (url.startsWith('https://api.unsplash.com/search/photos')) {
      const results = Array.from({ length: o.results ?? 2 }, (_, i) => ({
        id: `u${i}`, width: 4000, height: 3000, alt_description: 'a lake',
        urls: { raw: `https://images.unsplash.com/photo-u${i}?ixid=abc` },
        links: { html: `https://unsplash.com/photos/u${i}`, download_location: `https://api.unsplash.com/photos/u${i}/download?ixid=abc` },
        user: { name: `Photographer ${i}`, links: { html: `https://unsplash.com/@p${i}` } },
      }));
      return new Response(JSON.stringify({ results }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://api.pexels.com/v1/search')) {
      const photos = [{ id: 77, width: 3000, height: 2000, url: 'https://www.pexels.com/photo/77/', photographer: 'Pex Person', photographer_url: 'https://www.pexels.com/@pex', alt: 'desk', src: { original: 'https://images.pexels.com/photos/77/p.jpeg' } }];
      return new Response(JSON.stringify({ photos }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/download?')) return new Response('{}', { headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://images.')) {
      images++;
      if (o.failFirst && images === 1) return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
      const body = o.body ?? PNG;
      const headers: Record<string, string> = { 'content-type': o.type ?? 'image/png' };
      if (o.length !== undefined) headers['content-length'] = String(o.length);
      return new Response(new Uint8Array(body), { headers });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}
const unsplash = { UNSPLASH_ACCESS_KEY: KEY } as NodeJS.ProcessEnv;
const pexels = { PEXELS_API_KEY: KEY } as NodeJS.ProcessEnv;

const STOCK_SPEC = join(dir, 'stock.json');
await check('no key: a clear message, nothing downloaded', async () => {
  assert(stockProvider({} as NodeJS.ProcessEnv) === null, 'no provider without keys');
  const { f, calls } = mockFetch();
  let msg = '';
  await resolveStock(STOCK_SPEC, 'mountain lake', { fetch: f, env: {} as NodeJS.ProcessEnv }).catch((e) => (msg = e.message));
  assert(msg.includes(NO_KEY) && msg.includes('stock:mountain lake'), `message: ${msg}`);
  assert(calls.length === 0, 'no request without a key');
});

await check('stock: queries are found anywhere in a spec, normalized', () => {
  const q = stockQueries({ scenes: [{ layers: [{ type: 'image', src: 'stock:Mountain   Lake' }, { type: 'group', children: [{ type: 'image', src: 'stock:desk' }, { type: 'image', src: 'a.png' }] }] }] });
  assert(JSON.stringify(q) === JSON.stringify(['mountain lake', 'desk']), JSON.stringify(q));
});

let firstFile = '';
await check('Unsplash: search, download into media/stock, sidecar, credits, download endpoint called', async () => {
  const { f, calls } = mockFetch();
  firstFile = await resolveStock(STOCK_SPEC, 'mountain lake', { fetch: f, env: unsplash });
  assert(firstFile.startsWith(join(dir, 'media', 'stock')), `file in media/stock: ${firstFile}`);
  assert((await readFile(firstFile)).equals(PNG), 'the downloaded bytes are written');
  const side = JSON.parse(await readFile(join(dir, 'media/stock/stock.json'), 'utf8'));
  const name = firstFile.split(/[\\/]/).pop()!;
  assert(side.queries['mountain lake'] === name, `sidecar maps the query: ${JSON.stringify(side.queries)}`);
  assert(side.credits[name].photographer === 'Photographer 0', 'credit recorded');
  const credits = await readFile(join(dir, 'media/stock/CREDITS.md'), 'utf8');
  assert(credits.includes('Photographer 0') && credits.includes('https://unsplash.com/photos/u0') && credits.includes('Unsplash'), credits);
  const search = calls.find((c) => c.url.includes('/search/photos'))!;
  assert(search.headers.Authorization === `Client-ID ${KEY}`, 'key sent in the Authorization header');
  assert(search.url.includes('orientation=landscape'), 'landscape by default');
  const dl = calls.find((c) => c.url.includes('/photos/u0/download'));
  assert(dl && dl.headers.Authorization === `Client-ID ${KEY}`, 'download endpoint triggered with the key');
  assert(calls.every((c) => !c.url.includes(KEY)), 'the key never appears in a URL');
});

await check('the same query is served from the sidecar without any request', async () => {
  const { f, calls } = mockFetch();
  const again = await resolveStock(STOCK_SPEC, 'mountain lake', { fetch: f, env: unsplash });
  assert(again === firstFile, `same file: ${again}`);
  assert(calls.length === 0, `no requests: ${calls.length}`);
});

await check('a response that is not an image is refused (the next result is used)', async () => {
  const { f } = mockFetch({ failFirst: true });
  const file = await resolveStock(STOCK_SPEC, 'city at night', { fetch: f, env: unsplash });
  assert(/-u1\.png$/.test(file), `the second photo was used: ${file}`);
  const { f: f2 } = mockFetch({ type: 'text/html' });
  let msg = '';
  await resolveStock(STOCK_SPEC, 'forest', { fetch: f2, env: unsplash }).catch((e) => (msg = e.message));
  assert(msg.includes('Not an image'), msg);
});

await check('oversized images are refused, declared or streamed', async () => {
  const photo: StockPhoto = { provider: 'pexels', id: '1', url: 'https://images.pexels.com/x.jpeg', page: '', photographer: '', photographerUrl: '', width: 1, height: 1, alt: '' };
  const { f } = mockFetch({ length: MAX_IMAGE_BYTES + 1 });
  let msg = '';
  await downloadStock(photo, join(dir, 'media/stock'), { query: 'big', base: dir, fetch: f }).catch((e) => (msg = e.message));
  assert(msg.includes('too large'), `declared: ${msg}`);
  const { f: f2 } = mockFetch();
  msg = '';
  await downloadStock(photo, join(dir, 'media/stock'), { query: 'big', base: dir, fetch: f2, maxBytes: 100 }).catch((e) => (msg = e.message));
  assert(msg.includes('too large'), `streamed: ${msg}`);
  msg = '';
  await downloadStock({ ...photo, url: 'http://images.pexels.com/x.jpeg' }, join(dir, 'media/stock'), { query: 'big', base: dir, fetch: f2 }).catch((e) => (msg = e.message));
  assert(msg.includes('non-https'), `http refused: ${msg}`);
});

await check('Pexels when only its key is set', async () => {
  const { f, calls } = mockFetch({ type: 'image/jpeg' });
  const file = await resolveStock(STOCK_SPEC, 'desk setup', { fetch: f, env: pexels });
  assert(/pexels-77\.jpg$/.test(file), file);
  const search = calls.find((c) => c.url.startsWith('https://api.pexels.com'))!;
  assert(search.headers.Authorization === KEY, 'Pexels key in the Authorization header');
  const credits = await readFile(join(dir, 'media/stock/CREDITS.md'), 'utf8');
  assert(credits.includes('Pex Person') && credits.includes('Pexels'), 'Pexels credit');
});

await check('a media/stock folder that links outside the spec folder is refused', async () => {
  const other = join(dir, 'linked');
  const outside = join(dir, 'outside');
  await mkdir(join(other, 'media'), { recursive: true });
  await mkdir(outside, { recursive: true });
  try {
    await symlink(outside, join(other, 'media', 'stock'), 'junction');
  } catch {
    console.log('     (links not available here; skipped)');
    return;
  }
  const { f } = mockFetch();
  let msg = '';
  await resolveStock(join(other, 'spec.json'), 'river', { fetch: f, env: unsplash }).catch((e) => (msg = e.message));
  assert(msg.includes("inside the spec's folder"), `refused: ${msg}`);
  assert((await readdir(outside)).length === 0, 'nothing written outside');
});

await check('bemotion stock: several photos into a folder, with credits', async () => {
  const { f } = mockFetch({ results: 3, type: 'image/webp' });
  const out = join(dir, 'cmd');
  const r = await stockCommand('Team Meeting', { count: 3, dir: out, fetch: f, env: unsplash });
  assert(r.files.length === 3 && r.files.every((x) => x.endsWith('.webp')), JSON.stringify(r.files));
  const side = JSON.parse(await readFile(join(out, 'stock.json'), 'utf8'));
  assert(side.queries['team meeting'] === r.files[0], 'the first answers stock:team meeting');
  assert(Object.keys(side.credits).length === 3, 'three credits');
});

// ---------------------------------------------------------------- icons (node side)

await check('Lucide names, search and files', async () => {
  assert(lucideNames().length > 1000, `names: ${lucideNames().length}`);
  const hits = await searchIcons('lock');
  assert(hits[0]?.name === 'lock', `lock first: ${hits.slice(0, 3).map((h) => h.name)}`);
  assert((await searchIcons('chart')).some((h) => h.name === 'chart-line'), 'chart finds chart-line');
  assert((await lucideIcon('house'))?.includes('<svg'), 'house svg');
  assert((await lucideIcon('../package')) === null && (await lucideIcon('nope-not-an-icon')) === null, 'bad names give null');
});

// ---------------------------------------------------------------- rendering (browser)

// shapes.svg: viewBox 320x200 drawn 640 wide (scale 2), centered. File point (x, y) lands at frame
// (960 + (x - 160) * 2, 540 + (y - 100) * 2).
const P = (x: number, y: number): [number, number] => [960 + (x - 160) * 2, 540 + (y - 100) * 2];
const shapes = (extra: Record<string, unknown> = {}) => ({ type: 'svg', src: 'media/svg/shapes.svg', width: 640, ...extra });
const spec = {
  fps: 30, width: 1920, height: 1080,
  post: { grain: 0, vignette: 0, bloom: false, tonemap: 'none' },
  scenes: [
    { id: 'full', duration: 1, background: '#FFFFFF', layers: [shapes()] },
    { id: 'none', duration: 1, background: '#FFFFFF', layers: [shapes({ progress: 0 })] },
    { id: 'mono', duration: 1, background: '#FFFFFF', layers: [shapes({ color: '#FF0000' })] },
    { id: 'half', duration: 1, background: '#FFFFFF', layers: [shapes({ progress: 0.5, stagger: 1, fillAfter: true })] },
    { id: 'draw', duration: 1, background: '#FFFFFF', layers: [shapes({ in: { preset: 'draw', duration: 0.8 } })] },
    { id: 'icons', duration: 1, background: '#000000', layers: [
      { type: 'icon', name: 'circle-check', size: 240, x: -300, color: '#FFFFFF' },
      { type: 'icon', name: 'check', size: 240, x: 300, color: '#FFFFFF' },
      { type: 'image', src: 'stock:mountain lake', width: 200, height: 200, y: 300 },
    ] },
  ],
};
const specPath = join(dir, 'spec.json');
// The stock image for the icons scene comes from the sidecar written above (same folder): no network.
await writeFile(specPath, JSON.stringify(spec));
const { server, url } = await startServer(specPath, { hmr: false });
const browser = await puppeteer.launch({ headless: true, args: BROWSER_ARGS });
try {
  await check('the server serves Lucide icons by name and refuses others', async () => {
    const ok = await fetch(`${url}/__bemotion/icon/house.svg`);
    assert(ok.status === 200 && (ok.headers.get('content-type') ?? '').includes('svg'), `house: ${ok.status}`);
    const bad = await fetch(`${url}/__bemotion/icon/arrow-rigth.svg`);
    assert(bad.status === 404, `unknown: ${bad.status}`);
    // A name with a path in it never reaches the icon route (Vite answers with its page instead).
    const esc = await fetch(`${url}/__bemotion/icon/..%2F..%2Fpackage.svg`);
    assert(!(esc.headers.get('content-type') ?? '').includes('svg'), `escape: ${esc.headers.get('content-type')}`);
    const svg = await fetch(`${url}/__bemotion/assets/media/svg/shapes.svg`);
    assert(svg.status === 200 && (svg.headers.get('content-type') ?? '').includes('svg'), 'svg files are served next to the spec');
  });

  await check('the server serves a stock: image from the sidecar', async () => {
    const res = await fetch(`${url}/__bemotion/stock?q=${encodeURIComponent('Mountain Lake')}`);
    assert(res.status === 200 && res.headers.get('content-type') === 'image/png', `status ${res.status}`);
    const missing = await fetch(`${url}/__bemotion/stock?q=nothing+here`);
    assert(missing.status === 404, `unknown query without a key: ${missing.status}`);
  });

  const { page } = await openPage(browser, url, spec);
  const api = (fn: string, ...args: unknown[]) => page.evaluate((f, a) => (window as any).bemotion[f](...a), fn, args);
  const frames = new Map<number, string>();
  const pixel = async (frame: number, [x, y]: [number, number]) => {
    if (!frames.has(frame)) frames.set(frame, (await api('frame', frame, 'png', 1, false)) as string);
    return page.evaluate(async (src, px, py) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      return Array.from(g.getImageData(px, py, 1, 1).data.slice(0, 3));
    }, frames.get(frame)!, Math.round(x), Math.round(y));
  };
  const near = (c: number[], hex: string, tol = 40) => {
    const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return c.every((v, i) => Math.abs(v - want[i]) <= tol);
  };
  const at = (scene: number, t = 0.5) => Math.round((scene + t) * 30);

  await check('a whole SVG file: fills, strokes, shapes and group transforms in their own colors', async () => {
    const f = at(0);
    const cases: [string, [number, number], string][] = [
      ['rounded rect fill', P(55, 40), '#4F46E5'],
      ['circle stroke', P(190, 40), '#F59E0B'],
      ['ellipse fill', P(260, 40), '#10B981'],
      ['ellipse stroke', P(260, 15), '#065F46'],
      ['polygon (rgb())', P(270, 140), '#EC4899'],
      ['line', P(70, 130), '#EF4444'],
      ['rect in a nested, rotated group', P(160, 175), '#FFA500'],
      ['empty circle middle', P(160, 40), '#FFFFFF'],
    ];
    for (const [what, p, hex] of cases) {
      const c = await pixel(f, p);
      assert(near(c, hex), `${what} at ${p}: got ${c}, want ${hex}`);
    }
  });

  await check('progress 0 draws nothing', async () => {
    for (const p of [P(55, 40), P(190, 40), P(270, 140)]) assert(near(await pixel(at(1), p), '#FFFFFF', 6), `blank at ${p}`);
  });

  await check('color paints every element one color', async () => {
    for (const p of [P(55, 40), P(190, 40), P(270, 140), P(160, 175)]) {
      const c = await pixel(at(2), p);
      assert(near(c, '#FF0000'), `red at ${p}: ${c}`);
    }
  });

  await check('draw-on goes element by element; fillAfter fills each as its trace completes', async () => {
    // Eight elements one after another (stagger 1): at 0.5 the first four are done, the last not begun.
    assert(near(await pixel(at(3), P(55, 40)), '#4F46E5'), 'the first element is drawn and filled');
    assert(near(await pixel(at(3), P(160, 175)), '#FFFFFF', 6), 'the last element has not started');
  });

  await check('the draw entrance traces the file on', async () => {
    assert(near(await pixel(at(4, 0.02), P(55, 40)), '#FFFFFF', 6), 'nothing at the start');
    assert(near(await pixel(at(4, 0.95), P(55, 40)), '#4F46E5'), 'drawn and filled at the end');
  });

  await check('Lucide and built-in icons render by name; stock: images load', async () => {
    // circle-check: a circle of radius 10 on a 24 grid, 240 px: its stroke 100 px left of center.
    const c = await pixel(at(5), [960 - 300 - 100, 540]);
    assert(near(c, '#FFFFFF', 60), `circle-check ring: ${c}`);
    assert(near(await pixel(at(5), [960 - 300, 540 + 60]), '#000000', 30), 'circle-check is hollow');
    // check: M20 6 L9 17 L4 12 at 10 px per unit; its corner (9, 17) is 30 px left of center, 50 below.
    const check2 = await pixel(at(5), [960 + 300 - 30, 540 + 50]);
    assert(near(check2, '#FFFFFF', 60), `built-in check: ${check2}`);
    const img = await pixel(at(5), [960, 540 - 300]);
    assert(!near(img, '#000000', 10), `the stock image is drawn: ${img}`);
  });
} finally {
  await browser.close();
  await server.close();
}

console.log(failed ? `\n${failed} of ${n} asset checks failed.` : `\nAll ${n} asset checks passed.`);
process.exit(failed ? 1 : 0);
