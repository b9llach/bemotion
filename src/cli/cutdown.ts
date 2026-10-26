import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { validateVideo, type Video } from '../spec/schema';
import { layoutScenes, toSeconds } from '../spec/time';
import { applyFormat } from '../spec/formats';
import { findingLines, wordCount, type CheckResult } from './check';

/**
 * Cutdowns: shorter versions (15 s, 6 s) of a longer ad, as specs of their own.
 *
 * 1. Choose scenes. The first scene (the hook) and the last (logo and call to action) always stay. The
 *    others are ranked by what they carry: the product's name, the tagline of the end card, a number
 *    (proof), and what their id says (a reveal or the product on screen beats setting up the problem).
 *    They are added best first while the cut still fits at a comfortable pace (85% of their length).
 * 2. Retime. Kept scenes are scaled to fill the length: every moment inside (layer start and end,
 *    animation `at`, keyframe times, `delay`, camera moves) scales with the scene, so everything stays
 *    in step. Short animations (0.8 s or less: entrances, pops) keep their speed; longer ones scale but
 *    not below 0.8 s. No scene is scaled below the time its lines need to be read (`read` words per
 *    second, as `check` measures) or below 40% of its length.
 * 3. Clean up. Shared elements whose partner was cut lose `share`; a mask transition that started over
 *    a layer of a scene that is gone starts at the center; `sounds` pinned to cut scenes go; a voiceover
 *    (and its captions) is left out, since it narrates the full ad; `score.energy` follows the scenes.
 *    Music with `sync` keeps working (the warp is worked out when the video plays), and a generated
 *    score plans itself from the new scene list.
 */

type Json = any;

export interface CutOptions {
  /** Target length in seconds. */
  length: number;
  /** Scene ids (or indexes) to keep instead of choosing. */
  keep?: string[];
  /** Reading speed, words per second (default 4, as check). */
  read?: number;
}

export interface SceneChoice {
  index: number;
  id: string;
  duration: number;
  score: number;
  reasons: string[];
  kept: boolean;
  /** Why it was kept or dropped, in a few words. */
  why: string;
  /** Shortest duration its text allows. */
  min: number;
  /** New duration and scale, when kept. */
  newDuration?: number;
  scale?: number;
}

