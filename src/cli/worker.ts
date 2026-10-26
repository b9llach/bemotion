import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, constants as fsc } from 'node:fs';
import { copyFile, link, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { BROWSER_ARGS, openPage } from './render';
import { PKG_ROOT, startServer } from './server';
import { ChunkRenderer, type ChunkSettings } from './chunks';
import { gpuEncoder } from './ffmpeg';
import { safeRelPath } from './bundle';
import { buildInfo } from './version';
import { validateVideo } from '../spec/schema';
import { formatNames } from '../spec/formats';
import { log } from './log';

/**
 * `bemotion worker`: renders chunks of videos for a coordinator on another machine. A job is a spec plus
 * the files it uses (sent once and kept by content hash); the coordinator then asks for frame ranges and
 * gets back H.264 chunks encoded exactly as its own, which it concatenates without re-encoding.
 *
 * It opens a network port, so: a token is required on every request (compared in constant time), it
 * binds to 127.0.0.1 unless told otherwise, bodies are size-limited, bundle paths are checked and
 * every file lands inside a per-job folder (realpath checked), jobs are deleted when done or idle, and
 * nothing is ever fetched from the network on the coordinator's behalf: the render pages may only load
 * the render app and the job's own files from the local server.
 */

export interface WorkerOptions {
  port: number;
  host: string;
  token: string;
  workers: number;
  /** Where blobs and job folders live (default: <tmp>/bemotion-worker). */
  dir?: string;
  /** Largest single file a coordinator may send, in bytes. */
  maxFileBytes?: number;
  /** A job with no requests for this long is deleted (seconds). */
  idleSeconds?: number;
  /** Jobs that may exist at once. */
  maxJobs?: number;
}

const JSON_LIMIT = 20_000_000;
const MAX_FILES = 5000;
const MAX_JOB_SECONDS = 6 * 3600;
const BLOB_TTL_MS = 7 * 24 * 3600 * 1000;
const BLOB_CAP = 50_000_000_000;
const SHA = /^[0-9a-f]{64}$/;
const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
const SPEC_NAME = '.bemotion-job-spec.json';

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

interface Slot {
  browser: Browser;
  page: Page;
  chunks: ChunkRenderer;
}

interface Job {
  id: string;
  dir: string;
  video: unknown;
  settings: ChunkSettings;
  format?: string;
  height?: number;
  gpu: boolean;
  info: { width: number; height: number; fps: number; duration: number; frameCount: number };
  server: Awaited<ReturnType<typeof startServer>>['server'];
  url: string;
  slots: Slot[];
  idle: Slot[];
  opening: number;
  waiters: ((s: Slot | null) => void)[];
  active: number;
  lastUsed: number;
  created: number;
  closed: boolean;
  frames: number;
}

class Refused extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return res.destroy();
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, limit = JSON_LIMIT): Promise<any> {
  return new Promise((res, rej) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) return rej(new Refused(413, 'request too large'));
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return rej(new Refused(415, 'expected application/json'));
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        rej(new Refused(413, 'request too large'));
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => {
      try {
        res(JSON.parse(Buffer.concat(parts).toString('utf8')));
      } catch {
        rej(new Refused(400, 'invalid JSON'));
      }
    });
    req.on('error', rej);
  });
}

/** The install's code and packages (after links), as /@fs/ paths compare them: forward slashes, lower case, trailing slash. */
export async function codeDirs(): Promise<string[]> {
  const out: string[] = [];
  const norm = (p: string) => `${p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')}/`.toLowerCase();
  // assets/fonts: the bundled fallback fonts (CJK) the engine loads by URL.
  for (const d of ['src', 'node_modules', 'assets/fonts']) {
    // Vite asks by both: packages by their real path, its dependency cache by the path as written.
    out.push(norm(join(PKG_ROOT, d)));
    const real = await realpath(join(PKG_ROOT, d)).catch(() => null);
    if (real) out.push(norm(real));
  }
  return [...new Set(out)];
}

