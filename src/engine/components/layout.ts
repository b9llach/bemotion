/**
 * Automatic layout: a `stack` places its children in a row or a column with a gap, padding and
 * alignment, sized to fit them (or to a fixed width and height), so specs never compute positions by
 * hand. Sizes are measured from the specs before anything loads: shapes, images and components by
 * their dimensions, text by an estimate of its width (`estimateWidth`) and its wrapped lines. Text is
 * anchored at the edge the stack aligns it to, so an estimate that is a little off only changes how
 * far it reaches, never where it starts.
 */
import type { EngineContext } from '../context';
import { estimateWidth } from './measure';
import { counterFinalText } from '../layers/text';

type L = Record<string, any>;

/** A layer's size and where its box center sits relative to its x/y. */
export interface Box { w: number; h: number; cx: number; cy: number }

/** Copies made while laying out, mapped to the spec objects they came from (for paths in the JSON). */
const aliases = new WeakMap<object, object>();
export function aliasOf(o: object): object | undefined {
  return aliases.get(o);
}
function copyOf(o: L, extra: L): L {
  const c = { ...o, ...extra };
  aliases.set(c, aliases.get(o) ?? o);
  return c;
}

const ORIGINS: Record<string, [number, number]> = {
  center: [0, 0], left: [-0.5, 0], right: [0.5, 0], top: [0, 0.5], bottom: [0, -0.5],
  'top-left': [-0.5, 0.5], 'top-right': [0.5, 0.5], 'bottom-left': [-0.5, -0.5], 'bottom-right': [0.5, -0.5],
};

/** Width of one line of text, letter spacing included (em units, as text layers read it). */
export function lineWidth(text: string, size: number, letterSpacing = -0.02, mono = false): number {
  return estimateWidth(text, size, mono) + [...text].length * letterSpacing * size;
}

