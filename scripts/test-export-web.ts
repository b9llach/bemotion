/**
 * Web export, end to end: `exportWeb` writes a self-contained folder (player bundle, spec with its
 * assets, poster, soundtrack with the generated score), a tiny static server serves it from a sub
 * path, and headless Chrome plays it in each mode: loop and play draw real frames, scroll moves the
 * playhead with the page, playback pauses off screen, reduced motion shows the poster, the canvas
 * follows the element's size at no more than 2 device pixels, and no request leaves the folder.
 * Run: npx tsx scripts/test-export-web.ts
 */
import puppeteer, { type Page } from 'puppeteer';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { exportWeb } from '../src/cli/export-web';
import { BROWSER_ARGS } from '../src/cli/render';
import { PKG_ROOT } from '../src/cli/server';

let failed = 0;
let n = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(get: () => Promise<T>, pred: (v: T) => boolean, what: string, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  let v = await get();
  while (!pred(v)) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await wait(100);
    v = await get();
  }
  return v;
}

const work = await mkdtemp(join(tmpdir(), 'bemotion-web-test-'));
const project = join(work, 'project');
const site = join(work, 'site');
await mkdir(join(project, 'img'), { recursive: true });
await copyFile(join(PKG_ROOT, 'examples/dev/assets/photo.png'), join(project, 'img', 'photo.png'));
const spec = {
  title: 'Web export test',
  width: 960,
  height: 540,
  fps: 30,
  background: '#0B0B10',
  score: { style: 'ambient', drums: false },
  scenes: [
    {
      id: 'one',
      duration: 1.5,
      layers: [
        { type: 'background', style: 'radial', colors: ['#2A1F6B', '#0B0B10'] },
        { type: 'image', src: 'img/photo.png', width: 360, height: 240, x: -220, radius: 16, in: 'popIn' },
        { type: 'text', text: 'Ship it', size: 72, weight: 700, x: 220, keyframes: { x: [{ t: 0, v: 120 }, { t: 1.5, v: 260 }] } },
      ],
    },
    {
      id: 'two',
      duration: 1.5,
      transition: { type: 'fade', duration: 0.4 },
      layers: [
        { type: 'background', style: 'solid', color: '#F5F5F7' },
        { type: 'text', text: 'Live in the page', size: 64, weight: 700, color: '#1D1D1F', y: 0, keyframes: { y: [{ t: 0, v: -80 }, { t: 1.5, v: 80 }] } },
      ],
    },
  ],
};
const specPath = join(project, 'ad.json');
await writeFile(specPath, JSON.stringify(spec, null, 2));

await check('export writes the player, spec, assets, poster and soundtrack', async () => {
  await exportWeb(specPath, { out: site, mode: 'loop', poster: true, sound: true, alpha: false });
  for (const f of ['index.html', 'bemotion-player.js', 'spec.json', 'poster.png', 'soundtrack.m4a', 'assets/img/photo.png']) {
    assert(await stat(join(site, f)).then(() => true, () => false), `missing ${f}`);
  }
  const out = JSON.parse(await readFile(join(site, 'spec.json'), 'utf8'));
  assert(out.scenes[0].layers[1].src === 'assets/img/photo.png', `image src not rewritten: ${out.scenes[0].layers[1].src}`);
  const html = await readFile(join(site, 'index.html'), 'utf8');
  assert(html.includes('<bemotion-player src="spec.json" mode="loop"') && html.includes('sound="soundtrack.m4a"'), 'index.html has no player tag');
  assert((await stat(join(site, 'soundtrack.m4a'))).size > 10000, 'soundtrack is nearly empty');
});

await check('a second export into the same folder replaces it; an unrelated folder is refused', async () => {
  await exportWeb(specPath, { out: site, mode: 'loop', poster: true, sound: false, alpha: false });
  assert(!(await stat(join(site, 'soundtrack.m4a')).then(() => true, () => false)), 'old soundtrack left behind');
  const other = join(work, 'other');
  await mkdir(other);
  await writeFile(join(other, 'keep.txt'), 'x');
  let threw = false;
  try {
    await exportWeb(specPath, { out: other, mode: 'loop', poster: false, sound: false, alpha: false });
  } catch {
    threw = true;
  }
  assert(threw, 'exported into a folder with other files');
  // Back to the full export for the browser checks.
  await exportWeb(specPath, { out: site, mode: 'loop', poster: true, sound: true, alpha: false });
});

