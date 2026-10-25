import { Engine } from '../engine/engine';
import { sceneIndex } from '../spec/schema';

/** Headless capture API driven by the CLI through Puppeteer. */
interface CaptureApi {
  ready: boolean;
  load(spec: unknown, baseUrl: string, format?: string, height?: number): Promise<{ width: number; height: number; fps: number; duration: number; frameCount: number }>;
  frame(index: number, format: 'png' | 'jpeg' | 'none', quality: number, motionBlur: boolean): Promise<string>;
  /**
   * Renders frames a..b-1 back to back while a pool of workers encodes them, handing each image (base64)
   * to the page's \`bemotionOut(index, data)\` (exposed by the renderer). Resolves when all are handed over.
   */
  renderRange(a: number, b: number, format: 'png' | 'jpeg', quality: number, motionBlur: boolean, workers?: number): Promise<{ render: number; copy: number; wait: number }>;
  /** Renders a frame (no motion blur) and reports what is on screen plus a small grayscale thumbnail. */
  probe(index: number, rgb?: boolean): Promise<{ info: import('../engine/engine').InspectInfo; thumb: number[] }>;
  /** JSON path of the editable layer under a point (frame px from the top-left) at a frame, as the editor picks it. */
  pick(index: number, x: number, y: number): Promise<(string | number)[] | null>;
  /** Draw calls and memory of the last frame drawn (for profiling). */
  stats(): { calls: number; triangles: number; programs: number; geometries: number; textures: number } | null;
  gpu(): string;
  events(): { kind: string; t: number; gain: number }[];
  clips(): import('../engine/engine').ClipSound[];
  /**
   * Output seconds of a moment given in a scene's own time (design time, as written in the spec), or
   * the middle of the scene when `t` is null. Null when there is no such scene.
   */
  when(scene: string, t: number | null): number | null;
  /** A contact sheet of images (data URLs) in a grid, each with its label, as a PNG data URL. */
  sheet(images: string[], labels: string[], cols: number, width: number): Promise<string>;
}

declare global {
  interface Window {
    bemotion: CaptureApi;
  }
}

let engine: Engine | null = null;

/** Image encoders on worker threads, so encoding a frame overlaps rendering the next. */
const WORKER_SRC = `
onmessage = async (e) => {
  const { id, bmp, type, quality } = e.data;
  try {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    const blob = await c.convertToBlob({ type, quality });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    postMessage({ id, data: btoa(s) });
  } catch (err) {
    postMessage({ id, error: String(err) });
  }
};
`;
interface Encoder {
  encode(bmp: ImageBitmap, type: string, quality: number): Promise<string>;
}
let pool: Encoder[] = [];
function encoders(n: number): Encoder[] {
  if (pool.length >= n) return pool.slice(0, n);
  const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
  while (pool.length < n) {
    const w = new Worker(url);
    const waiting = new Map<number, { res: (d: string) => void; rej: (e: Error) => void }>();
    let next = 0;
    w.onmessage = (e) => {
      const p = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (e.data.error) p?.rej(new Error(e.data.error));
      else p?.res(e.data.data);
    };
    pool.push({
      encode(bmp, type, quality) {
        const id = next++;
        return new Promise((res, rej) => {
          waiting.set(id, { res, rej });
          w.postMessage({ id, bmp, type, quality }, [bmp]);
        });
      },
    });
  }
  return pool.slice(0, n);
}
const canvas = document.getElementById('c') as HTMLCanvasElement;
const thumbCanvas = Object.assign(document.createElement('canvas'), { width: 192, height: 108 });

