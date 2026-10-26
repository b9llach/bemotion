import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ICONS } from '../engine/icons';

/** Lucide's icons (lucide-static, ISC license): one SVG per name, aliases included, and search tags. */
let root: string | undefined;
function lucideRoot(): string {
  root ??= dirname(createRequire(import.meta.url).resolve('lucide-static/package.json'));
  return root;
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

let names: string[] | undefined;
/** Every Lucide icon name (aliases included), sorted. */
export function lucideNames(): string[] {
  names ??= readdirSync(join(lucideRoot(), 'icons'))
    .filter((f) => f.endsWith('.svg'))
    .map((f) => f.slice(0, -4))
    .filter((n) => NAME.test(n))
    .sort();
  return names;
}

/** The SVG text of a Lucide icon, or null when there is no icon by that name. */
export async function lucideIcon(name: string): Promise<string | null> {
  // Only plain kebab-case names reach the file system, so a name can never point outside the icons.
  if (!NAME.test(name) || !lucideNames().includes(name)) return null;
  return readFile(join(lucideRoot(), 'icons', `${name}.svg`), 'utf8');
}

let tags: Record<string, string[]> | undefined;
async function lucideTags(): Promise<Record<string, string[]>> {
  tags ??= JSON.parse(await readFile(join(lucideRoot(), 'tags.json'), 'utf8')) as Record<string, string[]>;
  return tags;
}

export interface IconHit {
  name: string;
  tags: string[];
  /** Built into the engine (drawn from its own path data rather than Lucide's). */
  builtIn: boolean;
}

/**
 * Icons matching all the words, best first: a word equal to a part of the name counts most, then a
 * part of the name starting with it, then a tag. Without words, every name.
 */
export async function searchIcons(query: string, limit = 40): Promise<IconHit[]> {
  const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const t = await lucideTags();
  const all = [...new Set([...lucideNames(), ...Object.keys(ICONS)])].sort();
  const hits: { hit: IconHit; score: number }[] = [];
  for (const name of all) {
    const parts = name.split('-');
    const tg = t[name] ?? [];
    let score = 0;
    let every = true;
    for (const w of words) {
      let s = 0;
      if (name === w) s = 10;
      else if (parts.includes(w)) s = 6;
      else if (parts.some((p) => p.startsWith(w))) s = 4;
      else if (tg.some((g) => g === w)) s = 3;
      else if (tg.some((g) => g.split(/\s+/).some((x) => x.startsWith(w)))) s = 2;
      else if (name.includes(w)) s = 1;
      if (!s) {
        every = false;
        break;
      }
      score += s;
    }
    if (!every) continue;
    // Shorter names are the plainer icon ("bell" before "bell-ring").
    hits.push({ hit: { name, tags: tg, builtIn: name in ICONS }, score: score - parts.length * 0.1 });
  }
  hits.sort((a, b) => b.score - a.score || a.hit.name.localeCompare(b.hit.name));
  return hits.slice(0, words.length ? limit : hits.length).map((h) => h.hit);
}
