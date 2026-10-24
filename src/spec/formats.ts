/**
 * Other aspect ratios from one spec. A video is designed in its own size (usually 1920x1080); a
 * format renders it at another aspect (9:16, 1:1, 4:5) with the same short side.
 *
 * The layout stays in design pixels. A narrower frame sees a narrower slice of it, zoomed out a little
 * (`zoom`) so more fits while type stays big, and text that would run off the frame wraps. Anything
 * that needs a different place, size or look in a format says so with `formats`:
 *
 *   layer:     "formats": { "9:16": { "y": 420, "size": 96 }, "1:1": false }   (false: not in that format)
 *   scene:     "formats": { "9:16": { "camera": { ... } } }
 *   top level: "formats": { "9:16": { "zoom": 0.9 } }
 *
 * In a narrower frame, a scene whose shapes, images, UI frames or devices reach past the frame's
 * edges zooms out as a whole (scene `zoom`, never below 0.6) so its composition stays intact. A
 * scene's own `zoom` (or one in its format override) replaces this.
 *
 * Overrides replace fields (no deep merge). This runs on the raw spec, before validation.
 */

export const FORMATS: Record<string, { aspect: [number, number]; zoom: number }> = {
  '16:9': { aspect: [16, 9], zoom: 1 },
  '9:16': { aspect: [9, 16], zoom: 1 },
  '1:1': { aspect: [1, 1], zoom: 0.9 },
  '4:5': { aspect: [4, 5], zoom: 0.9 },
};

export interface Framing {
  /** Output size in pixels. */
  width: number;
  height: number;
  /** Output pixels per design pixel. */
  zoom: number;
  /** Width text wraps to, in design pixels (only in formats other than the design's own). */
  wrap?: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function formatNames(): string[] {
  return Object.keys(FORMATS);
}

/** Output name suffix for a format: "9:16" -> "9x16". */
export function formatSlug(format: string): string {
  return format.replace(':', 'x');
}

function overrideOf(node: Obj, format: string): Obj | false | undefined {
  const f = node.formats;
  if (!isObj(f)) return undefined;
  const o = f[format];
  return o === false ? false : isObj(o) ? o : undefined;
}

/** Default widths of layers that have a box even without `width` (UI frames and devices). */
const DEFAULT_WIDTH: Record<string, number> = { browser: 1280, laptop: 1100, phone: 390, chart: 640, code: 760, card: 420, toast: 440, progress: 480 };
/** Layer types measured by their `width` when they have one. */
const SIZED = new Set(['shape', 'image', 'video', ...Object.keys(DEFAULT_WIDTH)]);

/**
 * Zoom that keeps a scene's composition in a narrower frame: every top-level layer with a known width
 * (shapes, images, video, UI frames, devices) must fit, offset included. Text wraps instead, and
 * groups and bleeding decoration are not counted. Never below 0.6: past that, edges may crop.
 */
function fitZoom(layers: unknown, visible: number): number {
  let k = 1;
  if (!Array.isArray(layers)) return k;
  const half = (visible / 2) * 0.95;
  for (const n of layers) {
    if (!isObj(n) || !SIZED.has(String(n.type))) continue;
    const w = typeof n.width === 'number' ? n.width : DEFAULT_WIDTH[String(n.type)] ?? 0;
    if (!(w > 0)) continue;
    const reach = Math.abs(typeof n.x === 'number' ? n.x : 0) + (w * Math.abs(typeof n.scale === 'number' ? n.scale : 1)) / 2;
    if (reach > half) k = Math.min(k, half / reach);
  }
  return Math.max(0.6, k);
}

function layersFor(list: unknown, format: string): unknown {
  if (!Array.isArray(list)) return list;
  return list.map((n) => {
    if (!isObj(n)) return n;
    const o = overrideOf(n, format);
    // A layer left out of this format becomes an empty group, so layer paths (used by the editor) stay put.
    if (o === false) return { type: 'group', children: [], ...(typeof n.id === 'string' ? { id: n.id } : {}) };
    const out: Obj = { ...n, ...(o ?? {}) };
    if (Array.isArray(out.children)) out.children = layersFor(out.children, format);
    return out;
  });
}

/**
 * Applies a format to a raw spec. Returns the spec as the engine should see it (width and height are
 * the visible design area) and the framing for the renderer. Without a format, or with the design's
 * own aspect, the spec is returned as is (still applying that format's overrides if it is named).
 */
export function applyFormat(input: unknown, format?: string): { spec: unknown; framing: Framing } {
  const base = isObj(input) ? input : {};
  const W0 = typeof base.width === 'number' ? base.width : 1920;
  const H0 = typeof base.height === 'number' ? base.height : 1080;
  if (!format) return { spec: input, framing: { width: W0, height: H0, zoom: 1 } };
  const def = FORMATS[format];
  if (!def) throw new Error(`Unknown format "${format}". Formats: ${formatNames().join(', ')}`);
  const [a, b] = def.aspect;
  const short = Math.min(W0, H0);
  const width = even(a >= b ? (short * a) / b : short);
  const height = even(a >= b ? short : (short * b) / a);
  const top = overrideOf(base, format) || {};
  const same = Math.abs(width / height - W0 / H0) < 0.01;
  const zoom = typeof top.zoom === 'number' ? top.zoom : same ? width / W0 : def.zoom;
  const { zoom: _z, ...topRest } = top;
  const spec: Obj = {
    ...base,
    ...topRest,
    width: width / zoom,
    height: height / zoom,
    scenes: Array.isArray(base.scenes)
      ? base.scenes.map((s) => {
          if (!isObj(s)) return s;
          const o = overrideOf(s, format) || {};
          const merged: Obj = { ...s, ...o };
          merged.layers = layersFor(merged.layers, format);
          const visible = width / zoom;
          // Too wide for the frame: the whole scene zooms out, so what was placed together stays together.
          if (visible < W0 * 0.99 && typeof merged.zoom !== 'number') {
            const k = fitZoom(merged.layers, visible);
            if (k < 0.999) merged.zoom = k;
          }
          return merged;
        })
      : base.scenes,
  };
  return { spec, framing: { width, height, zoom, wrap: same ? undefined : width / zoom } };
}
