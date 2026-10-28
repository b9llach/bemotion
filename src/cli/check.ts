import puppeteer from 'puppeteer';
import { resolve } from 'node:path';
import { readSpec, startServer } from './server';
import { BROWSER_ARGS, openPage } from './render';
import { validateVideo } from '../spec/schema';
import type { InspectInfo, InspectItem } from '../engine/engine';
import { SAFE_ZONES, zoneRects } from '../spec/safezones';

/** One sampled moment of the video. */
export interface Probe {
  t: number;
  info: InspectInfo;
  /** Grayscale thumbnail, 0-255. */
  thumb: number[];
}

export interface Collision {
  scene: string;
  a: string;
  b: string;
  from: number;
  to: number;
  /** Largest share of the smaller box covered, 0-1. */
  amount: number;
}

export interface Hold {
  from: number;
  to: number;
  scene: string;
  /** True when the hold runs to the end of the video (a final lockup may hold longer). */
  end: boolean;
}

/** Text that leaves before a viewer can read it. */
export interface Rush {
  scene: string;
  /** When the first of these lines became readable, and when they left. */
  from: number;
  to: number;
  words: number;
  /** Seconds the words need at the reading speed. */
  need: number;
  texts: string[];
}

/** Text or a key layer under a platform's interface (see src/spec/safezones.ts). */
export interface Unsafe {
  platform: string;
  scene: string;
  layer: string;
  /** Which parts of the interface cover it. */
  zones: string[];
  from: number;
  to: number;
  /** Largest share of its box covered, 0-1. */
  amount: number;
}

/** Product UI (text inside a browser, phone, card...) shown too small to read for a while. */
export interface SmallUi {
  /** `ui`: a component's text; `text`: a line of copy on its own (a subtitle, a URL). */
  kind: 'ui' | 'text';
  scene: string;
  layer: string;
  from: number;
  to: number;
  /** Median font size of its text on screen, in px at 1080p (the frame's shorter side). */
  px: number;
  /** Share of the frame its visible parts cover, 0-1. */
  share: number;
  texts: number;
}

/** A stretch where the frame is nearly empty: no headline and little else on screen. */
export interface Empty {
  scene: string;
  from: number;
  to: number;
  /** Largest share of the frame its layers covered, 0-1. */
  share: number;
  /** What was on screen. */
  layers: string[];
}

/** A stretch where nothing new appears and the picture stays nearly the same: it reads as a slide. */
export interface Stale {
  scene: string;
  from: number;
  to: number;
}

/** Text, or a device or card that would fit in the frame, cut off at the frame's edge. */
export interface Cropped {
  /** `text`: a line of copy on its own; `ui`: a component (browser, phone, card...) and its text. */
  kind: 'text' | 'ui';
  scene: string;
  layer: string;
  from: number;
  to: number;
  /** Which edges cut it: left, right, top, bottom. */
  edges: string[];
  /** Largest share of its width or height outside the frame, 0-1. */
  amount: number;
}

export interface CheckOptions {
  /** Reading speed for the reading-time check, in words per second. */
  read?: number;
  /** Longest stretch without visible motion before it is reported, in seconds. */
  hold?: number;
  /** The same for the last shot of the video. */
  endHold?: number;
  /** Shortest overlap worth reporting, in seconds. */
  minOverlap?: number;
  /** Platforms whose safe zones to check (tiktok, reels, shorts); implies the 9:16 format. */
  platforms?: string[];
}

const TEXT = new Set(['text', 'counter']);

function label(it: InspectItem): string {
  let name = it.id ? `"${it.id}"` : it.text ? `${it.type} "${it.text.length > 28 ? `${it.text.slice(0, 26)}..` : it.text}"` : it.type;
  if (!it.id && it.group) name += ` in "${it.group}"`;
  return it.path ? `${name} (${it.path})` : name;
}

function area(b: InspectItem['box']): number {
  return Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
}

/** Layers whose boxes say little about what they cover (3D objects). */
const LOOSE = new Set(['mesh', 'model']);

/**
 * How badly two on-screen elements collide, 0 when they do not. Only text can collide, in three ways:
 * - text over text (different words; a repeated word in a pattern is a design);
 * - something drawn on top of text, covering part of it;
 * - text crossing the edge of a panel under it, half on and half off. Text fully inside a card or
 *   button is the design.
 * Parts of the same component (a browser and the UI inside it) are designed together and skipped, as
 * are 3D objects and elements covering most of the frame (a full-bleed image, a device screen).
 */
