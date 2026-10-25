import puppeteer from 'puppeteer';
import { resolve } from 'node:path';
import { readSpec, startServer } from './server';
import { BROWSER_ARGS, openPage } from './render';
import { validateVideo } from '../spec/schema';
import type { InspectInfo, InspectItem } from '../engine/engine';

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

export interface CheckOptions {
  /** Reading speed for the reading-time check, in words per second. */
  read?: number;
  /** Longest stretch without visible motion before it is reported, in seconds. */
  hold?: number;
  /** The same for the last shot of the video. */
  endHold?: number;
  /** Shortest overlap worth reporting, in seconds. */
  minOverlap?: number;
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
 */
export function findRushes(probes: Probe[], duration: number, read = 4, frameHeight = 1080): Rush[] {
  interface Span { scene: string; text: string; from: number; to: number; words: number; h: number }
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
      } else open.set(k, { scene: p.info.scene, text, from: p.t, to: p.t + step, h, words: it.type === 'counter' ? 1 : wordCount(text) });
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
    const page = lines.slice(i, j).sort((a, b) => a.from - b.from);
    i = j;
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

/** Steps through a video headlessly and reports text collisions and motionless stretches. */
export async function check(specPath: string, opts: CheckOptions & { format?: string; rate?: number } = {}) {
  const spec = await readSpec(resolve(specPath));
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
      probes,
    };
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
