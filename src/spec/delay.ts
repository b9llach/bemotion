/**
 * `delay` on a layer with children: everything inside runs that many seconds later. The engine builds
 * the children from copies with their times moved (`shiftTimes`), so every layer type, preset and
 * component reads plain scene-local times.
 */

type Json = any;

/** Fields of a layer that are moments in scene time. */
const MOMENTS = ['start', 'end', 'at', 'press'];
/** Nested objects (or lists of them) whose `at`, `until` and `t` are moments. */
const NESTED = ['in', 'out', 'loop', 'animate', 'animateOut', 'motionPath', 'morph', 'focus', 'path'];

/**
 * A copy of one layer spec with its own moments moved by `dt` seconds (children are left alone: the
 * engine moves each as it builds it, after components expand). `seconds` turns a time value ("12f",
 * "4b", 1.5) into seconds. Durations, staggers, `trim` and text `times` (counted from `at`) stay.
 */
export function shiftTimes(layer: Json, dt: number, seconds: (v: unknown) => number): Json {
  if (!dt || !layer || typeof layer !== 'object') return layer;
  const out: Json = { ...layer };
  const move = (v: unknown) => seconds(v) + dt;
  for (const k of MOMENTS) if (out[k] !== undefined) out[k] = move(out[k]);
  if (Array.isArray(out.clicks)) out.clicks = out.clicks.map(move);
  if (out.keyframes && typeof out.keyframes === 'object') {
    out.keyframes = Object.fromEntries(Object.entries(out.keyframes).map(([p, ks]) =>
      [p, Array.isArray(ks) ? ks.map((k: Json) => ({ ...k, t: move(k.t) })) : ks]));
  }
  const nested = (o: Json) => {
    if (!o || typeof o !== 'object') return o;
    const c = { ...o };
    for (const k of ['at', 'until', 't']) if (c[k] !== undefined) c[k] = move(c[k]);
    return c;
  };
  for (const k of NESTED) {
    const v = out[k];
    if (Array.isArray(v)) out[k] = v.map(nested);
    else if (v && typeof v === 'object') out[k] = nested(v);
  }
  return out;
}

/** Total `delay` of the layers that contain the one at `path` (a JSON path into the video). */
export function delayAt(video: Json, path: (string | number)[], seconds: (v: unknown) => number): number {
  let node = video;
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    node = node?.[path[i]];
    if (path[i + 1] === 'children' && node?.delay !== undefined) total += seconds(node.delay);
  }
  return total;
}
