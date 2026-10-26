/**
 * Figma import, offline: a hand-written file in the REST API's shape (scripts/fixtures/figma-file.json)
 * and a mocked fetch for the API, the images endpoints and Google Fonts. Checks the layer mapping
 * (positions y up from the frame center, shapes, text per line, highlights, svg from path geometry,
 * masks, rendered nodes, image fills), the token staying with api.figma.com, download limits, and
 * renders a still of the result.
 * Run: npx tsx scripts/test-figma.ts
 */
import { deflateSync, crc32 } from 'node:zlib';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importFigma, parseFigmaRef } from '../src/cli/figma';
import { validateVideo } from '../src/spec/schema';

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

/** A small RGB PNG with a diagonal gradient between two colors. */
function png(w: number, h: number, a: number[], b: number[]): Uint8Array<ArrayBuffer> {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      for (let c = 0; c < 3; c++) raw[y * (w * 3 + 1) + 1 + x * 3 + c] = Math.round(a[c] + (b[c] - a[c]) * t);
    }
  }
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const KEY = 'AbCdEf1234567890XyZ';
const TOKEN = 'figd_SECRET-test-token-0123456789';
const fixture = JSON.parse(await readFile('scripts/fixtures/figma-file.json', 'utf8'));
const SHOT = 'https://s3-alpha-sig.figma.com/img/8f1c/shot';
const AVATAR = 'https://s3-alpha-sig.figma.com/img/3a9b/avatar';

const calls: { url: string; token: string | null }[] = [];
const realFetch = globalThis.fetch;
let huge = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const headers = new Headers(init?.headers);
  calls.push({ url, token: headers.get('x-figma-token') });
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const u = new URL(url);
  if (u.host === 'api.figma.com') {
    if (headers.get('x-figma-token') !== TOKEN) return json({ status: 403, err: 'Invalid token' }, 403);
    if (u.pathname === `/v1/files/${KEY}`) return json(fixture);
    if (u.pathname === `/v1/files/${KEY}/nodes`) {
      const id = u.searchParams.get('ids')!;
      const find = (nd: any): any => (nd.id === id ? nd : (nd.children ?? []).map(find).find(Boolean));
      const doc = find(fixture.document);
      return json({ name: fixture.name, nodes: { [id]: doc ? { document: doc, components: {}, styles: {} } : null } });
    }
    if (u.pathname === `/v1/files/${KEY}/images`) {
      return json({ error: false, status: 200, meta: { images: { '8f1c2b7a9e0d4c3b2a1f0e9d8c7b6a5f4e3d2c1b': huge ? 'https://s3-alpha-sig.figma.com/img/huge' : SHOT, '3a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b': AVATAR } } });
    }
    if (u.pathname === `/v1/images/${KEY}`) {
      const ids = u.searchParams.get('ids')!.split(',');
      return json({ err: null, images: Object.fromEntries(ids.map((id) => [id, `https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/${id.replace(':', '-')}`])) });
    }
    return json({ status: 404, err: 'Not found' }, 404);
  }
  if (url === SHOT) return new Response(png(320, 210, [40, 44, 60], [124, 92, 255]));
  if (url === AVATAR) return new Response(png(80, 80, [240, 180, 120], [180, 90, 70]));
  if (url.endsWith('/huge')) {
    // No length header: the limit must hold while streaming.
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent > 40_000_000) return c.close();
        sent += 1_000_000;
        c.enqueue(new Uint8Array(1_000_000));
      },
    });
    return new Response(body);
  }
  if (u.host.endsWith('amazonaws.com')) {
    const id = u.pathname.split('/').pop()!;
    // Rendered nodes: the angular-gradient orb (1-14) and the blurred blob (2-9), at scale 2.
    return new Response(id === '1-14' ? png(240, 240, [255, 102, 153], [102, 128, 255]) : png(480, 480, [45, 212, 191], [200, 245, 240]));
  }
  if (u.host === 'fonts.googleapis.com') return new Response('Not found', { status: 404 });
  return new Response('offline', { status: 599 });
}) as typeof fetch;

