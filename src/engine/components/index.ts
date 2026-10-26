import type {
  AvatarLayer, BadgeLayer, BrowserLayer, ButtonLayer, CardLayer, ChartLayer, CodeLayer, CursorLayer, FlashLayer, GlowLayer,
  Keyframe, LaptopLayer, Layer, PhoneLayer, ProgressLayer, RepeatLayer, ToastLayer,
} from '../../spec/schema';
import { rng } from '../util/random';
import type { EngineContext } from '../context';
import { Track } from '../anim/keyframes';
import { highlightCode } from './syntax';
import * as THREE from 'three';
import { smoothPoints } from '../layers/ribbon';
import { resolveEase } from '../anim/easing';
import { estimateWidth } from './measure';
import { timeline } from './timeline';

/** Internal layer spec shape: components expand into these. */
type L = Layer & Record<string, any>;

const BASE_KEYS = ['id', 'share', 'x', 'y', 'z', 'rotate', 'rotateX', 'rotateY', 'rotateZ', 'scale', 'scaleX', 'scaleY', 'opacity', 'origin', 'anchor', 'sound', 'start', 'end', 'in', 'out', 'loop', 'keyframes', 'blend'] as const;

function pickBase(spec: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of BASE_KEYS) if (spec[k] !== undefined) out[k] = spec[k];
  return out;
}

export function group(spec: Record<string, any>, children: L[], extra: Record<string, any> = {}): L {
  return { type: 'group', ...pickBase(spec), ...extra, children } as L;
}

