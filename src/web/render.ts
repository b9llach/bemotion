import { Engine } from '../engine/engine';

/** Headless capture API driven by the CLI through Puppeteer. */
interface CaptureApi {
  ready: boolean;
  load(spec: unknown, baseUrl: string, format?: string): Promise<{ width: number; height: number; fps: number; duration: number; frameCount: number }>;
  frame(index: number, format: 'png' | 'jpeg', quality: number, motionBlur: boolean): Promise<string>;
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