export interface CutResult {
  spec: Json;
  target: number;
  /** Length of the cut. */
  length: number;
  original: number;
  choices: SceneChoice[];
  notes: string[];
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const sceneName = (s: Json, i: number) => (typeof s.id === 'string' ? s.id : `scene ${i}`);

/** Shortest time an animation keeps when its scene is compressed. */
const KEEP_SPEED = 0.8;
/** No scene is compressed below this share of its length. */
const MIN_SCALE = 0.4;
/** Nor below this many seconds. */
const MIN_SCENE = 1;
/** Pace used when deciding whether one more scene fits. */
const COMFORT = 0.85;

/** Fields of a layer that are moments in scene time (`delay` too: children run that much later). */
const MOMENTS = ['start', 'end', 'at', 'press', 'delay'];
/** Nested objects (or lists of them) whose `at`, `until` and `t` are moments (as in src/spec/delay.ts). */
const NESTED = ['in', 'out', 'loop', 'animate', 'animateOut', 'motionPath', 'morph', 'focus', 'path'];

/** Scales every moment of a layer (and its children) by `s`; see the file comment for durations. */
export function scaleLayer(layer: Json, s: number, sec: (v: unknown) => number): Json {
  if (!isObj(layer) || s === 1) return layer;
  const out: Json = { ...layer };
  const at = (v: unknown) => r3(sec(v) * s);
  const dur = (v: unknown) => {
    const d = sec(v);
    return d <= KEEP_SPEED ? v : r3(Math.max(KEEP_SPEED, d * s));
  };
  for (const k of MOMENTS) if (out[k] !== undefined) out[k] = at(out[k]);
  if (out.duration !== undefined) out.duration = dur(out.duration);
  if (Array.isArray(out.clicks)) out.clicks = out.clicks.map(at);
  if (isObj(out.keyframes)) {
    out.keyframes = Object.fromEntries(Object.entries(out.keyframes).map(([p, ks]) =>
      [p, Array.isArray(ks) ? ks.map((k: Json) => (isObj(k) && k.t !== undefined ? { ...k, t: at(k.t) } : k)) : ks]));
  }
  const nested = (o: Json) => {
    if (!isObj(o)) return o;
    const c = { ...o };
    for (const k of ['at', 'until', 't']) if (c[k] !== undefined) c[k] = at(c[k]);
    if (c.duration !== undefined) c.duration = dur(c.duration);
    if (Array.isArray(c.times)) c.times = c.times.map(at);
    return c;
  };
  for (const k of NESTED) {
    const v = out[k];
    if (Array.isArray(v)) out[k] = v.map(nested);
    else if (isObj(v)) out[k] = nested(v);
  }
  // Timeline items: `time` is when one lands (their `at` is a place on the axis, not a time).
  if (out.type === 'timeline' && Array.isArray(out.items)) out.items = out.items.map((it: Json) => (isObj(it) && it.time !== undefined ? { ...it, time: at(it.time) } : it));
  if (isObj(out.formats)) {
    out.formats = Object.fromEntries(Object.entries(out.formats).map(([f, o]) => [f, isObj(o) ? scaleLayer(o, s, sec) : o]));
  }
  if (Array.isArray(out.children)) out.children = out.children.map((c: Json) => scaleLayer(c, s, sec));
  return out;
}

function scaleCamera(cam: Json, s: number, sec: (v: unknown) => number): Json {
  if (!isObj(cam) || s === 1) return cam;
  const out = { ...cam };
  if (isObj(out.keyframes)) {
    out.keyframes = Object.fromEntries(Object.entries(out.keyframes).map(([p, ks]) =>
      [p, Array.isArray(ks) ? ks.map((k: Json) => (isObj(k) && k.t !== undefined ? { ...k, t: r3(sec(k.t) * s) } : k)) : ks]));
  }
  if (Array.isArray(out.moves)) {
    out.moves = out.moves.map((m: Json) => {
      if (!isObj(m)) return m;
      const c = { ...m };
      if (c.at !== undefined) c.at = r3(sec(c.at) * s);
      if (c.duration !== undefined) {
        const d = sec(c.duration);
        if (d > KEEP_SPEED) c.duration = r3(Math.max(KEEP_SPEED, d * s));
      }
      return c;
    });
  }
  return out;
}

/** A scene with its length and every moment inside scaled by `s`. */
export function scaleScene(scene: Json, s: number, sec: (v: unknown) => number): Json {
  if (s === 1) return scene;
  const out: Json = { ...scene, duration: r3(sec(scene.duration) * s) };
  if (out.camera) out.camera = scaleCamera(out.camera, s, sec);
  out.layers = (scene.layers ?? []).map((l: Json) => scaleLayer(l, s, sec));
  if (isObj(out.formats)) {
    out.formats = Object.fromEntries(Object.entries(out.formats).map(([f, o]) => {
      if (!isObj(o)) return [f, o];
      const c: Json = { ...o };
      if (c.duration !== undefined) c.duration = r3(sec(c.duration) * s);
      if (c.camera) c.camera = scaleCamera(c.camera, s, sec);
      if (Array.isArray(c.layers)) c.layers = c.layers.map((l: Json) => scaleLayer(l, s, sec));
      return [f, c];
    }));
  }
  return out;
}

export interface TextSpan {
  text: string;
  words: number;
  from: number;
  to: number;
}

/** Text layers that repeat by design (a pattern, a ticker); their lines are not read one by one. */
const REPEATING = new Set(['repeat', 'marquee']);

/**
 * When each line of type in a scene can be read: from when it (or a parent) starts or its entrance
 * begins, to when it ends or its exit begins, in scene seconds, with `delay` applied. Morphs split a
 * line into the texts it turns into. Type under 12 px is left out (UI text inside a mock can still be
 * large on screen when the camera is close, so the line is lower than check's on-screen 14 px).
 */
export function textSpans(layers: Json[], sceneDuration: number, sec: (v: unknown) => number): TextSpan[] {
  const out: TextSpan[] = [];
  const first = (v: Json) => (Array.isArray(v) ? v[0] : v);
  const walk = (list: Json[], off: number, lo: number, hi: number) => {
    for (const l of list ?? []) {
      if (!isObj(l)) continue;
      let st = Math.max(lo, l.start !== undefined ? off + sec(l.start) : lo);
      let en = Math.min(hi, l.end !== undefined ? off + sec(l.end) : hi);
      for (const a of [first(l.in), first(l.animate)]) if (isObj(a) && a.at !== undefined) st = Math.max(st, off + sec(a.at));
      for (const a of [first(l.out), first(l.animateOut)]) if (isObj(a) && a.at !== undefined) en = Math.min(en, off + sec(a.at));
      if (en <= st) continue;
      if (l.type === 'text' && typeof l.text === 'string' && (l.size ?? 72) >= 12) {
        const texts: { text: string; at: number }[] = [{ text: l.text, at: st }];
        if (Array.isArray(l.morph)) for (const m of l.morph) if (isObj(m) && typeof m.text === 'string') texts.push({ text: m.text, at: off + sec(m.at) });
        texts.forEach((t, i) => {
          const a = Math.max(st, t.at);
          const b = Math.min(en, i + 1 < texts.length ? texts[i + 1].at : en);
          if (b - a > 0.05) out.push({ text: t.text, words: wordCount(t.text), from: a, to: b });
        });
      }
      if (Array.isArray(l.children) && !REPEATING.has(l.type)) walk(l.children, off + (l.delay !== undefined ? sec(l.delay) : 0), st, en);
    }
  };
  walk(layers, 0, 0, sceneDuration);
  return out;
}

/**
 * Lowest scale a scene takes while its text stays readable, with check's model: lines that leave
 * together (within 0.35 s) are one page, found in 0.4 s and read in the order they appear at `read`
 * words per second. Entrances keep their speed, so only the moments scale. A page the scene already
 * does not give enough time (a dense mock UI behind the message) is a backdrop and sets no limit.
 * `tail` is the length of the transition out of the scene.
 */
export function minScale(layers: Json[], sceneDuration: number, sec: (v: unknown) => number, read = 4, tail = 0): number {
  const lines = textSpans(layers, sceneDuration, sec).sort((a, b) => a.to - b.to);
  /** Lowest scale at which a page is read in time, or -1 when it is not even at full length. */
  const pageNeed = (page: TextSpan[]): number => {
    const to = Math.max(...page.map((s) => s.to));
    const fits = (k: number) => {
      let finish = k * page[0].from + 0.4;
      for (const s of page) finish = Math.max(finish, k * s.from) + s.words / read;
      // Lines still up at the end leave when the next scene's transition starts (it does not scale);
      // 0.25 s for the entrance to become legible.
      return finish + 0.25 <= k * to - (to >= sceneDuration - 0.05 ? tail : 0) + 0.05;
    };
    if (!fits(1)) return -1;
    let lo = 0;
    let hi = 1;
    for (let it = 0; it < 30; it++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  let need = 0;
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j].to - lines[j - 1].to <= 0.35) j++;
    const page = lines.slice(i, j).sort((a, b) => a.from - b.from);
    i = j;
    const k = pageNeed(page);
    if (k >= 0) {
      need = Math.max(need, k);
      continue;
    }
    // The page as a whole is a backdrop; lines that arrive later (within 0.35 s of each other) are
    // still the message and are read on their own.
    for (let a = 0; a < page.length; ) {
      let b = a + 1;
      while (b < page.length && page[b].from - page[b - 1].from <= 0.35) b++;
      const kk = pageNeed(page.slice(a, b));
      if (kk >= 0) need = Math.max(need, kk);
      a = b;
    }
  }
  return Math.min(1, need);
}