/** prefix + value / scale with `decimals` and thousands separators + suffix. */
function formatNumber(v: number, f: { prefix?: string; suffix?: string; scale?: number; decimals?: number } = {}): string {
  const x = v / (f.scale ?? 1);
  const [int, frac] = Math.abs(x).toFixed(f.decimals ?? 0).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${x < 0 ? '-' : ''}${f.prefix ?? ''}${grouped}${frac ? `.${frac}` : ''}${f.suffix ?? ''}`;
}

/**
 * A line or area chart in data units: `range` maps values to the box, `axes` label ticks, `events`
 * mark x values as the line draws past them, `rider` rides the tip, `readout` counts the value under it.
 * The curve is sampled here (smoothed the way paths are) so every mark sits exactly on the drawn line
 * and arrives exactly when the line gets there.
 */
function lineChart(s: ChartLayer, ctx: EngineContext, w: number, h: number, at: number, dur: number, color: string): L[] {
  const out: L[] = [];
  const pairs = s.data.map((d, i) => (Array.isArray(d) ? d : [i, d])) as [number, number][];
  const xs = pairs.map((p) => p[0]);
  const ys = pairs.map((p) => p[1]);
  const fancy = !!(s.range || s.axes || s.events || s.rider || s.readout);
  let [x0, x1] = s.range?.x ?? [Math.min(...xs), Math.max(...xs)];
  if (x1 === x0) x1 = x0 + 1;
  // Without a range the top value sits a little under the top edge.
  let [y0, y1] = s.range?.y ?? [0, Math.max(...ys, 1e-6) / (fancy ? 1 : 0.92)];
  if (y1 === y0) y1 = y0 + 1;
  const px = (x: number) => -w / 2 + ((x - x0) / (x1 - x0)) * w;
  const py = (y: number) => -h / 2 + ((y - y0) / (y1 - y0)) * h;
  const fromY = (v: number) => y0 + ((v + h / 2) / h) * (y1 - y0);
  const raw = pairs.map(([x, y]) => new THREE.Vector2(px(x), py(y)));
  const pts = (s.smooth ?? true) && raw.length > 2 ? smoothPoints(raw) : raw;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = cum[cum.length - 1] || 1;
  const pointAt = (u: number): THREE.Vector2 => {
    const target = u * total;
    for (let i = 1; i < cum.length; i++) {
      if (cum[i] >= target) {
        const seg = cum[i] - cum[i - 1];
        return pts[i - 1].clone().lerp(pts[i], seg > 0 ? (target - cum[i - 1]) / seg : 1);
      }
    }
    return pts[pts.length - 1].clone();
  };
  /** Height of the drawn line at a frame x (the highest crossing). */
  const curveY = (x: number): number => {
    let best = -Infinity;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if ((x - a.x) * (x - b.x) <= 0) best = Math.max(best, a.x === b.x ? Math.max(a.y, b.y) : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x));
    }
    return Number.isFinite(best) ? best : x < pts[0].x ? pts[0].y : pts[pts.length - 1].y;
  };
  // The draw: progress eases over [at, at + dur]; one sample per frame for what follows the tip.
  const ease = resolveEase('inOutCubic');
  const n = Math.max(12, Math.round(dur * ctx.fps));
  const samples = Array.from({ length: n + 1 }, (_, k) => ({ t: at + (dur * k) / n, p: pointAt(ease(k / n)) }));
  /** When the tip reaches frame x. */
  const tipTime = (x: number): number => {
    for (let k = 1; k < samples.length; k++) {
      const a = samples[k - 1];
      const b = samples[k];
      if (b.p.x >= x) return a.t + (b.t - a.t) * (b.p.x === a.p.x ? 1 : Math.min(1, Math.max(0, (x - a.p.x) / (b.p.x - a.p.x))));
    }
    return at + dur;
  };
  const muted = s.axes?.color ?? '$muted';
  const axisSize = s.axes?.size ?? 15;
  const ticksOf = (ax: { ticks?: number[]; step?: number }, lo: number, hi: number): number[] => {
    if (ax.ticks) return ax.ticks;
    if (!ax.step) return [lo, hi];
    const vals: number[] = [];
    for (let v = Math.ceil(lo / ax.step - 1e-9) * ax.step; v <= hi + 1e-9; v += ax.step) vals.push(Math.round(v * 1e9) / 1e9);
    return vals;
  };
  const fadeIn = { preset: 'fade', at, duration: 0.4 };
  if (s.axes?.y) {
    for (const v of ticksOf(s.axes.y, y0, y1)) {
      out.push({ type: 'shape', y: py(v), width: w, height: 1, fill: '$border', opacity: 0.6, in: fadeIn } as L);
      out.push({ type: 'text', text: formatNumber(v, s.axes.y), x: -w / 2 - 14, y: py(v), size: axisSize, weight: 500, font: 'body', color: muted, letterSpacing: 0, anchor: 'right', align: 'right', in: fadeIn } as L);
    }
  }
  if (s.axes?.x) {
    out.push({ type: 'shape', y: -h / 2, width: w, height: 1, fill: '$border', in: fadeIn } as L);
    for (const v of ticksOf(s.axes.x, x0, x1)) {
      out.push({ type: 'shape', x: px(v), y: -h / 2 - 5, width: 1, height: 10, fill: '$border', in: fadeIn } as L);
      out.push({ type: 'text', text: formatNumber(v, s.axes.x), x: px(v), y: -h / 2 - 28, size: axisSize, weight: 500, font: 'body', color: muted, letterSpacing: 0, in: fadeIn } as L);
    }
  }
  out.push({
    type: 'path', points: pts.map((p) => [p.x, p.y]), smooth: false, width: s.lineWidth ?? 5, color,
    area: s.kind === 'area' ? (color.startsWith('$') ? `${color}/45` : color) : undefined, areaBase: -h / 2,
    glow: { size: 5, intensity: 0.3 },
    keyframes: { progress: [{ t: at, v: 0 }, { t: at + dur, v: 1, ease: 'inOutCubic' }] },
  } as L);
  // Events: a ring on the line, a hairline down to the axis, a label above the curve and clear of it.
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const labelSize = s.labelSize ?? 18;
  for (const ev of s.events ?? []) {
    const x = px(ev.x);
    const y = curveY(x);
    const t = tipTime(x);
    const c = ev.color ?? color;
    const half = estimateWidth(ev.label, labelSize) / 2 + 8;
    let top = -Infinity;
    for (let d = -half; d <= half; d += 4) top = Math.max(top, curveY(x + d));
    let ly = Math.max(y + 34, top + labelSize * 1.3);
    // Step up past labels already placed that it would overlap.
    for (let guard = 0; guard < 8; guard++) {
      const hit = placed.find((b) => x - half < b.x1 && x + half > b.x0 && ly - labelSize * 0.7 < b.y1 && ly + labelSize * 0.7 > b.y0);
      if (!hit) break;
      ly = hit.y1 + labelSize * 0.8;
    }
    placed.push({ x0: x - half, x1: x + half, y0: ly - labelSize * 0.7, y1: ly + labelSize * 0.7 });
    out.push({ type: 'path', points: [[x, y - 10], [x, -h / 2]], smooth: false, width: 1, color: '$border', start: t + 0.05, keyframes: { progress: [{ t: t + 0.05, v: 0 }, { t: t + 0.45, v: 1, ease: 'outCubic' }] } } as L);
    out.push({ type: 'shape', shape: 'ring', x, y, width: 18, height: 18, strokeWidth: 2.5, fill: c, start: t, in: { preset: 'popIn', at: t, duration: 0.35 } } as L);
    out.push({ type: 'text', text: ev.label, x, y: ly, size: labelSize, weight: 500, font: 'body', color: '$text', letterSpacing: -0.01, start: t + 0.1, animate: { preset: 'lift', at: t + 0.1 } } as L);
  }
  const last = pts[pts.length - 1];
  const dotStyle = { type: 'shape', shape: 'circle', fill: color, stroke: '#FFFFFF', strokeWidth: 4, glow: { size: 14, intensity: 0.8 } };
  if (s.rider) {
    const r = typeof s.rider === 'object' ? s.rider : {};
    const size = r.size ?? 18;
    out.push({
      ...dotStyle, fill: r.color ?? color, width: size, height: size, start: at,
      keyframes: { x: samples.map((k) => ({ t: k.t, v: k.p.x })), y: samples.map((k) => ({ t: k.t, v: k.p.y })) },
    } as L);
  } else {
    out.push({ ...dotStyle, x: last.x, y: last.y, width: 18, in: { preset: 'popIn', at: at + dur * 0.95 } } as L);
  }
  if (s.readout) {
    const r = s.readout;
    const sc = r.scale ?? 1;
    const value = samples.map((k) => ({ t: k.t, v: fromY(k.p.y) / sc }));
    const follow = r.follow ?? false;
    out.push({
      type: 'counter', from: value[0].v, to: value[value.length - 1].v, prefix: r.prefix, suffix: r.suffix, decimals: r.decimals ?? 0,
      size: r.size ?? 44, weight: r.weight ?? 600, font: r.font ?? 'display', color: r.color ?? '$text', letterSpacing: -0.02,
      x: r.x ?? (follow ? 0 : -w / 2), y: r.y ?? (follow ? 0 : h / 2 + 60), anchor: follow ? 'center' : 'left', align: follow ? 'center' : 'left',
      start: at, in: { preset: 'fade', at, duration: 0.3 },
      keyframes: {
        value,
        ...(follow ? { x: samples.map((k) => ({ t: k.t, v: k.p.x + (r.x ?? 0) })), y: samples.map((k) => ({ t: k.t, v: k.p.y + (r.y ?? 48) })) } : {}),
      },
    } as L);
  }
  // Category labels (evenly spaced data) under their points.
  s.labels?.forEach((lab, i) => {
    if (!raw[i]) return;
    out.push({ type: 'text', text: lab, x: raw[i].x, y: -h / 2 - 26, size: 16, weight: 500, font: 'body', color: '$muted', letterSpacing: 0, in: { preset: 'fade', at: at + (dur * i) / raw.length } } as L);
  });
  return out;
}

const CURSOR_ARROW = 'M0 0 L0 22.5 L5.6 17.3 L9.3 26 L13 24.4 L9.4 16 L16.9 16 Z';
// Pointing hand on a 24x24 grid; the fingertip hotspot is at (10, 1).
const CURSOR_HAND =
  'M8 3 C8 1.9 8.9 1 10 1 C11.1 1 12 1.9 12 3 L12 9.2 C12.2 8.5 12.9 8 13.7 8 C14.6 8 15.3 8.7 15.3 9.6 L15.3 10.2 ' +
  'C15.6 9.6 16.2 9.2 16.9 9.2 C17.8 9.2 18.5 9.9 18.5 10.8 L18.5 11.4 C18.8 10.9 19.3 10.6 19.9 10.6 ' +
  'C20.8 10.6 21.5 11.3 21.5 12.2 L21.5 16 C21.5 20 18.5 23 14.5 23 L12.5 23 C10.4 23 8.9 22.3 7.6 21 ' +
  'L3.4 16.6 C2.7 15.9 2.7 14.8 3.4 14.1 C4.1 13.4 5.2 13.4 5.9 14.1 L8 16.2 L8 3 Z';
const HAND_CREASES = 'M12 9.6V13.2|M15.3 10.4V13.4|M18.5 11.6V13.8';

/** Deep copy with an entrance delay added to every `in`/`animate` start time. */
function delayed(spec: L, delay: number, ctx: EngineContext): L {
  const copy = JSON.parse(JSON.stringify(spec)) as L;
  if (delay <= 0) return copy;
  const shift = (a: any) => {
    if (!a) return a;
    if (typeof a === 'string') return { preset: a, at: delay };
    return { ...a, at: ctx.time(a.at, 0) + delay };
  };
  if (copy.in) copy.in = Array.isArray(copy.in) ? copy.in.map(shift) : shift(copy.in);
  if ((copy as any).animate) (copy as any).animate = shift((copy as any).animate);
  return copy;
}

export const COMPONENTS: Record<string, (spec: any, ctx: EngineContext) => L> = {
  browser(s: BrowserLayer, ctx) {
    const w = s.width ?? 1280;
    const h = s.height ?? 780;
    const r = s.radius ?? 16;
    const dark = (s.theme ?? 'dark') === 'dark';
    const bar = 48;
    const frame = dark ? '#16161D' : '#ECECF1';
    const content = s.fill ?? (dark ? '#0D0D12' : '#FFFFFF');
    const border = dark ? '#2A2A36' : '#D4D4DC';
    const shadow = s.shadow === false ? undefined : s.shadow === true || s.shadow === undefined ? { blur: 90, y: -50, opacity: 0.55 } : s.shadow;
    const top = h / 2;
    const contentH = h - bar;
    const children: L[] = [
      { type: 'shape', width: w, height: h, radius: r, fill: frame, stroke: border, strokeWidth: 1, shadow } as L,
      { type: 'shape', y: -bar / 2, width: w - 2, height: contentH - 1, radius: r - 1, fill: content } as L,
      { type: 'shape', y: top - bar - 0.5 - r / 2, width: w - 2, height: r, fill: content } as L,
      { type: 'shape', y: top - bar, width: w - 2, height: 1, fill: border } as L,
      ...['#FF5F57', '#FEBC2E', '#28C840'].map((c, i) => ({ type: 'shape', shape: 'circle', x: -w / 2 + 26 + i * 22, y: top - bar / 2, width: 13, fill: c }) as L),
    ];
    if (s.url !== undefined) {
      const pw = Math.min(w * 0.42, 520);
      children.push(
        { type: 'shape', shape: 'pill', y: top - bar / 2, width: pw, height: 30, fill: dark ? '#0D0D12' : '#FFFFFF', stroke: border, strokeWidth: 1 } as L,
        { type: 'icon', name: 'lock', x: -estimateWidth(s.url, 15) / 2 - 14, y: top - bar / 2, size: 13, color: dark ? '#8A8AA0' : '#70707E', strokeWidth: 2.2 } as L,
        { type: 'text', text: s.url, x: 6, y: top - bar / 2, size: 15, weight: 500, font: 'body', color: dark ? '#B4B4C6' : '#55555F', letterSpacing: 0 } as L,
      );
    }
    children.push({ type: 'group', y: -bar / 2, width: w, height: contentH, children: (s.children ?? []) as L[] } as L);
    return group(s, children, { width: w, height: h });
  },

  phone(s: PhoneLayer, ctx) {
    const w = s.width ?? 390;
    const h = s.height ?? 800;
    const depth = s.depth ?? 34;
    const bezel = 14;
    const r = w * 0.15;
    // A few px in front of the body: closer, the metal flickers through the bezel at a distance.
    const front = depth / 2 + 2.5;
    return group(s, [
      { type: 'mesh', geometry: 'slab', size: [w, h, depth], radius: r, material: 'metal', color: s.color ?? '#2A2A30', roughness: 0.28 } as L,
      { type: 'shape', z: front, width: w - bezel * 2 + 6, height: h - bezel * 2 + 6, radius: r - bezel + 3, fill: '#050507' } as L,
      { type: 'shape', z: front + 0.3, width: w - bezel * 2, height: h - bezel * 2, radius: r - bezel, fill: s.screen ?? '#0B0B10' } as L,
      { type: 'group', z: front + 0.6, width: w - bezel * 2, height: h - bezel * 2, children: (s.children ?? []) as L[] } as L,
      { type: 'shape', shape: 'pill', z: front + 1.2, y: h / 2 - bezel - 26, width: w * 0.3, height: 32, fill: '#000000' } as L,
    ], { width: w, height: h });
  },

  laptop(s: LaptopLayer, ctx) {
    const w = s.width ?? 1100;
    const sh = w * 0.64;
    const deck = w * 0.68;
    const open = s.open ?? 100;
    const lidKeys: Record<string, Keyframe[]> = {};
    if (s.keyframes?.open) lidKeys.rotateX = s.keyframes.open.map((k) => ({ ...k, v: 90 - (k.v as number) }));
    const color = s.color ?? '#9EA1AA';
    const lid: L = {
      type: 'group',
      z: -deck / 2,
      rotateX: 90 - open,
      keyframes: Object.keys(lidKeys).length ? lidKeys : undefined,
      children: [
        { type: 'mesh', y: sh / 2, geometry: 'slab', size: [w, sh, 14], radius: 28, material: 'metal', color, roughness: 0.35 } as L,
        // The lid's front face is at z 7. The bezel, screen and content sit a few px in front of it:
        // closer than that, depth precision runs out at a distance and the metal flickers through.
        { type: 'shape', y: sh / 2, z: 9.5, width: w - 16, height: sh - 16, radius: 22, fill: '#050507' } as L,
        { type: 'shape', y: sh / 2 + 6, z: 10.5, width: w - 52, height: sh - 64, radius: 6, fill: s.screen ?? '#0B0B10' } as L,
        { type: 'group', y: sh / 2 + 6, z: 11.5, width: w - 52, height: sh - 64, children: (s.children ?? []) as L[] } as L,
      ],
    } as L;
    const base: L = {
      type: 'group',
      children: [
        { type: 'mesh', y: -9, geometry: 'slab', size: [w, deck, 18], radius: 30, material: 'metal', color, roughness: 0.35, rotateX: -90 } as L,
        { type: 'shape', y: 0.6, z: -deck * 0.08, width: w * 0.86, height: deck * 0.5, radius: 10, fill: '#1A1B20', rotateX: -90 } as L,
        { type: 'shape', y: 0.6, z: deck * 0.3, width: w * 0.36, height: deck * 0.25, radius: 12, fill: '#83868F', rotateX: -90 } as L,
      ],
    } as L;
    return group(s, [{ type: 'group', y: -sh * 0.35, children: [base, lid] } as L], { width: w, height: sh });
  },

  card(s: CardLayer, ctx) {
    const w = s.width ?? 420;
    const h = s.height ?? 260;
    const pad = s.padding ?? 32;
    const accent = s.accent ?? '$primary';
    const shadow = s.shadow === false ? undefined : s.shadow === true || s.shadow === undefined ? { blur: 60, y: -28, opacity: 0.45 } : s.shadow;
    const children: L[] = [
      { type: 'shape', width: w, height: h, radius: s.radius ?? 24, fill: s.fill ?? '$surface', stroke: s.stroke ?? '$border', strokeWidth: 1, shadow, glow: s.glow } as L,
    ];
    let cursorY = h / 2 - pad;
    if (s.icon) {
      children.push(
        { type: 'shape', x: -w / 2 + pad + 26, y: cursorY - 26, width: 52, height: 52, radius: 14, fill: `${accent}` , opacity: 0.16 } as L,
        { type: 'icon', name: s.icon, x: -w / 2 + pad + 26, y: cursorY - 26, size: 26, color: accent } as L,
      );
      cursorY -= 52 + 22;
    }
    if (s.title) {
      children.push({ type: 'text', text: s.title, x: -w / 2 + pad, y: cursorY - 14, size: 26, weight: 600, align: 'left', anchor: 'left', maxWidth: w - pad * 2, color: '$text', letterSpacing: -0.01 } as L);
      cursorY -= 28 + 14;
    }
    if (s.subtitle) {
      children.push({ type: 'text', text: s.subtitle, x: -w / 2 + pad, y: cursorY - 22, size: 18, weight: 400, font: 'body', align: 'left', anchor: 'left', maxWidth: w - pad * 2, color: '$muted', lineHeight: 1.4, letterSpacing: 0 } as L);
    }
    children.push({ type: 'group', children: (s.children ?? []) as L[] } as L);
    return group(s, children, { width: w, height: h });
  },

  button(s: ButtonLayer, ctx) {
    const size = s.size ?? 22;
    const iconW = s.icon ? size + 10 : 0;
    const h = s.height ?? size * 2.6;
    const w = s.width ?? estimateWidth(s.label, size) + iconW + size * 2.4;
    const keyframes: Record<string, Keyframe[]> = { ...(s.keyframes ?? {}) };
    if (s.press !== undefined) ctx.event('click', ctx.time(s.press), 0.9);
    if (s.press !== undefined && !keyframes.scale) {
      const at = ctx.time(s.press);
      keyframes.scale = [
        { t: Math.max(0, at - 0.12), v: s.scale ?? 1 },
        { t: at, v: (s.scale ?? 1) * 0.9, ease: 'outQuad' },
        { t: at + 0.45, v: s.scale ?? 1, ease: 'springBouncy' },
      ];
    }
    const textX = s.icon ? -iconW / 2 : 0;
    const children: L[] = [
      { type: 'shape', width: w, height: h, radius: s.radius ?? h / 2, fill: s.fill ?? '$primary', glow: s.glow, shadow: { blur: 30, y: -10, opacity: 0.35 } } as L,
      { type: 'text', text: s.label, x: textX, y: 0, size, weight: 600, font: 'body', color: s.color ?? '#FFFFFF', letterSpacing: -0.005 } as L,
    ];
    if (s.icon) children.push({ type: 'icon', name: s.icon, x: textX + estimateWidth(s.label, size) / 2 + 10 + size / 2, size: size * 0.95, color: s.color ?? '#FFFFFF', strokeWidth: 2.4 } as L);
    if (s.press !== undefined) {
      const at = ctx.time(s.press);
      children.push({
        type: 'shape', width: w, height: h, radius: s.radius ?? h / 2, fill: '#FFFFFF', blend: 'add', start: at, end: at + 0.5,
        keyframes: { opacity: [{ t: at, v: 0.35 }, { t: at + 0.5, v: 0, ease: 'outCubic' }] },
      } as L);
    }
    return group({ ...s, keyframes }, children, { width: w, height: h });
  },

  cursor(s: CursorLayer, ctx) {
    const size = s.size ?? (s.style === 'hand' ? 2.2 : 1.6);
    const pathKeys = s.path ?? [];
    const keyframes: Record<string, Keyframe[]> = { ...(s.keyframes ?? {}) };
    if (pathKeys.length) {
      keyframes.x = pathKeys.map((k) => ({ t: k.t, v: k.x, ease: k.ease ?? 'inOutCubic' }));
      keyframes.y = pathKeys.map((k) => ({ t: k.t, v: k.y, ease: k.ease ?? 'inOutCubic' }));
    }
    const clicks = (s.clicks ?? []).map((c) => ctx.time(c));
    for (const c of clicks) ctx.event('click', c, 1);
    if (clicks.length && !keyframes.scale) {
      const sk: Keyframe[] = [{ t: 0, v: 1 }];
      for (const c of clicks) sk.push({ t: Math.max(0, c - 0.1), v: 1 }, { t: c, v: 0.8, ease: 'outQuad' }, { t: c + 0.3, v: 1, ease: 'outBack' });
      keyframes.scale = sk;
    }
    const xs = keyframes.x ? new Track(keyframes.x, ctx) : null;
    const ys = keyframes.y ? new Track(keyframes.y, ctx) : null;
    const ripples: L[] = clicks.map((c) => {
      const cx = xs ? (xs.eval(c) as number) : s.x ?? 0;
      const cy = ys ? (ys.eval(c) as number) : s.y ?? 0;
      return {
        type: 'shape', shape: 'ring', x: cx, y: cy, width: 70, strokeWidth: 3, fill: s.color === '#000000' ? '#000000' : '$primary', start: c, end: c + 0.6,
        keyframes: { scale: [{ t: c, v: 0.2 }, { t: c + 0.6, v: 1.3, ease: 'outCubic' }], opacity: [{ t: c, v: 0.9 }, { t: c + 0.6, v: 0, ease: 'inQuad' }] },
      } as L;
    });
    const fill = s.color ?? '#FFFFFF';
    const ink = s.color === '#FFFFFF' || !s.color ? '#16161D' : '#FFFFFF';
    const arrow: L =
      s.style === 'hand'
        ? ({
            type: 'group',
            scale: size * 1.25,
            children: [
              { type: 'svg', d: CURSOR_HAND, x: 2 + 0.8, y: -11 - 1.6, fill: '#1B1B4D', opacity: 0.18, viewBox: [0, 0, 24, 24] } as L,
              { type: 'svg', d: CURSOR_HAND, x: 2, y: -11, fill, stroke: ink, strokeWidth: 1.3, viewBox: [0, 0, 24, 24] } as L,
              { type: 'icon', d: HAND_CREASES, x: 2, y: -11, size: 24, color: ink, strokeWidth: 1.3 } as L,
            ],
          } as L)
        : ({
            type: 'group',
            scale: size,
            children: [
              { type: 'svg', d: CURSOR_ARROW, x: 8.5 + 1.5, y: -13 - 3, fill: '#000000', opacity: 0.35, viewBox: [0, 0, 17, 26] } as L,
              { type: 'svg', d: CURSOR_ARROW, x: 8.5, y: -13, fill, stroke: ink, strokeWidth: 1.4, viewBox: [0, 0, 17, 26] } as L,
            ],
          } as L);
    const { path: _p, clicks: _c, style: _s, ...rest } = s;
    const cursorGroup = group({ ...rest, keyframes, z: (s.z ?? 0) + 2 }, [arrow]);
    // The pointer floats above the UI; keep it sharp even with camera depth of field.
    return { type: 'group', start: s.start, end: s.end, dof: false, children: [...ripples, cursorGroup] } as L;
  },

  chart(s: ChartLayer, ctx) {
    const kind = s.kind ?? 'bar';
    const w = s.width ?? 640;
    const h = s.height ?? 360;
    const at = ctx.time(s.at, ctx.time(s.start, 0));
    const dur = ctx.time(s.duration, 1.2);
    const data = s.data.map((d) => (Array.isArray(d) ? d[1] : d));
    const max = Math.max(...data, 1e-6);
    const color = s.color ?? '$primary';
    const children: L[] = [];
    // A line chart with y ticks draws its grid at the ticks.
    const tickGrid = (kind === 'line' || kind === 'area') && !!s.axes?.y;
    if ((s.gridLines ?? kind !== 'donut') && !tickGrid) {
      for (let i = 0; i <= 4; i++) {
        children.push({ type: 'shape', y: -h / 2 + (h * i) / 4, width: w, height: 1, fill: '$border', opacity: i === 0 ? 1 : 0.6 } as L);
      }
    }
    if (kind === 'bar') {
      const n = data.length;
      const slot = w / n;
      const bw = slot * 0.62;
      const stagger = ctx.time(s.stagger, 0.06);
      data.forEach((v, i) => {
        const bh = Math.max(2, (v / max) * h);
        const c = s.colors?.[i % s.colors.length] ?? color;
        children.push({
          type: 'shape',
          x: -w / 2 + slot * (i + 0.5),
          y: -h / 2 + bh / 2,
          width: bw,
          height: bh,
          radius: s.radius ?? Math.min(10, bw / 4),
          fill: { type: 'linear', from: c, to: c.startsWith('$') ? `${c}/35` : c, angle: 180 },
          origin: 'bottom',
          in: { preset: 'growY', at: at + i * stagger, duration: dur * 0.7, ease: 'outExpo' },
        } as L);
        if (s.labels?.[i]) {
          children.push({ type: 'text', text: s.labels[i], x: -w / 2 + slot * (i + 0.5), y: -h / 2 - 26, size: 16, weight: 500, font: 'body', color: '$muted', letterSpacing: 0, in: { preset: 'fade', at: at + i * stagger } } as L);
        }
      });
    } else if (kind === 'line' || kind === 'area') {
      children.push(...lineChart(s, ctx, w, h, at, dur, color));
    } else {
      const total = data.reduce((a, b) => a + b, 0) || 1;
      const size = Math.min(w, h);
      const stroke = size * 0.14;
      let acc = 0;
      const palette = s.colors ?? [color, '$secondary', '$accent', '$success', '$warning'];
      data.forEach((v, i) => {
        const frac = v / total;
        const startFrac = acc;
        acc += frac;
        children.push({
          type: 'shape', shape: 'ring', width: size, strokeWidth: stroke, fill: palette[i % palette.length], rotate: -startFrac * 360,
          keyframes: { progress: [{ t: at + startFrac * dur, v: 0 }, { t: at + (startFrac + frac) * dur, v: Math.max(0, frac - 0.004), ease: 'inOutCubic' }] },
        } as L);
      });
    }
    return group(s, children, { width: w, height: h });
  },

  toast(s: ToastLayer, ctx) {
    const w = s.width ?? 440;
    const h = s.body ? 100 : 76;
    const dark = (s.theme ?? 'dark') === 'dark';
    const accent = s.accent ?? '$success';
    const left = -w / 2 + 24;
    const children: L[] = [
      { type: 'shape', width: w, height: h, radius: 18, fill: dark ? '$surface2' : '#FFFFFF', stroke: dark ? '$border' : '#E3E3EA', strokeWidth: 1, shadow: { blur: 50, y: -22, opacity: 0.5 } } as L,
      { type: 'shape', shape: 'circle', x: left + 22, y: 0, width: 44, fill: accent, opacity: 0.18 } as L,
      { type: 'icon', name: s.icon ?? 'check', x: left + 22, y: 0, size: 22, color: accent, strokeWidth: 2.6 } as L,
      { type: 'text', text: s.title, x: left + 60, y: s.body ? 15 : 0, size: 20, weight: 600, font: 'body', align: 'left', anchor: 'left', color: dark ? '$text' : '#111118', letterSpacing: -0.01, maxWidth: w - 110 } as L,
    ];
    if (s.body) children.push({ type: 'text', text: s.body, x: left + 60, y: -15, size: 16, weight: 400, font: 'body', align: 'left', anchor: 'left', color: dark ? '$muted' : '#6B6B78', letterSpacing: 0, maxWidth: w - 110 } as L);
    return group(s, children, { width: w, height: h });
  },

  progress(s: ProgressLayer, ctx) {
    const w = s.width ?? 480;
    const h = s.height ?? 12;
    const at = ctx.time(s.at, ctx.time(s.start, 0));
    const dur = ctx.time(s.duration, 1.2);
    const from = Math.max(0.0001, s.from ?? 0);
    const to = s.value ?? 1;
    const ease = s.ease ?? 'inOutCubic';
    return group(s, [
      { type: 'shape', shape: 'pill', width: w, height: h, fill: s.track ?? '$border' } as L,
      {
        type: 'shape', shape: 'pill', height: h, fill: s.color ?? { type: 'linear', from: '$primary', to: '$secondary', angle: 90 }, glow: { size: 10, intensity: 0.5 },
        keyframes: {
          width: [{ t: at, v: Math.max(h, from * w) }, { t: at + dur, v: Math.max(h, to * w), ease }],
          x: [{ t: at, v: -w / 2 + Math.max(h, from * w) / 2 }, { t: at + dur, v: -w / 2 + Math.max(h, to * w) / 2, ease }],
        },
      } as L,
    ], { width: w, height: h });
  },

  badge(s: BadgeLayer, ctx) {
    const size = s.size ?? 18;
    const iconW = s.icon ? size + 8 : 0;
    const h = size * 2;
    const w = estimateWidth(s.label, size) + iconW + size * 1.6;
    const color = s.color ?? '$primary';
    const children: L[] = [
      { type: 'shape', shape: 'pill', width: w, height: h, fill: s.fill ?? (color.startsWith('$') ? `${color}/14` : color + '24'), stroke: s.stroke ?? (color.startsWith('$') ? `${color}/40` : color + '66'), strokeWidth: 1 } as L,
      { type: 'text', text: s.label, x: iconW / 2, size, weight: 600, font: 'body', color, letterSpacing: 0 } as L,
    ];
    if (s.icon) children.push({ type: 'icon', name: s.icon, x: -w / 2 + size * 0.8 + size / 2, size, color, strokeWidth: 2.4 } as L);
    return group(s, children, { width: w, height: h });
  },

  avatar(s: AvatarLayer, ctx) {
    const size = s.size ?? 64;
    const children: L[] = [];
    if (s.src) {
      children.push({ type: 'image', src: s.src, width: size, height: size, radius: size / 2 } as L);
    } else {
      children.push({ type: 'shape', shape: 'circle', width: size, fill: s.fill ?? { type: 'linear', from: '$primary', to: '$accent', angle: 135 } } as L);
      if (s.initials) children.push({ type: 'text', text: s.initials, size: size * 0.38, weight: 600, font: 'body', color: s.color ?? '#FFFFFF', letterSpacing: 0 } as L);
    }
    if (s.ring) children.push({ type: 'shape', shape: 'ring', width: size + 8, strokeWidth: 3, fill: s.ring } as L);
    return group(s, children, { width: size, height: size });
  },

  flash(s: FlashLayer, ctx) {
    const at = ctx.time(s.at, ctx.time(s.start, 0));
    const dur = ctx.time(s.duration, 0.35);
    const peak = s.intensity ?? 0.9;
    ctx.event('impact', at, Math.min(1, peak + 0.2));
    return {
      type: 'background', style: 'solid', color: s.color ?? '#FFFFFF', blend: s.blend ?? 'add', start: Math.max(0, at - 0.001), end: at + dur, id: s.id,
      keyframes: { opacity: [{ t: at, v: peak }, { t: at + dur, v: 0, ease: 'outQuad' }] },
    } as L;
  },

  glow(s: GlowLayer, ctx) {
    const c = s.color ?? '$primary';
    const size = s.size ?? 700;
    const intensity = s.intensity ?? 0.55;
    let from: string;
    let to: string;
    if (c.startsWith('$')) {
      const token = c.split('/')[0];
      from = `${token}/${Math.round(intensity * 100)}`;
      to = `${token}/0`;
    } else {
      // Fade to the same color at zero alpha so normal blending leaves no dark halo on light backgrounds.
      const rgb = ctx.color(c);
      const hex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
      const base = `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`;
      from = `${base}${hex(rgb.a * intensity)}`;
      to = `${base}00`;
    }
    return { type: 'shape', shape: 'circle', ...pickBase(s), width: size, blend: s.blend ?? 'add', falloff: 3, fill: { type: 'radial', from, to } } as L;
  },

  code(s: CodeLayer, ctx) {
    const size = s.size ?? 22;
    const lh = size * (s.lineHeight ?? 1.6);
    const lines = s.code.replace(/\t/g, '  ').split('\n');
    const longest = Math.max(...lines.map((l) => l.length), 10);
    const pad = 32;
    const bar = s.title !== undefined ? 46 : 0;
    const w = s.width ?? longest * size * 0.6 + pad * 2;
    const h = s.height ?? lines.length * lh + pad * 2 + bar;
    const at = ctx.time(s.at, ctx.time(s.start, 0));
    const cps = s.speed ?? 45;
    const charW = size * 0.6;
    const children: L[] = [
      { type: 'shape', width: w, height: h, radius: 18, fill: '#0E0E14', stroke: '$border', strokeWidth: 1, shadow: { blur: 70, y: -36, opacity: 0.5 } } as L,
    ];
    if (bar) {
      children.push(
        ...['#FF5F57', '#FEBC2E', '#28C840'].map((c, i) => ({ type: 'shape', shape: 'circle', x: -w / 2 + 24 + i * 20, y: h / 2 - bar / 2, width: 12, fill: c }) as L),
        { type: 'text', text: s.title!, y: h / 2 - bar / 2, size: 15, weight: 500, font: 'mono', color: '$muted', letterSpacing: 0 } as L,
        { type: 'shape', y: h / 2 - bar, width: w, height: 1, fill: '$border' } as L,
      );
    }
    const top = h / 2 - bar - pad - lh / 2;
    let charIndex = 0;
    lines.forEach((line, li) => {
      const tokens = highlightCode(line, s.language);
      let col = 0;
      for (const tok of tokens) {
        if (tok.text.trim().length) {
          const appear = at + charIndex / cps;
          children.push({
            type: 'text', text: tok.text, font: 'mono', size, weight: 400, color: tok.color, align: 'left', anchor: 'left', letterSpacing: 0,
            x: -w / 2 + pad + col * charW, y: top - li * lh,
            ...(s.typing === false ? {} : { animate: { preset: 'typewriter', by: 'char', at: appear, stagger: 1 / cps } }),
          } as L);
        }
        col += tok.text.length;
        charIndex += tok.text.length;
      }
      charIndex += 4;
    });
    if (s.typing !== false) {
      // Blinking caret that tracks typing progress line by line.
      const caretKeys: Keyframe[] = [];
      const caretY: Keyframe[] = [];
      let ci = 0;
      lines.forEach((line, li) => {
        const t0 = at + ci / cps;
        const t1 = at + (ci + line.length) / cps;
        caretKeys.push({ t: t0, v: -w / 2 + pad, ease: 'linear' }, { t: t1, v: -w / 2 + pad + line.length * charW, ease: 'linear' });
        caretY.push({ t: t0, v: top - li * lh, ease: 'linear' }, { t: t1, v: top - li * lh, ease: 'linear' });
        ci += line.length + 4;
      });
      children.push({ type: 'shape', width: 3, height: size * 1.2, fill: '$primary', keyframes: { x: caretKeys, y: caretY }, loop: { preset: 'blink', period: 1 } } as L);
    }
    return group(s, children, { width: w, height: h });
  },
};

export function repeat(s: RepeatLayer, ctx: EngineContext): L {
  const n = s.count;
  const templates = (s.children ?? []) as L[];
  if (!templates.length) return group(s, []);
  const layout = s.layout ?? 'line';
  const sp = s.spacing;
  const [sx, sy, sz] = typeof sp === 'number' ? [sp, sp, sp] : sp ? [sp[0], sp[1], (sp as number[])[2] ?? 0] : [320, 240, 400];
  const stagger = ctx.time(s.stagger, 0);
  const r = rng(s.seed ?? 7);
  const radius = s.radius ?? 600;
  const items: L[] = [];
  for (let i = 0; i < n; i++) {
    const item = delayed(templates[i % templates.length], i * stagger, ctx);
    let wrap: L;
    switch (layout) {
      case 'grid': {
        const cols = s.columns ?? Math.ceil(Math.sqrt(n));
        const rowsN = Math.ceil(n / cols);
        const cx = (i % cols) - (cols - 1) / 2;
        const cy = Math.floor(i / cols) - (rowsN - 1) / 2;
        wrap = { type: 'group', x: cx * sx, y: -cy * sy, children: [item] } as L;
        break;
      }
      case 'ring': {
        // Carousel around the vertical axis, items facing outward.
        const a = (360 * i) / n;
        wrap = { type: 'group', rotateY: a, children: [{ type: 'group', z: radius, children: [item] } as L] } as L;
        break;
      }
      case 'tunnel': {
        // Items line the walls of a tunnel around the camera axis, facing inward. `rows` repeat along z.
        const rowsN = s.rows ?? 1;
        const perRow = Math.ceil(n / rowsN);
        const row = Math.floor(i / perRow);
        const a = (360 * (i % perRow)) / perRow + (row % 2) * (180 / perRow);
        wrap = {
          type: 'group', rotateZ: a + 90, z: -row * (sz || 900),
          children: [{ type: 'group', y: -radius, rotateX: -90, children: [item] } as L],
        } as L;
        break;
      }
      case 'scatter': {
        const [w, h, d] = s.area ?? [1800, 1000, 900];
        const j = s.jitter ?? 25;
        wrap = {
          type: 'group', x: (r() - 0.5) * w, y: (r() - 0.5) * h, z: (r() - 0.5) * d,
          rotateX: (r() - 0.5) * j, rotateY: (r() - 0.5) * j * 1.4, rotateZ: (r() - 0.5) * j * 0.6,
          children: [item],
        } as L;
        break;
      }
      default:
        wrap = { type: 'group', x: (i - (n - 1) / 2) * sx, children: [item] } as L;
    }
    items.push(wrap);
  }
  return group(s, items);
}

export function isComponent(type: string): boolean {
  return type in COMPONENTS;
}

export function expand(spec: L, ctx: EngineContext): L {
  const fn = COMPONENTS[spec.type];
  return fn ? fn(spec, ctx) : spec;
}

COMPONENTS.repeat = repeat as (spec: any, ctx: EngineContext) => L;
COMPONENTS.timeline = timeline as (spec: any, ctx: EngineContext) => L;