/** Only the render app and the job's own files, from the job's local server; nothing else. */
export function pageRequestAllowed(rawUrl: string, method: string, origin: string, code: string[]): boolean {
  if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) return true;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.origin !== origin) return false;
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return false;
  }
  if (path.includes('\\') || path.split('/').includes('..')) return false;
  if (method === 'POST') return path === '/__bemotion/voice';
  if (method !== 'GET' && method !== 'HEAD') return false;
  // The editor's and preview's endpoints have no business in a render.
  if (/^\/__bemotion\/(edit|undo|redo|upload|comments|files|spec)\b/.test(path)) return false;
  if (path.startsWith('/@fs/')) {
    // Vite serves files from anywhere in the install this way; renders need only its code and packages.
    const p = path.slice(5).replace(/^\/+/, '').toLowerCase();
    return code.some((d) => p.startsWith(d));
  }
  // Modules by id are package names, never file paths.
  if (path.startsWith('/@id/')) return !/[:\\]/.test(path.slice(5)) && !path.slice(5).startsWith('/');
  return true;
}

export async function startWorker(o: WorkerOptions): Promise<{ url: string; port: number; close(): Promise<void> }> {
  if (!o.token || o.token.length < 16) throw new Error('A worker token of at least 16 characters is required');
  const expected = createHash('sha256').update(o.token).digest();
  const root = resolve(o.dir ?? join(tmpdir(), 'bemotion-worker'));
  const blobs = join(root, 'blobs');
  const jobsDir = join(root, 'jobs');
  await mkdir(blobs, { recursive: true });
  // Jobs from an earlier run of the worker are gone with it.
  await rm(jobsDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  await mkdir(jobsDir, { recursive: true });
  const realJobs = await realpath(jobsDir);
  const maxFile = o.maxFileBytes ?? 2_000_000_000;
  const idleMs = (o.idleSeconds ?? 600) * 1000;
  const maxJobs = o.maxJobs ?? 2;
  const build = await buildInfo();
  const encoder = await gpuEncoder();
  const jobs = new Map<string, Job>();
  const code = await codeDirs();
  const debug = !!process.env.BEMOTION_WORKER_DEBUG;

  const authorized = (req: IncomingMessage) => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    const got = createHash('sha256').update(m ? m[1] : '').digest();
    return timingSafeEqual(got, expected) && !!m;
  };

  /** Old blobs go first when the store is over its cap; blobs unused for a week always go. */
  const sweepBlobs = async () => {
    try {
      const items: { file: string; size: number; used: number }[] = [];
      for (const name of await readdir(blobs)) {
        const file = join(blobs, name);
        const st = await lstat(file);
        if (name.endsWith('.part') && Date.now() - st.mtimeMs > 3600_000) await rm(file, { force: true });
        else if (SHA.test(name)) items.push({ file, size: st.size, used: st.mtimeMs });
      }
      items.sort((a, b) => a.used - b.used);
      let total = items.reduce((s, i) => s + i.size, 0);
      for (const it of items) {
        if (Date.now() - it.used < BLOB_TTL_MS && total <= BLOB_CAP) break;
        await rm(it.file, { force: true });
        total -= it.size;
      }
    } catch {}
  };
  await sweepBlobs();

  const closeJob = async (job: Job, why: string) => {
    if (job.closed) return;
    job.closed = true;
    jobs.delete(job.id);
    for (const w of job.waiters.splice(0)) w(null);
    await Promise.all(job.slots.map((s) => s.browser.close().catch(() => {})));
    await job.server.close().catch(() => {});
    await rm(job.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    log.info(`job ${job.id}: closed (${why}, ${job.frames} frames rendered)`);
  };

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const job of jobs.values()) {
      if (job.active === 0 && now - job.lastUsed > idleMs) void closeJob(job, 'idle');
      else if (now - job.created > MAX_JOB_SECONDS * 1000) void closeJob(job, 'too old');
    }
  }, 15000);
  const blobSweeper = setInterval(sweepBlobs, 3600_000);

  const launch = async (job: Job, first: boolean): Promise<Slot> => {
    const args = job.gpu ? BROWSER_ARGS : BROWSER_ARGS.filter((a) => !a.startsWith('--use-angle')).concat('--use-angle=swiftshader');
    // No name resolves to anything: the page has no reason to reach past the local server.
    const browser = await puppeteer.launch({ headless: true, args: [...args, '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'], protocolTimeout: 600000 });
    try {
      const origin = new URL(job.url).origin;
      const page0 = await browser.newPage();
      await page0.setRequestInterception(true);
      page0.on('request', (r) => {
        if (r.isInterceptResolutionHandled()) return;
        if (pageRequestAllowed(r.url(), r.method(), origin, code)) {
          if (debug) log.info(`job ${job.id}: ${r.method()} ${r.url().slice(0, 200)}`);
          void r.continue();
        }
        else {
          log.warn(`job ${job.id}: blocked a request from the render page: ${r.method()} ${r.url().slice(0, 200)}`);
          void r.abort('accessdenied');
        }
      });
      const { page, info } = await openPage(browser, job.url, job.video, first ? undefined : job.info, job.format, job.height, page0);
      if (first) job.info = info;
      return { browser, page, chunks: await ChunkRenderer.attach(page) };
    } catch (e) {
      await browser.close().catch(() => {});
      throw e;
    }
  };

  /** A free render page for the job: an idle one, a new one while under the worker count, or the next to free up. */
  const acquire = async (job: Job): Promise<Slot | null> => {
    const idle = job.idle.pop();
    if (idle) return idle;
    if (job.slots.length + job.opening < o.workers) {
      job.opening++;
      try {
        const s = await launch(job, false);
        job.slots.push(s);
        return s;
      } finally {
        job.opening--;
      }
    }
    return new Promise((res) => job.waiters.push(res));
  };
  const release = (job: Job, s: Slot) => {
    const w = job.waiters.shift();
    if (w) w(s);
    else job.idle.push(s);
  };

  const putBlob = async (req: IncomingMessage, sha: string) => {
    const declared = Number(req.headers['content-length'] ?? -1);
    if (declared > maxFile) throw new Refused(413, `file too large (limit ${maxFile} bytes)`);
    const target = join(blobs, sha);
    if (await stat(target).then(() => true, () => false)) {
      req.resume();
      return;
    }
    const part = join(blobs, `${sha}.${randomBytes(6).toString('hex')}.part`);
    const h = createHash('sha256');
    let size = 0;
    try {
      await new Promise<void>((res, rej) => {
        const out = createWriteStream(part, { flags: 'wx' });
        req.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxFile) {
            rej(new Refused(413, `file too large (limit ${maxFile} bytes)`));
            req.destroy();
            out.destroy();
            return;
          }
          h.update(c);
        });
        req.on('error', rej);
        req.on('aborted', () => rej(new Error('upload cut off')));
        out.on('error', rej);
        out.on('close', () => res());
        req.pipe(out);
      });
      if (h.digest('hex') !== sha) throw new Refused(400, 'content does not match its hash');
      await rename(part, target);
    } finally {
      await rm(part, { force: true }).catch(() => {});
    }
  };

  let creating = 0;
  const createJob = async (body: any): Promise<Job> => {
    if (jobs.size + creating >= maxJobs) throw new Refused(503, 'busy: too many jobs');
    creating++;
    try {
      return await makeJob(body);
    } finally {
      creating--;
    }
  };
  const makeJob = async (body: any): Promise<Job> => {
    if (!body || typeof body !== 'object') throw new Refused(400, 'expected a job');
    const v = validateVideo(body.spec);
    if (!v.ok) throw new Refused(400, `invalid spec: ${v.errors.slice(0, 3).join('; ')}`);
    const s = body.settings ?? {};
    const settings: ChunkSettings = {
      fps: Number(s.fps),
      imageFormat: s.imageFormat === 'png' ? 'png' : 'jpeg',
      jpegQ: Number(s.jpegQ),
      crf: Number(s.crf),
      preset: String(s.preset),
      encoder: s.encoder === null || s.encoder === undefined ? null : String(s.encoder),
      motionBlur: s.motionBlur === true,
    };
    if (!(settings.fps > 0 && settings.fps <= 240) || !(settings.jpegQ > 0 && settings.jpegQ <= 1) || !Number.isInteger(settings.crf) || settings.crf < 0 || settings.crf > 51 || !PRESETS.includes(settings.preset)) {
      throw new Refused(400, 'invalid encoder settings');
    }
    if (settings.encoder !== null && settings.encoder !== encoder) throw new Refused(400, `this worker has no ${settings.encoder} encoder${encoder ? ` (it has ${encoder})` : ''}`);
    const format = body.format === undefined || body.format === null ? undefined : String(body.format);
    if (format !== undefined && !formatNames().includes(format)) throw new Refused(400, 'unknown format');
    const height = body.height === undefined || body.height === null ? undefined : Number(body.height);
    if (height !== undefined && !(Number.isInteger(height) && height >= 64 && height <= 4320)) throw new Refused(400, 'invalid height');
    const files = body.files ?? {};
    if (typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length > MAX_FILES) throw new Refused(400, 'invalid file list');
    const entries: [string, string][] = [];
    for (const [p, sha] of Object.entries(files)) {
      const rel = safeRelPath(p);
      if (!rel || rel !== p || rel.split('/')[0].toLowerCase().startsWith('.bemotion-job')) throw new Refused(400, `unsafe path in bundle: ${JSON.stringify(String(p).slice(0, 200))}`);
      if (typeof sha !== 'string' || !SHA.test(sha)) throw new Refused(400, `invalid hash for ${rel}`);
      if (!(await stat(join(blobs, sha)).then((st) => st.isFile(), () => false))) throw new Refused(409, `missing file ${rel}: upload it first`);
      entries.push([rel, sha]);
    }

    const dir = await mkdtemp(join(realJobs, 'job-'));
    const realDir = await realpath(dir);
    if (!realDir.startsWith(realJobs + sep)) throw new Refused(500, 'job folder outside the worker folder');
    const id = dir.slice(dir.lastIndexOf('job-') + 4);
    try {
      for (const [rel, sha] of entries) {
        const target = resolve(realDir, ...rel.split('/'));
        if (!target.startsWith(realDir + sep)) throw new Refused(400, `unsafe path in bundle: ${rel}`);
        await mkdir(dirname(target), { recursive: true });
        // Every folder on the way was made here, but check where it really is before writing.
        const parent = await realpath(dirname(target));
        if (parent !== realDir && !parent.startsWith(realDir + sep)) throw new Refused(400, `unsafe path in bundle: ${rel}`);
        const blob = join(blobs, sha);
        try {
          await link(blob, target);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Refused(400, `duplicate path in bundle: ${rel}`);
          await copyFile(blob, target, fsc.COPYFILE_EXCL);
        }
        const now = new Date();
        await utimes(blob, now, now).catch(() => {});
      }
      const specPath = join(realDir, SPEC_NAME);
      await writeFile(specPath, JSON.stringify(body.spec), { flag: 'wx' });
      const { server, url } = await startServer(specPath, { hmr: false, offline: true });
      const job: Job = {
        id, dir: realDir, video: body.spec, settings, format, height, gpu: body.gpu !== false,
        info: { width: 0, height: 0, fps: 0, duration: 0, frameCount: 0 },
        server, url, slots: [], idle: [], opening: 0, waiters: [], active: 0,
        lastUsed: Date.now(), created: Date.now(), closed: false, frames: 0,
      };
      jobs.set(id, job);
      try {
        job.active++;
        const first = await launch(job, true);
        job.slots.push(first);
        job.idle.push(first);
      } catch (e) {
        await closeJob(job, 'failed to load');
        throw new Refused(400, `could not load the spec: ${(e as Error).message.slice(0, 500)}`);
      } finally {
        job.active--;
        job.lastUsed = Date.now();
      }
      if (job.info.fps !== settings.fps) {
        await closeJob(job, 'frame rate mismatch');
        throw new Refused(400, 'frame rate does not match the spec');
      }
      log.info(`job ${id}: ${entries.length} files, ${job.info.width}x${job.info.height}, ${job.info.frameCount} frames`);
      return job;
    } catch (e) {
      if (!jobs.has(id)) await rm(realDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
      throw e;
    }
  };

  const renderChunk = async (job: Job, body: any, res: ServerResponse, req: IncomingMessage) => {
    const a = Number(body?.from);
    const b = Number(body?.to);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b > job.info.frameCount || b <= a || b - a > 2000) throw new Refused(400, 'invalid frame range');
    job.active++;
    let slot: Slot | null = null;
    const out = join(job.dir, '.bemotion-chunks', `${a}-${b}-${randomBytes(4).toString('hex')}.mp4`);
    try {
      slot = await acquire(job);
      if (!slot || job.closed) throw new Refused(410, 'job closed');
      await mkdir(dirname(out), { recursive: true });
      log.info(`job ${job.id}: frames ${a}-${b - 1}`);
      try {
        await slot.chunks.render(a, b, out, job.settings);
      } catch (e) {
        // A page that failed mid-chunk is not trusted with the next one: replace it.
        const broken = slot;
        slot = null;
        job.slots = job.slots.filter((x) => x !== broken);
        await broken.browser.close().catch(() => {});
        const w = job.waiters.shift();
        if (w) acquire(job).then(w, () => w(null));
        throw e;
      }
      job.frames += b - a;
      const st = await stat(out);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', String(st.size));
      res.setHeader('X-Bemotion-Frames', String(b - a));
      await new Promise<void>((done, fail) => {
        const s = createReadStream(out);
        s.on('error', fail);
        res.on('close', () => done());
        req.on('close', () => s.destroy());
        s.pipe(res);
      });
    } finally {
      if (slot) {
        if (job.closed) await slot.browser.close().catch(() => {});
        else release(job, slot);
      }
      job.active--;
      job.lastUsed = Date.now();
      await rm(out, { force: true }).catch(() => {});
    }
  };

  const server = createServer(async (req, res) => {
    try {
      // Browsers send an Origin; the coordinator does not. No web page gets to talk to a worker.
      if (req.headers.origin) throw new Refused(403, 'forbidden');
      if (!authorized(req)) {
        log.warn(`refused a request without a valid token from ${req.socket.remoteAddress}`);
        throw new Refused(401, 'invalid token');
      }
      const path = (req.url ?? '').split('?')[0];
      const m = /^\/v1\/(?:blobs\/([0-9a-f]{64})|jobs\/([A-Za-z0-9]{1,32})(\/chunk)?)$/.exec(path);
      if (req.method === 'GET' && path === '/v1/info') {
        return sendJson(res, 200, { name: 'bemotion-worker', ...build, workers: o.workers, encoder, jobs: jobs.size, maxJobs });
      }
      if (req.method === 'POST' && path === '/v1/blobs/missing') {
        const body = await readJson(req, 1_000_000);
        const hashes = Array.isArray(body?.hashes) ? body.hashes : null;
        if (!hashes || hashes.length > MAX_FILES || !hashes.every((h: unknown) => typeof h === 'string' && SHA.test(h))) throw new Refused(400, 'expected { hashes: [sha256...] }');
        const missing: string[] = [];
        for (const h of hashes as string[]) if (!(await stat(join(blobs, h)).then(() => true, () => false))) missing.push(h);
        return sendJson(res, 200, { missing });
      }
      if (req.method === 'PUT' && m?.[1]) {
        await putBlob(req, m[1]);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/v1/jobs') {
        const job = await createJob(await readJson(req));
        return sendJson(res, 200, { id: job.id, info: job.info });
      }
      if (m?.[2]) {
        const job = jobs.get(m[2]);
        if (!job) throw new Refused(404, 'no such job');
        if (req.method === 'POST' && m[3]) return await renderChunk(job, await readJson(req, 10_000), res, req);
        if (req.method === 'DELETE' && !m[3]) {
          await closeJob(job, 'finished');
          return sendJson(res, 200, { ok: true });
        }
      }
      throw new Refused(404, 'not found');
    } catch (e) {
      const status = e instanceof Refused ? e.status : 500;
      if (status === 500) log.warn(`request failed: ${(e as Error).message}`);
      sendJson(res, status, { error: (e as Error).message });
      if (status === 413) req.destroy();
    }
  });
  server.requestTimeout = 3600_000;
  server.headersTimeout = 60_000;
  server.maxConnections = 64;
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(o.port, o.host, () => res());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : o.port;
  const host = o.host.includes(':') ? `[${o.host}]` : o.host;
  return {
    url: `http://${host}:${port}`,
    port,
    async close() {
      clearInterval(sweeper);
      clearInterval(blobSweeper);
      await Promise.all([...jobs.values()].map((j) => closeJob(j, 'worker stopped')));
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
      await closed;
    },
  };
}
