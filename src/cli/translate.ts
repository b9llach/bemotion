import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { ApiBackend, ClaudeCodeBackend, type Backend } from './backends';
import { log } from './log';
import { fillTemplate, slotNames } from './template';
import { validateVideo } from '../spec/schema';
import { cjkScript, hasRtl, type CjkScript } from '../spec/scripts';
import type { InspectItem } from '../engine/engine';

/**
 * Translating a spec: one spec per language with the visible copy translated (text, counter
 * prefixes and suffixes, component labels, chart labels, voiceover scripts). The model only sees a
 * JSON list of strings and returns one; strings are taken out of the spec and put back by path, so
 * nothing else in the spec can change. Brand and product names, URLs and numbers are kept.
 *
 * After translating, every text is measured in the rendered video (`check`) against the original:
 * a translation that runs off the frame, outgrows its card or panel, or collides with something
 * gets one round of shorter alternatives with a length budget, then a smaller font size (down to
 * 75%). The report lists what changed.
 */

type Path = (string | number)[];

/** One piece of copy in the spec. */
export interface CopyString {
  path: Path;
  text: string;
  /** What it is, for the translator ("headline", "button label"...). */
  kind: string;
  /** Index of the string this one must appear in verbatim (a highlighted part of a line). */
  partOf?: number;
}

/** Languages whose line layout the engine cannot do: letters are drawn one by one, left to right. */
export const RTL_LANGS = new Set(['ar', 'he', 'iw', 'fa', 'ur', 'yi', 'ps', 'sd', 'ug', 'dv', 'ckb']);

const LANGS: Record<string, string> = {
  de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', 'pt-br': 'Brazilian Portuguese', nl: 'Dutch',
  sv: 'Swedish', da: 'Danish', no: 'Norwegian', nb: 'Norwegian', fi: 'Finnish', pl: 'Polish', cs: 'Czech', sk: 'Slovak',
  hu: 'Hungarian', ro: 'Romanian', tr: 'Turkish', el: 'Greek', ru: 'Russian', uk: 'Ukrainian', bg: 'Bulgarian',
  ja: 'Japanese', zh: 'Simplified Chinese', 'zh-cn': 'Simplified Chinese', 'zh-tw': 'Traditional Chinese', ko: 'Korean',
  id: 'Indonesian', ms: 'Malay', vi: 'Vietnamese', th: 'Thai', hi: 'Hindi', en: 'English',
};

export function languageName(code: string): string {
  return LANGS[code.toLowerCase()] ?? code;
}

/** The bundled fallback font a language's copy uses (CJK), for the report. */
const CJK_FONT: Record<CjkScript, string> = { japanese: 'Noto Sans JP', 'chinese-simplified': 'Noto Sans SC', korean: 'Noto Sans KR' };

const fmt = (p: Path) => p.map((k, i) => (typeof k === 'number' ? `[${k}]` : i ? `.${k}` : k)).join('');

// ---------------------------------------------------------------------------------------------
// Extraction and reinsertion

/** Whether a string has anything to translate: letters that are not only kept names. */
function translatable(s: string, keep: string[]): boolean {
  let rest = s.replace(/\{\{[^}]*\}\}/g, ' ');
  for (const k of keep) rest = rest.split(k).join(' ');
  rest = rest.replace(/https?:\/\/\S+|\b[\w-]+(\.[\w-]+)+\b|@\w+/g, ' ');
  return /\p{L}{2,}/u.test(rest);
}

