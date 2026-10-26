/**
 * Transparent renders (`--alpha`): the spec as it renders with nothing behind it. The video and every
 * scene get a transparent background color and `background` layers are dropped, wherever they are.
 */
export function transparentSpec<T>(spec: T): T {
  const out = structuredClone(spec) as Record<string, unknown>;
  out.background = 'transparent';
  const strip = (layers: unknown): unknown =>
    Array.isArray(layers)
      ? layers
          .filter((l) => !(l && typeof l === 'object' && (l as { type?: unknown }).type === 'background'))
          .map((l) => {
            if (!l || typeof l !== 'object') return l;
            const o = l as Record<string, unknown>;
            return Array.isArray(o.children) ? { ...o, children: strip(o.children) } : o;
          })
      : layers;
  if (Array.isArray(out.scenes)) {
    out.scenes = out.scenes.map((s) => {
      if (!s || typeof s !== 'object') return s;
      const sc = { ...(s as Record<string, unknown>) };
      if (sc.background !== undefined) sc.background = 'transparent';
      sc.layers = strip(sc.layers);
      return sc;
    });
  }
  // Per-format overrides can set a background too.
  if (out.formats && typeof out.formats === 'object') {
    for (const f of Object.values(out.formats as Record<string, Record<string, unknown>>)) {
      if (f && typeof f === 'object' && 'background' in f) f.background = 'transparent';
    }
  }
  return out as T;
}

/** True when the spec's own background is see-through (renders with alpha where the output allows). */
export function hasTransparentBackground(spec: unknown): boolean {
  const bg = (spec as { background?: unknown })?.background;
  return typeof bg === 'string' && /^(transparent|none)$/i.test(bg.trim());
}

/** Output containers by extension, and whether each can carry alpha. */
export type OutputKind = 'mp4' | 'webm' | 'mov' | 'gif';

export function outputKind(file: string): OutputKind {
  const ext = file.toLowerCase().split('.').pop() ?? '';
  if (ext === 'webm' || ext === 'mov' || ext === 'gif') return ext;
  if (ext === 'mp4' || ext === 'm4v' || !file.includes('.')) return 'mp4';
  throw new Error(`Unknown output type ".${ext}". Use .mp4, .webm, .mov or .gif.`);
}
