/**
 * Distributed rendering: two `bemotion worker` processes on random local ports with a token, a render
 * split between them and this machine that matches a purely local render frame for frame, a worker
 * killed mid-job whose chunks are rendered here instead, and the worker's defenses (token, Origin,
 * bundle paths, hashes, body size, the render page's network confinement, version check, timeouts).
 * Run: npx tsx scripts/test-remote.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { render } from '../src/cli/render';
import { ffmpegPath } from '../src/cli/ffmpeg';
import { safeRelPath } from '../src/cli/bundle';
import { pageRequestAllowed, codeDirs } from '../src/cli/worker';
import { RemoteWorker, countFrames, parseRemotes } from '../src/cli/remote';
import { ChunkQueue, connectRemotes } from '../src/cli/distribute';
import { buildInfo } from '../src/cli/version';
import { PKG_ROOT } from '../src/cli/server';

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

const TOKEN = 'test-token-0123456789abcdef';
const root = await mkdtemp(join(tmpdir(), 'bemotion-remote-'));
const specDir = join(root, 'ad');
await mkdir(join(specDir, 'media'), { recursive: true });
await copyFile(resolve(PKG_ROOT, 'examples/dev/assets/photo.png'), join(specDir, 'media', 'photo.png'));
const spec = {
  fps: 30,
  scenes: [
    {
      duration: 2,
      layers: [
        { type: 'background', style: 'aurora', colors: ['#07070B', '#3B1F8F', '#0E4F6B', '#5B1A4A'] },
        { type: 'text', text: 'Render anywhere.', size: 110, weight: 700, y: 160, animate: { preset: 'rise', by: 'char', stagger: 0.03 } },
        { type: 'image', src: 'media/photo.png', width: 420, x: -380, y: -150, radius: 24, in: 'popIn' },
        { type: 'mesh', geometry: 'torusKnot', material: 'iridescent', size: 200, x: 400, y: -160, spin: [20, 40, 0] },
      ],
    },
    {
      duration: 2,
      transition: { type: 'slide' },
      layers: [
        { type: 'background', style: 'solid', color: '#0B0B12' },
        { type: 'text', text: 'Same frames.', size: 120, weight: 700, animate: { preset: 'rise', by: 'word' } },
      ],
    },
  ],
};
const specPath = join(specDir, 'ad.json');
await writeFile(specPath, JSON.stringify(spec, null, 2));
// Two 2 s scenes overlapping by the 0.5 s transition.
const FRAMES = 105;

// ---------------------------------------------------------------- workers as separate processes

interface Proc {
  proc: ChildProcess;
  url: string;
  addr: string;
  out: string[];
}
async function startWorkerProc(name: string, workers = 1): Promise<Proc> {
  const proc = spawn(process.execPath, [resolve(PKG_ROOT, 'bin/bemotion.mjs'), 'worker', '--port', '0', '--workers', String(workers), '--dir', join(root, name)], {
    env: { ...process.env, BEMOTION_WORKER_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const out: string[] = [];
  const onData = (d: Buffer) => out.push(...d.toString().split(/\r?\n/).filter(Boolean));
  proc.stdout!.on('data', onData);
  proc.stderr!.on('data', onData);
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    const line = out.find((l) => /listening on http:\/\/127\.0\.0\.1:\d+/.test(l));
    if (line) {
      const url = /http:\/\/127\.0\.0\.1:\d+/.exec(line)![0];
      return { proc, url, addr: url.slice(7), out };
    }
    if (proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`worker ${name} did not start:\n${out.join('\n')}`);
}
/** Kills the worker and its browsers at once (no cleanup), like a machine dropping off. */
function killTree(p: Proc): Promise<void> {
  return new Promise((res) => {
    if (p.proc.exitCode !== null) return res();
    p.proc.once('exit', () => res());
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(p.proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-p.proc.pid!, 'SIGKILL');
  });
}