export function collision(a: InspectItem, b: InspectItem, frameArea: number): number {
  if (a.anc.includes(b.uid) || b.anc.includes(a.uid)) return 0;
  if (!TEXT.has(a.type) && !TEXT.has(b.type)) return 0;
  if (LOOSE.has(a.type) || LOOSE.has(b.type)) return 0;
  if (a.opacity < 0.6 || b.opacity < 0.6) return 0;
  // Parts of one component are designed together.
  if (a.component !== undefined && a.component === b.component) return 0;
  const A = a.box;
  const B = b.box;
  const iw = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
  const ih = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const frac = inter / Math.max(1, Math.min(area(A), area(B)));
  if (frac < 0.04) return 0;
  // A mock UI (browser, phone, card) is a backdrop: headlines and floating panels over it are the design.
  if (a.component !== b.component) return 0;
  if (TEXT.has(a.type) && TEXT.has(b.type)) return a.text !== undefined && a.text === b.text ? 0 : frac;
  const [txt, other] = TEXT.has(a.type) ? [a, b] : [b, a];
  if (area(other.box) > frameArea * 0.6) return 0;
  const covered = inter / Math.max(1, area(txt.box));
  // Drawn over the text: any real cover hides letters.
  if (other.order > txt.order) return covered >= 0.04 ? covered : 0;
  // Under the text: fine when the text sits fully on it, or when it is a small mark inside the
  // text's box (an icon beside a word).
  if (covered > 0.92) return 0;
  if (inter / Math.max(1, area(other.box)) > 0.92) return 0;
  return covered;
}

/** Collisions (see `collision`) that last at least `minOverlap` seconds. */
export function findCollisions(probes: Probe[], frame: { width: number; height: number }, minOverlap = 0.4): Collision[] {
  const open = new Map<string, Collision & { last: number }>();
  const out: Collision[] = [];
  const step = probes.length > 1 ? probes[1].t - probes[0].t : 0.1;
  const close = (k: string) => {
    const c = open.get(k)!;
    open.delete(k);
    if (c.to - c.from + step >= minOverlap - 1e-6) out.push({ scene: c.scene, a: c.a, b: c.b, from: c.from, to: c.to, amount: c.amount });
  };
  let prev = new Map<number, InspectItem['box']>();
  let prevScene = '';
  // How far two elements moved relative to each other since the last sample (camera moves cancel out).
  const drift = (a: InspectItem, b: InspectItem) => {
    const pa = prev.get(a.uid);
    const pb = prev.get(b.uid);
    if (!pa || !pb) return 0;
    const dx = (a.box.x0 + a.box.x1 - pa.x0 - pa.x1) / 2 - (b.box.x0 + b.box.x1 - pb.x0 - pb.x1) / 2;
    const dy = (a.box.y0 + a.box.y1 - pa.y0 - pa.y1) / 2 - (b.box.y0 + b.box.y1 - pb.y0 - pb.y1) / 2;
    return Math.hypot(dx, dy) / step;
  };
  for (const p of probes) {
    const seen = new Set<string>();
    const items = p.info.items;
    if (p.info.scene !== prevScene) prev = new Map();
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const amt = collision(items[i], items[j], frame.width * frame.height);
        // Passing each other (a card swiping across, a toast sliding in): not a layout problem.
        if (!amt || drift(items[i], items[j]) > 90) continue;
        const k = `${p.info.scene}|${Math.min(items[i].uid, items[j].uid)}|${Math.max(items[i].uid, items[j].uid)}`;
        seen.add(k);
        const c = open.get(k);
        if (c) {
          c.to = p.t;
          c.last = p.t;
          c.amount = Math.max(c.amount, amt);
        } else open.set(k, { scene: p.info.scene, a: label(items[i]), b: label(items[j]), from: p.t, to: p.t, last: p.t, amount: amt });
      }
    }
    for (const k of [...open.keys()]) if (!seen.has(k)) close(k);
    prev = new Map(items.map((it) => [it.uid, it.box]));
    prevScene = p.info.scene;
  }
  for (const k of [...open.keys()]) close(k);
  return out.sort((x, y) => x.from - y.from);
}

/** Mean absolute difference between two thumbnails, 0-255. */
export function frameChange(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / Math.max(1, a.length);
}

/**
 * Stretches where the picture barely changes. `still` is the per-sample change below which a pair
 * of samples counts as no motion (a slow camera push still registers above it).
 */