/** Every string a viewer reads in a scene (text, labels, titles of components). */
function sceneTexts(layers: Json[]): string[] {
  const out: string[] = [];
  const keys = new Set(['text', 'label', 'title', 'subtitle', 'body', 'detail', 'heading', 'caption', 'name', 'value']);
  const walk = (v: Json, key?: string) => {
    if (typeof v === 'string') {
      if (key && keys.has(key) && /[A-Za-z0-9]/.test(v)) out.push(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) if (k !== 'formats') walk(x, k);
  };
  walk(layers);
  return out;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'your', 'you', 'our', 'from', 'that', 'this', 'are', 'its', 'made', 'every', 'more', 'less', 'all', 'one', 'into', 'out']);
const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(?<=[a-z]{3})s$/, '')) ?? [];

/** The product's name: a capitalized word of the title that also appears on screen, else the end card's first word. */
export function productName(video: Json): string | undefined {
  const all = (video.scenes ?? []).flatMap((s: Json) => sceneTexts(s.layers)).join(' \n ').toLowerCase();
  for (const w of String(video.title ?? '').split(/[^A-Za-z0-9.]+/)) {
    if (w.length >= 3 && /^[A-Z0-9]/.test(w) && all.includes(w.toLowerCase())) return w;
  }
  const last = video.scenes?.[video.scenes.length - 1];
  const t = last ? sceneTexts(last.layers)[0] : undefined;
  return t?.split(/\s+/)[0];
}

