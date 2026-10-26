import { toSeconds } from './time';
import { validateVideo } from './schema';

/**
 * Edit operations the visual editor applies to a spec. The same code runs in the browser (optimistic
 * live preview) and on the dev server (writes the file), so both always agree on the result.
 */
export type Path = (string | number)[];
export type EaseValue = string | [number, number, number, number];

export type EditOp =
  | { op: 'set'; path: Path; value: unknown }
  | { op: 'delete'; path: Path }
  | { op: 'key'; layer: Path; prop: string; t: number; v: number | number[] | string; ease?: EaseValue }
  | { op: 'unkey'; layer: Path; prop: string; t: number }
  | { op: 'retime'; layer: Path; prop?: string; t: number; to: number }
  | { op: 'ease'; layer: Path; prop: string; t: number; ease: EaseValue | null }
  | { op: 'insert'; path: Path; index?: number; value: Record<string, unknown> }
  | { op: 'remove'; path: Path }
  | { op: 'move'; path: Path; to: number };

type Json = Record<string, any>;

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const IDENT = /^[A-Za-z][A-Za-z0-9]*$/;

/** Rejects keys that could reach object prototypes, and anything that is not a plain string or index. */
function checkKey(key: unknown): asserts key is string | number {
  const bad =
    typeof key === 'number' ? !Number.isInteger(key) || key < 0 : typeof key !== 'string' || key.length === 0 || FORBIDDEN.has(key);
  if (bad) throw new Error(`Invalid path key: ${JSON.stringify(key)}`);
}

/**
 * Length of the layer prefix of a path: scenes.<n>.layers.<n>(.children.<n>)*. Returns 0 when the
 * path does not start with a layer.
 */
function layerPrefix(path: Path): number {
  if (path[0] !== 'scenes' || typeof path[1] !== 'number' || path[2] !== 'layers' || typeof path[3] !== 'number') return 0;
  let n = 4;
  while (path[n] === 'children' && typeof path[n + 1] === 'number') n += 2;
  return n;
}

function asPath(path: unknown): Path {
  if (!Array.isArray(path) || path.length > 40) throw new Error('Invalid path');
  path.forEach(checkKey);
  return path as Path;
}

/** A layer or something inside it: scenes.<n>.layers.<n>..., then identifier or index keys. */
function propPath(raw: unknown): Path {
  const path = asPath(raw);
  // The soundtrack settings (tracks, effects, the generated score) are the only edits allowed outside the layers.
  const n = path[0] === 'audio' || path[0] === 'sfx' || path[0] === 'score' ? 1 : layerPrefix(path);
  if (!n) throw new Error('Edits must target a layer (scenes.<n>.layers.<n>...), audio or sfx');
  for (const k of path.slice(n)) if (typeof k === 'string' && !IDENT.test(k)) throw new Error(`Invalid path key: ${JSON.stringify(k)}`);
  return path;
}

/** Exactly a layer: scenes.<n>.layers.<n>(.children.<n>)*. */
function layerPath(raw: unknown): Path {
  const path = asPath(raw);
  if (!layerPrefix(path) || layerPrefix(path) !== path.length) throw new Error('Expected a layer path');
  return path;
}

/** A layer list: scenes.<n>.layers or <layer>.children. */
function listPath(raw: unknown): Path {
  const path = asPath(raw);
  const top = path.length === 3 && path[0] === 'scenes' && typeof path[1] === 'number' && path[2] === 'layers';
  const kids = path[path.length - 1] === 'children' && layerPrefix(path.slice(0, -1)) === path.length - 1;
  if (!top && !kids) throw new Error('Expected a layer list path');
  return path;
}

function time(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 36000) throw new Error('Invalid time');
  return v;
}

function ease(v: unknown): EaseValue | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string' && v.length < 64) return v;
  if (Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n))) return v as EaseValue;
  throw new Error('Invalid ease');
}

function prop(v: unknown): string {
  if (typeof v !== 'string' || !IDENT.test(v)) throw new Error('Invalid property name');
  return v;
}

