import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { validateVideo } from '../spec/schema';

/**
 * Templates: a spec with `{{name}}` placeholders in its strings (copy, image paths, colors, the URL),
 * optionally described in a top-level `slots` block ({ name: { label, default } }). `fillTemplate`
 * puts values in; `batch` does it once per row of a CSV.
 */

export type Values = Record<string, string>;

const SLOT = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/** Every placeholder name used in a spec, in order of first use. */
export function slotNames(spec: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(SLOT)) if (!out.includes(m[1])) out.push(m[1]);
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(visit);
    }
  };
  visit(spec);
  return out;
}

/** Keys whose string values are files next to the spec. */
const PATH_KEYS = new Set(['src']);

export interface FillOptions {
  /** Folder of the template: its own relative paths start here. */
  templateDir: string;
  /** Folder the values came from (a CSV next to images): relative paths in values start here. */
  valuesDir?: string;
  /** Folder the filled spec will be written to: paths are rewritten relative to it. */
  outDir: string;
}

/**
 * Fills a template. Throws when a placeholder has no value and no default. A string that is only a
 * placeholder and gets a number becomes a number (sizes, times). File paths (src, fonts) are rewritten
 * so the filled spec finds them from its own folder.
 */
export function fillTemplate(template: Record<string, unknown>, values: Values, o: FillOptions): Record<string, unknown> {
  const slots = (template.slots ?? {}) as Record<string, { default?: string | number }>;
  const missing = new Set<string>();
  const valueOf = (name: string): string | undefined => {
    if (values[name] !== undefined && values[name] !== '') return values[name];
    const d = slots[name]?.default;
    return d === undefined ? undefined : String(d);
  };
  const fromValues = new Set<string>();
  const sub = (s: string): unknown => {
    const whole = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/.exec(s);
    if (whole) {
      const v = valueOf(whole[1]);
      if (v === undefined) {
        missing.add(whole[1]);
        return s;
      }
      if (values[whole[1]] !== undefined && values[whole[1]] !== '') fromValues.add(v);
      return /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v;
    }
    return s.replace(SLOT, (all, name: string) => {
      const v = valueOf(name);
      if (v === undefined) {
        missing.add(name);
        return all;
      }
      return v;
    });
  };
  const rebase = (p: string, fromValue: boolean): string => {
    if (/^(https?:|data:|\/)/.test(p) || isAbsolute(p)) return p;
    const from = fromValue && o.valuesDir ? o.valuesDir : o.templateDir;
    const abs = resolve(from, p);
    // A value that is not a file next to the values (a template-relative path) falls back to the template.
    const real = existsSync(abs) || !fromValue ? abs : resolve(o.templateDir, p);
    return relative(o.outDir, real).replace(/\\/g, '/');
  };
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      const filled = sub(v);
      if (typeof filled === 'string' && key && PATH_KEYS.has(key)) return rebase(filled, fromValues.has(filled) && filled !== v);
      return filled;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, k);
      return out;
    }
    return v;
  };
  const { slots: _drop, ...rest } = template;
  void _drop;
  const filled = walk(rest) as Record<string, unknown>;
  // Font files are paths too: `fonts: { Family: "file" | { "400": "file" } }`.
  if (filled.fonts && typeof filled.fonts === 'object') {
    const f = filled.fonts as Record<string, string | Record<string, string>>;
    for (const [fam, v] of Object.entries(f)) {
      f[fam] = typeof v === 'string' ? rebase(v, false) : Object.fromEntries(Object.entries(v).map(([w, p]) => [w, rebase(p, false)]));
    }
  }
  if (missing.size) throw new Error(`No value for ${[...missing].map((m) => `{{${m}}}`).join(', ')}`);
  return filled;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. First row is the header. */
export function parseCsv(text: string): Values[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  const keys = head.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'video';
}

export interface BatchItem {
  name: string;
  spec: string;
  error?: string;
}

/** Fills a template once per CSV row into `outDir/<name>.json` (name from a `name` or `id` column, else the row number). */
export async function batch(templatePath: string, csvPath: string, outDir: string): Promise<BatchItem[]> {
  const tpath = resolve(templatePath);
  const template = JSON.parse(await readFile(tpath, 'utf8')) as Record<string, unknown>;
  const rows = parseCsv(await readFile(resolve(csvPath), 'utf8'));
  const out = resolve(outDir);
  await mkdir(out, { recursive: true });
  const used = new Set<string>();
  const items: BatchItem[] = [];
  for (const [i, row] of rows.entries()) {
    let name = slug(row.name || row.id || `${i + 1}`);
    while (used.has(name)) name += '-2';
    used.add(name);
    const file = join(out, `${name}.json`);
    try {
      const spec = fillTemplate(template, row, { templateDir: dirname(tpath), valuesDir: dirname(resolve(csvPath)), outDir: out });
      const v = validateVideo(spec);
      if (!v.ok) throw new Error(v.errors.slice(0, 4).join('; '));
      await writeFile(file, JSON.stringify(spec, null, 2) + '\n');
      items.push({ name, spec: file });
    } catch (e) {
      items.push({ name, spec: file, error: (e as Error).message });
    }
  }
  return items;
}