export function findHolds(probes: Probe[], duration: number, opts: CheckOptions = {}, still = 0.08): Hold[] {
  const hold = opts.hold ?? 1.2;
  const endHold = opts.endHold ?? 2.5;
  const out: Hold[] = [];
  let from = -1;
  const push = (toIdx: number) => {
    if (from < 0) return;
    const a = probes[from].t;
    const b = probes[toIdx].t;
    const end = toIdx === probes.length - 1 && duration - b < 0.2;
    if (b - a >= (end ? endHold : hold) - 1e-6) out.push({ from: a, to: end ? duration : b, scene: probes[from].info.scene, end });
    from = -1;
  };
  for (let i = 1; i < probes.length; i++) {
    const quiet = frameChange(probes[i - 1].thumb, probes[i].thumb) < still;
    if (quiet && from < 0) from = i - 1;
    if (!quiet) push(i - 1);
  }
  push(probes.length - 1);
  return out;
}

/** Words a viewer reads in a line: numbers and single symbols count half. */
export function wordCount(text: string): number {
  let n = 0;
  for (const w of text.split(/\s+/)) {
    if (!w) continue;
    n += /[A-Za-z]{2,}/.test(w) ? 1 : 0.5;
  }
  return n;
}

/**
 * Text that leaves before a viewer can read it. Lines that leave together (within 0.35 s) form one
 * page. The viewer takes 0.4 s to find the page, then reads its lines in the order they appear at
 * `read` words per second, never before a line is there: a grid of eight labels popping in quickly
 * needs time after the last one lands, and a chat that grows line by line is read as it grows.
 * Lines still on screen at the end of the video are left out (the final frame holds as long as
 * wanted), as is fine print, never over 14 px tall at 1080p (labels on a construction, legal lines).
 * A line missing for under a second is the same line.
 * Product UI is glanced at, not read: of the lines inside one component (a browser, a phone, a card)
 * only its `uiLines` largest count, and the rest of the screen is backdrop. Lines under `uiPx` tall
 * (at 1080p) outside any component, UI built from plain groups, count the same way, as one screen.
 */