/** Validates the request body shape before anything touches the spec. */
export function parseOps(body: unknown): EditOp[] {
  const ops = (body as { ops?: unknown })?.ops;
  if (!Array.isArray(ops) || ops.length > 200) throw new Error('Expected { ops: [...] }');
  return ops.map((o: any): EditOp => {
    if (!o || typeof o !== 'object') throw new Error('Invalid op');
    switch (o.op) {
      case 'set':
        return { op: 'set', path: propPath(o.path), value: o.value };
      case 'delete':
        return { op: 'delete', path: propPath(o.path) };
      case 'key': {
        const v = o.v;
        const okV = typeof v === 'number' || typeof v === 'string' || (Array.isArray(v) && v.every((n: unknown) => typeof n === 'number'));
        if (!okV) throw new Error('Invalid keyframe value');
        const e = ease(o.ease);
        return { op: 'key', layer: layerPath(o.layer), prop: prop(o.prop), t: time(o.t), v, ...(e ? { ease: e } : {}) };
      }
      case 'unkey':
        return { op: 'unkey', layer: layerPath(o.layer), prop: prop(o.prop), t: time(o.t) };
      case 'retime':
        return { op: 'retime', layer: layerPath(o.layer), ...(o.prop !== undefined ? { prop: prop(o.prop) } : {}), t: time(o.t), to: time(o.to) };
      case 'ease':
        return { op: 'ease', layer: layerPath(o.layer), prop: prop(o.prop), t: time(o.t), ease: o.ease === null ? null : ease(o.ease)! };
      case 'insert': {
        const value = o.value;
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') throw new Error('Inserted layer needs a type');
        if (o.index !== undefined && (!Number.isInteger(o.index) || o.index < 0)) throw new Error('Invalid index');
        return { op: 'insert', path: listPath(o.path), ...(o.index !== undefined ? { index: o.index } : {}), value };
      }
      case 'remove':
        return { op: 'remove', path: layerPath(o.path) };
      case 'move':
        if (!Number.isInteger(o.to) || o.to < 0) throw new Error('Invalid index');
        return { op: 'move', path: layerPath(o.path), to: o.to };
      default:
        throw new Error(`Unknown op ${JSON.stringify(o.op)}`);
    }
  });
}

function walk(root: Json, path: Path, create: boolean): any {
  let node: any = root;
  for (const key of path) {
    checkKey(key);
    if (node === null || typeof node !== 'object') throw new Error(`Path not found: ${path.join('.')}`);
    if (!Object.prototype.hasOwnProperty.call(node, key)) {
      if (!create) throw new Error(`Path not found: ${path.join('.')}`);
      node[key] = {};
    }
    node = node[key];
  }
  return node;
}

/** Deep copy that drops prototype keys from user-supplied values. */
function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') {
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) if (!FORBIDDEN.has(k)) out[k] = clean(x);
    return out;
  }
  return v;
}

const round = (t: number) => Math.round(t * 1000) / 1000;

/**
 * Applies operations to a copy of `spec` and returns it. When the input was a valid video, the
 * result must be valid too, otherwise this throws with the validation errors.
 */