/** Every piece of visible copy in a spec, with where it is. Voice scripts only for spoken (tts) tracks. */
export function extractStrings(spec: Record<string, unknown>, keep: string[] = []): CopyString[] {
  const out: CopyString[] = [];
  const add = (path: Path, text: unknown, kind: string, partOf?: number): number => {
    if (typeof text !== 'string' || !translatable(text, keep)) return -1;
    out.push({ path, text, kind, ...(partOf !== undefined ? { partOf } : {}) });
    return out.length - 1;
  };
  const layer = (l: Record<string, unknown>, p: Path): void => {
    if (!l || typeof l !== 'object') return;
    fields(l, l.type as string, p);
    const fo = l.formats as Record<string, unknown> | undefined;
    if (fo && typeof fo === 'object') {
      for (const [f, o] of Object.entries(fo)) if (o && typeof o === 'object') fields(o as Record<string, unknown>, l.type as string, [...p, 'formats', f]);
    }
    if (Array.isArray(l.children)) l.children.forEach((c, i) => layer(c as Record<string, unknown>, [...p, 'children', i]));
    if (l.mask && typeof l.mask === 'object') layer(l.mask as Record<string, unknown>, [...p, 'mask']);
  };
  const fields = (l: Record<string, unknown>, type: string, p: Path): void => {
    const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    switch (type) {
      case 'text': {
        const main = add([...p, 'text'], l.text, 'line of on-screen text');
        arr<Record<string, unknown>>(l.highlight).forEach((h, i) => add([...p, 'highlight', i, 'text'], h.text, 'highlighted words of the line', main >= 0 ? main : undefined));
        arr<Record<string, unknown>>(l.morph).forEach((m, i) => {
          const step = add([...p, 'morph', i, 'text'], m.text, 'next wording of the same line (it morphs into this)');
          arr<Record<string, unknown>>(m.highlight).forEach((h, k) => add([...p, 'morph', i, 'highlight', k, 'text'], h.text, 'highlighted words of the line', step >= 0 ? step : undefined));
        });
        break;
      }
      case 'counter':
        add([...p, 'prefix'], l.prefix, 'text before an animated number');
        add([...p, 'suffix'], l.suffix, 'text after an animated number');
        break;
      case 'mesh':
        add([...p, 'text'], l.text, '3D extruded headline');
        break;
      case 'card':
        add([...p, 'title'], l.title, 'card title');
        add([...p, 'subtitle'], l.subtitle, 'card subtitle');
        break;
      case 'button':
        add([...p, 'label'], l.label, 'button label');
        break;
      case 'badge':
        add([...p, 'label'], l.label, 'badge label');
        break;
      case 'toast':
        add([...p, 'title'], l.title, 'notification title');
        add([...p, 'body'], l.body, 'notification text');
        break;
      case 'chart': {
        arr<unknown>(l.labels).forEach((s, i) => add([...p, 'labels', i], s, 'chart label'));
        arr<Record<string, unknown>>(l.events).forEach((e, i) => add([...p, 'events', i, 'label'], e.label, 'chart annotation'));
        const unit = (o: unknown, q: Path) => {
          if (!o || typeof o !== 'object') return;
          add([...q, 'prefix'], (o as Record<string, unknown>).prefix, 'unit before a chart number');
          add([...q, 'suffix'], (o as Record<string, unknown>).suffix, 'unit after a chart number');
        };
        unit(l.readout, [...p, 'readout']);
        const ax = l.axes as Record<string, unknown> | undefined;
        if (ax) {
          unit(ax.x, [...p, 'axes', 'x']);
          unit(ax.y, [...p, 'axes', 'y']);
        }
        break;
      }
      case 'timeline':
        add([...p, 'prefix'], l.prefix, 'text before timeline numbers');
        add([...p, 'suffix'], l.suffix, 'text after timeline numbers');
        add([...p, 'axisLabel'], l.axisLabel, 'timeline axis label');
        arr<Record<string, unknown>>(l.items).forEach((it, i) => {
          add([...p, 'items', i, 'label'], it.label, 'timeline milestone');
          const d = add([...p, 'items', i, 'detail'], it.detail, 'timeline milestone detail');
          add([...p, 'items', i, 'highlight'], it.highlight, 'highlighted words of the detail', d >= 0 ? d : undefined);
        });
        break;
    }
  };
  const scenes = Array.isArray(spec.scenes) ? (spec.scenes as Record<string, unknown>[]) : [];
  scenes.forEach((s, i) => {
    (Array.isArray(s.layers) ? (s.layers as Record<string, unknown>[]) : []).forEach((l, k) => layer(l, ['scenes', i, 'layers', k]));
    const tr = s.transition as Record<string, unknown> | undefined;
    if (tr && typeof tr.text === 'string') add(['scenes', i, 'transition', 'text'], tr.text, 'big word the next scene shows through');
  });
  (Array.isArray(spec.audio) ? (spec.audio as Record<string, unknown>[]) : []).forEach((a, i) => {
    if (a.role === 'voice' && a.tts) add(['audio', i, 'script'], a.script, 'voiceover script, spoken aloud (also shown as captions)');
  });
  return out;
}

function getAt(obj: unknown, path: Path): unknown {
  let o = obj as Record<string | number, unknown> | undefined;
  for (const k of path) o = o?.[k] as Record<string | number, unknown> | undefined;
  return o;
}

function setAt(obj: unknown, path: Path, value: unknown): void {
  let o = obj as Record<string | number, unknown>;
  for (const k of path.slice(0, -1)) o = o[k] as Record<string | number, unknown>;
  o[path[path.length - 1]] = value;
}

