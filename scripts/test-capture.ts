/**
 * UI capture against a local page (no network): boxes keep their fill, radius and shadow, wrapped text
 * becomes one layer per line, screen-reader copies and tiled textures are skipped, inline icons become
 * images, and the result is a valid spec that renders.
 * Run: npx tsx scripts/test-capture.ts
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureUi } from '../src/cli/capture';
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

const noise = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const page = `<!doctype html><html><head><title>Fixture</title><style>
body { margin: 0; background: #F4F5F9; font-family: Arial, sans-serif; }
.card { position: absolute; left: 200px; top: 120px; width: 520px; padding: 32px; background: #FFFFFF; border-radius: 16px;
  box-shadow: 0 12px 40px rgba(20, 20, 40, 0.18); }
.title { font-size: 34px; font-weight: 700; color: #14141F; margin: 0 0 12px; }
.body { font-size: 20px; color: #55556A; width: 300px; margin: 0; line-height: 28px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.btn { display: inline-flex; align-items: center; gap: 8px; margin-top: 20px; padding: 10px 18px; background: #4F46E5; color: #FFFFFF; border-radius: 10px; font-size: 18px; }
.grain { position: absolute; inset: 0; background-image: url(/noise.png); background-repeat: repeat; opacity: 0.1; pointer-events: none; }
</style></head><body>
<div class="card">
  <h1 class="title">Invoices that send themselves</h1>
  <span class="sr">Invoices that send themselves</span>
  <p class="body">Acme sends, chases and reconciles every invoice for you.</p>
  <div class="btn"><svg width="18" height="18" viewBox="0 0 24 24"><path d="M4 12h12M12 6l6 6-6 6" stroke="currentColor" stroke-width="2.5" fill="none"/></svg>Start free</div>
</div>
<div class="grain"></div>
</body></html>`;
const server = createServer((req, res) => {
  if (req.url === '/noise.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(noise);
  res.writeHead(200, { 'content-type': 'text/html' }).end(page);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const dir = await mkdtemp(join(tmpdir(), 'bemotion-capture-'));

try {
  const r = await captureUi(`http://127.0.0.1:${port}/`, join(dir, 'ui.json'), { width: 1000, height: 700 });
  const scene = (r.spec.scenes as any[])[0];
  const layers = scene.layers[0].children as any[];
  const texts = layers.filter((l) => l.type === 'text');

  await check('the result is a valid spec on the page background', () => {
    const v = validateVideo(r.spec);
    assert(v.ok, v.errors.join('; '));
    assert(scene.background === '#F4F5F9', `background ${scene.background}`);
  });
  await check('the card keeps its fill, radius and shadow, at its place', () => {
    const card = layers.find((l) => l.type === 'shape' && l.fill === '#FFFFFF');
    assert(card, 'no card');
    assert(card.radius === 16, `radius ${card.radius}`);
    assert(card.shadow && card.shadow.blur === 40 && card.shadow.y === -12, JSON.stringify(card.shadow));
    // The page is 1000x700: the card's center is left of and above the middle.
    assert(card.x < 0 && card.y > 0, `at ${card.x}, ${card.y}`);
  });
  await check('wrapped text is one layer per line, with size, weight and color', () => {
    const body = texts.filter((t) => t.color === '#55556A');
    assert(body.length >= 2, `${body.length} body lines`);
    assert(body.every((t) => t.size === 20 && t.anchor === 'left'), 'body style');
    assert(body[0].y > body[1].y, 'second line below the first');
    const title = texts.find((t) => t.weight === 700);
    assert(title && title.size === 34 && title.color === '#14141F', JSON.stringify(title));
  });
  await check('the screen-reader copy and the tiled grain are skipped', () => {
    assert(texts.filter((t) => t.text.startsWith('Invoices')).length === 1, 'the headline appears more than once');
    assert(!layers.some((l) => l.type === 'image' && /image-/.test(l.src)), 'the noise tile was captured');
  });
  await check('the inline icon becomes an image file in the button color', async () => {
    const icon = layers.find((l) => l.type === 'image' && /icon-/.test(l.src));
    assert(icon && icon.width === 18, JSON.stringify(icon));
    assert((await stat(join(dir, icon.src))).size > 100, 'icon file');
    const png = await readFile(join(dir, icon.src));
    assert(png.readUInt32BE(16) === 36, 'drawn at twice its size');
  });
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} of ${n} capture checks failed.` : `\nAll ${n} capture checks passed.`);
process.exit(failed ? 1 : 0);
