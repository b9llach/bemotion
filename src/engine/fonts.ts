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

const custom = new Map<string, string>();

export function registerCustomFont(name: string, url: string): void {
  custom.set(norm(name), url);
}

export function bundledFonts(): string[] {
  return [...displayNames.values()].sort();
}

export function resolveFontUrl(family: string, weight = 400, italic = false): string {
  const key = norm(family);
  const c = custom.get(key);
  if (c) return c;
  const faces = registry.get(key);
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
