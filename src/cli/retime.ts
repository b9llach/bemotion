import { validateVideo, type Video } from '../spec/schema';
import { layoutScenes, toSeconds } from '../spec/time';
import { minScale, scaleScene, textSpans } from './cutdown';
import type { CheckResult, Rush } from './check';

/**
 * Automatic retiming for text that leaves before it can be read (`check`'s rushes).
 *
 * 1. Hold. For each rush with a small shortfall (up to `maxGap` seconds), time is inserted into its
 *    scene just before the lines start to leave (their exit animation, the end of the layer, or the
 *    next scene's transition): every moment at or after that point moves later by the shortfall plus
 *    a little, the scene gets longer by the same amount, and camera moves running across the point
 *    stretch. Larger shortfalls (a dense screen nobody reads in full) are left to the review.
 * 2. Pay it back. When the brief asks for a length and the video now runs past it, the scenes that
 *    got no extra time are scaled down together (as `cutdown` does), never below the time their own
 *    lines need, 80% of their length or 1 s. The end card is left alone.
 * 3. Sounds on the video timeline and those pinned to a scene follow their moments. Videos timed to a
 *    voiceover are not retimed (the voice sets when the lines arrive).
 */

type Json = any;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Fields of a layer that are moments in scene time (as in cutdown). */
const MOMENTS = ['start', 'end', 'at', 'press'];
/** Nested objects (or lists of them) whose `at`, `until` and `t` are moments. */
const NESTED = ['in', 'out', 'loop', 'animate', 'animateOut', 'motionPath', 'morph', 'focus', 'path'];
/** Shortest scale for the scenes that pay the time back. */
const PAY_SCALE = 0.8;

/** Moves every moment of a layer at or after scene time `at` later by `d`. `base` is when the layer's own time 0 falls in the scene. */
export function shiftLayer(layer: Json, at: number, d: number, sec: (v: unknown) => number, base = 0, newBase = 0): Json {
  if (!isObj(layer)) return layer;
  const out: Json = { ...layer };
  const F = (abs: number) => (abs >= at - 1e-6 ? abs + d : abs);
  const map = (v: unknown) => r3(F(base + sec(v)) - newBase);
  for (const k of MOMENTS) if (out[k] !== undefined) out[k] = map(out[k]);
  if (Array.isArray(out.clicks)) out.clicks = out.clicks.map(map);
  if (isObj(out.keyframes)) {
    out.keyframes = Object.fromEntries(Object.entries(out.keyframes).map(([p, ks]) =>
      [p, Array.isArray(ks) ? ks.map((k: Json) => (isObj(k) && k.t !== undefined ? { ...k, t: map(k.t) } : k)) : ks]));
  }
  const nested = (o: Json) => {
    if (!isObj(o)) return o;
    const c = { ...o };
    for (const k of ['at', 'until', 't']) if (c[k] !== undefined) c[k] = map(c[k]);
    if (Array.isArray(c.times)) c.times = c.times.map(map);
    return c;
  };
  for (const k of NESTED) {
    const v = out[k];
    if (Array.isArray(v)) out[k] = v.map(nested);
    else if (isObj(v)) out[k] = nested(v);
  }
  if (out.type === 'timeline' && Array.isArray(out.items)) out.items = out.items.map((it: Json) => (isObj(it) && it.time !== undefined ? { ...it, time: map(it.time) } : it));
  if (isObj(out.formats)) {
    out.formats = Object.fromEntries(Object.entries(out.formats).map(([f, o]) => [f, isObj(o) ? shiftLayer(o, at, d, sec, base, newBase) : o]));
  }
  if (Array.isArray(out.children)) {
    // Children count from the group's `delay`.
    const delay = layer.delay !== undefined ? sec(layer.delay) : 0;
    const childBase = base + delay;
    const childNew = layer.delay !== undefined ? newBase + (out.delay = r3(F(base + delay) - newBase)) : newBase;
    out.children = out.children.map((c: Json) => shiftLayer(c, at, d, sec, childBase, childNew));
  }
  return out;
}