export function findRushes(probes: Probe[], duration: number, read = 4, frameHeight = 1080, uiLines = 3, uiPx = 30): Rush[] {
  interface Span { scene: string; text: string; from: number; to: number; words: number; h: number; component?: number; px: number }
  const spans: Span[] = [];
  const open = new Map<string, Span>();
  const step = probes.length > 1 ? probes[1].t - probes[0].t : 0.1;
  for (const p of probes) {
    const seen = new Set<string>();
    for (const it of p.info.items) {
      if (!TEXT.has(it.type) || it.opacity < 0.6) continue;
      const text = it.text ?? '0';
      const k = `${p.info.scene}|${it.uid}`;
      const h = ((it.box.y1 - it.box.y0) * 1080) / frameHeight;
      seen.add(k);
      const s = open.get(k);
      if (s) {
        s.to = p.t + step;
        s.h = Math.max(s.h, h);
      } else open.set(k, { scene: p.info.scene, text, from: p.t, to: p.t + step, h, words: it.type === 'counter' ? 1 : wordCount(text), component: it.component, px: it.px ?? h });
    }
    for (const [k, s] of [...open]) if (!seen.has(k) && (s.scene !== p.info.scene || p.t - s.to > 1)) {
      spans.push(s);
      open.delete(k);
    }
  }
  // What is still open shows at the end: the final lockup.
  const lines = spans.filter((s) => s.h >= 14).sort((a, b) => a.to - b.to);
  const out: Rush[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j].scene === lines[i].scene && lines[j].to - lines[j - 1].to <= 0.35) j++;
    const all = lines.slice(i, j);
    i = j;
    // Per component, its largest lines (earliest first among equals); the rest is backdrop.
    const comps = new Map<number, Span[]>();
    const screen = (s: Span) => s.component ?? ((s.px * 1080) / frameHeight < uiPx ? -1 : undefined);
    for (const s of all) {
      const c = screen(s);
      if (c !== undefined) comps.set(c, [...(comps.get(c) ?? []), s]);
    }
    const read1 = new Set<Span>(all.filter((s) => screen(s) === undefined));
    for (const list of comps.values()) for (const s of [...list].sort((a, b) => b.px - a.px || a.from - b.from).slice(0, uiLines)) read1.add(s);
    const page = all.filter((s) => read1.has(s)).sort((a, b) => a.from - b.from);
    const to = Math.max(...page.map((s) => s.to));
    const from = page[0].from;
    let finish = from + 0.4;
    for (const s of page) finish = Math.max(finish, s.from) + s.words / read;
    if (finish > to + 0.05) {
      out.push({ scene: page[0].scene, from, to, words: page.reduce((a, s) => a + s.words, 0), need: finish - from, texts: page.map((s) => s.text) });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

function median(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Product UI a viewer cannot read: a component (browser, phone, card, chart...) with at least three
 * visible lines of text whose median font size on screen stays under `minPx` (at 1080p, measured on
 * the frame's shorter side) for `minTime` seconds. Fine print alone does not trigger it; most of the
 * component's text has to be small. Scenes that zoom into the part that matters pass.
 * Lines of copy on their own (not part of a component) are held to `minTextPx`.
 */
export function findSmallUi(probes: Probe[], frame: { width: number; height: number }, minPx = 18, minTime = 1.5, minTextPx = 22): SmallUi[] {
  const norm = 1080 / Math.min(frame.width, frame.height);
  const frameArea = frame.width * frame.height;
  const step = probes.length > 1 ? probes[1].t - probes[0].t : 0.1;
  type Open = SmallUi & { pxs: number[]; shares: number[] };
  const open = new Map<string, Open>();
  const out: SmallUi[] = [];
  const close = (k: string) => {
    const o = open.get(k)!;
    open.delete(k);
    if (o.to - o.from < minTime - 1e-6) return;
    out.push({ kind: o.kind, scene: o.scene, layer: o.layer, from: o.from, to: o.to, px: Math.round(median(o.pxs)), share: Number(median(o.shares).toFixed(2)), texts: o.texts });
  };
  for (const p of probes) {
    const seen = new Set<string>();
    if (!p.info.transition) {
      const comps = new Map<number, InspectItem[]>();
      for (const it of p.info.items) {
        if (it.opacity < 0.6) continue;
        if (it.component === undefined) {
          if (!TEXT.has(it.type) || it.px === undefined || !(it.text ?? '0').trim()) continue;
          const px = it.px * norm;
          if (px >= minTextPx) continue;
          const k = `${p.info.scene}|t${it.uid}`;
          seen.add(k);
          const o = open.get(k);
          if (o) {
            o.to = p.t + step;
            o.pxs.push(px);
          } else open.set(k, { kind: 'text', scene: p.info.scene, layer: label(it), from: p.t, to: p.t + step, px, share: 0, texts: 1, pxs: [px], shares: [0] });
          continue;
        }
        const list = comps.get(it.component) ?? [];
        list.push(it);
        comps.set(it.component, list);
      }
      for (const [c, items] of comps) {
        const texts = items.filter((it) => TEXT.has(it.type) && it.px !== undefined && (it.text ?? '0').trim());
        if (texts.length < 3) continue;
        const px = median(texts.map((it) => it.px! * norm));
        if (px >= minPx) continue;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const it of items) {
          x0 = Math.min(x0, it.box.x0); y0 = Math.min(y0, it.box.y0); x1 = Math.max(x1, it.box.x1); y1 = Math.max(y1, it.box.y1);
        }
        const w = Math.max(0, Math.min(frame.width, x1) - Math.max(0, x0));
        const h = Math.max(0, Math.min(frame.height, y1) - Math.max(0, y0));
        const k = `${p.info.scene}|${c}`;
        seen.add(k);
        const o = open.get(k);
        if (o) {
          o.to = p.t + step;
          o.pxs.push(px);
          o.shares.push((w * h) / frameArea);
          o.texts = Math.max(o.texts, texts.length);
        } else {
          const first = texts[0];
          const name = first.id ? `"${first.id}"` : first.path ? first.path : `${texts.length} lines`;
          open.set(k, { kind: 'ui', scene: p.info.scene, layer: name, from: p.t, to: p.t + step, px, share: 0, texts: texts.length, pxs: [px], shares: [(w * h) / frameArea] });
        }
      }
    }
    for (const k of [...open.keys()]) if (!seen.has(k)) close(k);
  }
  for (const k of [...open.keys()]) close(k);
  return out.sort((a, b) => a.from - b.from);
}

/** Share of the frame covered by visible layers (ones covering most of the frame are left out), on a 64 x 36 grid. */
export function coverage(items: InspectItem[], frame: { width: number; height: number }): number {
  const G = 64;
  const R = 36;
  const grid = new Uint8Array(G * R);
  for (const it of items) {
    if (it.opacity < 0.6) continue;
    const x0 = Math.max(0, Math.floor((it.box.x0 / frame.width) * G));
    const x1 = Math.min(G, Math.ceil((it.box.x1 / frame.width) * G));
    const y0 = Math.max(0, Math.floor((it.box.y0 / frame.height) * R));
    const y1 = Math.min(R, Math.ceil((it.box.y1 / frame.height) * R));
    if ((x1 - x0) * (y1 - y0) > G * R * 0.85) continue;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) grid[y * G + x] = 1;
  }
  let n = 0;
  for (const c of grid) n += c;
  return n / (G * R);
}

/**
 * Nearly empty frames: for at least `minTime` seconds, no text at headline size (`headline` px at
 * 1080p) and the visible layers cover under `share` of the frame (a lone sparkle, a row of dashes,
 * an empty input). A big word alone on a plain background is a design choice and passes. The first
 * 0.4 s and transitions are left out.
 */
export function findEmpty(probes: Probe[], frame: { width: number; height: number }, minTime = 1.2, share = 0.04, headline = 56): Empty[] {
  const norm = 1080 / Math.min(frame.width, frame.height);
  const out: Empty[] = [];
  let run: Empty | null = null;
  const close = () => {
    if (run && run.to - run.from >= minTime - 1e-6) out.push(run);
    run = null;
  };
  const step = probes.length > 1 ? probes[1].t - probes[0].t : 0.1;
  for (const p of probes) {
    const visible = p.info.items.filter((it) => it.opacity >= 0.6);
    const big = Math.max(0, ...visible.filter((it) => it.px !== undefined).map((it) => it.px! * norm));
    const cover = coverage(visible, frame);
    const empty = !p.info.transition && p.t > 0.4 && big < headline && cover < share;
    if (empty && run && run.scene === p.info.scene) {
      run.to = p.t + step;
      run.share = Math.max(run.share, cover);
      for (const it of visible) if (run.layers.length < 4 && !run.layers.includes(label(it))) run.layers.push(label(it));
    } else {
      close();
      if (empty) run = { scene: p.info.scene, from: p.t, to: p.t + step, share: cover, layers: visible.slice(0, 4).map(label) };
    }
  }
  close();
  return out;
}

/** What is on screen, for telling whether anything new appeared: visible layers and their text. */
function contentKey(p: Probe): string {
  return p.info.items
    .filter((it) => it.opacity >= 0.6)
    .map((it) => `${it.uid}:${it.text ?? ''}`)
    .sort()
    .join('|');
}

/**
 * Slides: stretches where nothing new appears (the same layers, the same text) and the picture stays
 * within `change` (mean gray difference, 0-255, on the thumbnail) of where the stretch began, so a
 * slow push-in alone does not count as change. Reported from `minTime` seconds. The last scene (the
 * end card) is left out, and so are stretches a motion hold already reports.
 */
export function findStale(probes: Probe[], holds: Hold[] = [], minTime = 2.5, change = 6): Stale[] {
  const out: Stale[] = [];
  if (!probes.length) return out;
  const lastScene = probes[probes.length - 1].info.scene;
  let a = 0;
  for (let i = 1; i <= probes.length; i++) {
    const p = probes[i];
    const anchor = probes[a];
    const brk = !p || p.info.scene !== anchor.info.scene || p.info.transition || anchor.info.transition || contentKey(p) !== contentKey(anchor) || frameChange(anchor.thumb, p.thumb) > change;
    if (!brk) continue;
    const from = anchor.t;
    const to = probes[i - 1].t;
    const covered = holds.some((h) => h.from <= from + 0.05 && h.to >= to - 0.05);
    if (!anchor.info.transition && anchor.info.scene !== lastScene && to - from >= minTime - 1e-6 && !covered) out.push({ scene: anchor.info.scene, from, to });
    a = i;
  }
  return out;
}

/** How far a box runs past each edge of the frame, as a share of its own width or height. */
function overhang(b: InspectItem['box'], frame: { width: number; height: number }): { edges: string[]; amount: number } {
  const w = Math.max(1, b.x1 - b.x0);
  const h = Math.max(1, b.y1 - b.y0);
  const sides: [string, number][] = [
    ['left', -b.x0 / w],
    ['right', (b.x1 - frame.width) / w],
    ['top', -b.y0 / h],
    ['bottom', (b.y1 - frame.height) / h],
  ];
  const cut = sides.filter(([, a]) => a > 0);
  return { edges: cut.map(([e]) => e), amount: Math.max(0, ...cut.map(([, a]) => a)) };
}

/**
 * Things cut off at the frame's edge for at least `minTime` seconds, outside transitions:
 * - a line of copy on its own with part of its ink outside the frame (a camera push that crops a
 *   headline, a line placed too close to the edge);
 * - a component (browser, phone, card, chart...) that is smaller than the frame yet sits partly
 *   outside it, cutting its text. A component larger than the frame (a dive into part of an app)
 *   is cropped on purpose and passes.
 * A component spanning 80% of the frame or more is a close shot and passes too. Anything at least
 * `share` outside (by width or height) counts; lines wider or taller than the frame, and a word
 * repeated three times or more, are type used as texture and pass.
 */
export function findCropped(probes: Probe[], frame: { width: number; height: number }, minTime = 0.4, share = 0.03): Cropped[] {
  const step = probes.length > 1 ? probes[1].t - probes[0].t : 0.1;
  const open = new Map<string, Cropped & { edgeSet: Set<string> }>();
  const out: Cropped[] = [];
  const close = (k: string) => {
    const o = open.get(k)!;
    open.delete(k);
    if (o.to - o.from >= minTime - 1e-6) out.push({ kind: o.kind, scene: o.scene, layer: o.layer, from: o.from, to: o.to, edges: [...o.edgeSet], amount: Number(o.amount.toFixed(2)) });
  };
  const note = (k: string, p: Probe, kind: Cropped['kind'], layer: string, cut: { edges: string[]; amount: number }) => {
    const o = open.get(k);
    if (o) {
      o.to = p.t + step;
      o.amount = Math.max(o.amount, cut.amount);
      for (const e of cut.edges) o.edgeSet.add(e);
    } else open.set(k, { kind, scene: p.info.scene, layer, from: p.t, to: p.t + step, edges: [], edgeSet: new Set(cut.edges), amount: cut.amount });
  };
  const onScreen = (b: InspectItem['box']) => b.x1 > 0 && b.x0 < frame.width && b.y1 > 0 && b.y0 < frame.height;
  for (const p of probes) {
    const seen = new Set<string>();
    if (!p.info.transition) {
      const comps = new Map<number, InspectItem[]>();
      // A word repeated across the frame is a pattern; its copies may run off the edges.
      const repeats = new Map<string, number>();
      for (const it of p.info.items) if (it.text && it.opacity >= 0.6) repeats.set(it.text, (repeats.get(it.text) ?? 0) + 1);
      for (const it of p.info.items) {
        if (it.opacity < 0.6) continue;
        if (it.component !== undefined) {
          const list = comps.get(it.component) ?? [];
          list.push(it);
          comps.set(it.component, list);
          continue;
        }
        if (!TEXT.has(it.type) || !(it.text ?? '0').trim() || !onScreen(it.box) || (repeats.get(it.text ?? '') ?? 0) >= 3) continue;
        if (it.box.x1 - it.box.x0 > frame.width || it.box.y1 - it.box.y0 > frame.height) continue;
        const cut = overhang(it.box, frame);
        if (cut.amount < share) continue;
        const k = `${p.info.scene}|t${it.uid}`;
        seen.add(k);
        note(k, p, 'text', label(it), cut);
      }
      for (const [c, items] of comps) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const it of items) {
          x0 = Math.min(x0, it.box.x0); y0 = Math.min(y0, it.box.y0); x1 = Math.max(x1, it.box.x1); y1 = Math.max(y1, it.box.y1);
        }
        const box = { x0, y0, x1, y1 };
        if (!onScreen(box)) continue;
        const cut = overhang(box, frame);
        // Only edges along which it would fit: a component wider than the frame is a dive.
        // Spanning most of the frame, it is a close shot that crops on purpose.
        const fits = (e: string) => (e === 'left' || e === 'right' ? x1 - x0 < frame.width * 0.8 : y1 - y0 < frame.height * 0.8);
        cut.edges = cut.edges.filter(fits);
        if (!cut.edges.length || cut.amount < share) continue;
        const texts = items.filter((it) => TEXT.has(it.type) && (it.text ?? '0').trim());
        const cutText = texts.filter((it) => overhang(it.box, frame).amount > 0);
        if (!cutText.length) continue;
        const k = `${p.info.scene}|${c}`;
        seen.add(k);
        note(k, p, 'ui', `${cutText.length} of its ${texts.length} lines, from ${label(cutText[0])}`, cut);
      }
    }
    for (const k of [...open.keys()]) if (!seen.has(k)) close(k);
  }
  for (const k of [...open.keys()]) close(k);
  return out.sort((a, b) => a.from - b.from);
}

