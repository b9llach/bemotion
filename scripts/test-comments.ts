/**
 * Review comments in the preview, end to end in headless Chrome: C opens the comment box at the
 * playhead, Enter saves it with its scene, time and selected layer, a marker appears on the timeline,
 * resolving and deleting work, other sites cannot write, and the CLI lists what was left.
 * Run: npx tsx scripts/test-comments.ts
 */
import puppeteer from 'puppeteer';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/cli/server';
import { commentLines, readComments } from '../src/cli/comments';

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
async function until<T>(get: () => Promise<T>, pred: (v: T) => boolean, what: string, ms = 6000): Promise<T> {
  const end = Date.now() + ms;
  let v = await get();
  while (!pred(v)) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await wait(80);
    v = await get();
  }
  return v;
}

const dir = await mkdtemp(join(tmpdir(), 'bemotion-comments-'));
const SPEC = join(dir, 'ad.json');
await writeFile(SPEC, JSON.stringify({
  title: 'Comments test',
  scenes: [
    { id: 'hook', duration: 3, layers: [{ type: 'text', text: 'Hello' }] },
    { id: 'demo', duration: 3, transition: { type: 'cut' }, layers: [{ type: 'text', text: 'World' }] },
  ],
}));
const { server, url } = await startServer(SPEC, { port: 0 });
const browser = await puppeteer.launch({ headless: true, args: ['--ignore-gpu-blocklist', '--use-angle=default'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.evaluateOnNewDocument(() => localStorage.setItem('bemotion:time', '4.2'));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#tracks .clip').length === 2, { timeout: 15000 });

  await check('C opens the comment box; Enter saves it with its scene and time', async () => {
    await page.keyboard.press('c');
    assert(await page.evaluate(() => document.activeElement?.id === 'comment-text'), 'the comment box is not focused');
    await page.keyboard.type('The second line feels slow');
    await page.keyboard.press('Enter');
    const list = await until(() => readComments(SPEC), (l) => l.length === 1, 'one saved comment');
    assert(list[0].text === 'The second line feels slow', list[0].text);
    assert(list[0].scene === 'demo' && Math.abs(list[0].t - 4.2) < 0.05 && Math.abs(list[0].sceneTime - 1.2) < 0.05, JSON.stringify(list[0]));
    assert(await page.$eval('#comment-text', (e) => (e as HTMLInputElement).value === ''), 'the box is cleared');
  });

  await check('the comment shows in the list and as a marker on the timeline', async () => {
    await page.waitForFunction(() => document.querySelectorAll('#comment-list li').length === 1 && document.querySelectorAll('#comment-marks .comment-mark').length === 1, { timeout: 5000 });
    const left = await page.$eval('#comment-marks .comment-mark', (e) => parseFloat((e as HTMLElement).style.left));
    assert(Math.abs(left - 70) < 1.5, `marker at ${left}%`);
  });

  await check('clicking a comment jumps to it; resolving hides its marker', async () => {
    await page.evaluate(() => localStorage.setItem('bemotion:time', '0'));
    await page.keyboard.press('Home');
    await page.click('#comment-list li .comment-text');
    const tc = await page.$eval('#tc', (e) => e.textContent);
    assert(tc === '00:04.20', `timecode ${tc}`);
    await page.click('#comment-list li input[type=checkbox]');
    await until(() => readComments(SPEC), (l) => l[0]?.resolved === true, 'resolved');
    await page.waitForFunction(() => document.querySelectorAll('#comment-marks .comment-mark').length === 0, { timeout: 5000 });
  });

  await check('the CLI lists open comments, and resolved ones with --all', async () => {
    assert(commentLines(await readComments(SPEC)).length === 0, 'resolved comments are hidden');
    const all = commentLines(await readComments(SPEC), true);
    assert(all.length === 1 && /4\.20s \[demo at 1\.20s\].*\(resolved\): The second line feels slow/.test(all[0]), all[0]);
  });

  await check('other sites cannot write comments', async () => {
    const res = await fetch(`${url}/__bemotion/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ op: 'add', t: 1, scene: 'x', sceneTime: 1, text: 'pwned' }) });
    assert(res.status === 403, `status ${res.status}`);
    const plain = await fetch(`${url}/__bemotion/comments`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ op: 'add', t: 1, text: 'pwned' }) });
    assert(plain.status === 403, `text/plain status ${plain.status}`);
    assert((await readComments(SPEC)).length === 1, 'a comment was added');
  });

  await check('deleting removes it; saving comments does not reload the preview', async () => {
    await page.evaluate(() => ((window as any).__stillHere = true));
    await page.hover('#comment-list li');
    await page.click('#comment-list li .mini-btn');
    await until(() => readComments(SPEC), (l) => l.length === 0, 'deleted');
    await wait(400);
    assert(await page.evaluate(() => (window as any).__stillHere === true), 'the page reloaded');
    assert(JSON.parse(await readFile(join(dir, 'ad.comments.json'), 'utf8')).length === 0, 'file');
  });

  await check('no page errors', async () => {
    assert(errors.length === 0, errors.join('\n'));
  });
} finally {
  await browser.close();
  await server.close();
  await rm(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} of ${n} comment checks failed.` : `\nAll ${n} comment checks passed.`);
process.exit(failed ? 1 : 0);