/**
 * Puts translations back by path. A highlighted part that is no longer found in its line is dropped
 * (the line stays, uncolored) and reported.
 */
export function insertStrings(spec: Record<string, unknown>, strings: CopyString[], texts: string[]): { spec: Record<string, unknown>; dropped: string[] } {
  const out = structuredClone(spec);
  const dropped: string[] = [];
  const remove: Path[] = [];
  strings.forEach((s, i) => {
    const t = texts[i] ?? s.text;
    if (s.partOf !== undefined && !(texts[s.partOf] ?? strings[s.partOf].text).includes(t)) {
      dropped.push(`${fmt(s.path)}: "${t}" is not in "${texts[s.partOf]}"`);
      // highlight[i].text: remove the entry; timeline items[i].highlight: remove the field.
      remove.push(s.path[s.path.length - 1] === 'text' ? s.path.slice(0, -1) : s.path);
      return;
    }
    setAt(out, s.path, t);
  });
  // Last first, so array indices stay valid.
  for (const p of remove.sort((a, b) => fmt(b).localeCompare(fmt(a)))) {
    const parent = getAt(out, p.slice(0, -1));
    const k = p[p.length - 1];
    if (Array.isArray(parent) && typeof k === 'number') parent.splice(k, 1);
    else if (parent && typeof parent === 'object') delete (parent as Record<string | number, unknown>)[k];
  }
  return { spec: out, dropped };
}

// ---------------------------------------------------------------------------------------------
// Protected names and numbers

const COMMON = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'with', 'your', 'our', 'meet', 'new', 'launch', 'film', 'ad', 'video', 'teaser', 'promo', 'demo', 'intro', 'business', 'app', 'apps', 'team', 'teams', 'flow', 'story']);

/**
 * Names to keep as they are: given ones, words with inner capitals (GitHub, iPhone), domains, handles,
 * the product name from the browser URL or the title when the copy uses it, and brand.json's name.
 */
