/**
 * Product UI from data: lists, tables, kanban boards, chat and email threads, forms, a calendar week,
 * an app sidebar and a pile of notifications. Each lays itself out (no hand-placed rows), keeps its
 * text inside its box (long lines end in an ellipsis), uses the theme's color tokens and brings its
 * rows in one after another from `at`, `stagger` apart (`stagger: 0` shows them at once).
 */
import type { EngineContext } from '../context';
import type { Keyframe } from '../../spec/schema';
import { group as makeGroup } from './index';
import { layoutStack, lineWidth, padding, truncate, wrapLines } from './layout';

type L = Record<string, any>;

const BODY = { font: 'body', letterSpacing: 0 } as const;
const group = makeGroup as unknown as (spec: L, children: L[], extra?: L) => L;

function text(t: string, x: number, y: number, size: number, extra: L = {}): L {
  return { type: 'text', text: t, x, y, size, weight: 500, color: '$text', align: 'left', anchor: 'left', ...BODY, ...extra };
}

function panel(s: L, w: number, h: number, defaults: L = {}): L {
  const shadow = s.shadow === false ? undefined : s.shadow === true || s.shadow === undefined ? { blur: 60, y: -28, opacity: 0.4 } : s.shadow;
  return { type: 'shape', width: w, height: h, radius: s.radius ?? defaults.radius ?? 20, fill: s.fill ?? '$surface', stroke: s.stroke ?? '$border', strokeWidth: 1, shadow };
}

/** When rows start and how far apart. */
function timing(s: L, ctx: EngineContext, stagger = 0.08): { at: number; stagger: number } {
  return { at: ctx.time(s.at, ctx.time(s.start, 0)), stagger: s.stagger !== undefined ? ctx.time(s.stagger, 0) : stagger };
}

function enter(s: L, t: number, preset = 'riseIn'): L {
  return s.stagger === 0 ? {} : { in: { preset: s.enter ?? preset, at: t, duration: 0.5 } };
}

function tint(c: string, pct: number): string {
  return c.startsWith('$') ? `${c.split('/')[0]}/${pct}` : c.length === 7 ? c + Math.round((pct / 100) * 255).toString(16).padStart(2, '0') : c;
}

function avatarAt(a: L | string, x: number, y: number, size: number): L {
  const spec = typeof a === 'string' ? (/\.(png|jpe?g|webp|svg)$/i.test(a) ? { src: a } : { initials: a }) : a;
  return { type: 'avatar', size, x, y, ...spec };
}

function badgeAt(b: string | L, x: number, y: number, size: number, anchor = 'right'): L {
  const spec = typeof b === 'string' ? { label: b } : b;
  return { type: 'badge', size, x, y, anchor, ...spec };
}