/** Layers that must stay clear of a platform's interface besides text: buttons and anything named like a logo or CTA. */
const KEY_NAME = /logo|cta|brand|wordmark|url|qr|price|badge/i;
function important(it: InspectItem): boolean {
  if (TEXT.has(it.type) || it.type === 'button') return true;
  return KEY_NAME.test(it.id ?? '') || KEY_NAME.test(it.group ?? '');
}

/**
 * Text and key layers (buttons, logos, CTAs) that sit under a platform's interface for at least
 * `minTime` seconds: more than `share` of their box inside the top bar, the caption area, the action
 * buttons or the left edge. Boxes are output pixels of a 9:16 render.
 */
export function findUnsafe(probes: Probe[], frame: { width: number; height: number }, platforms: string[], minTime = 0.3, share = 0.1): Unsafe[] {
  const out: Unsafe[] = [];
  const step = probes.length > 1 ? probes[1].t - probes[0].t : 0.1;
  const frameArea = frame.width * frame.height;
  for (const platform of platforms) {
    if (!SAFE_ZONES[platform]) throw new Error(`Unknown platform "${platform}"`);
    const rects = zoneRects(platform, frame.width, frame.height);
    const open = new Map<string, Unsafe & { zoneSet: Set<string> }>();
    const close = (k: string) => {
      const u = open.get(k)!;
      open.delete(k);
      if (u.to - u.from + step >= minTime - 1e-6) out.push({ platform, scene: u.scene, layer: u.layer, zones: [...u.zoneSet], from: u.from, to: u.to, amount: u.amount });
    };
    for (const p of probes) {
      const seen = new Set<string>();
      for (const it of p.info.items) {
        if (it.opacity < 0.6 || !important(it) || area(it.box) > frameArea * 0.6) continue;
        const a = Math.max(1, area(it.box));
        let covered = 0;
        const hit: string[] = [];
        for (const r of rects) {
          const iw = Math.min(it.box.x1, r.x1) - Math.max(it.box.x0, r.x0);
          const ih = Math.min(it.box.y1, r.y1) - Math.max(it.box.y0, r.y0);
          if (iw <= 0 || ih <= 0) continue;
          covered += (iw * ih) / a;
          hit.push(r.name);
        }
        if (covered < share) continue;
        const k = `${p.info.scene}|${it.uid}`;
        seen.add(k);
        const u = open.get(k);
        if (u) {
          u.to = p.t;
          u.amount = Math.max(u.amount, Math.min(1, covered));
          for (const h of hit) u.zoneSet.add(h);
        } else open.set(k, { platform, scene: p.info.scene, layer: label(it), zones: [], zoneSet: new Set(hit), from: p.t, to: p.t, amount: Math.min(1, covered) });
      }
      for (const k of [...open.keys()]) if (!seen.has(k)) close(k);
    }
    for (const k of [...open.keys()]) close(k);
  }
  return out.sort((x, y) => x.from - y.from || x.platform.localeCompare(y.platform));
}

