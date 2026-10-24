import { Engine } from '../engine/engine';

/** Headless capture API driven by the CLI through Puppeteer. */
interface CaptureApi {
  ready: boolean;
  load(spec: unknown, baseUrl: string, format?: string): Promise<{ width: number; height: number; fps: number; duration: number; frameCount: number }>;
  frame(index: number, format: 'png' | 'jpeg', quality: number, motionBlur: boolean): Promise<string>;
  /** Renders a frame (no motion blur) and reports what is on screen plus a small grayscale thumbnail. */
  probe(index: number, rgb?: boolean): Promise<{ info: import('../engine/engine').InspectInfo; thumb: number[] }>;
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
  async load(spec, baseUrl, format) {
    engine?.dispose();
    engine = await Engine.create(canvas, spec, { baseUrl, preview: false, format: format || undefined });
    return { width: engine.pixelWidth, height: engine.pixelHeight, fps: engine.fps, duration: engine.duration, frameCount: engine.frameCount };
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
