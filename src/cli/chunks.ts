import type { Page } from 'puppeteer';
import { startEncoder } from './ffmpeg';

/**
 * How frames become a chunk file. The same settings on every machine give chunks that concatenate
 * without re-encoding (same codec, size, frame rate and parameters).
 */
export interface ChunkSettings {
  fps: number;
  imageFormat: 'png' | 'jpeg';
  jpegQ: number;
  crf: number;
  preset: string;
  /** A hardware H.264 encoder name, or null for x264. */
  encoder: string | null;
  motionBlur: boolean;
}

export interface ChunkTiming {
  render: number;
  copy: number;
  wait: number;
}

type Current = { enc: ReturnType<typeof startEncoder>; ready: Map<number, Buffer>; next: number; writing: Promise<void> };

/**
 * Renders frame ranges of a loaded render page into H.264 chunk files. The page renders frames back
 * to back while its threads encode them; images arrive here, possibly out of order, and go to the
 * current chunk's ffmpeg in order.
 */
export class ChunkRenderer {
  private cur: Current | null = null;

  private constructor(private page: Page, private onFrame: () => void) {}

  static async attach(page: Page, onFrame: () => void = () => {}): Promise<ChunkRenderer> {
    const r = new ChunkRenderer(page, onFrame);
    await page.exposeFunction('bemotionOut', (i: number, data: string) => {
      const c = r.cur;
      if (!c) return;
      c.ready.set(i, Buffer.from(data, 'base64'));
      c.writing = c.writing.then(async () => {
        while (c.ready.has(c.next)) {
          const buf = c.ready.get(c.next)!;
          c.ready.delete(c.next);
          c.next++;
          await c.enc.write(buf);
          r.onFrame();
        }
      });
      return c.writing;
    });
    return r;
  }

  /** Renders frames a..b-1 to `out`. */
  async render(a: number, b: number, out: string, s: ChunkSettings): Promise<ChunkTiming> {
    const cur: Current = {
      enc: startEncoder({ fps: s.fps, input: s.imageFormat, crf: s.crf, preset: s.preset, out, encoder: s.encoder }),
      ready: new Map(),
      next: a,
      writing: Promise.resolve(),
    };
    this.cur = cur;
    try {
      const timing = (await this.page.evaluate(
        (from, to, fmt, q, mb) => (window as any).bemotion.renderRange(from, to, fmt, q, mb, 3),
        a,
        b,
        s.imageFormat,
        s.jpegQ,
        s.motionBlur,
      )) as ChunkTiming;
      await cur.writing;
      if (cur.next !== b) throw new Error(`frames ${cur.next}-${b - 1} never arrived from the renderer`);
      cur.enc.proc.stdin.end();
      await cur.enc.done;
      return timing;
    } catch (e) {
      cur.enc.proc.kill();
      throw e;
    } finally {
      this.cur = null;
    }
  }
}