window.bemotion = {
  ready: true,
  async load(spec, baseUrl, format, height) {
    engine?.dispose();
    engine = await Engine.create(canvas, spec, { baseUrl, preview: false, format: format || undefined });
    // Output size: the design size, or scaled so the video is `height` pixels tall (1440p, 4K...).
    const scale = height ? height / engine.pixelHeight : 1;
    if (scale !== 1) engine.setScale(scale);
    const w = Math.round((engine.pixelWidth * scale) / 2) * 2;
    const h = Math.round((engine.pixelHeight * scale) / 2) * 2;
    return { width: w, height: h, fps: engine.fps, duration: engine.duration, frameCount: engine.frameCount };
  },
  async frame(index, format, quality, motionBlur) {
    if (!engine) throw new Error('No video loaded');
    await engine.renderFrameIndex(index, { motionBlur });
    const gl = engine.renderer.getContext();
    gl.finish();
    // 'none': render only (for timing the engine without image encoding).
    if (format === 'none') return '';
    return canvas.toDataURL(format === 'png' ? 'image/png' : 'image/jpeg', quality);
  },
  async probe(index, rgb) {
    if (!engine) throw new Error('No video loaded');
    await engine.renderFrameIndex(index, { motionBlur: false });
    engine.renderer.getContext().finish();
    const info = engine.inspect(index / engine.fps);
    const ctx2 = thumbCanvas.getContext('2d', { willReadFrequently: true })!;
    ctx2.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    const px = ctx2.getImageData(0, 0, thumbCanvas.width, thumbCanvas.height).data;
    const thumb: number[] = [];
    for (let i = 0; i < px.length; i += 4) {
      if (rgb) thumb.push(px[i], px[i + 1], px[i + 2]);
      else thumb.push(Math.round(px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722));
    }
    return { info, thumb };
  },
  async pick(index, x, y) {
    if (!engine) throw new Error('No video loaded');
    await engine.renderFrameIndex(index, { motionBlur: false });
    const l = engine.pick({ x: (x / engine.pixelWidth) * 2 - 1, y: 1 - (y / engine.pixelHeight) * 2 }, index / engine.fps);
    return l?.sourcePath ?? null;
  },
  async renderRange(a, b, format, quality, motionBlur, workers = 3) {
    if (!engine) throw new Error('No video loaded');
    const pool = encoders(workers);
    const out = (window as any).bemotionOut as (i: number, data: string) => Promise<void>;
    const type = format === 'png' ? 'image/png' : 'image/jpeg';
    let inflight = 0;
    let wake: (() => void) | null = null;
    let failure: unknown = null;
    const jobs: Promise<void>[] = [];
    const time = { render: 0, copy: 0, wait: 0 };
    for (let i = a; i < b; i++) {
      if (failure) throw failure;
      let t = performance.now();
      await engine.renderFrameIndex(i, { motionBlur });
      time.render += performance.now() - t;
      t = performance.now();
      // A copy of the frame for a worker to encode while the next frame renders.
      const bmp = await createImageBitmap(canvas);
      time.copy += performance.now() - t;
      t = performance.now();
      while (inflight >= workers * 2) await new Promise<void>((r) => (wake = r));
      time.wait += performance.now() - t;
      inflight++;
      jobs.push(
        pool[i % pool.length].encode(bmp, type, quality)
          .then((data) => out(i, data))
          .catch((e) => {
            failure = e;
          })
          .finally(() => {
            inflight--;
            const f = wake;
            wake = null;
            f?.();
          }),
      );
    }
    await Promise.all(jobs);
    if (failure) throw failure;
    return { render: time.render / (b - a), copy: time.copy / (b - a), wait: time.wait / (b - a) };
  },
  stats() {
    const i = engine?.renderer.info;
    return i ? { calls: i.render.calls, triangles: i.render.triangles, programs: i.programs?.length ?? 0, geometries: i.memory.geometries, textures: i.memory.textures } : null;
  },
  events() {
    return engine ? engine.events() : [];
  },
  when(scene, t) {
    if (!engine) return null;
    let i = sceneIndex(engine.video, scene);
    if (i < 0 && /^\d+$/.test(scene)) i = sceneIndex(engine.video, Number(scene));
    const tm = engine.designTimings[i];
    if (!tm) return null;
    return engine.output(tm.start + (t ?? tm.duration / 2));
  },
  async sheet(images, labels, cols, width) {
    const imgs = await Promise.all(images.map((src) => new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('could not read a still'));
      im.src = src;
    })));
    const w = Math.round(width / cols);
    const h = Math.round((w * imgs[0].naturalHeight) / imgs[0].naturalWidth);
    const rows = Math.ceil(imgs.length / cols);
    const c = document.createElement('canvas');
    c.width = w * cols;
    c.height = h * rows;
    const g = c.getContext('2d')!;
    g.fillStyle = '#111';
    g.fillRect(0, 0, c.width, c.height);
    imgs.forEach((im, i) => {
      const x = (i % cols) * w;
      const y = Math.floor(i / cols) * h;
      g.drawImage(im, x, y, w, h);
      g.strokeStyle = '#111';
      g.lineWidth = 2;
      g.strokeRect(x + 1, y + 1, w - 2, h - 2);
      const size = Math.max(12, Math.round(w / 32));
      g.font = `600 ${size}px system-ui, sans-serif`;
      const tw = g.measureText(labels[i]).width;
      g.fillStyle = 'rgba(0,0,0,0.72)';
      g.fillRect(x + 8, y + 8, tw + size, size * 1.6);
      g.fillStyle = '#fff';
      g.textBaseline = 'middle';
      g.fillText(labels[i], x + 8 + size / 2, y + 8 + size * 0.8);
    });
    return c.toDataURL('image/png');
  },

  clips() {
    return engine ? engine.clipSounds() : [];
  },
  gpu() {
    const gl = (engine?.renderer.getContext() ?? canvas.getContext('webgl2')) as WebGL2RenderingContext;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  },
};