export const UI: Record<string, (s: any, ctx: EngineContext) => L> = {
  stack(s, ctx) {
    const l = layoutStack(s, ctx);
    const { fill: _f, stroke: _s, ...rest } = s;
    const g = group(rest, l.children, { width: l.size[0], height: l.size[1] });
    // Without a panel it is only layout: its text is copy, not a component's UI.
    if (s.fill === undefined && s.stroke === undefined) g.layoutOnly = true;
    return g;
  },

  list(s, ctx) {
    const size = s.size ?? 24;
    const w = s.width ?? size * 28;
    const rows: L[] = s.rows ?? [];
    const hasSub = rows.some((r) => r.subtitle);
    const rh = s.rowHeight ?? (hasSub ? size * 3.8 : size * 3);
    const [pt, pr, pb, pl] = padding(s.padding, 12);
    const head = s.title ? size * 2.6 : 0;
    const h = pt + head + rows.length * rh + pb;
    const { at, stagger } = timing(s, ctx);
    const children: L[] = [panel(s, w, h)];
    const left = -w / 2 + pl;
    const right = w / 2 - pr;
    let y = h / 2 - pt;
    if (s.title) {
      children.push(text(s.title, left + 12, y - head / 2, size * 0.95, { weight: 600 }));
      y -= head;
      children.push({ type: 'shape', y, width: w, height: 1, fill: '$border' });
    }
    rows.forEach((r, i) => {
      const cy = y - rh / 2;
      const t = at + i * stagger;
      const kids: L[] = [];
      const sel = s.select && s.select.row === i;
      if (r.highlight || sel) {
        kids.push({
          type: 'shape', width: right - left, height: rh - 8, radius: 12, fill: tint(s.accent ?? '$primary', 14),
          ...(sel && !r.highlight ? { in: { preset: 'fade', at: ctx.time(s.select.at, t + 0.5), duration: 0.25 } } : {}),
        });
      }
      let x = left + 12;
      const lead = size * 2.1;
      if (r.avatar || r.src) {
        kids.push(avatarAt(r.src ?? r.avatar, x + lead / 2, 0, lead));
        x += lead + 16;
      } else if (r.icon) {
        kids.push({ type: 'shape', x: x + lead / 2, width: lead, height: lead, radius: 10, fill: tint(r.color ?? '$primary', 16) });
        kids.push({ type: 'icon', name: r.icon, x: x + lead / 2, size: size * 1.05, color: r.color ?? '$primary', strokeWidth: 2.2 });
        x += lead + 16;
      }
      let end = right - 12;
      if (r.meta !== undefined) {
        kids.push(text(String(r.meta), end, 0, size * 0.85, { align: 'right', anchor: 'right', color: '$muted' }));
        end -= lineWidth(String(r.meta), size * 0.85, 0) + 18;
      }
      if (r.badge) {
        const b = badgeAt(r.badge, end, 0, size * 0.75);
        kids.push(b);
        end -= lineWidth(b.label, size * 0.75, 0) + size * 1.4 + 14;
      }
      const room = end - x;
      if (r.subtitle) {
        kids.push(text(truncate(r.title, size, room), x, size * 0.6, size, { weight: 600 }));
        kids.push(text(truncate(r.subtitle, size * 0.82, room), x, -size * 0.65, size * 0.82, { color: '$muted', weight: 400 }));
      } else kids.push(text(truncate(r.title, size, room), x, 0, size, { weight: 600 }));
      children.push({ type: 'group', y: cy, children: kids, ...enter(s, t) });
      if (i < rows.length - 1 && s.dividers !== false) children.push({ type: 'shape', y: y - rh, width: right - left, height: 1, fill: '$border', opacity: 0.6 });
      y -= rh;
    });
    return group(s, children, { width: w, height: h });
  },

  table(s, ctx) {
    const cols: L[] = s.columns ?? [];
    const rows: unknown[][] = s.rows ?? [];
    const size = s.size ?? 22;
    const w = s.width ?? size * 44;
    const rh = s.rowHeight ?? size * 2.9;
    const pad = 24;
    const headH = size * 2.6;
    const h = headH + rows.length * rh + 8;
    const { at, stagger } = timing(s, ctx, 0.06);
    // Column widths: given (px, or fractions of the width), the rest shared by the others.
    const inner = w - pad * 2;
    const given = cols.map((c) => (c.width === undefined ? undefined : c.width <= 1 ? c.width * inner : c.width));
    const fixed = given.reduce<number>((a, b) => a + (b ?? 0), 0);
    const open = given.filter((g) => g === undefined).length;
    const widths = given.map((g) => g ?? Math.max(40, (inner - fixed) / Math.max(1, open)));
    const xs: number[] = [];
    let acc = -w / 2 + pad;
    for (const cw of widths) {
      xs.push(acc);
      acc += cw;
    }
    const children: L[] = [panel(s, w, h, { radius: 16 })];
    const top = h / 2;
    const colX = (i: number, align: string) => (align === 'right' ? xs[i] + widths[i] - 12 : align === 'center' ? xs[i] + widths[i] / 2 : xs[i]);
    cols.forEach((c, i) => {
      const align = c.align ?? 'left';
      children.push(text(String(c.label ?? '').toUpperCase(), colX(i, align), top - headH / 2, size * 0.75, { align, anchor: align, color: '$muted', weight: 600, letterSpacing: 0.06 }));
    });
    children.push({ type: 'shape', y: top - headH, width: w, height: 1, fill: '$border' });
    rows.forEach((r, ri) => {
      const cy = top - headH - rh * ri - rh / 2;
      const t = at + ri * stagger;
      const kids: L[] = [];
      if (s.highlight === ri) kids.push({ type: 'shape', width: w - 16, height: rh - 6, radius: 10, fill: tint(s.accent ?? '$primary', 14) });
      r.forEach((cell, ci) => {
        if (ci >= cols.length || cell === null || cell === undefined) return;
        const align = cols[ci].align ?? (typeof cell === 'number' ? 'right' : 'left');
        const x = colX(ci, align);
        const room = widths[ci] - 16;
        if (typeof cell === 'object') {
          const c = cell as L;
          if (c.badge) kids.push(badgeAt({ label: c.badge, color: c.color }, x, 0, size * 0.8, align === 'right' ? 'right' : align === 'center' ? 'center' : 'left'));
          else if (c.avatar !== undefined) {
            kids.push(avatarAt(c.avatar, x + size, 0, size * 1.7));
            if (c.text) kids.push(text(truncate(String(c.text), size, room - size * 2.4), x + size * 2.4, 0, size, { weight: 600 }));
          } else kids.push(text(truncate(String(c.text ?? ''), size, room), x, 0, size, { align, anchor: align, color: c.color ?? '$text', weight: c.weight ?? 500 }));
        } else {
          kids.push(text(truncate(String(cell), size, room), x, 0, size, { align, anchor: align, weight: ci === 0 ? 600 : 500, color: ci === 0 ? '$text' : '$text' }));
        }
      });
      children.push({ type: 'group', y: cy, children: kids, ...enter(s, t, 'fade') });
      if (ri < rows.length - 1) children.push({ type: 'shape', y: cy - rh / 2, width: w - pad * 2, height: 1, fill: '$border', opacity: 0.5 });
    });
    return group(s, children, { width: w, height: h });
  },

  board(s, ctx) {
    const cols: L[] = s.columns ?? [];
    const size = s.size ?? 22;
    const cw = s.columnWidth ?? size * 16;
    const gap = s.gap ?? 20;
    const cardH = size * 4.4;
    const cardGap = 12;
    const headH = size * 2.8;
    const maxCards = Math.max(1, ...cols.map((c) => (c.cards ?? []).length + (s.move && s.move.to === cols.indexOf(c) ? 1 : 0)));
    const colH = s.height ?? headH + maxCards * (cardH + cardGap) + 16;
    const w = cols.length * cw + (cols.length - 1) * gap;
    const h = colH;
    const { at, stagger } = timing(s, ctx, 0.05);
    const children: L[] = [];
    const colX = (i: number) => -w / 2 + cw / 2 + i * (cw + gap);
    const cardY = (k: number) => h / 2 - headH - cardH / 2 - k * (cardH + cardGap);
    cols.forEach((c, i) => {
      children.push({ type: 'shape', x: colX(i), width: cw, height: h, radius: 16, fill: s.fill ?? '$surface', stroke: s.stroke ?? '$border', strokeWidth: 1 });
      children.push({ type: 'shape', shape: 'circle', x: colX(i) - cw / 2 + 22, y: h / 2 - headH / 2, width: 10, fill: c.color ?? '$primary' });
      children.push(text(truncate(c.title, size, cw - 60), colX(i) - cw / 2 + 36, h / 2 - headH / 2, size, { weight: 600 }));
    });
    // Where every card is before and after the move.
    const move = s.move as { card: string; to: number; at?: unknown; duration?: unknown } | undefined;
    const moveAt = move ? ctx.time(move.at as any, at + 1.2) : 0;
    const moveDur = move ? ctx.time(move.duration as any, 0.7) : 0;
    let n = 0;
    cols.forEach((c, i) => {
      const cards: L[] = c.cards ?? [];
      let after = 0;
      cards.forEach((card, k) => {
        const moving = move && card.title === move.card;
        const x0 = colX(i);
        const y0 = cardY(k);
        let x1 = x0;
        let y1 = y0;
        if (moving) {
          x1 = colX(move!.to);
          y1 = cardY((cols[move!.to]?.cards ?? []).length);
        } else {
          y1 = cardY(after);
          after++;
        }
        const t = at + n++ * stagger;
        const kids: L[] = [
          { type: 'shape', width: cw - 24, height: cardH, radius: 12, fill: s.cardFill ?? '$surface2', stroke: '$border', strokeWidth: 1, shadow: moving ? { blur: 40, y: -18, opacity: 0.5 } : undefined },
          text(truncate(card.title, size, cw - 60), -(cw - 24) / 2 + 16, card.tag || card.avatar ? size * 0.75 : 0, size, { weight: 600 }),
        ];
        if (card.tag) kids.push(badgeAt({ label: card.tag, color: card.tagColor ?? c.color ?? '$primary' }, -(cw - 24) / 2 + 16, -size * 0.85, size * 0.82, 'left'));
        if (card.avatar) kids.push(avatarAt(card.avatar, (cw - 24) / 2 - 16 - size * 0.8, -size * 0.85, size * 1.6));
        const keyframes: Record<string, Keyframe[]> = {};
        if (x1 !== x0 || y1 !== y0) {
          const ease = 'inOutCubic';
          keyframes.x = [{ t: moveAt, v: x0 }, { t: moveAt + moveDur, v: x1, ease }];
          keyframes.y = [{ t: moveAt, v: y0 }, { t: moveAt + moveDur, v: y1, ease }];
          if (moving) {
            keyframes.rotate = [{ t: moveAt, v: 0 }, { t: moveAt + moveDur * 0.4, v: -3, ease: 'outCubic' }, { t: moveAt + moveDur, v: 0, ease: 'inOutCubic' }];
            keyframes.scale = [{ t: moveAt, v: 1 }, { t: moveAt + moveDur * 0.4, v: 1.05, ease: 'outCubic' }, { t: moveAt + moveDur, v: 1, ease: 'inOutCubic' }];
          }
        }
        children.push({ type: 'group', x: x0, y: y0, z: moving ? 4 : 0, children: kids, ...(Object.keys(keyframes).length ? { keyframes } : {}), ...enter(s, t) });
      });
    });
    return group(s, children, { width: w, height: h });
  },

  thread(s, ctx) {
    const size = s.size ?? 24;
    const w = s.width ?? size * 28;
    const email = s.style === 'email';
    const msgs: L[] = s.messages ?? [];
    const { at, stagger } = timing(s, ctx, email ? 0.25 : 0.7);
    const [pt, pr, pb, pl] = padding(s.padding, 24);
    const inner = w - pl - pr;
    const lh = size * 1.35;
    const children: L[] = [];
    const items: { h: number; build: (top: number) => L[]; t: number }[] = [];
    const first = msgs.find((m) => m.from)?.from;
    msgs.forEach((m, i) => {
      const t = m.at !== undefined ? ctx.time(m.at, at) : at + i * stagger;
      if (email) {
        const body = wrapLines(m.text, size, inner, 0);
        const head = size * 2.6;
        const h = head + body.length * lh + size * 0.9;
        items.push({
          h, t,
          build: (top) => {
            const kids: L[] = [];
            const av = size * 2;
            if (m.from) kids.push(avatarAt(m.avatar ?? initials(m.from), -w / 2 + pl + av / 2, top - av / 2, av));
            kids.push(text(truncate(m.from ?? '', size, inner - av - 120), -w / 2 + pl + av + 14, top - size * 0.55, size, { weight: 600 }));
            if (m.email) kids.push(text(truncate(m.email, size * 0.8, inner - av - 120), -w / 2 + pl + av + 14, top - size * 1.6, size * 0.8, { color: '$muted', weight: 400 }));
            if (m.time) kids.push(text(m.time, w / 2 - pr, top - size * 0.55, size * 0.8, { align: 'right', anchor: 'right', color: '$muted' }));
            kids.push({ type: 'text', text: body.join('\n'), x: -w / 2 + pl, y: top - head - (body.length * lh) / 2, size, weight: 400, color: '$text', align: 'left', anchor: 'left', lineHeight: 1.35, ...BODY });
            return kids;
          },
        });
      } else {
        const right = m.side ? m.side === 'right' : m.from !== undefined && m.from !== first;
        const maxBubble = inner * 0.78;
        const lines = wrapLines(m.text, size, maxBubble - size * 1.6, 0);
        const bw = Math.min(maxBubble, Math.max(...lines.map((x) => lineWidth(x, size, 0))) + size * 1.6);
        const bh = lines.length * lh + size * 1.1;
        const label = m.from && s.names !== false && (i === 0 || msgs[i - 1].from !== m.from) ? size * 1.3 : 0;
        items.push({
          h: bh + label, t,
          build: (top) => {
            const kids: L[] = [];
            const bx = right ? w / 2 - pr - bw / 2 : -w / 2 + pl + bw / 2;
            if (label) kids.push(text(m.from, right ? w / 2 - pr : -w / 2 + pl, top - size * 0.45, size * 0.75, { color: '$muted', align: right ? 'right' : 'left', anchor: right ? 'right' : 'left' }));
            const by = top - label - bh / 2;
            kids.push({ type: 'shape', x: bx, y: by, width: bw, height: bh, radius: Math.min(size * 1.1, bh / 2), fill: right ? m.color ?? s.accent ?? '$primary' : s.bubble ?? '$surface2' });
            kids.push({ type: 'text', text: lines.join('\n'), x: bx - bw / 2 + size * 0.8, y: by, size, weight: 400, color: right ? '#FFFFFF' : '$text', align: 'left', anchor: 'left', lineHeight: 1.35, ...BODY });
            return kids;
          },
        });
      }
    });
    const gap = email ? size * 1.2 : size * 0.6;
    const subject = email && s.subject ? size * 2.4 : 0;
    const contentH = items.reduce((a, b) => a + b.h, 0) + gap * Math.max(0, items.length - 1);
    const h = s.height ?? pt + (subject ? subject + size * 0.9 : 0) + contentH + pb;
    if (s.panel !== false) children.push(panel(s, w, h));
    let top = h / 2 - pt;
    if (subject) {
      children.push(text(truncate(s.subject, size * 1.2, inner), -w / 2 + pl, top - subject / 2 + 4, size * 1.2, { weight: 600 }));
      children.push({ type: 'shape', y: top - subject, width: w, height: 1, fill: '$border' });
      top -= subject + size * 0.9;
    }
    items.forEach((it, i) => {
      children.push({ type: 'group', children: it.build(top), ...(s.stagger === 0 ? {} : { in: { preset: s.enter ?? (email ? 'fade' : 'popIn'), at: it.t, duration: 0.45 } }) });
      if (email && i < items.length - 1) children.push({ type: 'shape', y: top - it.h - gap / 2, width: inner, height: 1, fill: '$border', opacity: 0.6 });
      top -= it.h + gap;
    });
    // Typing dots before each incoming message (chat only).
    if (!email && s.typing) {
      items.forEach((it, i) => {
        const m = msgs[i];
        const right = m.side ? m.side === 'right' : m.from !== undefined && m.from !== first;
        if (right || it.t - 0.8 < 0) return;
        let y = h / 2 - pt;
        for (let k = 0; k < i; k++) y -= items[k].h + gap;
        const dy = y - it.h / 2;
        children.push({ type: 'group', x: -w / 2 + pl + 40, y: dy, start: it.t - 0.8, end: it.t, children: [
          { type: 'shape', shape: 'pill', width: 80, height: size * 2, fill: s.bubble ?? '$surface2' },
          ...[0, 1, 2].map((d) => ({ type: 'shape', shape: 'circle', x: (d - 1) * 16, width: 9, fill: '$muted', loop: { preset: 'bob', period: 0.6, phase: d * 0.8, amount: 3 } })),
        ] });
      });
    }
    return group(s, children, { width: w, height: h });
  },

  form(s, ctx) {
    const size = s.size ?? 22;
    const w = s.width ?? size * 25;
    const fields: L[] = s.fields ?? [];
    const [pt, pr, pb, pl] = padding(s.padding, 32);
    const inner = w - pl - pr;
    const inputH = size * 2.7;
    const { at, stagger } = timing(s, ctx, 0.7);
    const heights = fields.map((f) => (f.kind === 'toggle' || f.kind === 'check' ? size * 2.4 : size * 1.5 + inputH));
    const gap = size * 1.1;
    const titleH = s.title ? size * 2.6 : 0;
    const btnH = s.submit ? size * 2.7 : 0;
    const h = pt + titleH + heights.reduce((a, b) => a + b, 0) + gap * Math.max(0, fields.length - 1) + (btnH ? gap * 1.4 + btnH : 0) + pb;
    const children: L[] = [panel(s, w, h)];
    const left = -w / 2 + pl;
    let top = h / 2 - pt;
    if (s.title) {
      children.push(text(truncate(s.title, size * 1.3, inner), left, top - titleH / 2 + 4, size * 1.3, { weight: 600 }));
      top -= titleH;
    }
    let typed = at;
    fields.forEach((f, i) => {
      const fh = heights[i];
      if (f.kind === 'toggle' || f.kind === 'check') {
        const cy = top - fh / 2;
        children.push(text(truncate(f.label ?? '', size, inner - 80), f.kind === 'check' ? left + size * 1.8 : left, cy, size));
        const on = f.on ?? false;
        const flip = f.at !== undefined ? ctx.time(f.at, typed) : undefined;
        if (f.kind === 'toggle') {
          const tw = size * 2.6;
          const th = size * 1.5;
          const tx = w / 2 - pr - tw / 2;
          const kOff = tx - tw / 2 + th / 2;
          const kOn = tx + tw / 2 - th / 2;
          const final = flip !== undefined ? !on : on;
          children.push({ type: 'shape', shape: 'pill', x: tx, y: cy, width: tw, height: th, fill: on ? '$primary' : '$border',
            ...(flip !== undefined ? { keyframes: { fill: [{ t: flip, v: on ? '$primary' : '$border' }, { t: flip + 0.25, v: final ? '$primary' : '$border' }] } } : {}) });
          children.push({ type: 'shape', shape: 'circle', x: on ? kOn : kOff, y: cy, width: th - 6, fill: '#FFFFFF',
            ...(flip !== undefined ? { keyframes: { x: [{ t: flip, v: on ? kOn : kOff }, { t: flip + 0.3, v: final ? kOn : kOff, ease: 'springSoft' }] } } : {}) });
        } else {
          const bs = size * 1.2;
          children.push({ type: 'shape', x: left + bs / 2, y: cy, width: bs, height: bs, radius: 5, fill: on || flip !== undefined ? '$primary' : 'none', stroke: '$border', strokeWidth: 1.5,
            ...(flip !== undefined && !on ? { in: { preset: 'popIn', at: flip, duration: 0.3 } } : {}) });
          if (on || flip !== undefined) children.push({ type: 'icon', name: 'check', x: left + bs / 2, y: cy, size: bs * 0.75, color: '#FFFFFF', strokeWidth: 3, ...(flip !== undefined && !on ? { in: { preset: 'popIn', at: flip, duration: 0.3 } } : {}) });
        }
      } else {
        children.push(text(truncate(f.label ?? '', size * 0.85, inner), left, top - size * 0.5, size * 0.85, { color: '$muted', weight: 500 }));
        const iy = top - size * 1.5 - inputH / 2;
        const value = f.value !== undefined ? String(f.value) : '';
        const typing = value && s.typing !== false && f.kind !== 'select';
        const start = f.at !== undefined ? ctx.time(f.at, typed) : typed;
        const cps = s.speed ?? 22;
        const end = start + value.length / cps;
        children.push({ type: 'shape', x: 0, y: iy, width: inner, height: inputH, radius: 10, fill: s.inputFill ?? '$surface2', stroke: '$border', strokeWidth: 1 });
        if (typing) {
          children.push({ type: 'shape', x: 0, y: iy, width: inner + 6, height: inputH + 6, radius: 13, fill: 'none', stroke: s.accent ?? '$primary', strokeWidth: 2, start: start - 0.15, end: end + 0.5,
            in: { preset: 'fade', at: start - 0.15, duration: 0.15 } });
        }
        const room = inner - size * 1.6 - (f.kind === 'select' ? size * 1.6 : 0);
        if (value) {
          children.push(text(truncate(value, size, room), left + size * 0.8, iy, size, {
            weight: 500, ...(typing ? { animate: { preset: 'typewriter', by: 'char', at: start, stagger: 1 / cps } } : {}),
          }));
        } else if (f.placeholder) children.push(text(truncate(f.placeholder, size, room), left + size * 0.8, iy, size, { color: '$muted', weight: 400 }));
        if (f.kind === 'select') children.push({ type: 'icon', name: 'chevron-down', x: w / 2 - pr - size * 1.1, y: iy, size: size * 1.1, color: '$muted' });
        if (typing) typed = end + stagger * 0.4;
      }
      top -= fh + gap;
    });
    if (s.submit) {
      const by = top - gap * 0.4 - btnH / 2;
      children.push({ type: 'button', label: s.submit, y: by, width: inner, height: btnH, radius: 12, size, ...(s.press !== undefined ? { press: s.press } : {}) });
    }
    return group(s, children, { width: w, height: h });
  },

  calendar(s, ctx) {
    const days: string[] = s.days ?? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    const from: number = s.from ?? 9;
    const to: number = s.to ?? 17;
    const size = s.size ?? 22;
    const w = s.width ?? size * 54;
    const h = s.height ?? size * 32;
    const gutter = size * 4.2;
    const headH = size * 3;
    const colW = (w - gutter - 16) / days.length;
    const hourH = (h - headH - 16) / (to - from);
    const { at, stagger } = timing(s, ctx, 0.1);
    const children: L[] = [panel(s, w, h, { radius: 18 })];
    const x0 = -w / 2 + gutter;
    const y0 = h / 2 - headH;
    const yAt = (hr: number) => y0 - (hr - from) * hourH;
    days.forEach((d, i) => {
      const cx = x0 + colW * (i + 0.5);
      const today = s.today === i;
      children.push(text(d.toUpperCase(), cx, h / 2 - headH / 2, size * 0.9, { align: 'center', anchor: 'center', weight: 600, letterSpacing: 0.06, color: today ? s.accent ?? '$primary' : '$muted' }));
      if (i > 0) children.push({ type: 'shape', x: x0 + colW * i, y: y0 - (h - headH - 16) / 2, width: 1, height: h - headH - 16, fill: '$border', opacity: 0.6 });
    });
    for (let hr = from; hr <= to; hr++) {
      children.push({ type: 'shape', x: (x0 + w / 2 - 16) / 2, y: yAt(hr), width: w / 2 - 16 - x0, height: 1, fill: '$border', opacity: hr === from ? 1 : 0.5 });
      if (hr < to) children.push(text(hourLabel(hr, s.clock), x0 - 12, yAt(hr) - size * 0.1, size * 0.85, { align: 'right', anchor: 'right', color: '$muted' }));
    }
    (s.events ?? []).forEach((e: L, i: number) => {
      const t = e.at !== undefined ? ctx.time(e.at, at) : at + i * stagger;
      const ex = x0 + colW * (e.day + 0.5);
      const top = yAt(e.from);
      const bottom = yAt(e.to);
      const eh = Math.max(size * 1.6, top - bottom - 4);
      const ew = colW - 10;
      const c = e.color ?? s.accent ?? '$primary';
      // Text on a solid event: dark on light colors, white on dark ones.
      const ink = e.solid ? (luminance(ctx.color(c)) > 0.45 ? '#0B0B10' : '#FFFFFF') : undefined;
      const kids: L[] = [
        { type: 'shape', width: ew, height: eh, radius: 8, fill: tint(c, e.solid ? 100 : 22) },
        { type: 'shape', x: -ew / 2 + 2.5, width: 4, height: eh - 10, radius: 2, fill: c },
      ];
      const room = ew - 22;
      const fits2 = eh > size * 3.2;
      kids.push(text(truncate(e.title, size, room), -ew / 2 + 12, fits2 ? eh / 2 - size * 1.05 : 0, size, { weight: 600, color: ink ?? '$text' }));
      if (fits2) kids.push(text(`${hourLabel(e.from, s.clock, true)} - ${hourLabel(e.to, s.clock, true)}`, -ew / 2 + 12, eh / 2 - size * 2.4, size * 0.85, { color: ink ?? '$muted', weight: 400, opacity: ink ? 0.8 : 1 }));
      if (e.icon) kids.push({ type: 'icon', name: e.icon, x: ew / 2 - size, y: eh / 2 - size, size: size * 1.1, color: ink ?? c });
      children.push({ type: 'group', x: ex, y: top - 2 - eh / 2, children: kids, ...(s.stagger === 0 ? {} : { in: { preset: s.enter ?? 'popIn', at: t, duration: 0.45 } }) });
    });
    if (s.now !== undefined) {
      const y = yAt(s.now);
      children.push({ type: 'shape', x: (x0 + w / 2 - 16) / 2, y, width: w / 2 - 16 - x0, height: 2, fill: '$danger' });
      children.push({ type: 'shape', shape: 'circle', x: x0, y, width: 10, fill: '$danger' });
    }
    return group(s, children, { width: w, height: h });
  },

  sidebar(s, ctx) {
    const size = s.size ?? 22;
    const w = s.width ?? size * 14;
    const items: L[] = s.items ?? [];
    const itemH = size * 2.5;
    const [pt, pr, pb, pl] = padding(s.padding, 16);
    const brandH = s.brand ? size * 3.4 : 0;
    const sections = items.filter((i) => i.section).length;
    const contentH = brandH + items.length * itemH + sections * size * 0.6;
    const h = s.height ?? pt + contentH + pb;
    const children: L[] = [panel(s, w, h, { radius: 18 })];
    const left = -w / 2 + pl;
    let top = h / 2 - pt;
    if (s.brand) {
      const mark = size * 1.8;
      if (s.logo) children.push({ type: 'image', src: s.logo, x: left + 8 + mark / 2, y: top - brandH / 2, width: mark, height: mark, radius: 8 });
      else children.push({ type: 'shape', x: left + 8 + mark / 2, y: top - brandH / 2, width: mark, height: mark, radius: 8, fill: s.accent ?? '$primary' },
        text(String(s.brand)[0].toUpperCase(), left + 8 + mark / 2, top - brandH / 2, size, { align: 'center', anchor: 'center', weight: 700, color: '#FFFFFF' }));
      children.push(text(truncate(s.brand, size * 1.05, w - pl - pr - mark - 30), left + 8 + mark + 12, top - brandH / 2, size * 1.05, { weight: 600 }));
      top -= brandH;
    }
    const ys: number[] = [];
    items.forEach((it) => {
      if (it.section) {
        top -= size * 0.6;
        ys.push(top - itemH / 2);
        children.push(text(String(it.section).toUpperCase(), left + 10, top - itemH / 2 - size * 0.2, size * 0.75, { color: '$muted', weight: 600, letterSpacing: 0.08 }));
        top -= itemH;
        return;
      }
      ys.push(top - itemH / 2);
      top -= itemH;
    });
    // The highlight under the active item, sliding to `select.item` at `select.at`.
    const active = s.active;
    if (active !== undefined || s.select) {
      const fromI = active ?? s.select.item;
      const pill: L = { type: 'shape', x: 0, y: ys[fromI] ?? 0, width: w - pl - pr, height: itemH - 6, radius: 10, fill: tint(s.accent ?? '$primary', 16) };
      if (s.select && ys[s.select.item] !== undefined && active !== undefined) {
        const t = ctx.time(s.select.at, 1);
        pill.keyframes = { y: [{ t, v: ys[fromI] }, { t: t + 0.35, v: ys[s.select.item], ease: 'inOutCubic' }] };
      }
      children.push(pill);
    }
    items.forEach((it, i) => {
      if (it.section) return;
      const y = ys[i];
      const on = (s.select ? s.select.item : active) === i;
      const c = on ? s.accent ?? '$primary' : '$muted';
      let x = left + 14;
      if (it.icon) {
        children.push({ type: 'icon', name: it.icon, x: x + size * 0.6, y, size: size * 1.15, color: c, strokeWidth: 2 });
        x += size * 2;
      }
      let end = w / 2 - pr - 12;
      if (it.badge !== undefined) {
        const b = badgeAt({ label: String(it.badge), color: it.badgeColor ?? '$primary' }, end, y, size * 0.75);
        children.push(b);
        end -= lineWidth(b.label, size * 0.75, 0) + size * 1.2 + 14;
      }
      children.push(text(truncate(it.label ?? '', size, end - x), x, y, size, { color: on ? '$text' : '$muted', weight: on ? 600 : 500 }));
    });
    return group(s, children, { width: w, height: h });
  },

  notifications(s, ctx) {
    const size = s.size ?? 22;
    const w = s.width ?? size * 24;
    const items: L[] = s.items ?? [];
    const hasBody = items.some((i) => i.body);
    const ih = s.itemHeight ?? (hasBody ? size * 5.2 : size * 3.8);
    const gap = s.gap ?? 12;
    const max = Math.min(items.length, s.max ?? items.length);
    const h = max * ih + (max - 1) * gap;
    const { at, stagger } = timing(s, ctx, 0.55);
    const slot = (k: number) => h / 2 - ih / 2 - k * (ih + gap);
    const children: L[] = [];
    items.forEach((it, i) => {
      const t = at + i * stagger;
      const c = it.color ?? s.accent ?? '$primary';
      const lead = size * 2.4;
      const x0 = -w / 2 + 16;
      const room = w - 32 - lead - 14;
      const kids: L[] = [
        { type: 'shape', width: w, height: ih, radius: 18, fill: s.fill ?? '$surface2', stroke: s.stroke ?? '$border', strokeWidth: 1, shadow: { blur: 40, y: -16, opacity: 0.4 } },
        { type: 'shape', x: x0 + lead / 2, width: lead, height: lead, radius: 12, fill: tint(c, 18) },
        { type: 'icon', name: it.icon ?? 'bell', x: x0 + lead / 2, size: size * 1.2, color: c, strokeWidth: 2.2 },
      ];
      const tx = x0 + lead + 14;
      const head = it.app ?? '';
      const timeW = it.time ? lineWidth(it.time, size * 0.8, 0) + 8 : 0;
      if (hasBody) {
        if (head) kids.push(text(truncate(head.toUpperCase(), size * 0.75, room - timeW), tx, ih / 2 - size * 1.15, size * 0.75, { color: '$muted', weight: 600, letterSpacing: 0.06 }));
        kids.push(text(truncate(it.title, size, room), tx, head ? size * 0.05 : size * 0.6, size, { weight: 600 }));
        if (it.body) kids.push(text(truncate(it.body, size * 0.88, room), tx, head ? -size * 1.25 : -size * 0.75, size * 0.88, { color: '$muted', weight: 400 }));
      } else kids.push(text(truncate(it.title, size, room - timeW), tx, 0, size, { weight: 600 }));
      if (it.time) kids.push(text(it.time, w / 2 - 18, hasBody ? ih / 2 - size * 1.15 : 0, size * 0.8, { color: '$muted', align: 'right', anchor: 'right' }));
      // Newest on top: each arrival pushes the earlier ones down a slot.
      const ys: Keyframe[] = [{ t, v: slot(0) }];
      for (let k = i + 1, d = 0; k < items.length; k++, d++) {
        const tk = at + k * stagger;
        ys.push({ t: tk, v: slot(d) }, { t: tk + 0.35, v: slot(d + 1), ease: 'outCubic' });
      }
      const depth = items.length - 1 - i;
      const g: L = {
        type: 'group', y: slot(0), children: kids,
        in: { preset: s.enter ?? 'slideDown', at: t, duration: 0.5 },
        ...(ys.length > 1 ? { keyframes: { y: ys } } : {}),
      };
      // Pushed below `max`: fades out as it leaves the pile.
      if (depth >= max) g.out = { preset: 'fade', at: at + (i + max) * stagger, duration: 0.3 };
      children.push(g);
    });
    return group(s, children, { width: w, height: h });
  },
};

function luminance(c: { r: number; g: number; b: number }): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

function hourLabel(hr: number, clock: string | undefined, minutes = false): string {
  const hh = Math.floor(hr);
  const mm = Math.round((hr - hh) * 60);
  if (clock === '24h') return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const h12 = ((hh + 11) % 12) + 1;
  const ampm = hh < 12 ? 'AM' : 'PM';
  return minutes && mm ? `${h12}:${String(mm).padStart(2, '0')}` : minutes ? `${h12}` : `${h12} ${ampm}`;
}
