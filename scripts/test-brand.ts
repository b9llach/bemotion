/**
 * Brand import: color and font picking, and an end-to-end import of a small local site (no network).
 * Run: npx tsx scripts/test-brand.ts
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { baseFamily, brandTheme, clusterColors, importBrand, nearestBundled, parseColor, parseFontFaces, pickColors, titleCase, undouble } from '../src/cli/brand';

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

await check('colors parse from rgb, rgba and hex', () => {
  assert(parseColor('rgb(83, 58, 253)')?.rgb.join() === '83,58,253', 'rgb');
  assert(parseColor('rgba(0, 0, 0, 0)')?.a === 0, 'rgba alpha');
  assert(parseColor('#fa0')?.rgb.join() === '255,170,0', 'short hex');
  assert(parseColor('color(srgb 1 0 0)') === null, 'unknown syntax is skipped');
});

await check('near-identical colors merge and keep their weight', () => {
  const sw = clusterColors([
    { color: 'rgb(10, 10, 10)', weight: 5, kind: 'bg' },
    { color: 'rgb(12, 11, 10)', weight: 3, kind: 'bg' },
    { color: 'rgb(200, 0, 0)', weight: 1, kind: 'button' },
  ]);
  assert(sw.length === 2 && sw[0].weight === 8 && sw[0].count === 2, JSON.stringify(sw));
});

await check('brand color: the button color wins over one colored card far down the page', () => {
  const c = pickColors(
    [
      { color: 'rgb(255, 255, 255)', weight: 1e7, kind: 'bg', top: 0 },
      { color: 'rgb(17, 17, 17)', weight: 9000, kind: 'text', top: 200 },
      { color: 'rgb(100, 100, 110)', weight: 4000, kind: 'text', top: 300 },
      { color: 'rgb(83, 58, 253)', weight: 40000, kind: 'button', top: 120 },
      { color: 'rgb(83, 58, 253)', weight: 900, kind: 'link', top: 700 },
      { color: 'rgb(228, 242, 34)', weight: 200000, kind: 'bg', top: 8200 },
    ],
    'rgb(255, 255, 255)',
  );
  assert(c.primary === '#533AFD', `primary ${c.primary}`);
  assert(c.background === '#FFFFFF' && !c.dark, 'light background');
  assert(c.text === '#111111', `text ${c.text}`);
  assert(c.secondary !== '#E4F222' && c.accent !== '#E4F222', 'the far card is not a brand color');
});

await check('a monochrome dark site uses its text color as the accent', () => {
  const c = pickColors(
    [
      { color: 'rgb(8, 9, 10)', weight: 1e7, kind: 'bg', top: 0 },
      { color: 'rgb(208, 214, 224)', weight: 9000, kind: 'text', top: 200 },
    ],
    'rgb(8, 9, 10)',
  );
  assert(c.dark && c.primary === '#D0D6E0', JSON.stringify(c));
});

await check('font names: @font-face parsing, variable suffixes, title case, bundled fallbacks', () => {
  const faces = parseFontFaces(
    `@font-face { font-family: "Acme Sans"; font-weight: 700; src: url(/f/acme-700.woff2) format("woff2"), url('/f/acme-700.woff') format("woff"); }`,
    'https://example.com/css/site.css',
  );
  assert(faces.length === 1 && faces[0].family === 'Acme Sans' && faces[0].urls[1] === 'https://example.com/f/acme-700.woff', JSON.stringify(faces));
  assert(baseFamily('Inter Variable') === 'Inter', 'variable suffix');
  assert(titleCase('inter tight') === 'Inter Tight', 'title case');
  assert(nearestBundled('Domaine Display') === 'Instrument Serif', 'serif');
  assert(nearestBundled('Söhne') === 'Inter', 'default');
  assert(nearestBundled('GT Sectra') === 'Instrument Serif', 'sectra');
  assert(nearestBundled('Berkeley Mono') === 'JetBrains Mono', 'mono');
  assert(undouble('Ship faster Ship faster') === 'Ship faster' && undouble('A B C') === 'A B C', 'undouble');
});

// A small local site: a header logo, a brand button, a woff web font, a headline and a product image.
const woff = await readFile('node_modules/@fontsource/manrope/files/manrope-latin-700-normal.woff');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const page = `<!doctype html><html><head><title>Acme | Invoices that send themselves</title>
<meta name="description" content="Acme sends, chases and reconciles invoices for small teams.">
<link rel="stylesheet" href="/site.css"></head>
<body>
<header style="display:flex;justify-content:space-between;align-items:center;padding:20px 40px;background:#fff">
  <a href="./" aria-label="Acme home"><svg width="120" height="32" viewBox="0 0 120 32"><circle cx="16" cy="16" r="14" fill="#0E7C66"/><text x="38" y="23" font-size="20" font-family="Acme Display" fill="#0B1F1A">Acme</text></svg></a>
  <a href="/signup" style="background:#0E7C66;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Start free</a>
</header>
<main style="padding:80px 40px">
  <h1 style="font-family:'Acme Display';font-size:64px;color:#0B1F1A">Invoices that send themselves<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)"> Invoices that send themselves</span></h1>
  <p style="font-size:20px;color:#55635F">Acme sends, chases and reconciles every invoice, so your team gets paid without the follow-ups.</p>
  <img src="/product.png" width="1100" height="640" style="display:block;background:#E8F3EF">
  <h2>Chasing on autopilot</h2>
</main>
<section style="height:1400px;background:#F4F7F6"><h2 style="margin:0;padding:80px 40px">Reconciled to the cent</h2></section>
<div style="opacity:0"><div style="background:#E4F222;width:900px;height:900px"></div></div>
</body></html>`;
const css = `@font-face { font-family: 'Acme Display'; font-weight: 700; src: url('/acme-700.woff') format('woff'); }
body { margin: 0; font-family: 'Acme Display', sans-serif; background: #FFFFFF; color: #0B1F1A; }`;
const server = createServer((req, res) => {
  const url = req.url ?? '/';
  if (url === '/' || url === '/index.html') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  if (url === '/site.css') return res.writeHead(200, { 'content-type': 'text/css' }).end(css);
  if (url === '/acme-700.woff') return res.writeHead(200, { 'content-type': 'font/woff' }).end(woff);
  if (url === '/product.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(pixel);
  res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const dir = await mkdtemp(join(tmpdir(), 'bemotion-brand-'));

try {
  const b = await importBrand(`http://127.0.0.1:${port}/`, dir, { shots: 3 });
  await check('import: name, description and the brand color from the button', () => {
    assert(b.name === 'Acme', `name ${b.name}`);
    assert(b.description.startsWith('Acme sends'), 'description');
    assert(b.colors.primary === '#0E7C66', `primary ${b.colors.primary}`);
    assert(b.colors.background === '#FFFFFF' && !b.dark, `background ${b.colors.background}`);
    assert(![b.colors.primary, b.colors.secondary, b.colors.accent].includes('#E4F222'), 'a hidden element gave a color');
  });
  await check('import: headline without its hidden duplicate, call to action', () => {
    assert(b.headlines[0] === 'Invoices that send themselves', `headline "${b.headlines[0]}"`);
    assert(b.ctas.includes('Start free'), `ctas ${b.ctas.join(', ')}`);
  });
  await check('import: the web font is downloaded and becomes a spec fonts entry', async () => {
    const f = b.fonts.find((x) => x.family === 'Acme Display');
    assert(f && f.source === 'site' && f.files['700'], JSON.stringify(b.fonts));
    assert((await stat(join(dir, f.files['700']))).size === woff.length, 'font file size');
    const t = brandTheme(b, 'brand/');
    assert((t.theme as any).fonts.display === 'Acme Display' && t.fonts['Acme Display']['700'] === `brand/${f.files['700']}`, JSON.stringify(t));
  });
  await check('import: a transparent logo capture, a hero screenshot, distinct sections', async () => {
    assert(b.logo === 'logo.png' && b.logoInk === 'dark', `logo ${b.logo} ${b.logoInk}`);
    const logo = await readFile(join(dir, 'logo.png'));
    assert(logo.readUInt32BE(16) >= 100 && logo.readUInt32BE(16) < 400, `logo width ${logo.readUInt32BE(16)}`);
    assert(b.screenshots[0] === 'shots/hero.png' && b.screenshots.length >= 2, b.screenshots.join(', '));
    const hero = await readFile(join(dir, 'shots/hero.png'));
    assert(hero.readUInt32BE(16) === 2880, `hero width ${hero.readUInt32BE(16)}`);
  });
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} of ${n} brand checks failed.` : `\nAll ${n} brand checks passed.`);
process.exit(failed ? 1 : 0);
