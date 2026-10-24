/**
 * Records a short, deterministic "screen recording" of a mock SaaS app for testing video focus: the
 * user types a search at the top left (0.8-2.8 s), the view is idle, then a details panel slides in
 * on the right and a comment is typed into it (4.5-7.5 s). Frames are set by time, not captured live.
 *
 * Run: npx tsx scripts/make-screen-recording.ts <out.mp4>
 */
import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { startEncoder } from '../src/cli/ffmpeg';

const out = process.argv[2] ?? 'out/dev/app-demo.mp4';
const FPS = 30;
const DURATION = 9;

const html = `<!doctype html><html><head><style>
  * { box-sizing: border-box; margin: 0; font-family: Segoe UI, Arial, sans-serif; }
  body { width: 1280px; height: 720px; background: #F4F5F8; color: #1C1D22; display: grid; grid-template-columns: 220px 1fr; overflow: hidden; }
  nav { background: #fff; border-right: 1px solid #E4E6EC; padding: 22px 16px; }
  nav b { display: block; font-size: 16px; margin-bottom: 26px; }
  nav div { padding: 9px 10px; border-radius: 7px; color: #5B5E6B; font-size: 14px; margin-bottom: 2px; }
  nav div.on { background: #EEF0FF; color: #3A3FD8; }
  main { padding: 22px 28px; position: relative; }
  .search { width: 420px; height: 40px; border: 1px solid #DADDE5; border-radius: 9px; background: #fff; padding: 10px 14px; font-size: 15px; }
  .search i { color: #9A9DAA; font-style: normal; }
  .caret { display: inline-block; width: 1.5px; height: 17px; background: #3A3FD8; vertical-align: -3px; }
  h1 { font-size: 22px; margin: 26px 0 16px; }
  .row { display: grid; grid-template-columns: 2fr 1fr 1fr; background: #fff; border: 1px solid #E8EAF0; border-radius: 9px; padding: 14px 16px; margin-bottom: 8px; font-size: 14px; color: #4A4D59; }
  .row.hit { border-color: #3A3FD8; box-shadow: 0 0 0 3px #E6E8FF; }
  .panel { position: absolute; top: 0; right: 0; bottom: 0; width: 360px; background: #fff; border-left: 1px solid #E4E6EC; padding: 24px; transform: translateX(var(--x, 380px)); }
  .panel h2 { font-size: 17px; margin-bottom: 14px; }
  .panel p { font-size: 13px; color: #6A6D79; margin-bottom: 18px; line-height: 1.5; }
  .comment { border: 1px solid #DADDE5; border-radius: 9px; padding: 12px; min-height: 96px; font-size: 14px; line-height: 1.5; }
  .send { margin-top: 12px; display: inline-block; background: #3A3FD8; color: #fff; padding: 9px 16px; border-radius: 8px; font-size: 14px; }
</style></head><body>
  <nav><b>Ledgerly</b><div class="on">Invoices</div><div>Customers</div><div>Reports</div><div>Settings</div></nav>
  <main>
    <div class="search" id="search"></div>
    <h1>Invoices</h1>
    <div id="rows"></div>
    <div class="panel" id="panel"><h2>INV-2041 Northwind</h2><p>Due Mar 14. Sent twice. Last opened yesterday by the finance team.</p><div class="comment" id="comment"></div><span class="send">Send reminder</span></div>
  </main>
<script>
  const rows = ['INV-2041 Northwind;$4,200;Overdue', 'INV-2038 Acme Corp;$1,150;Paid', 'INV-2035 Globex;$8,900;Sent', 'INV-2031 Initech;$2,300;Paid', 'INV-2027 Umbrella;$640;Draft'];
  const query = 'Northwind overdue';
  const note = 'Hi team, a quick reminder that INV-2041 is now 9 days overdue. Can you confirm the payment date?';
  window.setTime = (t) => {
    const typed = Math.max(0, Math.min(query.length, Math.floor((t - 0.8) * 9)));
    const caret = t > 0.6 && t < 3.2 && Math.floor(t * 2) % 2 === 0 ? '<span class="caret"></span>' : '';
    document.getElementById('search').innerHTML = typed ? query.slice(0, typed) + caret : '<i>Search invoices</i>' + caret;
    const filtered = typed >= 9 ? rows.slice(0, 1) : rows;
    document.getElementById('rows').innerHTML = filtered.map((r, i) => '<div class="row' + (typed >= 9 && i === 0 ? ' hit' : '') + '">' + r.split(';').map((c) => '<span>' + c + '</span>').join('') + '</div>').join('');
    const slide = Math.max(0, Math.min(1, (t - 4.2) / 0.35));
    document.getElementById('panel').style.setProperty('--x', (380 * (1 - slide * slide * (3 - 2 * slide))) + 'px');
    const chars = Math.max(0, Math.min(note.length, Math.floor((t - 4.8) * 32)));
    document.getElementById('comment').textContent = note.slice(0, chars);
  };
</script></body></html>`;

await mkdir(dirname(out), { recursive: true });
const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await page.setContent(html);
  const enc = startEncoder({ fps: FPS, input: 'png', crf: 16, preset: 'veryfast', out });
  for (let f = 0; f < DURATION * FPS; f++) {
    await page.evaluate((t) => (window as any).setTime(t), f / FPS);
    await enc.write(Buffer.from(await page.screenshot({ type: 'png' })));
  }
  enc.proc.stdin.end();
  await enc.done;
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
