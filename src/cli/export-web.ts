import puppeteer from 'puppeteer';
import { createHash } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PKG_ROOT, readSpec, startServer } from './server';
import { BROWSER_ARGS, openPage, soundtrack } from './render';
import { muxAudio } from './ffmpeg';
import { videoProxy } from './video-proxy';
import { validateVideo, type Video } from '../spec/schema';
import { hasTransparentBackground, transparentSpec } from './alpha';
import type { Cue } from './sfx';
import type { ClipSound, PreparedData } from '../engine/engine';
import type { ScorePlan } from '../spec/score';
import { log } from './log';

export interface WebExportOptions {
  out: string;
  mode: 'loop' | 'play' | 'scroll';
  /** Poster image: true for the last frame, a time in seconds, or false for none. */
  poster: boolean | number;
  /** Render the soundtrack (music, voice, generated score and sound effects) to soundtrack.m4a. */
  sound: boolean;
  /** Transparent background: background layers dropped, the page shows through. */
  alpha: boolean;
  format?: string;
}

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv']);
/** Spec fields that hold words, never file names. */
const TEXT_KEYS = new Set(['text', 'label', 'title', 'script', 'caption', 'subtitle', 'name', 'id', 'url', 'value']);
/** What the exporter writes (and replaces) in its folder. */
const OUTPUTS = ['index.html', 'bemotion-player.js', 'spec.json', 'poster.png', 'soundtrack.m4a', 'player', 'assets'];

/**
 * The embeddable player bundle (src/web/embed.ts with the engine and its fonts), built once per
 * version of the sources and cached in .bemotion-cache/player.
 */
async function buildPlayer(): Promise<string> {
  const h = createHash('sha1');
  const walk = async (dir: string) => {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(ts|glsl|json)$/.test(e.name)) h.update(relative(PKG_ROOT, p)).update(await readFile(p));
    }
  };
  for (const d of ['src/engine', 'src/spec', 'src/audio', 'src/web']) await walk(join(PKG_ROOT, d));
  h.update(await readFile(join(PKG_ROOT, 'package-lock.json')).catch(() => Buffer.from('')));
  const dir = join(PKG_ROOT, '.bemotion-cache', 'player', h.digest('hex').slice(0, 16));
  if (await stat(join(dir, 'bemotion-player.js')).then(() => true, () => false)) return dir;
  log.step('Building the player');
  const { build } = await import('vite');
  const tmp = `${dir}.${process.pid}.tmp`;
  await build({
    configFile: false,
    root: PKG_ROOT,
    // Relative URLs everywhere: the folder works wherever it is served from.
    base: './',
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir: tmp,
      emptyOutDir: true,
      copyPublicDir: false,
      chunkSizeWarningLimit: 4000,
      modulePreload: false,
      rollupOptions: {
        input: join(PKG_ROOT, 'src/web/embed.ts'),
        preserveEntrySignatures: 'exports-only',
        output: {
          entryFileNames: 'bemotion-player.js',
          chunkFileNames: 'player/[name]-[hash].js',
          assetFileNames: 'player/[name]-[hash][extname]',
        },
      },
    },
  });
  await rm(dir, { recursive: true, force: true });
  await cp(tmp, dir, { recursive: true });
  await rm(tmp, { recursive: true, force: true });
  return dir;
}

