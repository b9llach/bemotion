import { createServer, type ViteDevServer, type Plugin } from 'vite';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream, watch } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { SpecEditor, parseOps } from './edits';
import { sendFile, videoProxy } from './video-proxy';
import { videoFocus } from './video-focus';
import { trackBeatsCached } from './beats';
import { confinedFile, envelopeCached } from './envelope';
import { alignVoiceCached, prepareVoiceWords } from './voice';
import { Director, type DirectorOptions } from './director';
import { log } from './log';

const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];
const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v', '.mkv'];

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.json': 'application/json',
  '.glsl': 'text/plain; charset=utf-8',
};

export async function readSpec(specPath: string): Promise<unknown> {
  const raw = await readFile(specPath, 'utf8');
  let spec: unknown;
  try {
    spec = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${specPath} is not valid JSON: ${(e as Error).message}`);
  }
  // Voice tracks with `tts` are spoken from their script before anything plays.
  const { ensureVoices } = await import('./tts');
  await ensureVoices(specPath, spec);
  // Images with "stock:<query>" are downloaded once and kept next to the spec.
  const { ensureStock } = await import('./stock');
  await ensureStock(specPath, spec);
  // Images with `depth` and no map get one estimated (and cached) before anything renders.
  const { ensureDepthMaps } = await import('./depth');
  await ensureDepthMaps(specPath, spec);
  // The voice's words (transcribed or aligned) are ready before the engine asks for them.
  await prepareVoiceWords(specPath, spec);
  return spec;
}

/** Files under `dir` (three levels deep, at most 200) with one of the extensions, as relative paths. */
async function listFiles(dir: string, exts: string[]): Promise<string[]> {
  const out: string[] = [];
  const visit = async (sub: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(join(dir, sub), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= 200) return;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory() && depth < 3) await visit(rel, depth + 1);
      else if (e.isFile() && exts.includes(extname(e.name).toLowerCase())) out.push(rel);
    }
  };
  await visit('', 0);
  return out.sort();
}

/** Serves the current spec at /__bemotion/spec and files next to it at /__bemotion/assets/. */
function specPlugin(specPath: string, directorOpts: DirectorOptions = {}, offline = false): Plugin {
  const dir = dirname(specPath);
  return {
    name: 'bemotion-spec',
    configureServer(server) {
      const editor = new SpecEditor(specPath);
      // Auto director: turns new comments into a revision after a quiet period. Its status goes to
      // the preview over the HMR socket; its revision lands in the editor's undo history.
      const director = new Director(specPath, {
        ...directorOpts,
        record: (before) => editor.record(before),
        onStatus: (s) => server.ws.send({ type: 'custom', event: 'bemotion:director', data: s }),
      });
      server.httpServer?.on('close', () => director.close());
      const readBody = (req: import('node:http').IncomingMessage) =>
        new Promise<string>((resolve, reject) => {
          let body = '';
          req.on('data', (c) => {
            body += c;
            // Edits are small; refuse anything that is clearly not an editor request.
            if (body.length > 2_000_000) req.destroy(new Error('Request too large'));
          });
          req.on('end', () => resolve(body));
          req.on('error', reject);
        });
      server.middlewares.use(async (req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0]);
        if (req.method === 'POST' && (url === '/__bemotion/edit' || url === '/__bemotion/undo' || url === '/__bemotion/redo')) {
          // Writes from the visual editor; the file watcher then pushes the change back to the preview.
          // Only accept same-origin JSON requests so other websites cannot rewrite the spec. A JSON
          // content type forces a CORS preflight, which this server never approves.
          const origin = req.headers.origin;
          const sameOrigin = !origin || (() => {
            try {
              return new URL(origin).host === req.headers.host;
            } catch {
              return false;
            }
          })();
          if (!sameOrigin || !(req.headers['content-type'] ?? '').startsWith('application/json')) {
            res.statusCode = 403;
            res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
            return;
          }
          try {
            let text: string | null;
            if (url === '/__bemotion/edit') text = await editor.apply(parseOps(JSON.parse(await readBody(req))));
            else text = url.endsWith('undo') ? await editor.undo() : await editor.redo();
            // The resulting spec goes back to the preview so it can update without refetching.
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: text !== null, spec: text }));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
          }
          return;
        }
        if (url === '/__bemotion/comments') {
          // Review comments left in the preview, stored next to the spec. Changes only from the
          // preview itself: same origin and a JSON body (which forces a CORS preflight).
          const { readComments, applyComment } = await import('./comments');
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          if (req.method === 'GET') {
            res.end(JSON.stringify(await readComments(specPath)));
            return;
          }
          const origin = req.headers.origin;
          const sameOrigin = !origin || (() => {
            try {
              return new URL(origin).host === req.headers.host;
            } catch {
              return false;
            }
          })();
          if (req.method !== 'POST' || !sameOrigin || !(req.headers['content-type'] ?? '').startsWith('application/json')) {
            res.statusCode = 403;
            res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
            return;
          }
          try {
            const op = JSON.parse(await readBody(req));
            res.end(JSON.stringify(await applyComment(specPath, op)));
            if (op?.op === 'add') director.notify();
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
          }
          return;
        }
        if (url === '/__bemotion/director') {
          // The auto director's status, and the preview's toggle (same origin and a JSON body only).
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          if (req.method === 'GET') {
            res.end(JSON.stringify(director.status()));
            return;
          }
          const origin = req.headers.origin;
          const sameOrigin = !origin || (() => {
            try {
              return new URL(origin).host === req.headers.host;
            } catch {
              return false;
            }
          })();
          if (req.method !== 'POST' || !sameOrigin || !(req.headers['content-type'] ?? '').startsWith('application/json')) {
            res.statusCode = 403;
            res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
            return;
          }
          try {
            const body = JSON.parse(await readBody(req)) as { enabled?: unknown };
            if (typeof body.enabled !== 'boolean') throw new Error('Expected { enabled: true | false }');
            await director.setEnabled(body.enabled);
            res.end(JSON.stringify(director.status()));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
          }
          return;
        }
        if (url === '/__bemotion/upload' && req.method === 'POST') {
          // Audio dropped onto the preview: saved into audio/ next to the spec. The custom header
          // forces a CORS preflight (never approved), so only the preview page itself can upload.
          const origin = req.headers.origin;
          const sameOrigin = !origin || (() => {
            try {
              return new URL(origin).host === req.headers.host;
            } catch {
              return false;
            }
          })();
          const raw = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
          const ext = extname(raw).toLowerCase();
          const isVideo = VIDEO_EXTS.includes(ext);
          if (!sameOrigin || req.headers['x-bemotion'] !== '1' || !(AUDIO_EXTS.includes(ext) || isVideo)) {
            res.statusCode = 403;
            res.end(JSON.stringify({ ok: false, error: `Only audio (${AUDIO_EXTS.join(', ')}) or video (${VIDEO_EXTS.join(', ')}) files can be added` }));
            return;
          }
          // Audio goes to audio/, clips to media/.
          const folder = isVideo ? 'media' : 'audio';
          try {
            const stem = basename(raw, extname(raw)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'track';
            await mkdir(join(dir, folder), { recursive: true });
            let name = `${stem}${ext}`;
            for (let i = 2; await stat(join(dir, folder, name)).then(() => true, () => false); i++) name = `${stem}-${i}${ext}`;
            const file = join(dir, folder, name);
            let size = 0;
            await new Promise<void>((resolve, reject) => {
              const out = createWriteStream(file);
              req.on('data', (c: Buffer) => {
                size += c.length;
                if (size > 300_000_000) req.destroy(new Error('File too large (300 MB max)'));
              });
              req.on('error', reject);
              out.on('error', reject);
              out.on('finish', resolve);
              req.pipe(out);
            });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, src: `${folder}/${name}` }));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
          }
          return;
        }
        if (url === '/__bemotion/files' && req.method === 'GET') {
          // Asset picker for the editor's Add menu: files next to the spec, by kind.
          const kind = new URL(req.url ?? '', 'http://x').searchParams.get('kind');
          const exts = kind === 'model' ? ['.glb', '.gltf'] : kind === 'video' ? ['.mp4', '.webm', '.mov', '.m4v', '.mkv'] : ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(await listFiles(dir, exts)));
          return;
        }
        if (url === '/__bemotion/spec') {
          try {
            const raw = await readFile(specPath, 'utf8');
            try {
              const { ensureVoices } = await import('./tts');
              await ensureVoices(specPath, JSON.parse(raw), { paid: false });
            } catch (e) {
              // A broken spec is reported by the page; a failed voice is logged and the old file kept.
              if (!(e instanceof SyntaxError)) log.warn(String((e as Error).message ?? e));
            }
            try {
              const { ensureStock } = await import('./stock');
              await ensureStock(specPath, JSON.parse(raw));
            } catch (e) {
              if (!(e instanceof SyntaxError)) log.warn(String((e as Error).message ?? e));
            }
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(raw);
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
          }
          return;
        }
        if (url === '/__bemotion/stock' && req.method === 'GET') {
          // An image with "src": "stock:<query>": the photo kept for that query next to the spec.
          const { resolveStock, stockQuery } = await import('./stock');
          const q = stockQuery(`stock:${new URL(req.url ?? '', 'http://x').searchParams.get('q') ?? ''}`);
          try {
            if (!q) throw new Error('Expected ?q=<query>');
            const file = await resolveStock(specPath, q);
            await sendFile(req, res, file, MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
          } catch (e) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end((e as Error).message);
          }
          return;
        }
        const icon = /^\/__bemotion\/icon\/([^/]+)\.svg$/.exec(url);
        if (icon && req.method === 'GET') {
          // Lucide icons by name, read from the installed package (never from the network).
          const { lucideIcon, searchIcons } = await import('./icons');
          const svg = await lucideIcon(icon[1]);
          if (svg === null) {
            const near = (await searchIcons(icon[1].replace(/-/g, ' '), 8)).map((h) => h.name);
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end(near.length ? `Close matches: ${near.join(', ')}. Search with bemotion icons <words>.` : 'Search with bemotion icons <words>.');
            return;
          }
          res.setHeader('Content-Type', 'image/svg+xml');
          res.setHeader('Cache-Control', 'max-age=3600');
          res.end(svg);
          return;
        }
        if (url === '/__bemotion/depth' && req.method === 'GET') {
          // An estimated depth map for an image next to the spec (made once, then cached).
          try {
            const { depthMapCached, imageInside } = await import('./depth');
            const image = await imageInside(dir, new URL(req.url ?? '', 'http://x').searchParams.get('src') ?? '');
            await sendFile(req, res, await depthMapCached(image, dir), 'image/png');
          } catch (e) {
            res.statusCode = 404;
            res.end(String((e as Error).message));
          }
          return;
        }
        const hdri = /^\/__bemotion\/hdri\/([a-z0-9_]+)_(1k|2k|4k)\.hdr$/.exec(url);
        if (hdri) {
          try {
            const { resolveHdri } = await import('./hdri');
            // Render workers only use environments sent with the job; they never download.
            const file = offline ? join(dir, '.bemotion-hdri', `${hdri[1]}_${hdri[2]}.hdr`) : await resolveHdri(hdri[1], hdri[2] as '1k' | '2k' | '4k');
            const st = await stat(file);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', String(st.size));
            createReadStream(file).pipe(res);
          } catch (e) {
            res.statusCode = 404;
            res.end(String((e as Error).message));
          }
          return;
        }
        if (url === '/__bemotion/video' && req.method === 'GET') {
          // A seek-friendly copy of a clip next to the spec (built on first request, then cached).
          const q = new URL(req.url ?? '', 'http://x').searchParams;
          const file = resolve(dir, q.get('src') ?? '');
          const fps = Math.min(120, Math.max(1, Number(q.get('fps')) || 30));
          if (!file.startsWith(dir + sep)) {
            res.statusCode = 403;
            res.end('Forbidden');
            return;
          }
          try {
            await sendFile(req, res, await videoProxy(file, dir, fps), 'video/mp4');
          } catch (e) {
            res.statusCode = 404;
            res.end(`Could not prepare video: ${(e as Error).message}`);
          }
          return;
        }
        if (url === '/__bemotion/voice' && req.method === 'POST') {
          // When each word of a voiceover is said: transcribed, or aligned to its script (once, then cached).
          try {
            const body = JSON.parse(await readBody(req)) as { src?: string; script?: string };
            const file = resolve(dir, body.src ?? '');
            if (!file.startsWith(dir + sep) || (body.script !== undefined && typeof body.script !== 'string')) {
              res.statusCode = 400;
              res.end('Expected { src, script? } for a file next to the spec');
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(await alignVoiceCached(file, body.script, dir)));
          } catch (e) {
            res.statusCode = 404;
            res.end(`Could not align the voiceover: ${(e as Error).message}`);
          }
          return;
        }
        if (url === '/__bemotion/beats' && req.method === 'GET') {
          // Beats of a music track, for audio entries with "sync" (analyzed once, then cached).
          const file = resolve(dir, new URL(req.url ?? '', 'http://x').searchParams.get('src') ?? '');
          if (!file.startsWith(dir + sep)) {
            res.statusCode = 403;
            res.end('Forbidden');
            return;
          }
          try {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(await trackBeatsCached(file, dir)));
          } catch (e) {
            res.statusCode = 404;
            res.end(`Could not analyze audio: ${(e as Error).message}`);
          }
          return;
        }
        if (url === '/__bemotion/envelope' && req.method === 'GET') {
          // Loudness envelopes of a music track, for layers with "react" (analyzed once, then cached).
          const file = await confinedFile(dir, resolve(dir, new URL(req.url ?? '', 'http://x').searchParams.get('src') ?? ''));
          if (!file) {
            res.statusCode = 403;
            res.end('Forbidden');
            return;
          }
          try {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(await envelopeCached(file, dir)));
          } catch (e) {
            res.statusCode = 404;
            res.end(`Could not analyze audio: ${(e as Error).message}`);
          }
          return;
        }
        if (url === '/__bemotion/video-focus' && req.method === 'GET') {
          // Where things happen in a screen recording, for "focus": "auto" (analyzed once, then cached).
          const file = resolve(dir, new URL(req.url ?? '', 'http://x').searchParams.get('src') ?? '');
          if (!file.startsWith(dir + sep)) {
            res.statusCode = 403;
            res.end('Forbidden');
            return;
          }
          try {
            const moves = await videoFocus(file, dir);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(moves));
          } catch (e) {
            res.statusCode = 404;
            res.end(`Could not analyze video: ${(e as Error).message}`);
          }
          return;
        }
        if (url.startsWith('/__bemotion/assets/')) {
          const file = resolve(dir, url.slice('/__bemotion/assets/'.length));
          if (!file.startsWith(dir + sep) && file !== dir) {
            res.statusCode = 403;
            res.end('Forbidden');
            return;
          }
          try {
            await sendFile(req, res, file, MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
          } catch {
            res.statusCode = 404;
            res.end('Not found');
          }
          return;
        }
        next();
      });
      // Push spec changes to the preview without a full page reload.
      let timer: NodeJS.Timeout | null = null;
      const specName = basename(specPath);
      let assetChanged = false;
      const watcher = watch(dir, { recursive: false }, (_ev, name) => {
        // Uploaded audio lands in audio/; the spec edit that adds it is what the preview needs.
        if (!name || String(name).endsWith('.tmp') || String(name).endsWith('.comments.json') || ['audio', 'media', '.bemotion-cache'].includes(String(name))) return;
        // The spec updates in place; any other file (an image, a model) needs a full rebuild.
        if (String(name) !== specName) assetChanged = true;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          server.ws.send({ type: 'custom', event: 'bemotion:spec-changed', data: { asset: assetChanged } });
          assetChanged = false;
        }, 80);
      });
      server.httpServer?.on('close', () => watcher.close());
    },
  };
}

/**
 * Servers kept open for reuse inside `withSharedServers`, one per spec file. Each Vite server that has
 * served the page keeps its module graph in memory after it closes (held by the bundler's native
 * handles, about 20 MB a server), so a long run that checks and renders the same spec many times
 * (generate, bench) would grow by that much per load. Reusing the server pays it once per spec.
 */
const sharedServers = new AsyncLocalStorage<Map<string, Promise<{ server: ViteDevServer; url: string }>>>();

/** Runs `fn` with headless page servers shared per spec file; they close when it returns. */
export async function withSharedServers<T>(fn: () => Promise<T>): Promise<T> {
  if (sharedServers.getStore()) return fn();
  const map = new Map<string, Promise<{ server: ViteDevServer; url: string }>>();
  try {
    return await sharedServers.run(map, fn);
  } finally {
    for (const p of map.values()) {
      const s = await p.catch(() => null);
      await s?.server.close().catch(() => {});
    }
  }
}

export async function startServer(specPath: string, opts: { port?: number; hmr?: boolean; director?: DirectorOptions; offline?: boolean } = {}): Promise<{ server: ViteDevServer; url: string }> {
  const map = sharedServers.getStore();
  // Only plain headless servers are shared (the spec is read from disk on every request).
  if (map && opts.hmr === false && opts.port === undefined && !opts.director && !opts.offline) {
    const key = resolve(specPath);
    let p = map.get(key);
    if (!p) {
      p = createSpecServer(key, opts);
      map.set(key, p);
      p.catch(() => map.delete(key));
    }
    const { server, url } = await p;
    // Callers close the server when done; a shared one stays open until the scope ends.
    const kept = new Proxy(server, { get: (t, k) => (k === 'close' ? async () => {} : Reflect.get(t, k)) });
    return { server: kept, url };
  }
  return createSpecServer(specPath, opts);
}

async function createSpecServer(specPath: string, opts: { port?: number; hmr?: boolean; director?: DirectorOptions; offline?: boolean }): Promise<{ server: ViteDevServer; url: string }> {
  const server = await createServer({
    configFile: join(PKG_ROOT, 'vite.config.ts'),
    logLevel: 'warn',
    server: { port: opts.port ?? 0, strictPort: false, hmr: opts.hmr ?? true, host: '127.0.0.1', forwardConsole: false },
    plugins: [specPlugin(resolve(specPath), opts.director, opts.offline)],
    optimizeDeps: { include: ['three', 'troika-three-text', 'zod'] },
  });
  await server.listen();
  const addr = server.httpServer?.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  return { server, url: `http://127.0.0.1:${port}` };
}