export function applyOps(spec: Json, ops: EditOp[], opts: { validate?: boolean } = {}): Json {
  const wasValid = opts.validate !== false && validateVideo(spec).ok;
  const out = structuredClone(spec) as Json;
  const tctx = { fps: out.fps ?? 30, bpm: out.bpm };
  // Two keys closer than half a frame are the same key.
  const tol = 0.5 / tctx.fps;
  const sec = (k: Json) => toSeconds(k.t, tctx);
  const keysOf = (layer: Json, name: string): Json[] | undefined => {
    const ks = layer.keyframes?.[name];
    return Array.isArray(ks) ? ks : undefined;
  };
  const tidy = (layer: Json, name: string) => {
    const ks = keysOf(layer, name);
    if (ks && !ks.length) delete layer.keyframes[name];
    if (layer.keyframes && !Object.keys(layer.keyframes).length) delete layer.keyframes;
  };
  for (const o of ops) {
    switch (o.op) {
      case 'set': {
        const parent = walk(out, o.path.slice(0, -1), true);
        parent[o.path[o.path.length - 1]] = clean(o.value);
        break;
      }
      case 'delete': {
        const parent = walk(out, o.path.slice(0, -1), false);
        const last = o.path[o.path.length - 1];
        if (Array.isArray(parent) && typeof last === 'number') parent.splice(last, 1);
        else delete parent[last];
        break;
      }
      case 'key': {
        const layer = walk(out, o.layer, false);
        layer.keyframes ??= {};
        const keys: Json[] = (layer.keyframes[o.prop] ??= []);
        const t = round(o.t);
        const hit = keys.find((k) => Math.abs(sec(k) - t) < tol);
        if (hit) {
          hit.v = clean(o.v);
          if (o.ease) hit.ease = o.ease;
        } else {
          keys.push({ t, v: clean(o.v), ...(o.ease ? { ease: o.ease } : {}) });
          keys.sort((a, b) => sec(a) - sec(b));
        }
        break;
      }
      case 'unkey': {
        const layer = walk(out, o.layer, false);
        const keys = keysOf(layer, o.prop);
        if (!keys) break;
        layer.keyframes[o.prop] = keys.filter((k) => Math.abs(sec(k) - o.t) >= tol);
        tidy(layer, o.prop);
        break;
      }
      case 'retime': {
        const layer = walk(out, o.layer, false);
        const names = o.prop ? [o.prop] : Object.keys(layer.keyframes ?? {});
        const to = round(o.to);
        for (const name of names) {
          const keys = keysOf(layer, name);
          if (!keys) continue;
          const moving = keys.filter((k) => Math.abs(sec(k) - o.t) < tol);
          if (!moving.length) continue;
          // A key already sitting at the destination is replaced by the one being moved.
          const kept = keys.filter((k) => !moving.includes(k) && Math.abs(sec(k) - to) >= tol);
          for (const k of moving) k.t = to;
          layer.keyframes[name] = [...kept, moving[0]].sort((a, b) => sec(a) - sec(b));
        }
        break;
      }
      case 'ease': {
        const layer = walk(out, o.layer, false);
        const hit = keysOf(layer, o.prop)?.find((k) => Math.abs(sec(k) - o.t) < tol);
        if (!hit) throw new Error(`No ${o.prop} keyframe at ${o.t}s`);
        if (o.ease === null) delete hit.ease;
        else hit.ease = o.ease;
        break;
      }
      case 'insert': {
        const list = walk(out, o.path, o.path[o.path.length - 1] === 'children');
        const arr: unknown[] = Array.isArray(list) ? list : [];
        if (!Array.isArray(list)) walk(out, o.path.slice(0, -1), false)[o.path[o.path.length - 1]] = arr;
        arr.splice(Math.min(o.index ?? arr.length, arr.length), 0, clean(o.value));
        break;
      }
      case 'remove': {
        const list = walk(out, o.path.slice(0, -1), false);
        const i = o.path[o.path.length - 1] as number;
        if (!Array.isArray(list) || i >= list.length) throw new Error(`Path not found: ${o.path.join('.')}`);
        list.splice(i, 1);
        break;
      }
      case 'move': {
        const list = walk(out, o.path.slice(0, -1), false);
        const i = o.path[o.path.length - 1] as number;
        if (!Array.isArray(list) || i >= list.length) throw new Error(`Path not found: ${o.path.join('.')}`);
        const [item] = list.splice(i, 1);
        list.splice(Math.min(o.to, list.length), 0, item);
        break;
      }
    }
  }
  if (wasValid) {
    const v = validateVideo(out);
    if (!v.ok) throw new Error(`Edit would make the spec invalid:\n${v.errors.slice(0, 6).join('\n')}`);
  }
  return out;
}

/** Serialized form written to disk; the browser compares against it to skip redundant reloads. */
export function serialize(spec: unknown): string {
  return JSON.stringify(spec, null, 2) + '\n';
}