/** Steps through a video headlessly and reports text collisions and motionless stretches. */
export async function check(specPath: string, opts: CheckOptions & { format?: string; rate?: number } = {}) {
  const spec = await readSpec(resolve(specPath));
  if (opts.platforms?.length) {
    if (opts.format && opts.format !== '9:16') throw new Error(`Platform safe zones are for 9:16 video, not ${opts.format}`);
    opts = { ...opts, format: '9:16' };
  }
  const v = validateVideo(spec);
  if (!v.ok) throw new Error(`Invalid spec:\n${v.errors.map((e) => `  - ${e}`).join('\n')}`);
  const { server, url } = await startServer(resolve(specPath), { hmr: false });
  const browser = await puppeteer.launch({ headless: true, args: BROWSER_ARGS, protocolTimeout: 600000 });
  try {
    const { page, info } = await openPage(browser, url, v.video, undefined, opts.format);
    const every = Math.max(1, Math.round(info.fps / (opts.rate ?? 10)));
    const probes: Probe[] = [];
    for (let f = 0; f < info.frameCount; f += every) {
      const r = (await page.evaluate((i) => (window as any).bemotion.probe(i), f)) as { info: InspectInfo; thumb: number[] };
      probes.push({ t: f / info.fps, ...r });
    }
    return {
      duration: info.duration,
      collisions: findCollisions(probes, info, opts.minOverlap),
      holds: findHolds(probes, info.duration, opts),
      rushes: findRushes(probes, info.duration, opts.read, info.height),
      unsafe: opts.platforms?.length ? findUnsafe(probes, info, opts.platforms) : [],
      small: findSmallUi(probes, info),
      empty: findEmpty(probes, info),
      stale: findStale(probes, findHolds(probes, info.duration, opts)),
      cropped: findCropped(probes, info),
      probes,
    };
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

export type CheckResult = Awaited<ReturnType<typeof check>>;

/** One line per finding, the same wording as the check command (for people and for AI review). */
export function findingLines(r: Pick<CheckResult, 'collisions' | 'holds' | 'rushes'> & { unsafe?: Unsafe[]; small?: SmallUi[]; empty?: Empty[]; stale?: Stale[]; cropped?: Cropped[] }): string[] {
  const fmt = (t: number) => `${t.toFixed(2)}s`;
  const out: string[] = [];
  for (const x of r.rushes) {
    const names = x.texts.slice(0, 4).map((t) => `"${t.length > 40 ? `${t.slice(0, 38)}..` : t}"`).join(', ') + (x.texts.length > 4 ? ` and ${x.texts.length - 4} more` : '');
    out.push(`${fmt(x.from)} - ${fmt(x.to)} [${x.scene}] text leaves too soon: ${x.words} words on screen for ${(x.to - x.from).toFixed(1)}s, needs about ${x.need.toFixed(1)}s to read: ${names}`);
  }
  for (const c of r.collisions) out.push(`${fmt(c.from)} - ${fmt(c.to)} [${c.scene}] collision: ${c.a} overlaps ${c.b} (${Math.round(c.amount * 100)}%)`);
  for (const h of r.holds) out.push(`${fmt(h.from)} - ${fmt(h.to)} [${h.scene}] nothing moves for ${(h.to - h.from).toFixed(1)}s${h.end ? ' (final shot)' : ''}`);
  for (const u of r.unsafe ?? []) out.push(unsafeLine(u));
  for (const x of r.small ?? []) out.push(smallLine(x));
  for (const x of r.empty ?? []) out.push(emptyLine(x));
  for (const x of r.stale ?? []) out.push(staleLine(x));
  for (const x of r.cropped ?? []) out.push(croppedLine(x));
  return out;
}

/** One line for a layer under a platform's interface. */
export function unsafeLine(u: Unsafe): string {
  return `${u.from.toFixed(2)}s - ${u.to.toFixed(2)}s [${u.scene}] under the ${SAFE_ZONES[u.platform]?.label ?? u.platform} ${u.zones.join(' and ')} (${Math.round(u.amount * 100)}% covered): ${u.layer.replace(/\s*\n\s*/g, ' ')}`;
}

/** One line for product UI shown too small to read. */
export function smallLine(x: SmallUi): string {
  if (x.kind === 'text') return `${x.from.toFixed(2)}s - ${x.to.toFixed(2)}s [${x.scene}] text too small to read: about ${x.px} px tall on screen (set copy at 24 px or more at 1080p): ${x.layer.replace(/\s*\n\s*/g, ' ')}`;
  return `${x.from.toFixed(2)}s - ${x.to.toFixed(2)}s [${x.scene}] UI too small to read: ${x.texts} lines of its text are about ${x.px} px tall on screen (readable from 20 px at 1080p) and it covers ${Math.round(x.share * 100)}% of the frame: ${x.layer.replace(/\s*\n\s*/g, ' ')}. Move the camera in on the part that matters, scale it up, or show fewer, larger elements.`;
}

/** One line for a nearly empty frame. */
export function emptyLine(x: Empty): string {
  const what = x.layers.length ? `only ${x.layers.map((l) => l.replace(/\s*\n\s*/g, ' ')).join(', ')}` : 'nothing';
  return `${x.from.toFixed(2)}s - ${x.to.toFixed(2)}s [${x.scene}] nearly empty frame for ${(x.to - x.from).toFixed(1)}s: ${what} on screen (${Math.round(x.share * 100)}% of the frame, no headline). Bring the next element in sooner, keep the previous one until it arrives, or move the camera onto something.`;
}

/** One line for something cut off at the frame's edge. */
export function croppedLine(x: Cropped): string {
  const where = `${x.edges.join(' and ')} edge${x.edges.length > 1 ? 's' : ''}`;
  const what = x.kind === 'text' ? x.layer : `a device or card that fits in the frame (${x.layer})`;
  return `${x.from.toFixed(2)}s - ${x.to.toFixed(2)}s [${x.scene}] cut off at the ${where} (${Math.round(x.amount * 100)}% outside the frame): ${what.replace(/\s*\n\s*/g, ' ')}. Keep it inside the frame with a margin: pull the camera back (lower zoom or pushIn), aim the move at its middle, or move or scale the layer in.`;
}

/** One line for a stretch that reads as a slide. */
export function staleLine(x: Stale): string {
  const d = (x.to - x.from).toFixed(1);
  return `${x.from.toFixed(2)}s - ${x.to.toFixed(2)}s [${x.scene}] the picture stays the same for ${d}s (nothing new appears and the camera barely moves), so it reads as a slide. Add a beat: a cursor action, a highlight, a number counting, or a camera move onto a detail.`;
}