function shiftCamera(cam: Json, at: number, d: number, sec: (v: unknown) => number): Json {
  if (!isObj(cam)) return cam;
  const out = { ...cam };
  const F = (t: number) => (t >= at - 1e-6 ? t + d : t);
  if (isObj(out.keyframes)) {
    out.keyframes = Object.fromEntries(Object.entries(out.keyframes).map(([p, ks]) =>
      [p, Array.isArray(ks) ? ks.map((k: Json) => (isObj(k) && k.t !== undefined ? { ...k, t: r3(F(sec(k.t))) } : k)) : ks]));
  }
  if (Array.isArray(out.moves)) {
    out.moves = out.moves.map((m: Json) => {
      if (!isObj(m)) return m;
      const c = { ...m };
      const start = sec(c.at ?? 0);
      if (c.at !== undefined) c.at = r3(F(start));
      // A move running across the inserted time stretches over it.
      if (c.duration !== undefined && start < at - 1e-6 && start + sec(c.duration) > at + 1e-6) c.duration = r3(sec(c.duration) + d);
      return c;
    });
  }
  return out;
}

/** A scene with `d` seconds inserted at scene time `at`. */
export function shiftScene(scene: Json, at: number, d: number, sec: (v: unknown) => number): Json {
  const out: Json = { ...scene, duration: r3(sec(scene.duration) + d) };
  if (out.camera) out.camera = shiftCamera(out.camera, at, d, sec);
  out.layers = (scene.layers ?? []).map((l: Json) => shiftLayer(l, at, d, sec));
  if (isObj(out.formats)) {
    out.formats = Object.fromEntries(Object.entries(out.formats).map(([f, o]) => {
      if (!isObj(o)) return [f, o];
      const c: Json = { ...o };
      if (c.duration !== undefined) c.duration = r3(sec(c.duration) + d);
      if (c.camera) c.camera = shiftCamera(c.camera, at, d, sec);
      if (Array.isArray(c.layers)) c.layers = c.layers.map((l: Json) => shiftLayer(l, at, d, sec));
      return [f, c];
    }));
  }
  return out;
}

export interface RetimeResult {
  spec: Json;
  /** One line per change, for the log and the review. */
  changes: string[];
  /** Rushes left alone, and why. */
  skipped: string[];
  original: number;
  length: number;
}