/** A file the spec names, if it is a real file inside the spec's folder (no links out of it). */
async function localFile(base: string, src: string): Promise<{ file: string; rel: string } | null> {
  if (!/^[^:*?"<>|\n{}]+\.[A-Za-z0-9]{2,5}$/.test(src) || src.startsWith('/') || src.startsWith('\\') || isAbsolute(src)) return null;
  const file = resolve(base, src);
  const inside = (p: string) => {
    const rel = relative(base, p);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  };
  if (!inside(file)) return null;
  const st = await lstat(file).catch(() => null);
  if (!st || st.isSymbolicLink() || !st.isFile()) return null;
  const real = await realpath(file).catch(() => null);
  if (!real || !inside(real)) return null;
  return { file, rel: relative(base, file).split(sep).join('/') };
}

export async function exportWeb(specPath: string, o: WebExportOptions): Promise<{ dir: string; files: number; bytes: number }> {
  const raw = (await readSpec(specPath)) as Record<string, unknown>;
  const v = validateVideo(raw);
  if (!v.ok || !v.video) throw new Error(`Invalid spec:\n${v.errors.map((e) => `  - ${e}`).join('\n')}`);
  const alpha = o.alpha || hasTransparentBackground(raw);
  const source = o.alpha ? transparentSpec(raw) : raw;
  const parsed = (o.alpha ? transparentSpec(v.video) : v.video) as Video;
  const base = await realpath(dirname(resolve(specPath)));
  const fps = parsed.fps ?? 30;

  // The folder: new, empty, or an earlier export (whose files are replaced).
  const dir = resolve(o.out);
  const existing = await readdir(dir).catch(() => null);
  if (existing && existing.length && !existing.includes('bemotion-player.js')) {
    throw new Error(`${dir} is not empty. Export into a new folder or an earlier web export.`);
  }
  if (existing) for (const name of OUTPUTS) await rm(join(dir, name), { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const playerDir = await buildPlayer();
  await cp(playerDir, dir, { recursive: true });

  // Assets: every file the spec names inside its folder is copied into assets/ and the spec points
  // there. Clips go as their seek-friendly copy; audio stays out (the soundtrack is mixed below).
  log.step('Copying assets');
  const out = structuredClone(source) as Record<string, unknown>;
  const copied = new Map<string, string>();
  const copy = async (src: string): Promise<string | null> => {
    const f = await localFile(base, src);
    if (!f) return null;
    const ext = extname(f.rel).toLowerCase();
    if (AUDIO_EXTS.has(ext)) return null;
    let target = `assets/${f.rel}`;
    let from = f.file;
    if (VIDEO_EXTS.has(ext)) {
      from = await videoProxy(f.file, base, fps);
      if (ext !== '.mp4') target = `assets/${f.rel}.mp4`;
    }
    if (!copied.has(target)) {
      await mkdir(dirname(join(dir, target)), { recursive: true });
      await copyFile(from, join(dir, target));
      copied.set(target, f.rel);
    }
    return target;
  };
  const visit = async (node: unknown, key?: string): Promise<unknown> => {
    if (typeof node === 'string') return key && TEXT_KEYS.has(key) ? node : ((await copy(node)) ?? node);
    if (Array.isArray(node)) return Promise.all(node.map((n) => visit(n, key)));
    if (node && typeof node === 'object') {
      const r: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(node)) r[k] = await visit(val, k);
      return r;
    }
    return node;
  };
  const rewritten = (await visit(out)) as Record<string, unknown>;
  // Poly Haven lighting ("hdri:<id>") is served by the CLI; the export carries the file.
  const env = rewritten.environment;
  const hdriSrc = typeof env === 'string' ? env : env && typeof env === 'object' ? (env as { src?: string }).src : undefined;
  if (hdriSrc?.startsWith('hdri:')) {
    const res = (env && typeof env === 'object' ? (env as { res?: string }).res : undefined) ?? '1k';
    const { resolveHdri } = await import('./hdri');
    const file = await resolveHdri(hdriSrc.slice(5), res as '1k' | '2k' | '4k');
    const target = `assets/hdri/${basename(file)}`;
    await mkdir(join(dir, 'assets', 'hdri'), { recursive: true });
    await copyFile(file, join(dir, target));
    rewritten.environment = typeof env === 'string' ? target : { ...(env as object), src: target };
  }
  if (copied.size) log.info(`${copied.size} asset${copied.size === 1 ? '' : 's'}`);

  // Load once in the renderer: the poster, the soundtrack's cues, and the analysis the page reuses.
  log.step('Loading scenes');
  const { server, url } = await startServer(specPath, { hmr: false });
  const browser = await puppeteer.launch({ headless: true, args: BROWSER_ARGS, protocolTimeout: 600000 });
  const tmp = await mkdtemp(join(tmpdir(), 'bemotion-web-'));
  let prepared: PreparedData = {};
  let hasSound = false;
  try {
    // Film grain is left off the poster: it is a still image, and noise makes it several times larger.
    const quiet = { ...source, post: { ...((source.post as object) ?? {}), grain: 0 } };
    const { page, info } = await openPage(browser, url, quiet, undefined, o.format, undefined, alpha);
    log.info(`${info.width}x${info.height} @ ${info.fps}fps, ${info.duration.toFixed(2)}s, mode ${o.mode}${alpha ? ', transparent' : ''}`);
    prepared = (await page.evaluate(() => (window as any).bemotion.prepared())) as PreparedData;
    if (o.poster !== false) {
      const t = o.poster === true ? info.duration : o.poster;
      const frame = Math.min(info.frameCount - 1, Math.max(0, Math.round(t * info.fps)));
      const data = (await page.evaluate((i) => (window as any).bemotion.frame(i, 'png', 1, true), frame)) as string;
      await writeFile(join(dir, 'poster.png'), Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'));
    }
    if (o.sound) {
      const found = {
        engineCues: (await page.evaluate(() => (window as any).bemotion.events())) as Cue[],
        clipSounds: (await page.evaluate(() => (window as any).bemotion.clips())) as ClipSound[],
        scorePlan: (await page.evaluate(() => (window as any).bemotion.score())) as ScorePlan | null,
      };
      const tracks = await soundtrack(structuredClone(parsed), specPath, info, found, tmp, 0, info.frameCount, {});
      if (tracks.length) {
        log.step('Mixing the soundtrack');
        await muxAudio(null, tracks, info.duration, join(dir, 'soundtrack.m4a'), { audio: ['-c:a', 'aac', '-b:a', '192k'] });
        hasSound = true;
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  if (prepared.beats || prepared.words) rewritten.$prepared = prepared;
  await writeFile(join(dir, 'spec.json'), JSON.stringify(rewritten));
  const title = typeof raw.title === 'string' ? raw.title : basename(specPath, extname(specPath));
  await writeFile(join(dir, 'index.html'), demoPage({ title, mode: o.mode, poster: o.poster !== false, sound: hasSound, format: o.format, alpha }));

  let files = 0;
  let bytes = 0;
  const count = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await count(join(d, e.name));
      else {
        files++;
        bytes += (await stat(join(d, e.name))).size;
      }
    }
  };
  await count(dir);
  return { dir, files, bytes };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The page written next to the player: the video in place, and the snippet to copy. */
function demoPage(o: { title: string; mode: string; poster: boolean; sound: boolean; format?: string; alpha: boolean }): string {
  const attrs = [
    'src="spec.json"',
    `mode="${o.mode}"`,
    o.poster ? 'poster="poster.png"' : '',
    o.sound && o.mode !== 'scroll' ? 'sound="soundtrack.m4a"' : '',
    o.format ? `format="${esc(o.format)}"` : '',
    o.mode === 'scroll' ? 'scroll-target="parent"' : '',
  ].filter(Boolean).join(' ');
  const tag = `<bemotion-player ${attrs}></bemotion-player>`;
  const snippet = `<script type="module" src="bemotion-player.js"></script>\n${tag}`;
  const player = o.mode === 'scroll'
    ? `<section class="scroll">\n      <div class="sticky">${tag}</div>\n    </section>`
    : `<section class="hero">${tag}</section>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(o.title)}</title>
    <link rel="icon" href="data:," />
    <script type="module" src="bemotion-player.js"></script>
    <style>
      :root { color-scheme: light dark; --bg: #f5f5f7; --ink: #1d1d1f; --muted: #6e6e73; --card: #ffffff; --line: #e3e3e8; }
      @media (prefers-color-scheme: dark) { :root { --bg: #0b0b0e; --ink: #f5f5f7; --muted: #a1a1a6; --card: #16161a; --line: #2a2a30; } }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
      main { max-width: 1120px; margin: 0 auto; padding: 48px 16px 96px; }
      h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em; }
      p { margin: 0 0 24px; color: var(--muted); }
      bemotion-player { border-radius: 14px; overflow: hidden; ${o.alpha ? '' : 'background: #000;'} }
      .hero { margin-bottom: 40px; }
      .scroll { height: 400vh; margin-bottom: 40px; }
      .sticky { position: sticky; top: max(16px, calc(50vh - 28vw)); }
      pre { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; overflow-x: auto; font: 13px/1.6 ui-monospace, "SF Mono", Consolas, monospace; margin: 0; }
      h2 { font-size: 15px; font-weight: 600; margin: 0 0 10px; }
    </style>
  </head>
  <body>
    <main>
      <h1>${esc(o.title)}</h1>
      <p>${o.mode === 'scroll' ? 'Scroll to play.' : o.mode === 'play' ? 'Plays once, then holds the last frame.' : 'Plays in a loop.'} Rendered live in the page by Bemotion.</p>
    ${player}
      <h2>Embed</h2>
      <pre><code>${esc(snippet)}</code></pre>
    </main>
  </body>
</html>
`;
}
