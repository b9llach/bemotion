import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PKG_ROOT } from './server';

/**
 * The technique library (refs/, built by scripts/build-refs.py): named motion techniques, each a small
 * runnable spec with notes on when and how to use it. Searched by `bemotion refs`, and handed to
 * Claude by `generate --ref` or when a prompt names a technique.
 */
export interface Technique {
  key: string;
  name: string;
  style: 'flow' | 'minimal' | 'hype' | 'any';
  aliases: string[];
  tags: string[];
  summary: string;
  how: string[];
  spec: Record<string, unknown>;
}

export async function loadRefs(dir = join(PKG_ROOT, 'refs')): Promise<Technique[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8')) as Technique));
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);

/** Techniques ranked by how well they match a query (name and aliases count most). */
export function searchRefs(list: Technique[], query: string): Technique[] {
  const q = words(query);
  if (!q.length) return list;
  const scored = list.map((t) => {
    const name = words(`${t.key} ${t.name}`);
    const alias = t.aliases.flatMap(words);
    const tags = t.tags.flatMap(words);
    const body = words(`${t.summary} ${t.style}`);
    let score = 0;
    for (const w of q) {
      if (name.includes(w)) score += 5;
      else if (alias.includes(w)) score += 4;
      else if (tags.includes(w)) score += 3;
      else if (body.includes(w)) score += 1;
      else if ([...name, ...alias, ...tags].some((x) => x.startsWith(w) && w.length >= 3)) score += 2;
    }
    if (t.aliases.some((a) => query.toLowerCase().includes(a.toLowerCase()))) score += 6;
    return { t, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).map((s) => s.t);
}

/** Techniques a prompt names outright (by key, name or alias). */
export function namedInPrompt(list: Technique[], prompt: string): Technique[] {
  const p = ` ${prompt.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const hit = (s: string) => p.includes(` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `);
  return list.filter((t) => hit(t.key) || hit(t.name) || t.aliases.some(hit));
}

/** Finds techniques by key, or the best search match for anything that is not a key. */
export function pickRefs(list: Technique[], refs: string[]): Technique[] {
  const out: Technique[] = [];
  for (const r of refs) {
    const t = list.find((x) => x.key === r) ?? searchRefs(list, r)[0];
    if (!t) throw new Error(`No technique matches "${r}". Run bemotion refs to list them.`);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Ways to open an ad (techniques tagged "opening"), as short notes for every brief: the first second
 * and a half decides whether anyone keeps watching. Samples are left out to keep the brief short;
 * naming one in the prompt (or --ref) brings its sample in.
 */
export function openingContext(list: Technique[], skip: Technique[] = []): string {
  const ts = list.filter((t) => t.tags.includes('opening') && !skip.includes(t));
  if (!ts.length) return '';
  const blocks = ts.map((t) => [`${t.name} (${t.style}): ${t.summary}`, ...t.how.map((h) => `  - ${h}`)].join('\n'));
  const intro = 'Ways to open that hold attention. Pick the one that fits this product and story (or something as strong); never open on a small line over an empty background or on the logo alone.';
  return `<openings>\n${intro}\n\n${blocks.join('\n\n')}\n</openings>`;
}

/** The prompt text for techniques: notes plus the sample spec. */
export function refContext(ts: Technique[]): string {
  if (!ts.length) return '';
  const blocks = ts.map((t) =>
    [
      `<technique name="${t.name}" style="${t.style}">`,
      t.summary,
      ...t.how.map((h) => `- ${h}`),
      'Sample spec (a working example of the technique; adapt it to this brand and story, do not copy its copy):',
      '```json',
      JSON.stringify(t.spec),
      '```',
      '</technique>',
    ].join('\n'),
  );
  return `The brief asks for these techniques. Use them where they fit the story:\n\n${blocks.join('\n\n')}`;
}