/** Index of the scene `check` names: its id, or "scene N" (0-based, as Engine.inspect names it). */
function sceneIndex(scenes: Json[], name: string): number {
  const i = scenes.findIndex((s) => s.id === name);
  if (i >= 0) return i;
  const m = /^scene (\d+)$/.exec(name);
  return m ? Number(m[1]) : -1;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Whether a retimed video measures better: fewer rushes, nothing else measured worse, and the length
 * no further from the asked one (beyond half a second).
 */
export function retimeHelped(a: CheckResult, b: CheckResult, asked?: number): boolean {
  const others = (c: CheckResult) => c.collisions.length + c.holds.length + c.unsafe.length + c.small.length + c.empty.length + c.stale.length + c.cropped.length + c.contrast.length + c.clicks.length;
  const miss = (c: CheckResult) => (asked ? Math.max(0, Math.abs(c.duration - asked) - 0.5) : 0);
  return b.rushes.length < a.rushes.length && others(b) <= others(a) && miss(b) <= miss(a) + 1e-6;
}

interface Insert { i: number; at: number; d: number; text: string }

/** Holds rushed text long enough to read, then pays the time back from other scenes when the brief sets a length. */
export function retimeRushes(raw: Json, rushes: Rush[], o: { asked?: number; maxGap?: number; read?: number } = {}): RetimeResult {
  const v = validateVideo(raw);
  if (!v.ok || !v.video) throw new Error(`Invalid spec:\n${v.errors.map((e) => `  - ${e}`).join('\n')}`);
  const video = v.video as Video;
  const ctx = { fps: video.fps ?? 30, bpm: video.bpm };
  const sec = (x: unknown) => toSeconds(x as never, ctx);
  const scenes: Json[] = raw.scenes;
  const sceneId = (i: number) => (typeof scenes[i].id === 'string' ? scenes[i].id : `scene ${i}`);
  const before = layoutScenes(video.scenes, ctx);
  const result: RetimeResult = { spec: raw, changes: [], skipped: [], original: r3(before.duration), length: r3(before.duration) };
  if ((raw.audio ?? []).some((a: Json) => a.role === 'voice')) {
    if (rushes.length) result.skipped.push('timed to a voiceover: not retimed');
    return result;
  }
  const maxGap = o.maxGap ?? 1.5;
  const lengthOf = (sc: Json[]) => layoutScenes(sc.map((s: Json) => ({ duration: sec(s.duration), transition: s.transition })), ctx).duration;
  const refIndex = (ref: string | number) => (typeof ref === 'number' ? ref : scenes.findIndex((s) => s.id === ref));

  // Where time could go in each scene, and how much.
  const candidates: Insert[] = [];
  for (const r of rushes) {
    const i = sceneIndex(scenes, r.scene);
    const shown = r.to - r.from;
    const short = r.need - shown;
    const name = r.texts.length ? `"${norm(r.texts[0]).slice(0, 40)}"${r.texts.length > 1 ? ` and ${r.texts.length - 1} more` : ''}` : 'text';
    if (i < 0 || i >= scenes.length) {
      result.skipped.push(`[${r.scene}] ${name}: scene not found`);
      continue;
    }
    if (shown < 0.4) {
      result.skipped.push(`[${r.scene}] ${name}: only passes through (${shown.toFixed(1)}s), a hold cannot fix it`);
      continue;
    }
    if (short > maxGap) {
      result.skipped.push(`[${r.scene}] ${name}: needs ${short.toFixed(1)}s more, too much to hold (cut words or give the scene a beat)`);
      continue;
    }
    const start = before.scenes[i].start;
    const dur = before.scenes[i].duration;
    const localTo = r.to - start;
    // The lines' exit as the spec writes it: the earliest end among them near where check saw them go,
    // never before they are all on screen.
    const texts = new Set(r.texts.map(norm));
    const spans = textSpans(scenes[i].layers ?? [], dur, sec).filter((s) => texts.has(norm(s.text)) && Math.abs(s.to - localTo) < 1);
    let at = spans.length ? Math.min(...spans.map((s) => s.to)) : localTo - 0.4;
    at = Math.min(Math.max(at, r.from - start + 0.2, 0), dur);
    const d = r3(short + 0.2);
    const near = candidates.find((x) => x.i === i && Math.abs(x.at - at) < 0.3);
    if (near) near.d = Math.max(near.d, d);
    else candidates.push({ i, at, d, text: name });
  }
  if (!candidates.length) return result;

  /** The spec with time inserted, sounds following. */
  const insert = (list: Insert[]): Json => {
    const out: Json = JSON.parse(JSON.stringify(raw));
    for (const x of [...list].sort((a, b) => a.i - b.i || b.at - a.at)) out.scenes[x.i] = shiftScene(out.scenes[x.i], x.at, x.d, sec);
    if (Array.isArray(out.sounds)) {
      const global = list.map((x) => ({ t: before.scenes[x.i].start + x.at, d: x.d }));
      out.sounds = out.sounds.map((snd: Json) => {
        if (!isObj(snd) || snd.at === undefined) return snd;
        const at = sec(snd.at);
        if (snd.scene !== undefined) {
          const i = refIndex(snd.scene);
          return { ...snd, at: r3(at + list.filter((x) => x.i === i && x.at <= at + 1e-6).reduce((a, x) => a + x.d, 0)) };
        }
        return { ...snd, at: r3(at + global.filter((g) => g.t <= at + 1e-6).reduce((a, g) => a + g.d, 0)) };
      });
    }
    return out;
  };
  /** How far each scene that got no time may shrink to pay it back (1: not at all). */
  const floors = (out: Json, list: Insert[]): number[] => {
    const n = out.scenes.length;
    return out.scenes.map((s: Json, i: number) => {
      if (i === n - 1 || list.some((x) => x.i === i)) return 1;
      const d = sec(s.duration);
      const next = out.scenes[i + 1]?.transition;
      const tail = isObj(next) && next.type !== 'cut' ? sec(next.duration ?? 0.5) : 0;
      return Math.min(1, Math.max(PAY_SCALE, minScale(s.layers, d, sec, o.read ?? 4, tail) * 1.08, 1 / d));
    });
  };
  const shrunk = (out: Json, scales: number[]) => out.scenes.map((s: Json, i: number) => ({ ...s, duration: sec(s.duration) * scales[i] }));

  // Smallest holds first, while the time can be paid back (or, with no length asked, up to 10% longer).
  const limit = o.asked ? Math.max(o.asked + 0.25, before.duration) : before.duration * 1.1;
  const accepted: Insert[] = [];
  for (const c of [...candidates].sort((a, b) => a.d - b.d)) {
    const trial = [...accepted, c];
    const out = insert(trial);
    const least = o.asked ? lengthOf(shrunk(out, floors(out, trial))) : lengthOf(out.scenes);
    if (least <= limit + 1e-6) accepted.push(c);
    else result.skipped.push(`[${sceneId(c.i)}] ${c.text}: no time to pay back elsewhere for ${c.d.toFixed(1)}s more`);
  }
  if (!accepted.length) return result;
  let out = insert(accepted);
  for (const x of [...accepted].sort((a, b) => a.i - b.i || a.at - b.at)) result.changes.push(`[${sceneId(x.i)}] held ${x.text} ${x.d.toFixed(1)}s longer (time inserted at ${x.at.toFixed(2)}s of the scene)`);

  // Pay the time back when the brief sets the length: one pace for the scenes that got none.
  let len = lengthOf(out.scenes);
  if (o.asked && len > o.asked + 0.25) {
    const fl = floors(out, accepted);
    const scalesAt = (k: number) => fl.map((f) => (f >= 1 ? 1 : Math.min(1, Math.max(f, k))));
    let lo = 0;
    let hi = 1;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      if (lengthOf(shrunk(out, scalesAt(mid))) > o.asked) hi = mid;
      else lo = mid;
    }
    const scales = scalesAt(lo);
    const startsBefore = layoutScenes(out.scenes.map((s: Json) => ({ duration: sec(s.duration), transition: s.transition })), ctx).scenes;
    const paid: string[] = [];
    out = {
      ...out,
      scenes: out.scenes.map((s: Json, i: number) => {
        if (scales[i] >= 0.999) return s;
        paid.push(`${sceneId(i)} ${Math.round((1 - scales[i]) * 100)}%`);
        return scaleScene(s, scales[i], sec);
      }),
    };
    const startsAfter = layoutScenes(out.scenes.map((s: Json) => ({ duration: sec(s.duration), transition: s.transition })), ctx).scenes;
    if (Array.isArray(out.sounds)) {
      out.sounds = out.sounds.map((snd: Json) => {
        if (!isObj(snd) || snd.at === undefined) return snd;
        const at = sec(snd.at);
        if (snd.scene !== undefined) return { ...snd, at: r3(at * scales[refIndex(snd.scene)]) };
        const i = startsBefore.reduce((best, tm) => (tm.start <= at + 1e-6 ? tm.index : best), 0);
        return { ...snd, at: r3(startsAfter[i].start + (at - startsBefore[i].start) * scales[i]) };
      });
    }
    if (paid.length) result.changes.push(`shortened ${paid.join(', ')} to keep the length near ${o.asked}s`);
    len = lengthOf(out.scenes);
  }
  const ok = validateVideo(out);
  if (!ok.ok) throw new Error(`The retimed spec does not validate:\n${ok.errors.map((e) => `  - ${e}`).join('\n')}`);
  result.spec = out;
  result.length = r3(len);
  return result;
}
