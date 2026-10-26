import puppeteer from 'puppeteer';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { readSpec, startServer } from './server';
import { BROWSER_ARGS, openPage } from './render';
import { validateVideo } from '../spec/schema';
import { hasTransparentBackground, transparentSpec } from './alpha';
import { log } from './log';

export interface LottieOptions {
  out: string;
  /** Frames per second of the Lottie (default 30). */
  fps?: number;
  /** Width in pixels (default 720); the height follows the video's aspect ratio. */
  width?: number;
  /** JPEG quality 0-1 (default 0.8). Ignored with alpha, where frames are PNG. */
  quality?: number;
  /** Transparent frames (PNG): background layers dropped. A "transparent" spec background implies it. */
  alpha?: boolean;
  format?: string;
}

/** Above this the file is slow to load in a page; the exporter says so. */
const LARGE = 8 * 1024 * 1024;

/**
 * An image-based Lottie: every frame rendered by the engine and embedded as an image, shown by one
 * image layer for exactly one frame. It plays in any Lottie player (lottie-web, iOS, Android), but it
 * is not vector: it is as large as a short image sequence, so keep it small and short.
 */
export async function exportLottie(specPath: string, o: LottieOptions): Promise<{ file: string; bytes: number; frames: number }> {
  const spec = await readSpec(specPath);
  const v = validateVideo(spec);
  if (!v.ok) throw new Error(`Invalid spec:\n${v.errors.map((e) => `  - ${e}`).join('\n')}`);
  const alpha = !!o.alpha || hasTransparentBackground(v.video);
  const video = o.alpha ? transparentSpec(v.video) : v.video;
  const fps = Math.min(60, Math.max(1, o.fps ?? 30));
  const width = Math.max(16, Math.round(o.width ?? 720));
  const quality = Math.min(1, Math.max(0.1, o.quality ?? 0.8));
  const { server, url } = await startServer(specPath, { hmr: false });
  const browser = await puppeteer.launch({ headless: true, args: BROWSER_ARGS, protocolTimeout: 600000 });
  try {
    // Ask for the size first, then load at the height that gives `width` pixels across.
    const probe = await openPage(browser, url, video, undefined, o.format, undefined, undefined, alpha);
    const aspect = probe.info.width / probe.info.height;
    // Scaled so the frame is exactly `width` across (the renderer rounds the scaled size per side).
    const height = width / aspect;
    await probe.page.close();
    const { page, info } = await openPage(browser, url, video, undefined, o.format, height, undefined, alpha);
    const w = width;
    const h = Math.max(1, Math.round(width / aspect));
    const frames = Math.max(1, Math.round(info.duration * fps));
    log.info(`${w}x${h} @ ${fps}fps, ${frames} frames, ${alpha ? 'PNG with alpha' : `JPEG q${quality}`}`);
    const assets: Record<string, unknown>[] = [];
    const layers: Record<string, unknown>[] = [];
    for (let i = 0; i < frames; i++) {
      const data = (await page.evaluate((t, f, q) => (window as any).bemotion.frameAt(t, f, q, false), i / fps, alpha ? 'png' : 'jpeg', quality)) as string;
      const id = `f${i}`;
      assets.push({ id, w, h, u: '', p: data, e: 1 });
      // Layers are listed top first; each shows one frame, so the order does not matter.
      layers.push({
        ddd: 0,
        ind: i + 1,
        ty: 2,
        nm: `frame ${i}`,
        refId: id,
        sr: 1,
        ks: {
          o: { a: 0, k: 100 },
          r: { a: 0, k: 0 },
          p: { a: 0, k: [w / 2, h / 2, 0] },
          a: { a: 0, k: [w / 2, h / 2, 0] },
          s: { a: 0, k: [100, 100, 100] },
        },
        ao: 0,
        ip: i,
        op: i + 1,
        st: 0,
        bm: 0,
      });
      log.progress(`Rendering ${i + 1}/${frames} frames`);
    }
    log.progressDone();
    const lottie = {
      v: '5.7.4',
      fr: fps,
      ip: 0,
      op: frames,
      w,
      h,
      nm: v.video?.title ?? basename(specPath, extname(specPath)),
      ddd: 0,
      assets,
      layers,
      markers: [],
    };
    const file = resolve(o.out);
    await mkdir(dirname(file), { recursive: true });
    const text = JSON.stringify(lottie);
    await writeFile(file, text);
    if (text.length > LARGE) {
      log.warn(`The Lottie is ${(text.length / 1048576).toFixed(1)} MB: every frame is an image. Lower --width or --fps, or shorten the video, for pages that load it.`);
    }
    return { file, bytes: text.length, frames };
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
