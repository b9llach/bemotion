/**
 * Auto director, offline. The Director alone with a fake revision: the quiet period restarts with each
 * comment, runs never overlap and comments left during a run wait for the next one, failures are
 * reported. Then end to end in headless Chrome with a local stand-in for the Messages API (as in
 * test-generate): the toggle, a comment, the status reaching the page, the revision written, the
 * comment resolved, and one undo restoring the spec.
 * Run: npx tsx scripts/test-director.ts
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
async function until<T>(get: () => Promise<T> | T, pred: (v: T) => boolean, what: string, ms = 6000): Promise<T> {
  const end = Date.now() + ms;
  let v = await get();
  while (!pred(v)) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await wait(50);
    v = await get();
  }
  return v;
}

const base = {
  title: 'Director test',
  scenes: [
    { id: 'hook', duration: 2, layers: [{ type: 'text', text: 'Hello', size: 120 }] },
    { id: 'end', duration: 2, transition: { type: 'cut' }, layers: [{ type: 'text', text: 'World', size: 120 }] },
  ],
};
const revisedSpec = structuredClone(base);
revisedSpec.scenes[0].layers[0].text = 'Hello there';

// A stand-in for the Messages API: every review returns the revised spec.
const requests: any[] = [];
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const api = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const body = JSON.parse(raw);
    requests.push(body);
    const text = `The first line now reads Hello there.\n\n\`\`\`json\n${JSON.stringify(revisedSpec)}\n\`\`\``;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const usage = { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    res.write(sse('message_start', { type: 'message_start', message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }));
    res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }));
    res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
    res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } }));
    res.write(sse('message_stop', { type: 'message_stop' }));
    res.end();
  });
});
await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
process.env.ANTHROPIC_API_KEY = 'test-key';

const { Director } = await import('../src/cli/director');
const { applyComment, readComments } = await import('../src/cli/comments');
const { startServer } = await import('../src/cli/server');

const dir = await mkdtemp(join(tmpdir(), 'bemotion-director-'));
const SPEC = join(dir, 'ad.json');
const original = JSON.stringify(base, null, 2) + '\n';
await writeFile(SPEC, original);
const addComment = (text: string) => applyComment(SPEC, { op: 'add', t: 0.5, scene: 'hook', sceneTime: 0.5, text });

try {
  await check('the quiet period restarts with each comment; one run after the last', async () => {
    await addComment('Make the hook longer');
    const starts: number[] = [];
    const states: string[] = [];
    const d = new Director(SPEC, { enabled: true, quietMs: 300, run: async () => (starts.push(Date.now()), { summary: 'ok' }), onStatus: (s) => states.push(s.state) });
    const t0 = Date.now();
    d.notify();
    await wait(150);
    d.notify();
    await wait(150);
    d.notify();
    await wait(200);
    assert(starts.length === 0, 'ran before the quiet period after the last comment');
    await until(() => starts.length, (k) => k === 1, 'one run');
    assert(starts[0] - t0 >= 590, `started ${starts[0] - t0} ms after the first comment (expected at least 600)`);
    await until(() => d.status().state, (s) => s === 'done', 'done');
    await wait(400);
    const total: number = starts.length;
    assert(total === 1, `${total} runs`);
    assert(states.includes('waiting') && states.includes('working') && states.at(-1) === 'done', states.join(' > '));
    d.close();
  });

  await check('runs never overlap; comments during a run wait for the next one', async () => {
    let active = 0;
    let most = 0;
    let runs = 0;
    const d = new Director(SPEC, {
      enabled: true,
      quietMs: 100,
      run: async () => {
        runs++;
        active++;
        most = Math.max(most, active);
        await wait(500);
        active--;
        return { summary: `run ${runs}` };
      },
    });
    d.notify();
    await until(() => d.busy, (b) => b, 'first run');
    d.notify();
    d.notify();
    assert(d.status().queued === true && d.status().state === 'working', `status during the run: ${JSON.stringify(d.status())}`);
    await until(() => runs, (k) => k === 2, 'the queued run', 4000);
    await until(() => d.status().state, (s) => s === 'done', 'second done');
    await wait(300);
    assert(most === 1, `${most} runs at once`);
    assert(runs === 2, `${runs} runs`);
    d.close();
  });

  await check('off: comments do nothing; a failed run reports its error', async () => {
    let runs = 0;
    const off = new Director(SPEC, { quietMs: 50, run: async () => (runs++, { summary: '' }) });
    off.notify();
    await wait(200);
    assert(runs === 0 && off.status().state === 'idle', 'ran while off');
    const bad = new Director(SPEC, { enabled: true, quietMs: 50, run: async () => { throw new Error('Claude API error 529: overloaded'); } });
    bad.notify();
    const s = await until(() => bad.status(), (x) => x.state === 'failed', 'failed');
    assert(/529/.test(s.message ?? ''), s.message ?? '');
  });

  await check('no open comments: no run', async () => {
    for (const c of await readComments(SPEC)) await applyComment(SPEC, { op: 'resolve', id: c.id, resolved: true });
    let runs = 0;
    const d = new Director(SPEC, { enabled: true, quietMs: 50, run: async () => (runs++, { summary: '' }) });
    d.notify();
    await until(() => d.status().state, (s) => s === 'idle' && !d.busy, 'idle', 2000);
    await wait(100);
    assert(runs === 0, 'ran without open comments');
    await applyComment(SPEC, { op: 'delete', id: (await readComments(SPEC))[0].id });
  });

  // End to end: preview server, page, mocked API.
  const { server, url } = await startServer(SPEC, { port: 0, director: { quietMs: 800, backend: 'api' } });
  const browser = await puppeteer.launch({ headless: true, args: ['--ignore-gpu-blocklist', '--use-angle=default'] });
  const errors: string[] = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('#tracks .clip').length === 2, { timeout: 15000 });

    await check('other sites cannot switch the director on', async () => {
      const evil = await fetch(`${url}/__bemotion/director`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ enabled: true }) });
      assert(evil.status === 403, `cross-origin status ${evil.status}`);
      const plain = await fetch(`${url}/__bemotion/director`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ enabled: true }) });
      assert(plain.status === 403, `text/plain status ${plain.status}`);
      const s = await (await fetch(`${url}/__bemotion/director`)).json();
      assert(s.enabled === false, 'it is on');
    });

    await check('the toggle in the Comments panel turns it on', async () => {
      await page.evaluate(() => {
        const w = window as any;
        w.__states = [];
        const el = document.getElementById('director-status')!;
        new MutationObserver(() => w.__states.push(`${el.dataset.state}: ${el.textContent}`)).observe(el, { attributes: true, childList: true, characterData: true, subtree: true });
      });
      await page.click('label:has(#director-on)');
      const s = await until(async () => (await fetch(`${url}/__bemotion/director`)).json(), (v: any) => v.enabled === true, 'enabled');
      assert(s.state === 'idle', JSON.stringify(s));
      await page.waitForFunction(() => /^Idle/.test(document.getElementById('director-status')!.textContent ?? ''), { timeout: 3000 });
    });

    await check('a comment: waiting, working and done reach the page; the revision is written', async () => {
      await page.evaluate(() =>
        fetch('/__bemotion/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'add', t: 0.5, scene: 'hook', sceneTime: 0.5, text: 'Say hello there instead' }) }),
      );
      await page.waitForFunction(() => document.getElementById('director-status')!.dataset.state === 'waiting', { timeout: 3000 });
      await page.waitForFunction(() => document.getElementById('director-status')!.dataset.state === 'done', { timeout: 180000 });
      const states: string[] = await page.evaluate(() => (window as any).__states);
      assert(states.some((x) => x.startsWith('working')), states.join(' | '));
      const text = await page.$eval('#director-status', (e) => e.textContent ?? '');
      assert(/^Done: Revised for 1 comment/.test(text), text);
      const spec = JSON.parse(await readFile(SPEC, 'utf8'));
      assert(spec.scenes[0].layers[0].text === 'Hello there', 'the revision was not written');
      assert(requests.length === 1, `${requests.length} API requests`);
      assert(JSON.stringify(requests[0].messages[0].content).includes('Say hello there instead'), 'the comment reached the review');
    });

    await check('the comment is resolved, in the file and in the panel', async () => {
      const list = await readComments(SPEC);
      assert(list.length === 1 && list[0].resolved === true, JSON.stringify(list));
      await page.waitForFunction(() => document.querySelectorAll('#comment-list li.resolved').length === 1, { timeout: 5000 });
      const { mkdir } = await import('node:fs/promises');
      await mkdir('out/dev/director-test', { recursive: true });
      const panel = await page.$('#comments-panel');
      await panel?.screenshot({ path: 'out/dev/director-test/panel.png' });
    });

    await check('one undo restores the spec from before the revision', async () => {
      const r = await page.evaluate(async () => (await fetch('/__bemotion/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json());
      assert(r.ok === true, JSON.stringify(r));
      assert((await readFile(SPEC, 'utf8')) === original, 'the spec is not back to the original');
    });

    await check('no page errors', async () => {
      assert(errors.length === 0, errors.join('\n'));
    });
  } finally {
    await browser.close();
    await server.close();
  }
} finally {
  api.close();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log(failed ? `\n${failed} of ${n} director checks failed.` : `\nAll ${n} director checks passed.`);
process.exit(failed ? 1 : 0);
