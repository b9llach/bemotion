import { toSeconds } from './time';
import type { Video } from './schema';

/**
 * `"preset": "auto"` on a text layer's `animate` or `animateOut`. Resolves to concrete line styles so
 * consecutive lines never arrive (or leave) the same way, fitted to how long each line is on screen.
 *
 * It is a pure function of the spec: the same spec always resolves the same way, so editing one
 * scene in the preview never reshuffles the others unless their order really changed.
 */

/** Styles that read well for one word, and for phrases. Order is the rotation order. */
const SINGLE = ['focusPull', 'plop', 'depth', 'ripple', 'tipUp', 'scatter'];
const MULTI = ['push', 'plop', 'fromLeft', 'scatter', 'depth', 'fromRight', 'pushPop', 'ripple', 'focusPull', 'tipUp'];

/** The exit that carries on each entrance's motion. */
const EXIT_FOR: Record<string, string> = {
  push: 'riseOut',
  pushPop: 'collapse',
  plop: 'sinkOut',
  scatter: 'collapse',
  fromLeft: 'exitRight',
  fromRight: 'exitLeft',
  depth: 'recede',
  focusPull: 'riseOut',
  ripple: 'riseOut',
  tipUp: 'sinkOut',
};

/** Default timing per style (must match the engine's LINE_STYLES), used to fit a line's window. */
const TIMING: Record<string, { by: 'char' | 'word' | 'line'; duration: number; stagger: number }> = {
  push: { by: 'word', duration: 0.7, stagger: 0.14 },
  pushPop: { by: 'word', duration: 0.6, stagger: 0.12 },
  plop: { by: 'word', duration: 0.5, stagger: 0.1 },
  scatter: { by: 'word', duration: 0.45, stagger: 0.09 },
  fromLeft: { by: 'line', duration: 0.75, stagger: 0 },
  fromRight: { by: 'line', duration: 0.75, stagger: 0 },
  depth: { by: 'line', duration: 0.8, stagger: 0.1 },
  focusPull: { by: 'line', duration: 0.75, stagger: 0.1 },
  ripple: { by: 'char', duration: 0.6, stagger: 0.025 },
  tipUp: { by: 'char', duration: 0.7, stagger: 0.03 },
  riseOut: { by: 'line', duration: 0.32, stagger: 0 },
  sinkOut: { by: 'line', duration: 0.32, stagger: 0 },
  exitLeft: { by: 'line', duration: 0.38, stagger: 0 },
  exitRight: { by: 'line', duration: 0.38, stagger: 0 },
  recede: { by: 'line', duration: 0.36, stagger: 0 },
  collapse: { by: 'char', duration: 0.34, stagger: 0.012 },
};

/** Lines on screen for less than this (seconds) cut away instead of playing an automatic exit. */
const MIN_EXIT_WINDOW = 0.6;

export const AUTO_TEXT_STYLES = { entrances: MULTI, exits: [...new Set(Object.values(EXIT_FOR))] };

type Json = Record<string, any>;

function units(text: string, by: 'char' | 'word' | 'line'): number {
  if (by === 'char') return text.replace(/\s+/g, '').length;
  if (by === 'word') return text.split(/\s+/).filter(Boolean).length;
  return text.split('\n').length;
}

function hash(s: string): number {
  return [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
}

const isAuto = (a: unknown) => !!a && typeof a === 'object' && (a as Json).preset === 'auto';

/** Scales a style's timing down so the whole animation fits in `budget` seconds. */
function fit(style: string, text: string, budget: number, own: Json): Json {
  const t = TIMING[style];
  if (!t || own.duration !== undefined || own.stagger !== undefined) return {};
  const by = (own.by as 'char' | 'word' | 'line' | undefined) ?? t.by;
  const n = units(text, by);
  const total = t.duration + t.stagger * Math.max(0, n - 1);
  if (total <= budget) return {};
  const f = Math.max(0.2, budget / total);
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { duration: r(Math.max(0.22, t.duration * f)), stagger: r(t.stagger * f) };
}

export function resolveAutoText(video: Video): Video {
  const tctx = { fps: video.fps ?? 30, bpm: video.bpm };
  // Collect text layers in viewing order: scene by scene, then by start time, then tree order.
  const found: { layer: Json; scene: number; start: number; end: number; order: number }[] = [];
  let order = 0;
  const walk = (layers: Json[], scene: number, sceneDur: number) => {
    for (const l of layers) {
      if (l.type === 'text' && (isAuto(l.animate) || isAuto(l.animateOut))) {
        found.push({ layer: l, scene, start: toSeconds(l.start, tctx, 0), end: toSeconds(l.end, tctx, sceneDur), order: order++ });
      }
      if (Array.isArray(l.children)) walk(l.children, scene, sceneDur);
    }
  };
  if (!video.scenes.some((s) => JSON.stringify(s.layers).includes('"auto"'))) return video;
  const out = JSON.parse(JSON.stringify(video)) as Video;
  out.scenes.forEach((s, i) => walk(s.layers as Json[], i, toSeconds(s.duration, tctx)));
  found.sort((a, b) => a.scene - b.scene || a.start - b.start || a.order - b.order);

  // Each video starts the rotation somewhere different, so two ads never open the same way.
  const offset = hash(video.title ?? '');
  const cursor = { single: offset % SINGLE.length, multi: offset % MULTI.length };
  let previous = '';
  for (const f of found) {
    const l = f.layer;
    const text = String(l.text ?? '');
    const window = Math.max(0.2, f.end - f.start);
    let entrance = isAuto(l.animate) ? '' : (l.animate?.preset as string | undefined) ?? '';
    if (isAuto(l.animate)) {
      const one = units(text, 'word') <= 1;
      const list = one ? SINGLE : MULTI;
      const key = one ? 'single' : 'multi';
      entrance = list[cursor[key] % list.length];
      if (entrance === previous) entrance = list[++cursor[key] % list.length];
      cursor[key]++;
    }
    let exit = '';
    // Very short beats keep a hard cut: an exit would leave them no time on screen.
    if (isAuto(l.animateOut) && window < MIN_EXIT_WINDOW) delete l.animateOut;
    if (isAuto(l.animateOut)) exit = EXIT_FOR[entrance] ?? 'riseOut';
    // Leave the line on screen for a beat between its entrance and its exit.
    const exitTime = exit ? Math.min(TIMING[exit].duration, window * 0.25) : 0;
    if (isAuto(l.animateOut)) {
      const { preset: _p, ...own } = l.animateOut as Json;
      l.animateOut = { preset: exit, ...(own.duration === undefined ? { duration: Math.round(exitTime * 1000) / 1000 } : {}), ...own };
    }
    // Fit the entrance into what is left of the window, so it settles before the exit starts. A named
    // entrance is fitted too when the exit is automatic.
    if (isAuto(l.animate) || (exit && l.animate && TIMING[entrance])) {
      const { preset: _p, ...own } = l.animate as Json;
      const budget = Math.max(0.2, Math.min(window * 0.7, window - exitTime - 0.12));
      l.animate = { preset: entrance, ...fit(entrance, text, budget, own), ...own };
    }
    previous = entrance;
  }
  return out;
}