async function call(url: string, init: RequestInit & { token?: string | null } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.token !== null) headers.Authorization = `Bearer ${init.token ?? TOKEN}`;
  const r = await fetch(url, { ...init, headers });
  const text = await r.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: r.status, body };
}
const json = (o: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

// ---------------------------------------------------------------- frame comparison

function run(args: string[]): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => res({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }));
  });
}
async function frameHashes(file: string): Promise<string[]> {
  const r = await run(['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-']);
  return r.stdout.toString().split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim());
}
/** Mean absolute difference per frame (0-255) on small gray thumbnails. */
async function meanDiff(a: string, b: string): Promise<number> {
  const raw = async (f: string) => (await run(['-v', 'error', '-i', f, '-vf', 'scale=160:90,format=gray', '-f', 'rawvideo', '-'])).stdout;
  const [x, y] = [await raw(a), await raw(b)];
  if (x.length !== y.length) return Infinity;
  let s = 0;
  for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]);
  return s / x.length;
}
async function same(a: string, b: string): Promise<string> {
  const [ha, hb] = [await frameHashes(a), await frameHashes(b)];
  assert(ha.length === FRAMES && hb.length === FRAMES, `frame counts ${ha.length} and ${hb.length}, expected ${FRAMES}`);
  const differing = ha.filter((h, i) => h !== hb[i]).length;
  if (differing === 0) return 'identical frames';
  const d = await meanDiff(a, b);
  assert(d < 0.5, `${differing} frames differ, mean difference ${d.toFixed(3)}`);
  return `${differing} frames differ slightly (mean ${d.toFixed(3)})`;
}

/** Captures the coordinator's log lines while it runs. */
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn };
  console.log = (...a: unknown[]) => lines.push(a.join(' '));
  console.warn = (...a: unknown[]) => lines.push(a.join(' '));
  try {
    return { value: await fn(), lines };
  } finally {
    Object.assign(console, orig);
  }
}