/** Lines a text layer breaks into: its own line breaks, then word wrap at `maxWidth`. */
export function wrapLines(text: string, size: number, maxWidth?: number, letterSpacing = -0.02, mono = false): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!maxWidth) {
      out.push(para);
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && lineWidth(next, size, letterSpacing, mono) > maxWidth) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** Shortens one line to fit `maxWidth`, ending it with an ellipsis. */
export function truncate(text: string, size: number, maxWidth: number, letterSpacing = 0): string {
  if (lineWidth(text, size, letterSpacing) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && lineWidth(`${t}…`, size, letterSpacing) > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/** Components that build nothing but layers (no events), measured by expanding them. */
let expander: ((l: L, ctx: EngineContext) => L) | null = null;
const pure = new Set<string>();
export function useExpander(fn: (l: L, ctx: EngineContext) => L, types: string[]): void {
  expander = fn;
  for (const t of types) pure.add(t);
}

function textAnchor(l: L): string {
  return l.anchor ?? (l.align === 'left' ? 'left' : l.align === 'right' ? 'right' : 'center');
}

function rawBox(l: L, ctx: EngineContext): Box {
  const sized = (w: number, h: number): Box => ({ w, h, cx: 0, cy: 0 });
  switch (l.type) {
    case 'text': {
      const size = l.size ?? 72;
      const ls = l.letterSpacing ?? -0.02;
      const mono = l.font === 'mono';
      const str = l.uppercase ? String(l.text).toUpperCase() : String(l.text);
      const lines = wrapLines(str, size, l.maxWidth, ls, mono);
      let w = Math.max(0, ...lines.map((x) => lineWidth(x, size, ls, mono)));
      if (l.maxWidth) w = Math.min(w, l.maxWidth);
      const h = lines.length * size * (l.lineHeight ?? 1.12);
      const a = textAnchor(l);
      return { w, h, cx: a === 'left' ? w / 2 : a === 'right' ? -w / 2 : 0, cy: 0 };
    }
    case 'counter': {
      const size = l.size ?? 96;
      const w = lineWidth(counterFinalText(l as any), size, l.letterSpacing ?? -0.02);
      const a = textAnchor(l);
      return { w, h: size * 1.12, cx: a === 'left' ? w / 2 : a === 'right' ? -w / 2 : 0, cy: 0 };
    }
    case 'shape': {
      const round = l.shape === 'circle' || l.shape === 'ring';
      const w = l.width ?? (round ? l.height ?? 200 : 200);
      return sized(w, l.height ?? (round ? w : 200));
    }
    case 'image':
    case 'video':
    case 'lottie':
    case 'svg':
      return sized(l.width ?? l.height ?? 400, l.height ?? l.width ?? 400);
    case 'icon':
      return sized(l.size ?? 48, l.size ?? 48);
    case 'avatar':
      return sized(l.size ?? 64, l.size ?? 64);
    case 'button': {
      const size = l.size ?? 22;
      const iconW = l.icon ? size + 10 : 0;
      return sized(l.width ?? estimateWidth(l.label, size) + iconW + size * 2.4, l.height ?? size * 2.6);
    }
    case 'badge': {
      const size = l.size ?? 18;
      return sized(estimateWidth(l.label, size) + (l.icon ? size + 8 : 0) + size * 1.6, size * 2);
    }
    case 'toast':
      return sized(l.width ?? 440, l.body ? 100 : 76);
    case 'card':
      return sized(l.width ?? 420, l.height ?? 260);
    case 'browser':
      return sized(l.width ?? 1280, l.height ?? 780);
    case 'phone':
      return sized(l.width ?? 390, l.height ?? 800);
    case 'laptop':
      return sized(l.width ?? 1100, (l.width ?? 1100) * 0.64);
    case 'chart':
      return sized(l.width ?? 640, l.height ?? 360);
    case 'progress':
      return sized(l.width ?? 480, l.height ?? 12);
    case 'code': {
      const size = l.size ?? 22;
      const lines = String(l.code).replace(/\t/g, '  ').split('\n');
      const longest = Math.max(...lines.map((x) => x.length), 10);
      const bar = l.title !== undefined ? 46 : 0;
      return sized(l.width ?? longest * size * 0.6 + 64, l.height ?? lines.length * size * (l.lineHeight ?? 1.6) + 64 + bar);
    }
    case 'stack':
      return sized(...layoutStack(l, ctx).size);
  }
  if (pure.has(l.type) && expander) {
    const e = expander(l, ctx);
    if (e.width !== undefined && e.height !== undefined) return sized(e.width, e.height);
  }
  if (l.width !== undefined && l.height !== undefined) return sized(l.width, l.height);
  // A group: the union of its children's boxes.
  const kids: L[] = l.children ?? [];
  if (!kids.length) return sized(l.width ?? 0, l.height ?? 0);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const c of kids) {
    const b = measure(c, ctx);
    const x = (c.x ?? 0) + b.cx;
    const y = (c.y ?? 0) + b.cy;
    x0 = Math.min(x0, x - b.w / 2);
    x1 = Math.max(x1, x + b.w / 2);
    y0 = Math.min(y0, y - b.h / 2);
    y1 = Math.max(y1, y + b.h / 2);
  }
  return { w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/** The box a layer takes up, through its scale and `anchor`, relative to its x/y. */
export function measure(l: L, ctx: EngineContext): Box {
  const b = rawBox(l, ctx);
  const sx = (l.scale ?? 1) * (l.scaleX ?? 1);
  const sy = (l.scale ?? 1) * (l.scaleY ?? 1);
  let cx = b.cx;
  let cy = b.cy;
  if (l.anchor !== undefined && l.type !== 'text' && l.type !== 'counter') {
    const a = typeof l.anchor === 'string' ? ORIGINS[l.anchor] ?? [0, 0] : l.anchor;
    cx -= a[0] * b.w;
    cy -= a[1] * b.h;
  }
  return { w: Math.abs(b.w * sx), h: Math.abs(b.h * sy), cx: cx * sx, cy: cy * sy };
}

/** Padding as [top, right, bottom, left]: one number, [vertical, horizontal] or four. */
export function padding(p: number | number[] | undefined, fallback: number): [number, number, number, number] {
  if (p === undefined) return [fallback, fallback, fallback, fallback];
  if (typeof p === 'number') return [p, p, p, p];
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];
  return [p[0], p[1] ?? p[0], p[2] ?? p[0], p[3] ?? p[1] ?? p[0]];
}

/** Moves a layer's entrance later by `delay`, or gives it one (`enter`) that starts then. */
function staggered(l: L, at: number, enter: string | undefined, ctx: EngineContext): L {
  const shift = (a: any) => (typeof a === 'string' ? { preset: a, at: at } : { ...a, at: ctx.time(a.at, 0) + at });
  if (l.in) return copyOf(l, { in: Array.isArray(l.in) ? l.in.map(shift) : shift(l.in) });
  if (l.animate) return copyOf(l, { animate: shift(l.animate) });
  if (enter === 'none') return l;
  return copyOf(l, { in: { preset: enter ?? 'riseIn', at } });
}

export interface StackLayout {
  size: [number, number];
  /** Each child wrapped in a group at its place, plus the panel behind them if any. */
  children: L[];
}

/** Places a stack's children. Used by the stack component and by measuring. */
export function layoutStack(s: L, ctx: EngineContext): StackLayout {
  const row = s.direction === 'row';
  const gap = s.gap ?? 16;
  const panel = s.fill !== undefined || s.stroke !== undefined;
  const [pt, pr, pb, pl] = padding(s.padding, panel ? 24 : 0);
  const align: string = s.align ?? (row ? 'center' : 'start');
  const justify: string = s.justify ?? 'start';
  const fixedInnerW = s.width !== undefined ? s.width - pl - pr : undefined;
  const items: L[] = (s.children ?? []).map((c: L) => {
    if (c.type !== 'text' && c.type !== 'counter') return c;
    const extra: L = {};
    // Text takes the edge it is aligned to, so width estimates never move where it starts.
    const edge = row ? 'left' : align === 'end' ? 'right' : align === 'center' ? 'center' : 'left';
    if (c.align === undefined && c.anchor === undefined) extra.align = edge;
    // A column of fixed width wraps its text to fit.
    if (!row && fixedInnerW !== undefined && c.type === 'text' && c.maxWidth === undefined) extra.maxWidth = fixedInnerW;
    return Object.keys(extra).length ? copyOf(c, extra) : c;
  });
  const boxes = items.map((c) => measure(c, ctx));
  const main = boxes.map((b) => (row ? b.w : b.h));
  const cross = boxes.map((b) => (row ? b.h : b.w));
  const content = main.reduce((a, b) => a + b, 0) + gap * Math.max(0, items.length - 1);
  const crossMax = Math.max(0, ...cross);
  const innerW = fixedInnerW ?? (row ? content : crossMax);
  const innerH = s.height !== undefined ? s.height - pt - pb : row ? crossMax : content;
  const W = innerW + pl + pr;
  const H = innerH + pt + pb;
  const mainLen = row ? innerW : innerH;
  const crossLen = row ? innerH : innerW;
  const free = mainLen - content;
  let cursor = justify === 'center' ? free / 2 : justify === 'end' ? free : 0;
  const step = justify === 'between' && items.length > 1 && free > 0 ? gap + free / (items.length - 1) : gap;
  const left = -W / 2 + pl;
  const top = H / 2 - pt;
  const at = ctx.time(s.at, ctx.time(s.start, 0));
  const stagger = s.stagger !== undefined ? ctx.time(s.stagger, 0) : undefined;
  const out: L[] = [];
  if (panel) {
    const shadow = s.shadow === false || s.shadow === undefined ? undefined : s.shadow === true ? { blur: 60, y: -28, opacity: 0.4 } : s.shadow;
    out.push({ type: 'shape', width: W, height: H, radius: s.radius ?? 20, fill: s.fill ?? 'none', stroke: s.stroke, strokeWidth: s.stroke ? 1 : undefined, shadow, glow: s.glow });
  }
  items.forEach((c, i) => {
    const b = boxes[i];
    const m = cursor + main[i] / 2;
    cursor += main[i] + step;
    const cs = cross[i];
    const cc = align === 'center' ? crossLen / 2 : align === 'end' ? crossLen - cs / 2 : cs / 2;
    const x = row ? left + m : left + cc;
    const y = row ? top - cc : top - m;
    const child = stagger !== undefined ? staggered(c, at + i * stagger, s.enter, ctx) : c;
    out.push({ type: 'group', x: x - b.cx, y: y - b.cy, children: [child] });
  });
  return { size: [W, H], children: out };
}
