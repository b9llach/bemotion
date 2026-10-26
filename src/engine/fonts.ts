import { configureTextBuilder } from 'troika-three-text';
import { cjkScript, type CjkScript } from '../spec/scripts';

// Bundled fonts from @fontsource. Only the latin subset is bundled; troika reads .woff (not .woff2).
const files = import.meta.glob('../../node_modules/@fontsource/*/files/*-latin-[0-9]*-{normal,italic}.woff', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

interface FontFace {
  weight: number;
  italic: boolean;
  url: string;
}

const registry = new Map<string, FontFace[]>();
const displayNames = new Map<string, string>();

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');

for (const [path, url] of Object.entries(files)) {
  const m = /@fontsource\/([^/]+)\/files\/.+-latin-(\d+)-(normal|italic)\.woff$/.exec(path);
  if (!m) continue;
  const key = norm(m[1]);
  const list = registry.get(key) ?? [];
  list.push({ weight: parseInt(m[2], 10), italic: m[3] === 'italic', url });
  registry.set(key, list);
  displayNames.set(key, m[1].split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '));
}

const custom = new Map<string, FontFace[]>();

/** Registers a custom font file; several weights (and italics) can share one family name. */
export function registerCustomFont(name: string, url: string, weight = 400, italic = false): void {
  const list = custom.get(norm(name)) ?? [];
  list.push({ weight, italic, url });
  custom.set(norm(name), list);
}

export function bundledFonts(): string[] {
  return [...displayNames.values()].sort();
}

export function resolveFontUrl(family: string, weight = 400, italic = false): string {
  const key = norm(family);
  const faces = custom.get(key) ?? registry.get(key);
  if (!faces || faces.length === 0) {
    throw new Error(`Unknown font "${family}". Bundled fonts: ${bundledFonts().join(', ')}. Register others under "fonts" in the video spec.`);
  }
  const pool = faces.filter((f) => f.italic === italic).length ? faces.filter((f) => f.italic === italic) : faces;
  let best = pool[0];
  for (const f of pool) {
    if (Math.abs(f.weight - weight) < Math.abs(best.weight - weight)) best = f;
  }
  return best.url;
}

// Chinese, Japanese and Korean: whole-script subsets of Noto Sans (SIL Open Font License), regular and
// bold, bundled so renders never depend on a CDN for them (assets/fonts/cjk, built from @fontsource by
// scripts/build-cjk-fonts.py with overlapping contours merged). troika takes one font per text plus
// one global fallback (`defaultFontURL`, set once per page before the first text is laid out), so a
// video gets the fallback for the script its copy is in (see `configureCjkFallback`).
const cjkFiles = import.meta.glob('../../assets/fonts/cjk/noto-sans-{jp,sc,kr}-{400,700}.woff', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const cjk = new Map<string, string>();
for (const [path, url] of Object.entries(cjkFiles)) {
  const m = /noto-sans-(jp|sc|kr)-(\d+)\.woff$/.exec(path);
  if (m) cjk.set(`${({ jp: 'japanese', sc: 'chinese-simplified', kr: 'korean' } as const)[m[1] as 'jp' | 'sc' | 'kr']}|${m[2]}`, url);
}

/** The bundled fallback font file for a script, regular (400) or bold (700). */
export function cjkFontUrl(script: CjkScript, weight = 400): string | undefined {
  return cjk.get(`${script}|${weight >= 550 ? 700 : 400}`);
}

let configured: string | null = null;

/**
 * Sets troika's fallback font to the bundled Noto Sans for the CJK script in a video's copy, in the
 * weight most of that copy uses. Call before any text is laid out; troika keeps the first setting for
 * the page (a reload picks up a change of language). Returns the font chosen, or null.
 */
export function configureCjkFallback(video: unknown): string | null {
  const texts: { text: string; weight: number }[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const k of ['text', 'label', 'title', 'subtitle', 'body', 'prefix', 'suffix', 'detail', 'script']) {
        if (typeof o[k] === 'string') texts.push({ text: o[k] as string, weight: typeof o.weight === 'number' ? o.weight : k === 'text' ? 600 : 500 });
      }
      for (const x of Object.values(o)) if (x && typeof x === 'object') visit(x);
    }
  };
  visit(video);
  const script = cjkScript(texts.map((t) => t.text).join(' '));
  if (!script) return null;
  const mine = texts.filter((t) => cjkScript(t.text));
  const weight = mine.reduce((a, t) => a + t.weight, 0) / Math.max(1, mine.length);
  const url = cjkFontUrl(script, weight);
  if (!url) return null;
  if (configured === null) {
    configureTextBuilder({ defaultFontURL: url });
    configured = url;
  } else if (configured !== url) {
    console.warn(`This page already uses ${configured} for CJK text; reload to switch to ${url}.`);
  }
  return configured;
}