export function protectedNames(spec: Record<string, unknown>, strings: CopyString[], given: string[] = [], brandName?: string): string[] {
  const copy = strings.map((s) => s.text).join('\n');
  const out = new Set(given.filter(Boolean));
  if (brandName && copy.includes(brandName)) out.add(brandName);
  for (const m of copy.matchAll(/\b[A-Za-z]*[a-z][A-Z][A-Za-z0-9]*\b/g)) out.add(m[0]);
  for (const m of copy.matchAll(/(?:https?:\/\/)?\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:\/[^\s"]*)?/gi)) if (!/^\d/.test(m[0])) out.add(m[0]);
  for (const m of copy.matchAll(/[@#]\w+/g)) out.add(m[0]);
  const candidates: string[] = [];
  const visit = (v: unknown, key?: string) => {
    if (typeof v === 'string' && key === 'url') {
      const host = v.replace(/^https?:\/\//, '').split(/[/:]/)[0].replace(/^www\./, '').split('.')[0];
      if (host) candidates.push(host);
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  visit(spec);
  if (typeof spec.title === 'string') candidates.push(...spec.title.split(/[\s:,-]+/).filter((w) => /^[A-Z]/.test(w)));
  for (const c of candidates) {
    if (COMMON.has(c.toLowerCase()) || c.length < 3) continue;
    const re = new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const m = re.exec(copy);
    if (m && /^[A-Z]/.test(m[0])) out.add(m[0]);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Numbers in a string, as written. */
const numbers = (s: string) => s.match(/\d+(?:[.,:]\d+)*/g) ?? [];

/** What a translation lost: kept names and numbers of the source that are not in it. */
export function missingProtected(source: string, translation: string, keep: string[]): string[] {
  const out: string[] = [];
  for (const k of keep) if (source.includes(k) && !translation.includes(k)) out.push(k);
  for (const n of numbers(source)) if (!translation.includes(n)) out.push(n);
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------------------------
// The model

const ROLE = `You are a senior localization specialist for launch videos and SaaS ads. You translate on-screen copy so it reads as if it had been written in the target language: short, idiomatic, punchy, the tone of the original. You never explain; you reply with JSON only.`;

const RULES = `Rules:
- Translate every string in "strings" into the target language. Reply with one JSON array of objects {"id": <id>, "text": "<translation>"}, one per input id, and nothing else.
- Keep every name listed in "keep" exactly as written (brand and product names). Keep URLs, domains, email addresses, @handles, {{placeholders}} and every number exactly as written (do not reformat 1,200 or 4.9).
- Keep the length close to the original: on-screen lines must fit where the original fits. Prefer the shorter natural phrasing.
- Keep the punctuation style and line breaks (\\n) of the original. Keep a trailing period only if the original has one.
- A string with "partOf" is part of another string (highlighted words): its translation must appear exactly, character for character, inside the translation of that string.
- Strings are in the order they appear. Lines of the same scene are often one sentence split across lines ("When you work at a" / "small" / "business."): translate them so that, read in order, they form one natural sentence, each piece still standing on its own line.
- Strings that repeat the same words (a line and the next wording it morphs into) should share the same translated words where the original does.
- A voiceover script is spoken: write it to be read aloud naturally, and keep it about as long as the original.`;

function parseReply(reply: string): Map<number, string> {
  const a = reply.indexOf('[');
  const b = reply.lastIndexOf(']');
  if (a < 0 || b < a) throw new Error(`The translation reply had no JSON list: ${reply.slice(0, 200)}`);
  const list = JSON.parse(reply.slice(a, b + 1)) as { id: number; text: string }[];
  const out = new Map<number, string>();
  for (const x of list) if (typeof x?.id === 'number' && typeof x.text === 'string') out.set(x.id, x.text);
  return out;
}

export type BackendChoice = 'auto' | 'api' | 'claude-code';

function pickBackend(choice: BackendChoice, workDir: string, model?: string): Backend {
  const system = { role: ROLE, reference: RULES };
  const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (choice === 'api' || (choice === 'auto' && hasKey)) return new ApiBackend(system, 'medium');
  if (choice === 'claude-code' || ClaudeCodeBackend.available()) return new ClaudeCodeBackend(system, workDir, model ?? 'opus', 'medium');
  throw new Error('No way to reach Claude: set ANTHROPIC_API_KEY (or run `ant auth login`), or install and sign in to Claude Code to use --backend claude-code.');
}

/** Unique source strings sent to the model (identical copy is translated once), with their ids. */
function requestItems(strings: CopyString[]): { items: { id: number; text: string; where: string; scene?: number; partOf?: number }[]; idOf: number[] } {
  const idOf: number[] = [];
  const items: { id: number; text: string; where: string; scene?: number; partOf?: number }[] = [];
  const seen = new Map<string, number>();
  strings.forEach((s, i) => {
    const key = s.partOf === undefined ? s.text : `${s.text}\u0000${idOf[s.partOf]}`;
    let id = seen.get(key);
    if (id === undefined) {
      id = items.length + 1;
      seen.set(key, id);
      const scene = s.path[0] === 'scenes' ? (s.path[1] as number) + 1 : undefined;
      items.push({ id, text: s.text, where: s.kind, ...(scene ? { scene } : {}), ...(s.partOf !== undefined ? { partOf: idOf[s.partOf] } : {}) });
    }
    idOf[i] = id;
  });
  return { items, idOf };
}

async function translateStrings(backend: Backend, strings: CopyString[], lang: string, keep: string[], warnings: string[]): Promise<string[]> {
  const { items, idOf } = requestItems(strings);
  const payload = { language: languageName(lang), keep, strings: items };
  const first = await backend.send([{ type: 'text', text: `Translate into ${languageName(lang)} (${lang}).\n\n${JSON.stringify(payload, null, 1)}` }], `Translating ${items.length} strings into ${languageName(lang)}`);
  const got = parseReply(first);
  const problems: string[] = [];
  for (const it of items) {
    const t = got.get(it.id);
    if (t === undefined) problems.push(`id ${it.id}: missing`);
    else {
      const lost = missingProtected(it.text, t, keep);
      if (lost.length) problems.push(`id ${it.id}: keep ${lost.map((x) => `"${x}"`).join(', ')} exactly as written`);
      if (it.partOf !== undefined && got.has(it.partOf) && !got.get(it.partOf)!.includes(t)) problems.push(`id ${it.id}: must appear exactly inside the translation of id ${it.partOf}`);
    }
  }
  if (problems.length) {
    const fix = await backend.send([{ type: 'text', text: `Fix these and reply with the corrected JSON array for just these ids:\n${problems.join('\n')}` }], `Fixing ${problems.length} translations`);
    for (const [id, t] of parseReply(fix)) got.set(id, t);
    for (const it of items) {
      const t = got.get(it.id);
      if (t === undefined) warnings.push(`"${it.text}" was not translated; kept the original`);
      else {
        const lost = missingProtected(it.text, t, keep);
        if (lost.length) warnings.push(`"${t}" lost ${lost.map((x) => `"${x}"`).join(', ')}`);
      }
    }
  }
  return strings.map((s, i) => got.get(idOf[i]) ?? s.text);
}

// ---------------------------------------------------------------------------------------------
// Fit

export interface Measured {
  frame: { width: number; height: number };
  /** Per sample: the inspected items (visible text with boxes). */
  probes: { scene: string; items: InspectItem[] }[];
}

/** Renders a spec headlessly at a few samples per second and returns what is on screen. */
export async function measure(specPath: string): Promise<Measured> {
  const { check } = await import('./check');
  const r = await check(specPath, { rate: 5 });
  const spec = JSON.parse(await readFile(specPath, 'utf8')) as { width?: number; height?: number };
  return { frame: { width: spec.width ?? 1920, height: spec.height ?? 1080 }, probes: r.probes.map((p) => ({ scene: p.info.scene, items: p.info.items })) };
}

interface Span {
  key: string;
  scene: string;
  item: InspectItem;
  x0: number;
  x1: number;
  w: number;
  h: number;
}

const TEXT = new Set(['text', 'counter']);

/** Each text's widest extent over the video, keyed by scene and layer. */
function spans(m: Measured): Map<string, Span> {
  const out = new Map<string, Span>();
  for (const p of m.probes) {
    for (const it of p.items) {
      if (!TEXT.has(it.type) || it.opacity < 0.6) continue;
      const key = `${p.scene}|${it.uid}`;
      const b = it.box;
      const s = out.get(key);
      if (!s) out.set(key, { key, scene: p.scene, item: it, x0: b.x0, x1: b.x1, w: b.x1 - b.x0, h: b.y1 - b.y0 });
      else {
        s.x0 = Math.min(s.x0, b.x0);
        s.x1 = Math.max(s.x1, b.x1);
        s.w = Math.max(s.w, b.x1 - b.x0);
        s.h = Math.max(s.h, b.y1 - b.y0);
      }
    }
  }
  return out;
}

/** Pairs of layers that collide in at least two samples. */
async function collisions(m: Measured): Promise<Set<string>> {
  const { collision } = await import('./check');
  const count = new Map<string, number>();
  for (const p of m.probes) {
    const items = p.items;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (!collision(items[i], items[j], m.frame.width * m.frame.height)) continue;
        const k = `${p.scene}|${Math.min(items[i].uid, items[j].uid)}|${Math.max(items[i].uid, items[j].uid)}`;
        count.set(k, (count.get(k) ?? 0) + 1);
      }
    }
  }
  return new Set([...count].filter(([, n]) => n >= 2).map(([k]) => k));
}

/** A translated text that does not fit, and the share of its length it can keep. */
export interface Overflow {
  scene: string;
  path?: string;
  text?: string;
  reason: string;
  /** Budget as a share of the current width, 0-1. */
  ratio: number;
}

/** Layer types whose text sits in a box of their own size (they grow with it). */
const SELF_SIZED = new Set(['text', 'counter', 'button', 'badge']);

/**
 * Texts of the translated video that do not fit where the original's did: off the frame, much wider
 * (or taller) than the original inside a card or panel, or newly colliding with something.
 */
export async function findOverflows(orig: Measured, trans: Measured, spec: Record<string, unknown>): Promise<Overflow[]> {
  const W = trans.frame.width;
  const margin = W * 0.025;
  const a = spans(orig);
  const b = spans(trans);
  const before = await collisions(orig);
  const after = await collisions(trans);
  const fresh = new Map<string, number>();
  for (const k of after) {
    if (before.has(k)) continue;
    const [scene, u1, u2] = k.split('|');
    fresh.set(`${scene}|${u1}`, 1);
    fresh.set(`${scene}|${u2}`, 1);
  }
  const out: Overflow[] = [];
  for (const [key, t] of b) {
    const o = a.get(key);
    if (!o) continue;
    const typeAt = t.item.path ? (getAt(spec, parsePath(t.item.path)) as { type?: string } | undefined)?.type : undefined;
    const reasons: string[] = [];
    let ratio = 1;
    const left = t.x0 < margin && t.x0 < o.x0 - 1;
    const right = t.x1 > W - margin && t.x1 > o.x1 + 1;
    if (left || right) {
      const room = t.w - Math.max(0, margin - t.x0) - Math.max(0, t.x1 - (W - margin));
      ratio = Math.min(ratio, Math.max(0.3, room / t.w));
      reasons.push('runs off the frame');
    }
    const boxed = t.item.component !== undefined || (typeAt !== undefined && !SELF_SIZED.has(typeAt));
    if (boxed && typeAt !== 'button' && typeAt !== 'badge') {
      // Text in a panel usually wraps at the panel's width: much wider means it has no wrap and outgrows it.
      if (t.w > o.w * 1.6 + 4) {
        ratio = Math.min(ratio, (o.w * 1.6) / t.w);
        reasons.push(`${Math.round((t.w / o.w) * 100)}% of the original width in its ${typeAt ?? 'panel'}`);
      }
      if (t.h > o.h * 1.5 + 4) {
        ratio = Math.min(ratio, (o.h * 1.5) / t.h);
        reasons.push(`wraps to more lines in its ${typeAt ?? 'panel'}`);
      }
    }
    if (fresh.has(key)) {
      ratio = Math.min(ratio, 0.85);
      reasons.push('collides with another element');
    }
    if (reasons.length) out.push({ scene: t.scene, path: t.item.path, text: t.item.text, reason: reasons.join(', '), ratio });
  }
  return out;
}

function parsePath(s: string): Path {
  const out: Path = [];
  for (const m of s.matchAll(/([A-Za-z_$][\w$]*)|\[(\d+)\]/g)) out.push(m[1] !== undefined ? m[1] : Number(m[2]));
  return out;
}

/** The strings an overflowing item shows: direct fields of the layer at its path, matched by text. */
function stringsFor(o: Overflow, strings: CopyString[], texts: string[]): number[] {
  if (!o.path) return [];
  const prefix = `${o.path}.`;
  const idx = strings.map((s, i) => i).filter((i) => fmt(strings[i].path).startsWith(prefix) && strings[i].partOf === undefined && !fmt(strings[i].path).slice(prefix.length).includes('children'));
  if (idx.length <= 1 || !o.text) return idx;
  const exact = idx.filter((i) => texts[i] === o.text || (o.text ?? '').includes(texts[i]));
  return exact.length ? exact : idx;
}

/** Field that sets a layer's type size, and its default. */
const SIZE_FIELD: Record<string, [string, number]> = { text: ['size', 72], counter: ['size', 96], button: ['size', 22], badge: ['size', 18], chart: ['labelSize', 18] };

// ---------------------------------------------------------------------------------------------
// The command

export interface TranslateOptions {
  to: string[];
  /** Output folder (default: next to the spec). */
  outDir?: string;
  backend?: BackendChoice;
  model?: string;
  /** More names to keep untranslated. */
  keep?: string[];
  /** Measure and fix texts that no longer fit (default true). */
  fit?: boolean;
  /** For tests: the conversation for a language. */
  makeBackend?: (lang: string) => Backend;
  /** For tests: what the system voices are for a language. */
  voicesFor?: (lang: string) => Promise<string[]>;
}

export interface Change {
  path: string;
  from: string;
  to: string;
  reason: string;
}

export interface LanguageReport {
  lang: string;
  file: string;
  strings: number;
  shortened: Change[];
  resized: Change[];
  /** Texts that still do not fit after both rounds. */
  overflows: Overflow[];
  warnings: string[];
  font?: string;
}

export async function translate(specPath: string, o: TranslateOptions): Promise<LanguageReport[]> {
  const langs = o.to.map((l) => l.trim().toLowerCase()).filter(Boolean);
  if (!langs.length) throw new Error('Give the languages with --to, e.g. --to de,fr,ja');
  const rtl = langs.filter((l) => RTL_LANGS.has(l.split('-')[0]));
  if (rtl.length) {
    throw new Error(`Right-to-left languages are not supported: ${rtl.join(', ')}. The engine lays text out letter by letter from left to right (for its letter animations), so Hebrew and Arabic would come out reversed and Arabic letters would not join. Leave ${rtl.length > 1 ? 'them' : 'it'} out of --to.`);
  }
  const src = resolve(specPath);
  const raw = JSON.parse(await readFile(src, 'utf8')) as Record<string, unknown>;
  const v = validateVideo(raw);
  if (!v.ok) throw new Error(`Invalid spec:\n${v.errors.map((e) => `  - ${e}`).join('\n')}`);
  const specDir = dirname(src);
  const outDir = resolve(o.outDir ?? specDir);
  await mkdir(outDir, { recursive: true });
  const base = basename(src, extname(src));
  let brandName: string | undefined;
  try {
    brandName = (JSON.parse(await readFile(join(specDir, 'brand.json'), 'utf8')) as { name?: string }).name;
  } catch {
    // no brand file
  }
  const first = extractStrings(raw);
  const keep = protectedNames(raw, first, o.keep ?? [], brandName);
  const strings = extractStrings(raw, keep);
  if (!strings.length) throw new Error('Nothing to translate: the spec has no visible copy.');
  log.step(`${strings.length} strings to translate; keeping ${keep.length ? keep.map((k) => `"${k}"`).join(', ') : 'no names'} as written`);
  // Paths are rewritten for the output folder (a template's placeholders stay).
  const slots = Object.fromEntries(slotNames(raw).map((n) => [n, `{{${n}}}`]));
  const rebased = { ...fillTemplate(raw, slots, { templateDir: specDir, outDir }), ...(raw.slots ? { slots: raw.slots } : {}) };
  const fit = o.fit !== false;
  let orig: Measured | null = null;
  if (fit) {
    log.step('Measuring the original');
    orig = await measure(src);
  }
  const reports: LanguageReport[] = [];
  for (const lang of langs) {
    const warnings: string[] = [];
    const backend = o.makeBackend ? o.makeBackend(lang) : pickBackend(o.backend ?? 'auto', join(outDir, '.bemotion-translate', lang), o.model);
    log.step(`${languageName(lang)} (${lang}) with ${backend.name}`);
    let texts = await translateStrings(backend, strings, lang, keep, warnings);
    const file = join(outDir, `${base}.${lang}.json`);
    const voices = await voiceTracks(rebased, raw, lang, o.voicesFor, warnings);
    const build = () => {
      const { spec, dropped } = insertStrings(rebased, strings, texts);
      for (const [i, a] of voices) Object.assign((spec.audio as Record<string, unknown>[])[i], a);
      return { spec, dropped };
    };
    let { spec, dropped } = build();
    const write = async () => writeFile(file, JSON.stringify(spec, null, 2) + '\n');
    await write();
    const report: LanguageReport = { lang, file, strings: strings.length, shortened: [], resized: [], overflows: [], warnings };
    const all = strings.map((_, i) => texts[i]).join(' ');
    const script = cjkScript(all);
    if (script) report.font = CJK_FONT[script];
    if (/^zh-(tw|hk)/.test(lang)) warnings.push('Traditional Chinese letters missing from the bundled Noto Sans SC come from troika\'s online fallback fonts');
    if (!script && /[\u0e00-\u0e7f\u0900-\u097f]/.test(all)) warnings.push('Thai and Devanagari letters come from troika\'s online fallback fonts (renders need the network)');
    if (hasRtl(all)) warnings.push('Some translations contain right-to-left letters, which the engine does not lay out correctly');
    if (fit && orig) {
      let trans = await measure(file);
      let over = await findOverflows(orig, trans, spec);
      if (over.length) {
        // Round 1: shorter wording with a length budget.
        const ask = new Map<number, { budget: number; reason: string }>();
        for (const ov of over) {
          for (const i of stringsFor(ov, strings, texts)) {
            const budget = Math.max(2, Math.floor(texts[i].length * ov.ratio * 0.95));
            const prev = ask.get(i);
            if (!prev || budget < prev.budget) ask.set(i, { budget, reason: ov.reason });
          }
        }
        if (ask.size) {
          const list = [...ask].map(([i, a]) => ({ id: i + 1, original: strings[i].text, current: texts[i], maxChars: a.budget, problem: a.reason }));
          const reply = await backend.send([{ type: 'text', text: `These ${languageName(lang)} translations do not fit on screen. Give a shorter ${languageName(lang)} version of each, at most maxChars characters, same meaning and tone, names and numbers kept. Reply with a JSON array of {"id", "text"} for just these ids.\n\n${JSON.stringify(list, null, 1)}` }], `Shortening ${list.length} ${languageName(lang)} lines`);
          const got = parseReply(reply);
          for (const [i] of ask) {
            const t = got.get(i + 1);
            if (t === undefined || t === texts[i]) continue;
            const lost = missingProtected(strings[i].text, t, keep);
            if (lost.length) {
              warnings.push(`shorter "${t}" dropped ${lost.join(', ')}; kept "${texts[i]}"`);
              continue;
            }
            report.shortened.push({ path: fmt(strings[i].path), from: texts[i], to: t, reason: ask.get(i)!.reason });
            texts = texts.map((x, k) => (k === i ? t : x));
          }
          ({ spec, dropped } = build());
          await write();
          trans = await measure(file);
          over = await findOverflows(orig, trans, spec);
        }
      }
      // Round 2: a smaller type size, never below 75% of the original (measured again after each pass).
      const sizes = new Map<string, { key: string; from: number; to: number; reason: string }>();
      for (let pass = 0; pass < 3 && over.length; pass++) {
        let changed = false;
        for (const ov of over) {
          if (!ov.path) continue;
          const layer = getAt(spec, parsePath(ov.path)) as Record<string, unknown> | undefined;
          const field = layer && SIZE_FIELD[layer.type as string];
          if (!layer || !field) continue;
          const [key, def] = field;
          const now = typeof layer[key] === 'number' ? (layer[key] as number) : def;
          const first = sizes.get(ov.path)?.from ?? now;
          const want = now * (ov.reason.includes('lines') ? Math.sqrt(ov.ratio) : ov.ratio) * 0.97;
          const next = Math.round(Math.max(first * 0.75, want) * 10) / 10;
          if (next >= now - 0.05) continue;
          layer[key] = next;
          sizes.set(ov.path, { key, from: first, to: next, reason: ov.reason });
          changed = true;
        }
        if (!changed) break;
        await write();
        trans = await measure(file);
        over = await findOverflows(orig, trans, spec);
      }
      for (const [p, s] of sizes) report.resized.push({ path: `${p}.${s.key}`, from: String(s.from), to: String(s.to), reason: s.reason });
      report.overflows = over;
    }
    for (const d of dropped) warnings.push(`highlight dropped, ${d}`);
    log.info(`${languageName(lang)}: ${backend.summary()}`);
    reports.push(report);
  }
  return reports;
}

/**
 * Changes to voice tracks for a language: spoken (tts) tracks get their own file (vo.de.wav) and, with
 * the computer's voice, a voice that speaks the language when one is installed. Recordings are kept
 * (their script stays in the source language).
 */
async function voiceTracks(
  rebased: Record<string, unknown>, raw: Record<string, unknown>, lang: string,
  voicesFor: ((lang: string) => Promise<string[]>) | undefined, warnings: string[],
): Promise<[number, Record<string, unknown>][]> {
  const out: [number, Record<string, unknown>][] = [];
  const audio = Array.isArray(rebased.audio) ? (rebased.audio as Record<string, unknown>[]) : [];
  for (let i = 0; i < audio.length; i++) {
    const a = audio[i];
    if (a.role !== 'voice') continue;
    const orig = (raw.audio as Record<string, unknown>[])[i];
    if (!a.tts) {
      warnings.push(`voice track "${orig.src}" is a recording in the source language: it is kept as it is${a.script || raw.captions ? ', with its script and captions in the source language' : ''}. Record a translated voiceover, or use "tts"`);
      continue;
    }
    // Its own file, inside the translated spec's folder (a voice is only written inside its spec's folder).
    const s = String(orig.src).replace(/^(\.\.\/)+/, '');
    const ext = extname(s);
    const rel = `${s.slice(0, s.length - ext.length)}.${lang}${ext}`;
    const tts = (a.tts === true ? {} : { ...(a.tts as Record<string, unknown>) }) as Record<string, unknown>;
    const provider = (tts.provider as string | undefined) ?? 'system';
    if (provider === 'system') {
      const found = await (voicesFor ?? (async (l: string) => (await import('./tts')).systemVoicesFor(l)))(lang);
      if (found.length) tts.voice = found[0];
      else warnings.push(`no system voice for ${languageName(lang)} is installed: "${rel}" would be read by ${tts.voice ? `"${tts.voice}"` : 'the default voice'} in another language. Install a ${languageName(lang)} voice (Windows: Settings, Time and language, Speech), or use "provider": "elevenlabs" or "openai"`);
    } else if (provider === 'elevenlabs' && typeof tts.model === 'string' && !/multilingual|v3|flash_v2_5|turbo_v2_5/.test(tts.model)) {
      warnings.push(`ElevenLabs model "${tts.model}" may be English only; eleven_multilingual_v2 speaks ${languageName(lang)}`);
    }
    out.push([i, { src: rel, tts: Object.keys(tts).length ? tts : true }]);
  }
  return out;
}

/** The report as lines for the terminal. */
export function reportLines(r: LanguageReport): string[] {
  const out = [`${languageName(r.lang)}: ${r.file} (${r.strings} strings${r.font ? `, CJK letters in ${r.font}` : ''})`];
  for (const c of r.shortened) out.push(`  shortened ${c.path}: "${c.from}" -> "${c.to}" (${c.reason})`);
  for (const c of r.resized) out.push(`  smaller type ${c.path}: ${c.from} -> ${c.to} (${c.reason})`);
  for (const ov of r.overflows) out.push(`  still does not fit: ${ov.path ?? ov.scene} "${ov.text ?? ''}" (${ov.reason})`);
  for (const w of r.warnings) out.push(`  note: ${w}`);
  return out;
}