const procs: Proc[] = [];
try {
  // ------------------------------------------------------------ pure functions

  await check('bundle paths: relative names only, nothing that climbs out or means something to the OS', () => {
    for (const ok of ['media/photo.png', 'a/b/c.json', '.bemotion-hdri/x_1k.hdr']) assert(safeRelPath(ok) === ok, `refused ${ok}`);
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'C:\\x', 'a\\..\\b', './a', 'a//b', '', 'con', 'aux.png', 'a/nul', 'x.', 'a:b', 'a\u0000b']) {
      assert(safeRelPath(bad) === null, `accepted ${JSON.stringify(bad)}`);
    }
  });

  await check('render pages may load the app and the job files only', async () => {
    const o = 'http://127.0.0.1:5000';
    const code = await codeDirs();
    const fs = (p: string) => `${o}/@fs/${p.replace(/\\/g, '/')}`;
    assert(pageRequestAllowed(`${o}/__bemotion/assets/media/photo.png`, 'GET', o, code), 'job asset refused');
    assert(pageRequestAllowed(`${o}/render.html`, 'GET', o, code), 'app refused');
    assert(pageRequestAllowed(fs(join(PKG_ROOT, 'node_modules/three/build/three.module.js')), 'GET', o, code), 'package refused');
    assert(pageRequestAllowed('data:image/png;base64,AAAA', 'GET', o, code), 'data URL refused');
    assert(!pageRequestAllowed('https://example.com/x.png', 'GET', o, code), 'internet allowed');
    assert(!pageRequestAllowed('http://127.0.0.1:22/', 'GET', o, code), 'other local port allowed');
    assert(!pageRequestAllowed(fs(join(PKG_ROOT, 'package.json')), 'GET', o, code), 'install file allowed');
    assert(!pageRequestAllowed(fs('C:/Windows/win.ini'), 'GET', o, code), 'system file allowed');
    assert(!pageRequestAllowed(`${o}/@id/C:/Windows/win.ini`, 'GET', o, code), '@id path allowed');
    assert(!pageRequestAllowed(`${o}/__bemotion/assets/..%2fsecret.png`, 'GET', o, code), 'encoded .. allowed');
    assert(!pageRequestAllowed(`${o}/__bemotion/edit`, 'POST', o, code), 'editor endpoint allowed');
    assert(!pageRequestAllowed(`${o}/__bemotion/files?kind=image`, 'GET', o, code), 'file listing allowed');
    assert(pageRequestAllowed(`${o}/__bemotion/voice`, 'POST', o, code), 'voice alignment refused');
  });

  await check('remote addresses parse with the default port', () => {
    const r = parseRemotes('10.0.0.5:7500, gpu-box ,[::1]:7421');
    assert(r.map((x) => x.url).join(' ') === 'http://10.0.0.5:7500 http://gpu-box:7420 http://[::1]:7421', r.map((x) => x.url).join(' '));
    let threw = false;
    try {
      parseRemotes('http://x/y');
    } catch {
      threw = true;
    }
    assert(threw, 'a URL with a path was accepted');
  });

  await check('chunk queue: a failed remote chunk goes back to the local pages, which wait for it', async () => {
    const q = new ChunkQueue(3);
    const r1 = q.takeRemote();
    const l1 = await q.takeLocal();
    const l2 = await q.takeLocal();
    assert(r1 === 0 && l1 === 1 && l2 === 2, `${r1} ${l1} ${l2}`);
    assert(q.takeRemote() === null, 'remote took a chunk after the end');
    const waiting = q.takeLocal();
    setTimeout(() => q.remoteDone(0, false), 50);
    assert((await waiting) === 0, 'the failed chunk did not come back');
    assert((await q.takeLocal()) === null, 'queue did not finish');
  });

  // ------------------------------------------------------------ fake workers: version check, timeouts

  await check('version check: a worker on another commit is a warning, and refused with --strict', async () => {
    const mine = await buildInfo();
    const fake = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ name: 'bemotion-worker', version: mine.version, commit: 'abcdef123456', workers: 2, encoder: null }));
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
    const addr = `127.0.0.1:${(fake.address() as any).port}`;
    try {
      const { value, lines } = await captured(() => connectRemotes([addr], TOKEN, false));
      assert(value.length === 1, 'worker dropped without --strict');
      assert(lines.some((l) => /runs Bemotion .*abcdef123456/.test(l)), `no warning: ${lines.join(' | ')}`);
      let refused = '';
      await connectRemotes([addr], TOKEN, true).catch((e) => (refused = (e as Error).message));
      assert(/--strict/.test(refused), `not refused: ${refused}`);
    } finally {
      fake.close();
    }
  });

  await check('a chunk that takes too long times out', async () => {
    const fake = createServer(() => {});
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
    try {
      const w = new RemoteWorker('slow', `http://127.0.0.1:${(fake.address() as any).port}`, TOKEN);
      w.job = 'abc';
      const t = Date.now();
      let err = '';
      await w.renderChunk(0, 15, join(root, 'slow.mp4'), 400).catch((e) => (err = (e as Error).message));
      assert(/timed out/.test(err), `no timeout: ${err}`);
      assert(Date.now() - t < 3000, 'took too long to give up');
      assert(!existsSync(join(root, 'slow.mp4')) && !existsSync(join(root, 'slow.mp4.part')), 'left a partial file');
    } finally {
      fake.closeAllConnections();
      fake.close();
    }
  });

  // ------------------------------------------------------------ real workers

  const w1 = await startWorkerProc('w1');
  const w2 = await startWorkerProc('w2');
  procs.push(w1, w2);

  await check('a worker refuses to start without a token, and prints a new one when none is given', async () => {
    const env = { ...process.env };
    delete env.BEMOTION_WORKER_TOKEN;
    const p = spawn(process.execPath, [resolve(PKG_ROOT, 'bin/bemotion.mjs'), 'worker', '--port', '0', '--token', 'short', '--dir', join(root, 'w0')], { env, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const code = await new Promise<number>((r) => p.on('close', (c) => r(c ?? 0)));
    assert(code !== 0 && /at least 16 characters/.test(out), `short token accepted (${code}): ${out.slice(0, 300)}`);
    const g = spawn(process.execPath, [resolve(PKG_ROOT, 'bin/bemotion.mjs'), 'worker', '--port', '0', '--dir', join(root, 'w0')], { env, windowsHide: true });
    let gout = '';
    g.stdout.on('data', (d) => (gout += d));
    const end = Date.now() + 30000;
    while (!/listening/.test(gout) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    g.kill();
    assert(/generated one/.test(gout) && /^\s+[A-Za-z0-9_-]{32}\s*$/m.test(gout), `no generated token: ${gout.slice(0, 300)}`);
  });

  await check('the worker listens on 127.0.0.1 and wants a valid token on every request', async () => {
    assert(w1.url.startsWith('http://127.0.0.1:'), w1.url);
    assert((await call(`${w1.url}/v1/info`, { token: null })).status === 401, 'no token accepted');
    assert((await call(`${w1.url}/v1/info`, { token: 'wrong-token-0123456789abcdef' })).status === 401, 'wrong token accepted');
    assert((await call(`${w1.url}/v1/info`, { token: TOKEN.slice(0, -1) })).status === 401, 'token prefix accepted');
    const ok = await call(`${w1.url}/v1/info`);
    assert(ok.status === 200 && ok.body.name === 'bemotion-worker' && ok.body.workers === 1 && typeof ok.body.commit === 'string', JSON.stringify(ok.body));
    let err = '';
    await new RemoteWorker(w1.addr, w1.url, 'wrong-token-0123456789abcdef').connect().catch((e) => (err = (e as Error).message));
    assert(/401/.test(err), `client did not see the refusal: ${err}`);
  });

  await check('requests from web pages (with an Origin) are refused even with the token', async () => {
    const r = await call(`${w1.url}/v1/info`, { headers: { Origin: 'http://evil.example' } });
    assert(r.status === 403, String(r.status));
  });

  const blob = Buffer.from('hello');
  const sha = createHash('sha256').update(blob).digest('hex');
  await check('files are stored by hash, and a body that does not match its hash is refused', async () => {
    const bad = await call(`${w1.url}/v1/blobs/${'0'.repeat(64)}`, { method: 'PUT', body: blob });
    assert(bad.status === 400, `mismatch accepted: ${bad.status}`);
    const good = await call(`${w1.url}/v1/blobs/${sha}`, { method: 'PUT', body: blob });
    assert(good.status === 200, JSON.stringify(good.body));
    const m = await call(`${w1.url}/v1/blobs/missing`, json({ hashes: [sha, 'f'.repeat(64)] }));
    assert(JSON.stringify(m.body.missing) === JSON.stringify(['f'.repeat(64)]), JSON.stringify(m.body));
  });

  await check('path traversal and absolute paths in a bundle are refused, and nothing lands outside', async () => {
    for (const p of ['../evil.txt', '../../evil.txt', 'media/../../evil.txt', '/tmp/evil.txt', 'C:/evil.txt', '..\\evil.txt', '.bemotion-job-spec.json']) {
      const r = await call(`${w1.url}/v1/jobs`, json({ spec, files: { [p]: sha }, settings: { fps: 30, imageFormat: 'jpeg', jpegQ: 0.9, crf: 17, preset: 'slow', encoder: null, motionBlur: true } }));
      assert(r.status === 400 && /unsafe path/.test(r.body.error), `${p}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert(!existsSync(join(root, 'evil.txt')) && !existsSync(join(root, 'w1', 'evil.txt')), 'a file escaped');
    assert((await readdir(join(root, 'w1', 'jobs'))).length === 0, 'refused jobs left folders behind');
  });

  await check('oversized requests are refused', async () => {
    const r = await call(`${w1.url}/v1/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: Buffer.alloc(21_000_000, 32) }).catch(() => ({ status: 413, body: null }));
    assert(r.status === 413, String(r.status));
  });

  await check('the render page cannot fetch from the network or read the install', async () => {
    const leaky = {
      fps: 30,
      scenes: [{ duration: 1, layers: [
        { type: 'background', style: 'solid', color: '#000000' },
        { type: 'image', src: 'http://example.com/logo.png', width: 100 },
        { type: 'image', src: `/@fs/${PKG_ROOT.replace(/\\/g, '/')}/examples/dev/assets/photo.png`, width: 100 },
      ] }],
    };
    const before = w1.out.length;
    const r = await call(`${w1.url}/v1/jobs`, json({ spec: leaky, files: {}, settings: { fps: 30, imageFormat: 'jpeg', jpegQ: 0.9, crf: 17, preset: 'slow', encoder: null, motionBlur: true } }));
    if (r.status === 200) await call(`${w1.url}/v1/jobs/${r.body.id}`, { method: 'DELETE' });
    const log = w1.out.slice(before).join('\n');
    assert(/blocked a request.*example\.com/.test(log), `internet request not blocked:\n${log}`);
    assert(/blocked a request.*examples\/dev\/assets\/photo\.png/.test(log), `install file not blocked:\n${log}`);
  });

  // ------------------------------------------------------------ renders

  const local = join(root, 'local.mp4');
  const dist = join(root, 'dist.mp4');
  const killed = join(root, 'killed.mp4');
  await check('local render (reference)', async () => {
    await captured(() => render(specPath, { out: local, concurrency: 1 }));
    assert((await countFrames(local)) === FRAMES, 'wrong frame count');
  });

  await check('render split across two workers and this machine matches the local render', async () => {
    const chunkLines = () => [w1, w2].map((w) => w.out.filter((l) => /: frames \d+-\d+/.test(l)).length);
    const before = chunkLines();
    const { lines } = await captured(() => render(specPath, { out: dist, concurrency: 1, remote: [`${w1.addr},${w2.addr}`], token: TOKEN }));
    const after = chunkLines();
    assert(after[0] > before[0] && after[1] > before[1], `a worker rendered nothing (${before} -> ${after}):\n${lines.join('\n')}`);
    assert(lines.some((l) => /Throughput/.test(l)) && lines.some((l) => l.includes(w1.addr) && /fps/.test(l)), `no throughput table:\n${lines.join('\n')}`);
    const decode = await run(['-v', 'error', '-i', dist, '-f', 'null', '-']);
    assert(decode.code === 0 && !decode.stderr.trim(), `does not play cleanly: ${decode.stderr.slice(0, 300)}`);
    console.log(`     ${await same(local, dist)}`);
  });

  await check('a worker killed mid-job: its chunks are rendered locally and the video still matches', async () => {
    const w3 = await startWorkerProc('w3');
    procs.push(w3);
    const watch = setInterval(() => {
      if (w3.out.some((l) => /: frames \d+-\d+/.test(l))) {
        clearInterval(watch);
        void killTree(w3);
      }
    }, 20);
    try {
      const { lines } = await captured(() => render(specPath, { out: killed, concurrency: 1, remote: [`${w1.addr},${w3.addr}`], token: TOKEN }));
      assert(w3.proc.exitCode !== null || w3.proc.signalCode !== null, 'the worker was never killed');
      assert(lines.some((l) => l.includes(w3.addr) && /rendered here instead/.test(l)), `no failover:\n${lines.join('\n')}`);
      assert(lines.some((l) => l.includes(w3.addr) && /failed \(re-rendered locally\)/.test(l)), `throughput does not show the failure:\n${lines.join('\n')}`);
    } finally {
      clearInterval(watch);
    }
    console.log(`     ${await same(local, killed)}`);
  });

  await check('finished jobs are deleted on the workers', async () => {
    const end = Date.now() + 10000;
    let left: string[] = [];
    while (Date.now() < end) {
      left = [...(await readdir(join(root, 'w1', 'jobs'))).map((j) => `w1/${j}`), ...(await readdir(join(root, 'w2', 'jobs'))).map((j) => `w2/${j}`)];
      if (!left.length) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const jobLog = [...w1.out, ...w2.out].filter((l) => /job /.test(l) && !/: frames/.test(l));
    assert(!left.length, `left: ${left.join(', ')}; worker log: ${jobLog.join(' | ')}`);
  });

  await check('a second render sends no files the worker already has', async () => {
    const r = new RemoteWorker(w2.addr, w2.url, TOKEN);
    await r.connect();
    const { collectBundle } = await import('../src/cli/bundle');
    const { validateVideo } = await import('../src/spec/schema');
    const files = await collectBundle(specPath, validateVideo(spec).video!);
    assert(files.length === 1 && files[0].path === 'media/photo.png', JSON.stringify(files.map((f) => f.path)));
    const started = await r.start(validateVideo(spec).video, files, { fps: 30, imageFormat: 'jpeg', jpegQ: 0.95, crf: 17, preset: 'slow', encoder: null, motionBlur: true }, { gpu: true });
    await r.close();
    assert(started.sent === 0 && started.info.frameCount === FRAMES, JSON.stringify(started));
  });
} finally {
  await Promise.all(procs.map(killTree));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
}

console.log(failed ? `\n${failed} of ${n} remote checks failed.` : `\nAll ${n} remote checks passed.`);
process.exit(failed ? 1 : 0);
