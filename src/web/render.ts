import { Engine } from '../engine/engine';

/** Headless capture API driven by the CLI through Puppeteer. */
interface CaptureApi {
  ready: boolean;
  load(spec: unknown, baseUrl: string, format?: string, height?: number): Promise<{ width: number; height: number; fps: number; duration: number; frameCount: number }>;
  frame(index: number, format: 'png' | 'jpeg', quality: number, motionBlur: boolean): Promise<string>;
  /** Renders a frame (no motion blur) and reports what is on screen plus a small grayscale thumbnail. */
  probe(index: number, rgb?: boolean): Promise<{ info: import('../engine/engine').InspectInfo; thumb: number[] }>;
  /** JSON path of the editable layer under a point (frame px from the top-left) at a frame, as the editor picks it. */
  pick(index: number, x: number, y: number): Promise<(string | number)[] | null>;
  gpu(): string;
  events(): { kind: string; t: number; gain: number }[];
  clips(): import('../engine/engine').ClipSound[];
}

declare global {
  interface Window {
    bemotion: CaptureApi;
  }
}

let engine: Engine | null = null;
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
  events() {
    return engine ? engine.events() : [];
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
