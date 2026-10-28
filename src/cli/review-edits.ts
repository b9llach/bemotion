/**
 * Edits a reviewer sends back instead of a whole spec: a few changes to a 20-30 KB spec are written
 * in seconds, where rewriting the spec takes minutes. Paths are written the way check findings name
 * layers: `scenes[2].layers[4].children[1].x`.
 *
 *   { "edits": [
 *     { "set": "scenes[2].layers[4].x", "value": 120 },
 *     { "delete": "scenes[1].layers[3].out" },
 *     { "insert": "scenes[2].layers", "index": 5, "value": { "type": "text", ... } },
 *     { "remove": "scenes[2].layers[7]" }
 *   ] }
 *
 * Edits apply in order, each to the spec as the edits before it left it.
 */

type Json = any;
export type Path = (string | number)[];

export type ReviewEdit =
  | { set: string; value: unknown }
  | { delete: string }
  | { insert: string; index?: number; value: unknown }
  | { remove: string };

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

/** `scenes[2].layers[4].x` to ['scenes', 2, 'layers', 4, 'x']. */
export function parsePath(s: string): Path {
  if (typeof s !== 'string' || s.length > 400 || !/^[A-Za-z_]\w*(\[\d+\]|\.[A-Za-z_]\w*)*$/.test(s)) throw new Error(`Invalid path: ${JSON.stringify(s)}`);
  const out: Path = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]|(\.)/g;
  let m: RegExpExecArray | null;
  let at = 0;
  while ((m = re.exec(s))) {
    if (m.index !== at) break;
    at = re.lastIndex;
    if (m[1] !== undefined) {
      if (FORBIDDEN.has(m[1])) throw new Error(`Invalid path key: ${m[1]}`);
      out.push(m[1]);
    } else if (m[2] !== undefined) out.push(Number(m[2]));
  }
  if (at !== s.length || !out.length) throw new Error(`Invalid path: ${s}`);
  return out;
}

function walk(root: Json, path: Path, what: string): Json {
  let node = root;
  for (const k of path) {
    if (node === null || typeof node !== 'object' || !(k in node)) throw new Error(`${what}: nothing at ${fmt(path)}`);
    node = node[k];
  }
  return node;
}

export function fmt(path: Path): string {
  return path.map((k, i) => (typeof k === 'number' ? `[${k}]` : i ? `.${k}` : k)).join('');
}

/** Applies edits to a copy of the spec; throws on the first edit that does not fit, naming it. */
export function applyReviewEdits(spec: Json, edits: unknown[]): Json {
  if (!Array.isArray(edits) || edits.length > 300) throw new Error('Expected { "edits": [...] } with at most 300 edits');
  const out = structuredClone(spec);
  edits.forEach((e: Json, i) => {
    const where = `edit ${i + 1}`;
    if (!e || typeof e !== 'object') throw new Error(`${where}: not an object`);
    if (typeof e.set === 'string') {
      const p = parsePath(e.set);
      const parent = walk(out, p.slice(0, -1), where);
      if (parent === null || typeof parent !== 'object') throw new Error(`${where}: ${e.set} is inside a value, not an object`);
      if (e.value === undefined) throw new Error(`${where}: set needs a value`);
      parent[p[p.length - 1]] = e.value;
    } else if (typeof e.delete === 'string' || typeof e.remove === 'string') {
      const p = parsePath(e.delete ?? e.remove);
      const parent = walk(out, p.slice(0, -1), where);
      const last = p[p.length - 1];
      if (parent === null || typeof parent !== 'object' || !(last in parent)) throw new Error(`${where}: nothing at ${fmt(p)}`);
      if (Array.isArray(parent) && typeof last === 'number') parent.splice(last, 1);
      else delete parent[last];
    } else if (typeof e.insert === 'string') {
      const p = parsePath(e.insert);
      const list = walk(out, p, where);
      if (!Array.isArray(list)) throw new Error(`${where}: ${e.insert} is not a list`);
      if (e.value === undefined) throw new Error(`${where}: insert needs a value`);
      const index = e.index === undefined ? list.length : e.index;
      if (!Number.isInteger(index) || index < 0 || index > list.length) throw new Error(`${where}: index ${index} is outside ${e.insert} (length ${list.length})`);
      list.splice(index, 0, e.value);
    } else throw new Error(`${where}: expected "set", "delete", "insert" or "remove"`);
  });
  return out;
}

/** What a reply carries: edits, a whole spec, or neither. */
export function readReply(raw: string | null): { edits?: unknown[]; spec?: Json; error?: string } {
  if (!raw) return {};
  let parsed: Json;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: `JSON syntax error: ${(e as Error).message}` };
  }
  if (parsed && Array.isArray(parsed.edits)) return { edits: parsed.edits };
  if (Array.isArray(parsed)) return { edits: parsed };
  if (parsed && Array.isArray(parsed.scenes)) return { spec: parsed };
  return { error: 'The JSON is neither { "edits": [...] } nor a complete spec.' };
}

/** How to write edits, for the prompts that ask for them. */
export const EDITS_FORMAT = `Reply with only the changes, as one json code block:

\`\`\`json
{ "edits": [
  { "set": "scenes[2].layers[4].x", "value": 120 },
  { "set": "scenes[1].duration", "value": 4.2 },
  { "delete": "scenes[1].layers[3].out" },
  { "insert": "scenes[2].layers", "index": 5, "value": { "type": "text", "text": "New line" } },
  { "remove": "scenes[2].layers[7]" }
] }
\`\`\`

Paths name keys and list positions as the findings do (scenes[2].layers[4].children[1]). "set" replaces whatever is at the path (a number, a string, an object or a whole layer) and adds a missing key; "insert" adds to a list at "index" (the end when left out); "remove" or "delete" drops a list item or key. Edits apply in order, each to the spec as the edits before it left it, so after removing or inserting a list item the positions after it shift: put removals last, from the highest index down. Only when the changes would rewrite most of the spec, return the complete spec instead.`;
