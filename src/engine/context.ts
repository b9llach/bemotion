import * as THREE from 'three';
import type { Time, Video } from '../spec/schema';
import { toSeconds } from '../spec/time';
import { parseColor, toThreeColor, type RGBA } from './util/color';
import { registerCustomFont, resolveFontUrl } from './fonts';

export const DEFAULT_COLORS: Record<string, string> = {
  bg: '#07070B',
  surface: '#111118',
  surface2: '#1A1A24',
  border: '#2A2A3A',
  text: '#F5F5FA',
  muted: '#9A9AB0',
  primary: '#7C5CFF',
  secondary: '#22D3EE',
  accent: '#F472B6',
  success: '#34D399',
  warning: '#FBBF24',
  danger: '#F87171',
};

export const DEFAULT_FONTS: Record<string, string> = {
  display: 'Inter',
  body: 'Inter',
  mono: 'JetBrains Mono',
};

export type SfxKind = 'whoosh' | 'swoosh' | 'soft' | 'pop' | 'tick' | 'key' | 'click' | 'impact' | 'sparkle' | 'chime' | 'glitch';

export interface SfxEvent {
  kind: SfxKind;
  /** Scene-local time inside a scene context; global time once collected by the engine. */
  t: number;
  gain: number;
}

export interface EngineContext {
  width: number;
  height: number;
  fps: number;
  bpm?: number;
  preview: boolean;
  /** Lighting rig to pair with the environment. HDRIs light the scene themselves. */
  environment: 'room' | 'studio' | 'softbox' | 'hdri';
  lighting: import('../spec/schema').Lighting;
  envSettings: import('../spec/schema').Video['environment'];
  /** Shared, mutable render scale (preview renders below 1). */
  view: { scale: number };
  /** In a narrower format: the visible frame width in design px, which text without a maxWidth wraps to fit. */
  wrap?: number;
  /** The scene's `zoom` (layers are scaled by it about the center). */
  sceneZoom?: number;
  colors: Record<string, string>;
  fonts: Record<string, string>;
  /** Scene-local duration of the scene currently being built. */
  sceneDuration: number;
  renderer: THREE.WebGLRenderer;
  envMap: THREE.Texture | null;
  time(v: Time | undefined, fallback?: number): number;
  color(v: string): RGBA;
  threeColor(v: string): THREE.Color;
  fontUrl(family?: string, weight?: number, italic?: boolean): string;
  asset(src: string): string;
  texture(src: string): Promise<THREE.Texture>;
  /** Records a sound-design cue at scene-local time t. */
  event(kind: SfxKind, t: number, gain?: number): void;
  /** The music as data for `react` layers (set by the engine before scenes are built), or null. */
  music?: import('./anim/react').MusicSignal | null;
  /** Global design time to output time (music sync warps time). */
  outTime?: (t: number) => number;
  /** Global design time at which the scene being built starts. */
  sceneStart?: number;
}

export function createContext(
  video: Video,
  opts: { renderer: THREE.WebGLRenderer; baseUrl: string; preview: boolean; envMap: THREE.Texture | null; wrap?: number },
): EngineContext {
  const fps = video.fps ?? 30;
  const colors = { ...DEFAULT_COLORS, ...(video.theme?.colors ?? {}) };
  const fonts = { ...DEFAULT_FONTS, ...(video.theme?.fonts ?? {}) };
  const textureCache = new Map<string, Promise<THREE.Texture>>();
  const loader = new THREE.TextureLoader();

  const asset = (src: string) => {
    if (/^(https?:|data:|blob:)/.test(src) || src.startsWith('/')) return src;
    return opts.baseUrl.replace(/\/?$/, '/') + src.replace(/^\.\//, '');
  };

  for (const [name, src] of Object.entries(video.fonts ?? {})) {
    if (typeof src === 'string') registerCustomFont(name, asset(src));
    else {
      for (const [w, file] of Object.entries(src)) {
        const m = /^(\d+)?\s*(italic)?$/i.exec(w.trim());
        registerCustomFont(name, asset(file), m?.[1] ? parseInt(m[1], 10) : 400, !!m?.[2]);
      }
    }
  }

  const color = (v: string): RGBA => {
    let s = v.trim();
    let alpha = 1;
    if (s.startsWith('$')) {
      const [token, a] = s.slice(1).split('/');
      const val = colors[token];
      if (!val) throw new Error(`Unknown color token "$${token}". Theme colors: ${Object.keys(colors).join(', ')}`);
      s = val;
      if (a !== undefined) alpha = parseFloat(a) / 100;
    }
    const c = parseColor(s);
    return { ...c, a: c.a * alpha };
  };

  return {
    width: video.width ?? 1920,
    height: video.height ?? 1080,
    fps,
    bpm: video.bpm,
    preview: opts.preview,
    environment: typeof video.environment === 'string' && ['room', 'studio', 'softbox'].includes(video.environment)
      ? (video.environment as 'room' | 'studio' | 'softbox')
      : video.environment
        ? 'hdri'
        : 'room',
    lighting: video.lighting ?? {},
    envSettings: video.environment,
    view: { scale: 1 },
    wrap: opts.wrap,
    colors,
    fonts,
    sceneDuration: 0,
    renderer: opts.renderer,
    envMap: opts.envMap,
    time: (v, fallback = 0) => toSeconds(v, { fps, bpm: video.bpm }, fallback),
    color,
    threeColor: (v) => toThreeColor(color(v)),
    fontUrl: (family, weight = 400, italic = false) => resolveFontUrl(fonts[family ?? 'body'] ?? family ?? fonts.body, weight, italic),
    asset,
    event: () => {},
    texture: (src) => {
      const url = asset(src);
      let p = textureCache.get(url);
      if (!p) {
        p = loader.loadAsync(url).then((tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 8;
          return tex;
        });
        textureCache.set(url, p);
      }
      return p;
    },
  };
}