const dir = await mkdtemp(join(tmpdir(), 'bemotion-figma-'));
const out = join(dir, 'acme.json');
const logs: string[] = [];
const origLog = console.log;
const origWarn = console.warn;

try {
  await check('links and keys parse (file, design, node-id)', () => {
    assert(parseFigmaRef(`https://www.figma.com/design/${KEY}/Acme-Launch?node-id=12-34&t=x`).node === '12:34', 'node id from the link');
    assert(parseFigmaRef(`https://www.figma.com/file/${KEY}/Acme`).key === KEY, 'file link');
    assert(parseFigmaRef(KEY).key === KEY && !parseFigmaRef(KEY).node, 'bare key');
    let threw = false;
    try {
      parseFigmaRef('../../etc/passwd');
    } catch {
      threw = true;
    }
    assert(threw, 'junk is refused');
  });

  let r: Awaited<ReturnType<typeof importFigma>> | undefined;
  await check('the whole file imports: one scene per top-level frame', async () => {
    console.log = (...a: unknown[]) => void logs.push(a.join(' '));
    console.warn = (...a: unknown[]) => void logs.push(a.join(' '));
    try {
      r = await importFigma(`https://www.figma.com/design/${KEY}/Acme-Launch`, out, { token: TOKEN });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
    assert(r.scenes === 2, `scenes: ${r.scenes}`);
    assert(r.rendered === 2, `rendered nodes: ${r.rendered}`);
    assert(r.images === 2, `image fills: ${r.images}`);
  });

  const spec = JSON.parse(await readFile(out, 'utf8'));
  const all = (layers: any[]): any[] => layers.flatMap((l) => [l, ...(l.mask ? [l.mask] : []), ...all(l.children ?? [])]);
  const hero = all(spec.scenes[0].layers);
  const pricing = all(spec.scenes[1].layers);
  const byId = (list: any[], id: string) => list.find((l) => l.id === id);

  await check('the spec validates', () => {
    const v = validateVideo(spec);
    assert(v.ok, v.errors.join('; '));
    assert(spec.scenes.map((s: any) => s.id).join() === 'hero,pricing', spec.scenes.map((s: any) => s.id).join());
    assert(spec.scenes[0].background === '#0B0D12', `background ${spec.scenes[0].background}`);
  });

  await check('frames are scaled to fill the 1920x1080 video', () => {
    const scale = spec.scenes[0].layers[0].scale;
    assert(scale === 1.2, `scale ${scale}`);
  });

  await check('positions: from the frame center, y up (second frame offset too)', () => {
    const card = byId(hero, 'stat-card');
    // Center (1190, 670) in a 1440x900 frame: x 470, y -220.
    assert(card.x === 470 && card.y === -220, `stat card at ${card.x}, ${card.y}`);
    const title = byId(pricing, 'title');
    // Centered text: x is the box center (1920 + 400 - 2320 = 0), y from the frame at x 1600.
    assert(title.x === 0 && title.anchor === 'center' && title.y === 450 - 156, `title at ${title.x}, ${title.y}`);
  });

  await check('rectangles: radius, gradient angle, stroke, shadow', () => {
    const card = byId(hero, 'stat-card');
    assert(card.type === 'shape' && card.radius === 16, 'radius');
    assert(card.fill.type === 'linear' && card.fill.angle === 90 && card.fill.from === '#7C5CFF', `fill ${JSON.stringify(card.fill)}`);
    const shot = byId(hero, 'app-window');
    assert(shot.type === 'image' && shot.fit === 'cover' && shot.radius === 20 && /^media\/acme\/image-\d+\.png$/.test(shot.src), `image fill ${JSON.stringify(shot)}`);
    assert(shot.shadow && shot.shadow.y === -24 && shot.shadow.blur === 60 && shot.shadow.opacity === 0.5, `shadow ${JSON.stringify(shot.shadow)}`);
    const border = hero.find((l) => l.id === 'app-window-2');
    assert(border && border.stroke === '#FFFFFF1F' && border.fill === 'none', `border ${JSON.stringify(border)}`);
  });

  await check('frames: groups with their background, clipping as a mask', () => {
    const btn = byId(hero, 'get-started');
    assert(btn.type === 'group' && btn.x === -520 && btn.y === 32, `button group at ${btn.x}, ${btn.y}`);
    const bg = btn.children[0];
    assert(bg.type === 'shape' && bg.radius === 28 && bg.fill === '#7C5CFF' && bg.shadow, 'button background with shadow');
    const clip = btn.children[1];
    assert(clip.mask && clip.mask.width === 200 && clip.mask.radius === 28, 'clipsContent becomes a mask');
    const label = clip.children[0];
    assert(label.text === 'Get started' && label.x === 0 && label.y === 0 && label.weight === 600, `label ${JSON.stringify(label)}`);
  });

  await check('text: one layer per line, highlight from a colored run, style', () => {
    const l1 = byId(hero, 'headline-1');
    const l2 = byId(hero, 'headline-2');
    assert(l1.text === 'Ship faster' && l2.text === 'with Acme', 'lines split');
    assert(l1.y - l2.y === 80, `lines one line height apart: ${l1.y} ${l2.y}`);
    assert(l1.anchor === 'left' && l1.x === -620, `left edge ${l1.x}`);
    assert(l1.font === 'Inter' && l1.weight === 700 && l1.size === 72 && l1.letterSpacing === -0.02, 'font, weight, size, tracking');
    assert(l2.highlight?.[0]?.text === 'Acme' && l2.highlight[0].color === '#7C5CFF' && !l1.highlight, `highlight ${JSON.stringify(l2.highlight)}`);
    const sub = byId(hero, 'subhead');
    assert(sub.maxWidth === 481 && sub.color === '#FFFFFFB8', `wrapped body ${JSON.stringify(sub)}`);
    assert(sub.font === 'Manrope', `DM Sans is not reachable offline: nearest bundled (${sub.font})`);
    const label = byId(hero, 'stat-label');
    assert(label.uppercase === true && label.letterSpacing === 0.1, 'uppercase and tracking');
    const price = byId(pricing, 'price');
    assert(price.gradient?.colors?.length === 2, 'gradient text');
  });

  await check('vectors: svg from path geometry, stroke outlines, lines', () => {
    const logo = byId(hero, 'logo');
    assert(logo.type === 'svg' && logo.d.startsWith('M24 0') && logo.fill === '#7C5CFF' && logo.width === 48 && logo.viewBox.join() === '0,0,48,48', `logo ${JSON.stringify(logo)}`);
    const u = byId(hero, 'underline');
    assert(u.type === 'svg' && u.fill === '#2DD4BF', 'stroke-only vector is its stroke outline, filled');
    const div = byId(hero, 'divider');
    assert(div.type === 'shape' && div.width === 480 && div.height === 1, 'line as a thin bar');
  });

  await check('complex nodes are rendered by Figma and placed at their render bounds', () => {
    const orb = byId(hero, 'orb');
    assert(orb.type === 'image' && orb.width === 120 && orb.fit === 'fill', `orb ${JSON.stringify(orb)}`);
    const blob = byId(pricing, 'blurred-blob');
    assert(blob.type === 'image' && blob.width === 240, `blurred blob uses its render bounds: ${JSON.stringify(blob)}`);
    assert(!hero.some((l) => l.id === 'ellipse-1'), 'children of a rendered node are not imported again');
  });

  await check('rotation and groups', () => {
    const g = byId(hero, 'new-badge');
    assert(g.type === 'group', 'group');
    const bg = byId(hero, 'badge-bg');
    assert(Math.abs(bg.rotate - 10) < 0.1 && bg.width === 120 && bg.height === 40, `rotated badge ${JSON.stringify(bg)}`);
    assert(Math.abs(bg.x) < 0.2 && Math.abs(bg.y) < 0.2, 'the child sits at the group center');
  });

  await check('a mask node clips the siblings above it', () => {
    const masked = pricing.find((l) => l.id === 'avatar-mask-masked');
    assert(masked && masked.mask?.shape === 'circle' && masked.children[0].type === 'image', `mask ${JSON.stringify(masked)}`);
  });

  await check('hidden nodes are skipped', () => {
    assert(!JSON.stringify(spec).includes('Hidden draft copy'), 'hidden text imported');
  });

  await check('the token goes only to api.figma.com and is never logged or written', async () => {
    for (const c of calls) {
      const host = new URL(c.url).host;
      assert(host === 'api.figma.com' || c.token === null, `token sent to ${host}`);
    }
    assert(calls.some((c) => c.token === TOKEN), 'the API got the token');
    assert(!logs.join('\n').includes(TOKEN), 'token in the log');
    const files = await readdir(dir, { recursive: true });
    for (const f of files) {
      const p = join(dir, String(f));
      const text = await readFile(p).then((b) => b.toString('latin1'), () => '');
      assert(!text.includes(TOKEN), `token written to ${f}`);
    }
  });

  await check('a node link imports that frame alone', async () => {
    const one = join(dir, 'one.json');
    const origL = console.log;
    console.log = () => {};
    try {
      const res = await importFigma(`https://www.figma.com/design/${KEY}/Acme?node-id=2-1`, one, { token: TOKEN });
      assert(res.scenes === 1, `scenes ${res.scenes}`);
    } finally {
      console.log = origL;
    }
    const s = JSON.parse(await readFile(one, 'utf8'));
    assert(s.scenes[0].id === 'pricing', s.scenes[0].id);
  });

  await check('a bad token is a clear error without the token in it', async () => {
    try {
      await importFigma(KEY, join(dir, 'bad.json'), { token: 'figd_wrong-token-value' });
      throw new Error('no error');
    } catch (e) {
      const m = (e as Error).message;
      assert(/403/.test(m) && /FIGMA_TOKEN/.test(m) && !m.includes('figd_wrong'), m);
    }
  });

  await check('downloads are size-limited while streaming', async () => {
    huge = true;
    const big = join(dir, 'big.json');
    const ow = console.warn;
    const warned: string[] = [];
    console.warn = (...a: unknown[]) => void warned.push(a.join(' '));
    const ol = console.log;
    console.log = () => {};
    try {
      const res = await importFigma(KEY, big, { token: TOKEN });
      assert(res.images === 1, `the oversize image is skipped (${res.images} images)`);
      assert(warned.some((w) => /too large/.test(w)), `warned: ${warned.join(' | ')}`);
    } finally {
      console.warn = ow;
      console.log = ol;
      huge = false;
    }
  });

  await check('a still of the import renders', async () => {
    globalThis.fetch = realFetch;
    const { still } = await import('../src/cli/render');
    await rm('out/dev/figma-test', { recursive: true, force: true });
    const shots = await still(out, [2, 6], 'out/dev/figma-test/figma-{t}.png');
    assert(shots.length === 2, 'two stills');
    for (const s of shots) assert((await readFile(s)).length > 20000, `${s} looks empty`);
    await writeFile('out/dev/figma-test/spec.json', JSON.stringify(spec, null, 2));
    console.log(`     stills: ${shots.join(', ')}`);
  });
} finally {
  globalThis.fetch = realFetch;
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log(failed ? `\n${failed} of ${n} failed` : `\nAll ${n} checks passed`);
process.exit(failed ? 1 : 0);