// Test pages next to the export: other modes and layouts.
const page = (body: string, head = '') => `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><script type="module" src="bemotion-player.js"></script><style>body{margin:0;background:#222}</style>${head}</head><body>${body}</body></html>`;
await writeFile(join(site, 'play.html'), page('<bemotion-player src="spec.json" mode="play" style="width:640px"></bemotion-player>'));
await writeFile(join(site, 'scroll.html'), page('<div style="height:400vh"><div style="position:sticky;top:0"><bemotion-player src="spec.json" mode="scroll" style="width:640px"></bemotion-player></div></div>'));
await writeFile(join(site, 'below.html'), page('<div style="height:300vh"></div><bemotion-player src="spec.json" style="width:640px"></bemotion-player><div style="height:50vh"></div>'));
await writeFile(join(site, 'poster.html'), page('<bemotion-player src="spec.json" poster="poster.png" style="width:640px"></bemotion-player>'));
await writeFile(join(site, 'small.html'), page('<bemotion-player src="spec.json" style="width:300px"></bemotion-player>'));

// A tiny static server for the folder, under /site/ so relative paths are tested too.
const root = resolve(site);
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.woff': 'font/woff', '.m4a': 'audio/mp4', '.hdr': 'application/octet-stream', '.mp4': 'video/mp4' };
const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (!url.startsWith('/site/')) {
    res.statusCode = 404;
    return res.end();
  }
  const file = normalize(join(root, url.slice('/site/'.length)));
  if (!file.startsWith(root + sep)) {
    res.statusCode = 403;
    return res.end();
  }
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) {
    res.statusCode = 404;
    return res.end();
  }
  res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(st.size));
  createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const addr = server.address();
const origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
const base = `${origin}/site/`;

const browser = await puppeteer.launch({ headless: true, args: BROWSER_ARGS });
const requests: { url: string; status: number }[] = [];
const errors: string[] = [];
async function open(path: string, opts: { reduced?: boolean; dpr?: number } = {}): Promise<Page> {
  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 800, deviceScaleFactor: opts.dpr ?? 1 });
  if (opts.reduced) await p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  p.on('response', (r) => requests.push({ url: r.url(), status: r.status() }));
  p.on('requestfailed', (r) => requests.push({ url: r.url(), status: -1 }));
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await p.goto(base + path, { waitUntil: 'load' });
  return p;
}
const time = (p: Page) => p.evaluate(() => (document.querySelector('bemotion-player') as any).currentTime as number);
const dur = (p: Page) => p.evaluate(() => (document.querySelector('bemotion-player') as any).duration as number);
/** The last frame's time: 3 s of scenes less the 0.4 s fade they overlap, at 30 fps. */
const LAST = 2.6 - 1 / 30;
const ready = (p: Page) => p.evaluate(() => (document.querySelector('bemotion-player') as any).ready.then(() => true));
/** Spread of a small copy of the canvas: near 0 for a blank frame. */
const spread = (p: Page) =>
  p.evaluate(() => {
    const c = (document.querySelector('bemotion-player') as any).shadowRoot.querySelector('canvas') as HTMLCanvasElement | null;
    if (!c) return -1;
    const t = Object.assign(document.createElement('canvas'), { width: 64, height: 36 });
    const g = t.getContext('2d')!;
    g.drawImage(c, 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      s += y;
      s2 += y * y;
    }
    const m = s / (d.length / 4);
    return Math.sqrt(s2 / (d.length / 4) - m * m);
  });

await check('loop: the exported page draws real frames and keeps playing', async () => {
  const p = await open('index.html');
  await ready(p);
  const s = await spread(p);
  assert(s > 5, `frame looks blank (spread ${s.toFixed(2)})`);
  const t0 = await time(p);
  await until(() => time(p), (t) => Math.abs(t - t0) > 0.3, 'the playhead to move');
  assert(Math.abs((await dur(p)) - 2.6) < 1e-6, `duration ${await dur(p)}, expected 2.6`);
  // It wraps: watch past the end.
  const seen = new Set<number>();
  const end = Date.now() + 4500;
  while (Date.now() < end) {
    seen.add(Math.round((await time(p)) * 2) / 2);
    await wait(150);
  }
  assert(seen.has(0) || seen.has(0.5), `never looped back to the start: ${[...seen].join(',')}`);
  await p.close();
});

await check('play: plays once and holds the last frame', async () => {
  const p = await open('play.html');
  await ready(p);
  const last = LAST;
  await until(() => time(p), (t) => Math.abs(t - last) < 1e-6, 'the last frame', 15000);
  await wait(800);
  const t = await time(p);
  assert(Math.abs(t - last) < 1e-6, `moved after the end: ${t}`);
  assert((await spread(p)) > 5, 'last frame looks blank');
  await p.close();
});