/** Scene id words and what they say about the scene's role. */
const ROLES: [RegExp, number, string][] = [
  [/reveal|introduc|meet|solution|answer|launch/, 2.5, 'reveals the product'],
  [/product|demo|app|dashboard|feature|ui|screen|workflow|how/, 2, 'shows the product'],
  [/stat|proof|result|social|testimonial|trust|number|metric/, 1, 'proof'],
  [/problem|pain|setup|before|context|turn|why|chaos|old/, -1, 'sets up the problem'],
];

/** Ranks the middle scenes. Higher is kept first. */
export function rankScenes(video: Json): { score: number; reasons: string[] }[] {
  const scenes: Json[] = video.scenes;
  const product = productName(video)?.toLowerCase();
  const last = scenes[scenes.length - 1];
  const lastTexts = textSpans(last.layers, Infinity, () => 0).map((t) => t.text);
  // The tagline: end card lines that are not the name or a web address.
  const tagline = new Set(lastTexts.filter((t) => !/\.[a-z]{2,}\b/i.test(t) && (!product || t.toLowerCase().trim() !== product)).flatMap(words));
  return scenes.map((s, i) => {
    const reasons: string[] = [];
    let score = 0;
    if (i === 0) return { score: 100, reasons: ['first scene (the hook)'] };
    if (i === scenes.length - 1) return { score: 100, reasons: ['last scene (logo and call to action)'] };
    const texts = sceneTexts(s.layers);
    const joined = texts.join(' \n ');
    const lower = joined.toLowerCase();
    if (product && new RegExp(`\\b${product.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) {
      score += 3;
      reasons.push(`names the product (${productName(video)})`);
    }
    const shared = [...new Set(words(joined))].filter((w) => tagline.has(w));
    if (shared.length) {
      score += Math.min(2, shared.length);
      reasons.push(`echoes the tagline (${shared.slice(0, 3).join(', ')})`);
    }
    if (/\b(introducing|meet)\b/.test(lower)) {
      score += 2;
      reasons.push('introduces the product');
    }
    if (/\d/.test(joined) && /\d+(\.\d+)?\s*(%|x\b|k\b|\+|hours|minutes|seconds|days)|\b\d{2,}/i.test(joined)) {
      score += 1;
      reasons.push('has a number (proof)');
    }
    const id = String(s.id ?? '').toLowerCase();
    for (const [re, pts, why] of ROLES) {
      if (re.test(id)) {
        score += pts;
        reasons.push(`id "${s.id}": ${why}`);
        break;
      }
    }
    if (!reasons.length) reasons.push('no product name, tagline or number');
    return { score, reasons };
  });
}

/** One scene of the plan: which source scene, at what scale. */
interface ScenePick { index: number; scale: number }

/** Length of a cut, with its transitions overlapping as in layoutScenes. */
function cutLength(video: Json, picks: ScenePick[], sec: (v: unknown) => number, ctx: { fps: number; bpm?: number }): number {
  const scenes = picks.map((p, j) => ({
    duration: sec(video.scenes[p.index].duration) * p.scale,
    transition: j === 0 ? undefined : video.scenes[p.index].transition,
  }));
  return layoutScenes(scenes, ctx).duration;
}

/** Plans and builds one cutdown of a raw (validated) spec. */
export function cutdown(raw: Json, opts: CutOptions): CutResult {
  const v = validateVideo(raw);
  if (!v.ok || !v.video) throw new Error(`Invalid spec:\n${v.errors.map((e) => `  - ${e}`).join('\n')}`);
  const video = v.video as Video;
  const ctx = { fps: video.fps ?? 30, bpm: video.bpm };
  const sec = (x: unknown) => toSeconds(x as never, ctx);
  const read = opts.read ?? 4;
  const target = opts.length;
  if (!(target > 0)) throw new Error('The length must be a positive number of seconds');
  const scenes: Json[] = raw.scenes;
  const n = scenes.length;
  const original = layoutScenes(video.scenes, ctx);
  const durs = scenes.map((s) => sec(s.duration));
  const mins = scenes.map((s, i) => {
    const next = scenes[i + 1]?.transition;
    const tail = isObj(next) && next.type !== 'cut' ? sec(next.duration ?? 0.5) : 0;
    const k = Math.max(MIN_SCALE, minScale(s.layers, durs[i], sec, read, tail), Math.min(1, MIN_SCENE / durs[i]));
    return k;
  });
  const ranks = rankScenes(raw);
  const choices: SceneChoice[] = scenes.map((s, i) => ({
    index: i, id: sceneName(s, i), duration: durs[i], score: ranks[i].score, reasons: ranks[i].reasons, kept: false, why: '', min: r3(durs[i] * mins[i]),
  }));

  // Which scenes.
  let kept: number[];
  if (opts.keep?.length) {
    kept = [];
    for (const ref of opts.keep) {
      const i = /^\d+$/.test(ref) && !scenes.some((s) => s.id === ref) ? Number(ref) : scenes.findIndex((s) => s.id === ref);
      if (!(i >= 0 && i < n)) throw new Error(`--keep: no scene "${ref}"`);
      if (!kept.includes(i)) kept.push(i);
    }
    kept.sort((a, b) => a - b);
    for (const i of kept) choices[i].why = 'asked for (--keep)';
  } else {
    kept = n > 1 ? [0, n - 1] : [0];
    choices[0].why = ranks[0].reasons[0];
    if (n > 1) choices[n - 1].why = ranks[n - 1].reasons[0];
    const order = [...Array(n).keys()].slice(1, n - 1).sort((a, b) => ranks[b].score - ranks[a].score || a - b);
    order.forEach((i, rank) => {
      const trial = [...kept, i].sort((a, b) => a - b);
      const comfy = cutLength(raw, trial.map((j) => ({ index: j, scale: Math.max(mins[j], COMFORT) })), sec, ctx);
      const place = `ranked ${rank + 1} of ${order.length}`;
      if (comfy <= target + 0.25) {
        kept = trial;
        choices[i].why = place;
      } else choices[i].why = `${place}; does not fit`;
    });
  }
  for (const i of kept) choices[i].kept = true;

  // How fast: one pace k for all kept scenes, each held to its readable minimum.
  const picksAt = (k: number): ScenePick[] => kept.map((i) => ({ index: i, scale: Math.min(1, Math.max(mins[i], k)) }));
  const lenAt = (k: number) => cutLength(raw, picksAt(k), sec, ctx);
  let k = 1;
  if (lenAt(1) > target) {
    let lo = 0;
    let hi = 1;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      if (lenAt(mid) > target) hi = mid;
      else lo = mid;
    }
    k = lo;
  }
  const picks = picksAt(k);
  const notes: string[] = [];

  // Build the spec.
  const out: Json = JSON.parse(JSON.stringify(raw));
  out.scenes = picks.map((p) => scaleScene(JSON.parse(JSON.stringify(scenes[p.index])), p.scale, sec));
  picks.forEach((p, j) => {
    const c = choices[p.index];
    c.scale = r3(p.scale);
    c.newDuration = r3(sec(out.scenes[j].duration));
  });
  // Transitions: the first scene comes in on nothing; a scene that now follows another scene keeps its
  // own entrance, but a mask cannot start over a layer that is no longer there.
  if (out.scenes[0]?.transition) delete out.scenes[0].transition;
  out.scenes.forEach((s: Json, j: number) => {
    const tr = s.transition;
    if (j === 0 || !isObj(tr) || tr.type !== 'mask' || !tr.from) return;
    if (!hasId(out.scenes[j - 1].layers, tr.from)) {
      notes.push(`${sceneName(s, j)}: the mask transition starts at the center, not over "${tr.from}" (the scene with it was cut)`);
      delete tr.from;
    }
  });
  notes.push(...cleanShares(out));
  // Index references to scenes move with them.
  const newIndex = new Map(picks.map((p, j) => [p.index, j]));
  const scaleOf = new Map(picks.map((p) => [p.index, p.scale]));
  const refIndex = (ref: string | number): number => (typeof ref === 'number' ? ref : scenes.findIndex((s) => s.id === ref));
  if (Array.isArray(out.sounds)) {
    const before = out.sounds.length;
    out.sounds = out.sounds.flatMap((snd: Json) => {
      let i: number;
      let at = sec(snd.at);
      if (snd.scene !== undefined) i = refIndex(snd.scene);
      else {
        // A sound on the video timeline: pin it to the scene it plays in.
        i = original.scenes.reduce((best, tm) => (tm.start <= at + 1e-6 ? tm.index : best), 0);
        at -= original.scenes[i].start;
      }
      if (!newIndex.has(i)) return [];
      return [{ ...snd, at: r3(at * scaleOf.get(i)!), scene: typeof scenes[i].id === 'string' ? scenes[i].id : newIndex.get(i) }];
    });
    if (out.sounds.length < before) notes.push(`${before - out.sounds.length} sound${before - out.sounds.length > 1 ? 's' : ''} of cut scenes left out`);
    if (!out.sounds.length) delete out.sounds;
  }
  if (isObj(out.score?.energy)) {
    const e: Record<string, number> = {};
    for (const [ref, val] of Object.entries(out.score.energy as Record<string, number>)) {
      const i = scenes.some((s) => s.id === ref) ? refIndex(ref) : /^\d+$/.test(ref) ? Number(ref) : -1;
      if (!newIndex.has(i)) continue;
      e[scenes.some((s) => s.id === ref) ? ref : String(newIndex.get(i))] = val;
    }
    if (Object.keys(e).length) out.score.energy = e;
    else delete out.score.energy;
  }
  if (Array.isArray(out.audio)) {
    const keep = out.audio.filter((a: Json) => (a.role ?? 'music') === 'music');
    const dropped = out.audio.length - keep.length;
    if (dropped) {
      notes.push(`left out ${dropped} voice or effect track${dropped > 1 ? 's' : ''}: timed to the full-length ad`);
      if (out.captions) {
        delete out.captions;
        notes.push('captions left out with the voiceover');
      }
    }
    if (keep.length) out.audio = keep;
    else delete out.audio;
  }
  const length = layoutScenes(out.scenes.map((s: Json) => ({ duration: sec(s.duration), transition: s.transition })), ctx).duration;
  const check = validateVideo(out);
  if (!check.ok) throw new Error(`The cutdown does not validate:\n${check.errors.map((e) => `  - ${e}`).join('\n')}`);
  return { spec: out, target, length: r3(length), original: r3(original.duration), choices, notes };
}

function hasId(layers: Json[], id: string): boolean {
  for (const l of layers ?? []) {
    if (!isObj(l)) continue;
    if (l.id === id) return true;
    if (Array.isArray(l.children) && hasId(l.children, id)) return true;
  }
  return false;
}

/** Removes `share` from layers whose partner (same name in the scene before or after, across a transition that overlaps) was cut. */
export function cleanShares(video: Json): string[] {
  const notes: string[] = [];
  const names = (layers: Json[]): Set<string> => {
    const s = new Set<string>();
    const walk = (list: Json[]) => {
      for (const l of list ?? []) {
        if (!isObj(l)) continue;
        if (typeof l.share === 'string' && l.share) s.add(l.share);
        if (Array.isArray(l.children)) walk(l.children);
      }
    };
    walk(layers);
    return s;
  };
  const scenes: Json[] = video.scenes;
  const sets = scenes.map((s) => names(s.layers));
  const flows = (j: number) => j > 0 && j < scenes.length && isObj(scenes[j].transition) && scenes[j].transition.type !== 'cut';
  scenes.forEach((s, i) => {
    const strip = (list: Json[]) => {
      for (const l of list ?? []) {
        if (!isObj(l)) continue;
        if (typeof l.share === 'string' && l.share) {
          const paired = (flows(i) && sets[i - 1].has(l.share)) || (flows(i + 1) && sets[i + 1].has(l.share));
          if (!paired) {
            notes.push(`${sceneName(s, i)}: "${l.share}" is no longer shared (no partner in the scene next to it)`);
            delete l.share;
          }
        }
        if (Array.isArray(l.children)) strip(l.children);
      }
    };
    strip(s.layers);
  });
  return notes;
}

/** Rewrites relative file paths (`src`, font files) of a spec moved from `fromDir` to `toDir`. */
export function rebasePaths(spec: Json, fromDir: string, toDir: string): Json {
  if (resolve(fromDir) === resolve(toDir)) return spec;
  const move = (p: string) => (/^(https?:|data:|\/)/.test(p) || isAbsolute(p) || /\{\{/.test(p) ? p : relative(toDir, resolve(fromDir, p)).replace(/\\/g, '/'));
  const walk = (v: Json, key?: string): Json => {
    if (typeof v === 'string') return key === 'src' ? move(v) : v;
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  const out = walk(spec);
  if (isObj(out.fonts)) {
    for (const [fam, f] of Object.entries(out.fonts as Record<string, Json>)) {
      out.fonts[fam] = typeof f === 'string' ? move(f) : isObj(f) ? Object.fromEntries(Object.entries(f).map(([w, p]) => [w, typeof p === 'string' ? move(p) : p])) : f;
    }
  }
  if (typeof out.environment === 'string' && /\.(hdr|exr)$/i.test(out.environment)) out.environment = move(out.environment);
  return out;
}

export interface CutFile extends CutResult {
  path: string;
}

/** Writes one cutdown per length as `<name>.cut<length>.json` in `outDir` (default: next to the spec). */
export async function cutdownFiles(specPath: string, lengths: number[], o: { outDir?: string; keep?: string[]; read?: number; formats?: string[] } = {}): Promise<CutFile[]> {
  const src = resolve(specPath);
  const raw = JSON.parse(await readFile(src, 'utf8'));
  const dir = resolve(o.outDir ?? dirname(src));
  await mkdir(dir, { recursive: true });
  const name = basename(src, extname(src));
  const out: CutFile[] = [];
  for (const len of lengths) {
    const r = cutdown(raw, { length: len, keep: o.keep, read: o.read });
    const spec = rebasePaths(r.spec, dirname(src), dir);
    for (const f of o.formats ?? []) {
      if (f === '16:9') continue;
      const fv = validateVideo(applyFormat(spec, f).spec);
      if (!fv.ok) throw new Error(`The ${len}s cutdown does not validate at ${f}:\n${fv.errors.map((e) => `  - ${e}`).join('\n')}`);
    }
    const path = join(dir, `${name}.cut${String(len).replace('.', '_')}.json`);
    if (path === src) throw new Error('The cutdown would overwrite its source');
    await writeFile(path, JSON.stringify(spec, null, 2) + '\n');
    out.push({ ...r, spec, path });
  }
  return out;
}

/**
 * check's findings for a cutdown, each marked when the full-length ad has the same problem (same scene,
 * same lines or layers), so what the cut made worse stands out.
 */
export function comparedFindings(cut: Pick<CheckResult, 'collisions' | 'holds' | 'rushes'>, source: Pick<CheckResult, 'collisions' | 'holds' | 'rushes'>): string[] {
  const rushKey = (x: CheckResult['rushes'][number]) => `${x.scene}|${x.texts[0]}`;
  const hitKey = (x: CheckResult['collisions'][number]) => `${x.scene}|${x.a}|${x.b}`;
  const known = new Set([...source.rushes.map(rushKey), ...source.collisions.map(hitKey)]);
  const mark = (line: string, k: string) => (known.has(k) ? `${line} (also in the full ad)` : line);
  return [
    ...cut.rushes.map((x) => mark(findingLines({ rushes: [x], collisions: [], holds: [] })[0], rushKey(x))),
    ...cut.collisions.map((x) => mark(findingLines({ rushes: [], collisions: [x], holds: [] })[0], hitKey(x))),
    ...cut.holds.map((x) => findingLines({ rushes: [], collisions: [], holds: [x] })[0]),
  ];
}
