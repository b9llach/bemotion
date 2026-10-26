import type { Layer, TimelineLayer } from '../../spec/schema';
import type { EngineContext } from '../context';
import { estimateWidth } from './measure';
import { group } from './index';

type L = Layer & Record<string, any>;

/** Label block heights above (or below) the axis, by level. */
const LEVEL = (k: number, size: number) => size * 3.8 + k * size * 4;

interface Placed {
  side: 'up' | 'down';
  level: number;
  x0: number;
  x1: number;
}

/**
 * A timeline: an axis from `from` to `to` that draws on, ticks and value labels, then items that land
 * on it one after another. A point (`at`) gets a dot, a stem and a label; a range (`from`/`to`) gets a
 * band on the axis. Labels pick a level and a side of their stem so none overlap each other or another
 * item's stem.
 */
export function timeline(s: TimelineLayer, ctx: EngineContext): L {
  const W = s.width ?? 1600;
  const span = s.to - s.from || 1;
  const X = (v: number) => -W / 2 + ((v - s.from) / span) * W;
  const size = s.size ?? 34;
  const detailSize = Math.round(size * 0.66);
  const ink = s.color ?? '$text';
  const muted = s.muted ?? '$muted';
  const line = s.line ?? '$border';
  const accent = s.accent ?? '$primary';
  const at = ctx.time(s.at, ctx.time(s.start, 0));
  const dur = ctx.time(s.duration, 0.9);
  const step = s.ticks ?? 1;
  const labelStep = s.labelStep ?? 5;
  const valueSize = Math.round(size * 0.58);
  const labelled = new Set(s.labels ?? []);
  const fmt = (v: number) => `${s.prefix ?? ''}${Number.isInteger(v) ? v : v.toFixed(1)}${s.suffix ?? ''}`;

  const kids: L[] = [];
  // The axis grows from its left end; ticks and values fade in as it passes them.
  kids.push({ type: 'shape', x: -W / 2, width: W, height: 2, fill: line, anchor: 'left', origin: 'left', start: at, in: { preset: 'growX', duration: dur, ease: 'inOutCubic' } } as L);
  for (let v = s.from, i = 0; v <= s.to + 1e-9 && i < 400; v += step, i++) {
    const t = at + ((v - s.from) / span) * dur;
    const major = s.labels ? labelled.has(v) : Math.abs((v - s.from) / labelStep - Math.round((v - s.from) / labelStep)) < 1e-6;
    kids.push({ type: 'shape', x: X(v), width: 2, height: major ? 14 : 8, fill: line, start: t, in: { preset: 'fade', duration: 0.2 } } as L);
    if (major) kids.push({ type: 'text', text: fmt(v), x: X(v), y: -valueSize * 1.8, size: valueSize, weight: 500, color: muted, start: t, in: { preset: 'fade', duration: 0.3 } } as L);
  }
  if (s.axisLabel) {
    kids.push({ type: 'text', text: s.axisLabel, x: -W / 2, y: valueSize * 2, size: valueSize, weight: 500, color: muted, anchor: 'left', align: 'left', start: at, in: { preset: 'fade', duration: 0.3 } } as L);
  }

  // Items land after the axis, `stagger` apart, unless they say when.
  const stagger = ctx.time(s.stagger, 0.5);
  const items = s.items.map((it, i) => ({ it, t: it.time !== undefined ? ctx.time(it.time) : at + dur + 0.1 + i * stagger, x: X(it.at ?? it.from ?? s.from) }));
  const points = items.filter((p) => p.it.at !== undefined);
  const placed: Placed[] = [];
  const blockWidth = (it: TimelineLayer['items'][number]) => Math.max(estimateWidth(it.label, size), it.detail ? estimateWidth(it.detail, detailSize) : 0);

  /** Where a label can go: within the axis, clear of labels on its level and of stems it would cover. */
  const fits = (x: number, side: 'up' | 'down', level: number, x0: number, x1: number, self: unknown): boolean => {
    if (x0 < -W / 2 - size || x1 > W / 2 + size) return false;
    for (const p of placed) {
      if (p.side !== side) continue;
      if (p.level === level && x0 < p.x1 + 24 && x1 > p.x0 - 24) return false;
      // This item's stem passes through lower labels on its side.
      if (p.level < level && x > p.x0 - 8 && x < p.x1 + 8) return false;
    }
    // The label covers another point's stem unless that point sits on a lower level.
    for (const q of points) {
      if (q.it === self) continue;
      const qSide = q.it.side ?? 'up';
      if (qSide !== side || q.x < x0 - 8 || q.x > x1 + 8) continue;
      const qp = placedFor.get(q.it);
      if (!qp || qp.level >= level) return false;
    }
    return true;
  };
  const placedFor = new Map<unknown, Placed>();

  // Consecutive labels arrive differently ("auto" is resolved before components expand).
  const DIRS = ['up', 'left', 'down', 'right'] as const;
  let n = 0;
  for (const { it, t, x } of items) {
    const isRange = it.at === undefined;
    const side: 'up' | 'down' = it.side ?? (isRange ? 'down' : 'up');
    const w = blockWidth(it);
    let choice: Placed | undefined;
    for (let level = 0; level < 5 && !choice; level++) {
      const options: [number, number][] = isRange ? [[x, x + w]] : [[x + 16, x + 16 + w], [x - 16 - w, x - 16]];
      for (const [x0, x1] of options) {
        if (fits(x, side, level, x0, x1, it)) {
          choice = { side, level, x0, x1 };
          break;
        }
      }
    }
    choice ??= { side, level: 0, x0: x + 16, x1: x + 16 + w };
    placed.push(choice);
    placedFor.set(it, choice);

    const color = it.color ?? accent;
    const top = LEVEL(choice.level, size);
    if (isRange) {
      const x1 = X(it.to ?? it.from ?? s.from);
      kids.push({ type: 'shape', x: x, width: Math.max(4, x1 - x), height: 12, radius: 6, fill: color, anchor: 'left', origin: 'left', start: t, in: { preset: 'growX', duration: 0.8, ease: 'inOutCubic' } } as L);
    } else {
      kids.push({ type: 'shape', x, width: 2, height: top, fill: line, anchor: side === 'up' ? 'bottom' : 'top', origin: side === 'up' ? 'bottom' : 'top', start: t, in: { preset: 'growY', duration: 0.45, ease: 'outQuart' } } as L);
      kids.push({ type: 'shape', shape: 'circle', x, width: 16, height: 16, fill: it.color ?? ink, start: Math.max(0, t - 0.05), in: { preset: 'popIn', duration: 0.4 } } as L);
    }
    const leftAligned = isRange || choice.x0 > x;
    const tx = leftAligned ? choice.x0 : choice.x1;
    const anchor = leftAligned ? 'left' : 'right';
    // Above the axis the title sits at the top of the stem; below, under the values row.
    const titleY = side === 'up' ? top - size * 0.1 : -(top - size * 0.4);
    kids.push({ type: 'text', text: it.label, x: tx, y: titleY, size, weight: 600, color: ink, anchor, align: anchor, start: t + 0.15, animate: { preset: 'lift', by: 'word', direction: DIRS[n++ % DIRS.length], distance: size * 0.6 } } as L);
    if (it.detail) {
      kids.push({
        type: 'text', text: it.detail, x: tx, y: titleY - size * 1.25, size: detailSize, weight: 500, color: muted, anchor, align: anchor,
        start: t + 0.3, animate: { preset: 'lift', by: 'line', direction: 'none', blur: 8 }, ...(it.highlight ? { highlight: [{ text: it.highlight, color: accent }] } : {}),
      } as L);
    }
  }
  return group(s, kids, { width: W, height: LEVEL(2, size) * 2 });
}
