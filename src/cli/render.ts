import puppeteer, { type Browser, type Page } from 'puppeteer';
import { mkdtemp, rm, rename, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { dirname, join, resolve, extname } from 'node:path';
import { readSpec, startServer } from './server';
import { concatChunks, muxAudio, type AudioTrack, gpuEncoder } from './ffmpeg';
import { ChunkRenderer, type ChunkSettings } from './chunks';
import { ChunkQueue, connectRemotes, printThroughput, runRemote, type HostStats, type RemoteRun } from './distribute';
import { collectBundle } from './bundle';
import { validateVideo, type Video } from '../spec/schema';
import { toSeconds } from '../spec/time';
import { log } from './log';
import { renderSfx, type Cue } from './sfx';
import type { ClipSound } from '../engine/engine';
import { sfxSeed } from '../audio/sfx';
import { renderScore } from '../audio/music';
import type { ScorePlan } from '../spec/score';
import { writeWav } from './wav';
import { finalCodec, runFfmpeg, toGif } from './ffmpeg';
import { hasTransparentBackground, outputKind, transparentSpec } from './alpha';

export interface RenderOptions {
  out: string;
  concurrency?: number;
  quality?: 'draft' | 'standard' | 'high';
  from?: number;
  to?: number;
  motionBlur?: boolean;
  crf?: number;
  /** H.264 on the CPU (x264, the default) or the GPU (NVIDIA, AMD or Intel encoder, when there is one). */
  encoder?: 'cpu' | 'gpu';
  frames?: string;
  gpu?: boolean;
  /** Extra audio from the command line (paths relative to the working directory). */
  music?: string[];
  musicVolume?: number;
  voice?: string[];
  voiceAt?: number;
  sfx?: boolean;
  /** Render at another aspect ratio: "9:16", "1:1", "4:5". */
  format?: string;
  /** Output height in pixels (1440 renders 2560x1440 from a 1920x1080 design); default the design size. */
  height?: number;
  /** Render workers on other machines ("host:port"), which take chunks alongside the local pages. */
  remote?: string[];
  /** Their token (default: BEMOTION_WORKER_TOKEN). */
  token?: string;
  /** Refuse workers that run another Bemotion version or commit. */
  strict?: boolean;
  /** Seconds a remote chunk may take before it is rendered here instead (default: 60 plus 5 per frame). */
  chunkTimeout?: number;
  /**
   * Transparent output (.webm VP9, .mov ProRes 4444, .gif): background layers dropped and backgrounds
   * cleared to nothing. A spec whose `background` is "transparent" renders with alpha in those anyway.
   */
  alpha?: boolean;
  /** GIF frame rate (default 20) and largest width (default 720). */
  gifFps?: number;
  gifWidth?: number;
}

export interface Info {
  width: number;
  height: number;
  fps: number;
  duration: number;
  frameCount: number;
}

/**
 * For browsers that open other people's websites (brand import, UI capture): defaults only, nothing
 * from the render flags, which are meant for local specs.
 */
export const WEB_BROWSER_ARGS: string[] = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'];

export const BROWSER_ARGS = [
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--enable-webgl',
  '--use-angle=default',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  // Render workers are tabs of one browser: media in background tabs must still load and seek.
  '--disable-background-media-suspend',
  '--autoplay-policy=no-user-gesture-required',
  '--enable-unsafe-swiftshader',
];

export async function openPage(browser: Browser, url: string, spec: unknown, info?: Info, format?: string, height?: number, blank?: Page, alpha?: boolean): Promise<{ page: Page; info: Info }> {
  const page = blank ?? (await browser.newPage());
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (info) await page.setViewport({ width: info.width, height: info.height, deviceScaleFactor: 1 });
  await page.goto(`${url}/render.html`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => (window as any).bemotion?.ready === true, { timeout: 120000 });
  try {
    const loaded = (await page.evaluate(
      (s, base, f, h, a) => (window as any).bemotion.load(s, base, f, h, a),
      spec as any,
      `${url}/__bemotion/assets/`,
      format ?? '',
      height ?? 0,
      !!alpha,
    )) as Info;
    // The page opened at the default size; match the output size before capturing.
    if (!info) await page.setViewport({ width: loaded.width, height: loaded.height, deviceScaleFactor: 1 });
    return { page, info: loaded };
  } catch (e) {
    throw new Error(`${(e as Error).message}${errors.length ? `\nBrowser errors:\n${errors.slice(0, 5).join('\n')}` : ''}`);
  }
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return '--';
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m > 0 ? `${m}m${String(r).padStart(2, '0')}s` : `${r}s`;
}

export async function render(specPath: string, o: RenderOptions): Promise<void> {
  const t0 = Date.now();
  const spec = await readSpec(specPath);
  const v = validateVideo(spec);
  if (!v.ok) throw new Error(`Invalid spec:\n${v.errors.map((e) => `  - ${e}`).join('\n')}`);
  const kind = outputKind(o.out);
  // Transparent output: asked for, or a see-through spec rendered to a format that keeps alpha.
  const alpha = !!o.alpha || (kind !== 'mp4' && hasTransparentBackground(v.video));
  if (alpha && kind === 'mp4') throw new Error('MP4 (H.264) has no alpha channel. Render transparent video to .webm (VP9) or .mov (ProRes 4444).');
  const video = (o.alpha ? transparentSpec(v.video) : v.video) as Video;
  const quality = o.quality ?? 'standard';
  if (o.motionBlur === false || quality === 'draft') video.motionBlur = false;
  if (kind === 'gif') {
    // Film grain changes every pixel on every frame, which GIF compresses worst of all.
    video.post = { ...video.post, grain: 0 };
    for (const s of video.scenes) if (s.post) s.post = { ...s.post, grain: 0 };
  }

  log.step(`Starting render server`);
  const { server, url } = await startServer(specPath, { hmr: false });
  const browser = await puppeteer.launch({
    headless: true,
    args: o.gpu === false ? BROWSER_ARGS.filter((a) => !a.startsWith('--use-angle')).concat('--use-angle=swiftshader') : BROWSER_ARGS,
    protocolTimeout: 600000,
  });
  const tmp = await mkdtemp(join(tmpdir(), 'bemotion-'));
  try {
    log.step('Loading scenes');
    const first = await openPage(browser, url, video, undefined, o.format, o.height, undefined, alpha);
    const info = first.info;
    const gpu = await first.page.evaluate(() => (window as any).bemotion.gpu());
    const engineCues = (await first.page.evaluate(() => (window as any).bemotion.events())) as Cue[];
    const clipSounds = (await first.page.evaluate(() => (window as any).bemotion.clips())) as ClipSound[];
    const scorePlan = (await first.page.evaluate(() => (window as any).bemotion.score())) as ScorePlan | null;
    log.info(`${info.width}x${info.height}${o.format ? ` (${o.format})` : ''} @ ${info.fps}fps, ${info.duration.toFixed(2)}s, ${info.frameCount} frames${kind !== 'mp4' ? `, ${kind.toUpperCase()}${alpha ? ' with alpha' : ''}` : ''}`);
    log.info(`GPU: ${gpu}`);
    if (/swiftshader|llvmpipe|software/i.test(gpu)) log.warn('Rendering on a software GPU. This works but is much slower.');

    let start = 0;
    let end = info.frameCount;
    if (o.frames) {
      const [a, b] = o.frames.split('-').map((n) => parseInt(n, 10));
      start = Math.max(0, a);
      end = Math.min(info.frameCount, (b ?? a) + 1);
    } else {
      if (o.from !== undefined) start = Math.max(0, Math.round(o.from * info.fps));
      if (o.to !== undefined) end = Math.min(info.frameCount, Math.round(o.to * info.fps));
    }
    const total = end - start;
    if (total <= 0) throw new Error('Nothing to render: empty frame range');

    const imageFormat: 'png' | 'jpeg' = quality === 'high' || alpha ? 'png' : 'jpeg';
    const jpegQ = quality === 'draft' ? 0.85 : 0.95;
    const crf = o.crf ?? (quality === 'high' ? 14 : quality === 'draft' ? 23 : 17);
    const preset = quality === 'draft' ? 'veryfast' : 'slow';
    const encoder = o.encoder === 'gpu' ? await gpuEncoder() : null;
    if (o.encoder === 'gpu') log.info(encoder ? `Encoding on the GPU (${encoder})` : 'No GPU encoder found; encoding on the CPU');
    const workers = Math.max(1, Math.min(o.concurrency ?? Math.min(4, Math.max(1, Math.floor(cpus().length / 4))), Math.ceil(total / 15)));
    const motionBlur = video.motionBlur !== false;
    log.info(`Workers: ${workers}, quality: ${quality}, motion blur: ${motionBlur ? 'on' : 'off'}`);
    if (o.remote?.length && (kind !== 'mp4' || alpha)) throw new Error('Rendering on other machines makes MP4 only. Render .gif, .webm, .mov and transparent video on this machine.');
    const remotes = o.remote?.length ? await connectRemotes(o.remote, o.token ?? process.env.BEMOTION_WORKER_TOKEN, !!o.strict) : [];
    const remoteWorkers = remotes.reduce((n, r) => n + r.info.workers, 0);

    // Short chunks handed out as workers free up: heavy stretches (3D, motion blur, many layers) are
    // shared instead of keeping one worker busy while the others wait. Each chunk is its own file.
    const chunkLen = Math.max(15, Math.ceil(total / ((workers + remoteWorkers) * 4)));
    const ranges: [number, number][] = [];
    for (let f = start; f < end; f += chunkLen) ranges.push([f, Math.min(end, f + chunkLen)]);
    let rendered = 0;
    let lastPrint = 0;
    const progress = () => {
      const now = Date.now();
      if (now - lastPrint < 250 && rendered < total) return;
      lastPrint = now;
      const elapsed = (now - t0) / 1000;
      const fpsNow = rendered / Math.max(0.001, elapsed);
      const eta = (total - rendered) / Math.max(0.001, fpsNow);
      log.progress(`Rendering ${rendered}/${total} frames  ${((rendered / total) * 100).toFixed(0)}%  ${fpsNow.toFixed(1)} fps  ETA ${fmtTime(eta)}`);
    };

    // MP4 encodes as frames arrive; other outputs keep the frames as they are and encode at the end.
    const chunkFiles = ranges.map((_, k) => join(tmp, `chunk_${String(k).padStart(4, '0')}.${kind === 'mp4' ? 'mp4' : 'mov'}`));
    const settings: ChunkSettings = { fps: info.fps, imageFormat, jpegQ, crf, preset, encoder, motionBlur, ...(kind !== 'mp4' ? { copy: true } : {}) };
    const queue = new ChunkQueue(ranges.length);
    const localStats: HostStats = { label: 'this machine', workers: Math.min(workers, ranges.length), frames: 0, chunks: 0, failed: 0 };
    const renderStart = Date.now();
    let finished = false;
    // Remote workers get the job while the local pages already render; they join when ready.
    const bundle = remotes.length ? collectBundle(specPath, video) : null;
    bundle?.catch(() => {});
    const remoteRuns: RemoteRun[] = remotes.map((r) =>
      runRemote(r, {
        bundle: bundle!, video, settings, format: o.format, height: o.height, gpu: o.gpu !== false, info, queue, ranges,
        chunkFile: (k) => chunkFiles[k],
        chunkTimeout: (n) => (o.chunkTimeout ?? 60 + 5 * n) * 1000,
        onFrames: (n) => {
          rendered += n;
          progress();
        },
        finished: () => finished,
      }),
    );
    const extra: Browser[] = [];
    await Promise.all(
      Array.from({ length: Math.min(workers, ranges.length) }, async (_, wi) => {
        // Each worker gets its own browser: in a background tab the browser stops loading and
        // seeking video, which stalls any ad with video layers.
        let own: Browser | null = null;
        if (wi > 0) {
          own = await puppeteer.launch({ headless: true, args: BROWSER_ARGS, protocolTimeout: 600000 });
          extra.push(own);
        }
        const { page } = wi === 0 ? first : await openPage(own!, url, video, info, o.format, o.height, undefined, alpha);
        const chunks = await ChunkRenderer.attach(page, () => {
          rendered++;
          progress();
        });
        const totals = { render: 0, copy: 0, wait: 0, frames: 0 };
        for (let k = await queue.takeLocal(); k !== null; k = await queue.takeLocal()) {
          const [a, b] = ranges[k];
          const timing = await chunks.render(a, b, chunkFiles[k], settings);
          for (const key of ['render', 'copy', 'wait'] as const) totals[key] += timing[key] * (b - a);
          totals.frames += b - a;
          localStats.frames += b - a;
          localStats.chunks++;
        }
        if (process.env.BEMOTION_TIMING && totals.frames) {
          log.info(`worker ${wi}: ${totals.frames} frames, ms per frame render ${(totals.render / totals.frames).toFixed(1)}, wait ${(totals.wait / totals.frames).toFixed(1)}`);
        }
        await page.close();
        if (own) await own.close().catch(() => {});
      }),
    ).finally(async () => {
      finished = true;
      await Promise.all(extra.map((b) => b.close().catch(() => {})));
      await Promise.all(remotes.map((r) => r.close()));
      await Promise.all(remoteRuns.map((r) => r.done));
    });
    log.progressDone();
    if (remotes.length) printThroughput([localStats, ...remoteRuns.map((r) => r.stats)], (Date.now() - renderStart) / 1000);

    const out = resolve(o.out);
    await mkdir(dirname(out), { recursive: true });
    const silent = join(tmp, kind === 'mp4' ? 'video.mp4' : 'video.mov');
    if (chunkFiles.length === 1) await rename(chunkFiles[0], silent);
    else await concatChunks(chunkFiles, silent, tmp);

    const tracks = await soundtrack(video, specPath, info, { engineCues, clipSounds, scorePlan }, tmp, start, total, o);
    const shifted = tracks.map((t) => (t.at < 0 ? { ...t, trim: t.trim - t.at, at: 0 } : t));
    if (kind === 'gif') {
      log.step('Encoding GIF');
      if (tracks.length) log.info('GIF has no sound: the soundtrack is left out');
      await toGif(silent, out, { fps: o.gifFps ?? 20, width: o.gifWidth ?? 720, alpha });
    } else if (kind !== 'mp4') {
      const codec = finalCodec(kind, alpha, quality);
      log.step(`Encoding ${kind === 'webm' ? 'VP9 WebM' : alpha ? 'ProRes 4444' : 'ProRes 422 HQ'}${tracks.length ? ' and mixing audio' : ''}`);
      if (tracks.length) await muxAudio(silent, shifted, total / info.fps, out, codec);
      else await runFfmpeg(['-i', silent, ...codec.video, ...(codec.faststart ? ['-movflags', '+faststart'] : []), out]);
    } else if (tracks.length) {
      log.step('Mixing audio');
      await muxAudio(silent, shifted, total / info.fps, out);
    } else {
      await copyFile(silent, out);
    }
    log.success(`Wrote ${out} in ${fmtTime((Date.now() - t0) / 1000)}`);
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The audio tracks of a render from `start` (frame) for `total` frames: the spec's own and the command
 * line's, synthesized sound effects and the generated score (written as WAV files into `tmp`), and the
 * sound of video clips. Adds the generated tracks to `video.audio`.
 */
export async function soundtrack(
  video: Video, specPath: string, info: Info,
  found: { engineCues: Cue[]; clipSounds: ClipSound[]; scorePlan: ScorePlan | null },
  tmp: string, start: number, total: number,
  o: Pick<RenderOptions, 'music' | 'musicVolume' | 'voice' | 'voiceAt' | 'sfx'>,
): Promise<AudioTrack[]> {
  const { engineCues, clipSounds, scorePlan } = found;
  // Tracks passed on the command line join the spec's own.
  for (const m of o.music ?? []) (video.audio ??= []).push({ src: resolve(m), role: 'music', volume: o.musicVolume });
  for (const vo of o.voice ?? []) (video.audio ??= []).push({ src: resolve(vo), role: 'voice', at: o.voiceAt });
  if (o.sfx === false) video.sfx = false;
  const hasMusic = !!video.score || (video.audio ?? []).some((a) => (a.role ?? 'music') === 'music');
  const sfxCfg = video.sfx === false ? null : typeof video.sfx === 'object' ? video.sfx : {};
  if (sfxCfg) {
    const muted = new Set(sfxCfg.mute ?? []);
    // engineCues include the spec's own `sounds`, already on the output timeline.
    const t0s = start / info.fps;
    const cues = [...engineCues]
      .filter((c) => !muted.has(c.kind))
      .map((c) => ({ ...c, t: c.t - t0s }))
      .sort((a, b) => a.t - b.t);
    if (cues.length) {
      const sfxFile = join(tmp, 'sfx.wav');
      // Under music, effects sit back as accents instead of carrying the soundtrack.
      // Seeded from the title so every video gets its own variations and musical key.
      const name = video.title ?? 'video';
      const seed = sfxCfg.seed ?? sfxSeed(name);
      const used = await renderSfx(cues, total / info.fps, sfxFile, sfxCfg.volume ?? (hasMusic ? 0.45 : 0.9), {
        kit: sfxCfg.kit,
        seed,
        reverb: sfxCfg.reverb,
      });
      log.info(`Sound design: ${used} cues`);
      // Cues are already relative to the render start; place the track there.
      (video.audio ??= []).push({ src: sfxFile, at: t0s, role: 'sfx' });
    }
  }
  if (video.score) {
    if (scorePlan) {
      const plan = scorePlan;
      const scoreFile = join(tmp, 'score.wav');
      const audio = renderScore(video.score, plan, video.score.seed ?? sfxSeed(video.title ?? 'video'));
      await writeWav(scoreFile, audio, plan.duration);
      log.info(`Score: ${plan.sections.length} sections at ${plan.bpm} bpm`);
      // The score is written to the whole video, so it plays once from the start with its own ending.
      (video.audio ??= []).push({ src: scoreFile, role: 'music', at: 0, volume: 1, fadeOut: 0, loop: false });
    }
  }
  const tracks: AudioTrack[] = (video.audio ?? []).map((a) => {
    const tctx = { fps: info.fps, bpm: video.bpm };
    const role = a.role ?? 'music';
    return {
      file: resolve(dirname(specPath), a.src),
      role,
      at: toSeconds(a.at, tctx, 0) - start / info.fps,
      volume: a.volume ?? (role === 'music' ? 0.8 : 1),
      trim: toSeconds(a.trim, tctx, 0),
      fadeIn: toSeconds(a.fadeIn, tctx, 0),
      // Music fades out with the picture unless told otherwise.
      fadeOut: toSeconds(a.fadeOut, tctx, role === 'music' ? 1.5 : 0),
      loop: a.loop ?? role === 'music',
      duck: a.duck ?? true,
    };
  });
  // Sound from video layers, cut to the time each clip is on screen.
  for (const c of clipSounds) {
    tracks.push({
      file: resolve(dirname(specPath), c.src),
      role: 'sfx',
      at: c.at - start / info.fps,
      volume: c.volume,
      trim: c.trim,
      fadeIn: 0.02,
      fadeOut: 0.05,
      loop: c.repeat,
      duck: false,
      length: c.length,
      speed: c.speed,
    });
  }
  return tracks;
}

/** Renders single frames to PNG files. Used for thumbnails and visual checks. */
/**
 * A moment to capture: output seconds (`12.4`), a scene's own time as written in the spec
 * (`ricki@3.5`, `2@1.2` for the third scene), or a scene name alone for its middle.
 */
export type StillTime = number | string;

const NUMBER = /^-?\d+(\.\d+)?$/;
const AT = /^(.*)@(-?\d+(?:\.\d+)?)$/;

/** Label for file names and the sheet: `12.40` or `ricki@3.50`. */
function stillLabel(t: StillTime): string {
  if (typeof t === 'number' || NUMBER.test(t)) return Number(t).toFixed(2);
  const m = AT.exec(t);
  return m ? `${m[1]}@${Number(m[2]).toFixed(2)}` : t;
}

/**
 * Renders still frames to PNG. With `sheet`, also writes a labelled contact sheet of all of them
 * (`cols` across) to that path, and returns it last.
 */
export async function still(
  specPath: string, times: StillTime[], outPattern: string,
  opts: { motionBlur?: boolean; format?: string; height?: number; sheet?: string; cols?: number; alpha?: boolean } = {},
): Promise<string[]> {
  const spec = await readSpec(specPath);
  const v = validateVideo(spec);
  if (!v.ok) throw new Error(`Invalid spec:\n${v.errors.map((e) => `  - ${e}`).join('\n')}`);
  // Transparent stills: --alpha, or a spec whose background is "transparent".
  const alpha = !!opts.alpha || hasTransparentBackground(v.video);
  const stillSpec = opts.alpha ? transparentSpec(v.video) : v.video;
  const { server, url } = await startServer(specPath, { hmr: false });
  const browser = await puppeteer.launch({ headless: true, args: BROWSER_ARGS, protocolTimeout: 600000 });
  const files: string[] = [];
  try {
    const { page, info } = await openPage(browser, url, stillSpec, undefined, opts.format, opts.height, undefined, alpha);
    const shots: string[] = [];
    const labels: string[] = [];
    for (const time of times) {
      let t: number;
      if (typeof time === 'number' || NUMBER.test(time)) t = Number(time);
      else {
        const m = AT.exec(time);
        const scene = m ? m[1] : time;
        const at = (await page.evaluate((sc, tt) => (window as any).bemotion.when(sc, tt), scene, m ? Number(m[2]) : null)) as number | null;
        if (at === null) throw new Error(`No scene "${scene}" (give a scene id or index)`);
        t = at;
      }
      const label = stillLabel(time);
      const frame = Math.min(info.frameCount - 1, Math.max(0, Math.round(t * info.fps)));
      const dataUrl = (await page.evaluate((i, mb) => (window as any).bemotion.frame(i, 'png', 1, mb), frame, opts.motionBlur ?? false)) as string;
      const name = label.replace(/[^\w.@-]+/g, '_');
      const file = resolve(outPattern.includes('{t}') ? outPattern.replace('{t}', name) : times.length > 1 ? outPattern.replace(extname(outPattern), `_${name}${extname(outPattern) || '.png'}`) : outPattern);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
      files.push(file);
      shots.push(dataUrl);
      // Scene times also show where they land in the video.
      labels.push(label === stillLabel(t) ? label : `${label}  (${t.toFixed(2)}s)`);
    }
    if (opts.sheet && shots.length) {
      const cols = opts.cols ?? Math.min(3, shots.length);
      const sheet = (await page.evaluate((im, lb, c) => (window as any).bemotion.sheet(im, lb, c, 1920), shots, labels, cols)) as string;
      const file = resolve(opts.sheet);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, Buffer.from(sheet.slice(sheet.indexOf(',') + 1), 'base64'));
      files.push(file);
    }
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
  return files;
}

/** Captures frames as JPEG buffers (for AI review). Times are global seconds. */
export async function captureFrames(specPath: string, spec: unknown, times: number[], quality = 0.82): Promise<Buffer[]> {
  const { server, url } = await startServer(specPath, { hmr: false });
  const browser = await puppeteer.launch({ headless: true, args: BROWSER_ARGS, protocolTimeout: 600000 });
  try {
    const { page, info } = await openPage(browser, url, spec);
    const out: Buffer[] = [];
    for (const t of times) {
      const frame = Math.min(info.frameCount - 1, Math.max(0, Math.round(t * info.fps)));
      const dataUrl = (await page.evaluate((i, q) => (window as any).bemotion.frame(i, 'jpeg', q, false), frame, quality)) as string;
      out.push(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    }
    return out;
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