await check('scroll: the playhead follows the page scroll', async () => {
  const p = await open('scroll.html');
  await ready(p);
  await wait(300);
  const t0 = await time(p);
  assert(t0 < 0.1, `starts at ${t0}, expected 0`);
  const s0 = await spread(p);
  await p.evaluate(() => window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) / 2));
  const mid = await until(() => time(p), (t) => Math.abs(t - LAST / 2) < 0.1, 'the middle of the video');
  await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const end = await until(() => time(p), (t) => Math.abs(t - LAST) < 1e-6, 'the end of the video');
  const s1 = await spread(p);
  assert(s1 > 5 && s0 > 5, `blank frames while scrolling (${s0.toFixed(1)}, ${s1.toFixed(1)})`);
  await p.evaluate(() => window.scrollTo(0, 0));
  await until(() => time(p), (t) => t < 0.1, 'back to the start');
  console.log(`     middle ${mid.toFixed(2)} s, end ${end.toFixed(2)} s`);
  await p.close();
});

await check('off screen: nothing plays until the player is scrolled into view', async () => {
  const p = await open('below.html');
  await wait(2500);
  const before = await p.evaluate(() => {
    const el = document.querySelector('bemotion-player') as any;
    return { t: el.currentTime as number, on: !!el.shadowRoot.querySelector('canvas.on') };
  });
  assert(!before.on && before.t === 0, `rendered while off screen: ${JSON.stringify(before)}`);
  await p.evaluate(() => document.querySelector('bemotion-player')!.scrollIntoView());
  await ready(p);
  await until(() => time(p), (t) => t > 0.3, 'playback once visible');
  await p.close();
});

await check('reduced motion: the poster shows and no engine starts', async () => {
  const p = await open('poster.html', { reduced: true });
  await wait(1500);
  const st = await p.evaluate(() => {
    const r = (document.querySelector('bemotion-player') as any).shadowRoot as ShadowRoot;
    const img = r.querySelector('img') as HTMLImageElement;
    return { canvas: !!r.querySelector('canvas'), hidden: img.hidden, src: img.src, loaded: img.complete && img.naturalWidth > 0 };
  });
  assert(!st.canvas, 'a canvas was created');
  assert(!st.hidden && st.loaded && st.src.endsWith('/site/poster.png'), `poster not shown: ${JSON.stringify(st)}`);
  await p.close();
  // Without a poster: the last frame, drawn once and held.
  const q = await open('small.html', { reduced: true });
  await ready(q);
  await wait(600);
  const t = await time(q);
  assert(Math.abs(t - LAST) < 1e-6, `shows ${t}, not the last frame`);
  await q.close();
});

await check('size: the canvas follows the element, keeps 16:9 and caps at 2 device pixels', async () => {
  const p = await open('small.html', { dpr: 3 });
  await ready(p);
  await wait(300);
  const s = await p.evaluate(() => {
    const el = document.querySelector('bemotion-player') as HTMLElement;
    const c = (el.shadowRoot as ShadowRoot).querySelector('canvas') as HTMLCanvasElement;
    const r = c.getBoundingClientRect();
    return { cw: c.width, ch: c.height, w: r.width, h: r.height };
  });
  assert(Math.abs(s.w - 300) < 1 && Math.abs(s.h - 168.75) < 1, `CSS size ${s.w}x${s.h}, expected 300x168.75`);
  assert(s.cw === 600 && Math.abs(s.ch - 338) <= 1, `canvas ${s.cw}x${s.ch}, expected 600x338 (2x)`);
  await p.evaluate(() => ((document.querySelector('bemotion-player') as HTMLElement).style.width = '200px'));
  await until(
    () => p.evaluate(() => ((document.querySelector('bemotion-player') as any).shadowRoot.querySelector('canvas') as HTMLCanvasElement).width),
    (w) => w === 400,
    'the canvas to follow a resize',
  );
  await p.close();
});

await check('every request stays inside the exported folder, and none fails', async () => {
  assert(requests.length > 10, `only ${requests.length} requests seen`);
  const outside = requests.filter((r) => !r.url.startsWith(base) && !r.url.startsWith('data:') && !r.url.startsWith('blob:'));
  assert(!outside.length, `requests outside the folder: ${outside.map((r) => r.url).slice(0, 5).join(', ')}`);
  const bad = requests.filter((r) => r.status !== -1 && r.status >= 400);
  assert(!bad.length, `failed requests: ${bad.map((r) => `${r.status} ${r.url}`).slice(0, 5).join(', ')}`);
  assert(!errors.length, `page errors: ${errors.slice(0, 3).join(' | ')}`);
});

await browser.close();
server.close();
await rm(work, { recursive: true, force: true }).catch(() => {});
console.log(failed ? `\n${failed} of ${n} web export checks failed.` : `\nAll ${n} web export checks passed.`);
process.exit(failed ? 1 : 0);
