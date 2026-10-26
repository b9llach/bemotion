import puppeteer, { type HTTPResponse, type Page } from 'puppeteer';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BROWSER_ARGS } from './render';
import { log } from './log';

/**
 * Brand import: open a website headlessly and collect what an ad needs from it (name, logo, colors,
 * fonts, headlines, screenshots). Everything lands in one folder next to a brand.json, ready for a
 * spec or for `generate --url`.
 */

export interface BrandFont {
  /** The family as the site names it. */
  family: string;
  /** Where it is used on the site. */
  role: 'display' | 'body';
  /** Downloaded files by spec weight key ("400", "700italic"), relative to the brand folder. */
  files: Record<string, string>;
  /** A bundled font to use when no file could be downloaded. */
  fallback: string;
  source: 'site' | 'google' | 'bundled';
}

export interface Brand {
  url: string;
  name: string;
  title: string;
  description: string;
  colors: { background: string; text: string; muted: string; primary: string; secondary?: string; accent?: string; palette: string[] };
  dark: boolean;
  fonts: BrandFont[];
  headlines: string[];
  taglines: string[];
  ctas: string[];
  /** Files relative to the brand folder. */
  logo?: string;
  /** The logo is drawn for the site's background: light ink on dark sites, dark ink on light ones. */
  logoInk?: 'light' | 'dark';
  icon?: string;
  screenshots: string[];
  images: string[];
}

/** What the page script returns. */
interface PageFacts {
  title: string;
  description: string;
  siteName: string;
  themeColor: string;
  ogImage: string;
  icons: string[];
  h1: string[];
  h2: string[];
  paragraphs: string[];
  ctas: string[];
  colors: ColorSample[];
  pageBg: string;
  fonts: { family: string; role: 'display' | 'body'; weight: number }[];
  logoRect: { x: number; y: number; width: number; height: number } | null;
  logoSrc: string;
  images: { src: string; width: number; height: number; area: number }[];
  height: number;
}

// Runs in the page. A string, so the bundler's helpers never leak into the browser.
const FACTS = String.raw`(() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.1) return null;
    // Hidden by a parent (opacity, visibility, content-visibility) counts as hidden.
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return null;
    return { r, cs };
  };
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const meta = (sel) => (document.querySelector(sel) || {}).content || '';
  const texts = (sel, max, min = 2) => {
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      if (!vis(el)) continue;
      const t = clean(el.innerText);
      if (t.length >= min && t.length < 160 && !out.includes(t)) out.push(t);
      if (out.length >= max) break;
    }
    return out;
  };
  const vh = innerHeight;
  const colors = [];
  const all = document.querySelectorAll('body *');
  let n = 0;
  for (const el of all) {
    if (++n > 6000) break;
    const v = vis(el);
    if (!v) continue;
    const { r, cs } = v;
    const area = Math.min(r.width, innerWidth) * Math.min(r.height, vh * 3);
    const top = r.top + scrollY;
    const fold = top < vh ? 2 : top < vh * 3 ? 1 : 0.4;
    const tag = el.tagName;
    const isButton = tag === 'BUTTON' || (tag === 'A' && (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && r.height < 90 && r.width < 420));
    if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') {
      colors.push({ color: cs.backgroundColor, weight: isButton ? 40000 * fold : area * fold, kind: isButton ? 'button' : 'bg', top });
    }
    const own = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim().length > 1);
    if (own) {
      const len = clean(el.textContent).length;
      colors.push({ color: cs.color, weight: Math.min(len, 200) * parseFloat(cs.fontSize) * fold, kind: tag === 'A' ? 'link' : 'text', top });
    }
  }
  const fam = (el) => el ? clean(getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '')) : '';
  const fonts = [];
  const h = document.querySelector('h1') || document.querySelector('h2');
  if (h) fonts.push({ family: fam(h), role: 'display', weight: Number(getComputedStyle(h).fontWeight) || 700 });
  const p = [...document.querySelectorAll('p')].find((e) => vis(e) && clean(e.innerText).length > 30) || document.body;
  fonts.push({ family: fam(p), role: 'body', weight: Number(getComputedStyle(p).fontWeight) || 400 });
  // The logo: a link home in the header, or anything named logo near the top.
  const home = (a) => {
    try {
      const u = new URL(a.href, location.href);
      return u.origin === location.origin && (u.pathname === '/' || u.pathname === '/index.html') && !u.hash;
    } catch { return false; }
  };
  const cands = [
    ...[...document.querySelectorAll('a')].filter(home),
    ...document.querySelectorAll('[aria-label*="home" i], [class*="logo" i], [id*="logo" i], [data-framer-name*="logo" i], img[alt*="logo" i], header svg, nav svg'),
  ];
  let logo = null;
  for (const el of cands) {
    const v = vis(el);
    if (!v) continue;
    const { r } = v;
    if (r.top + scrollY > 220 || r.width > 420 || r.height > 140 || r.width < 16) continue;
    logo = el;
    break;
  }
  let logoSrc = '';
  if (logo) {
    logo.setAttribute('data-bemotion-logo', '1');
    const img = logo.tagName === 'IMG' ? logo : logo.querySelector('img');
    if (img && img.currentSrc) logoSrc = img.currentSrc;
  }
  const lr = logo ? logo.getBoundingClientRect() : null;
  const images = [];
  for (const img of document.querySelectorAll('img')) {
    const v = vis(img);
    if (!v || !img.currentSrc || img.naturalWidth < 700) continue;
    images.push({ src: img.currentSrc, width: img.naturalWidth, height: img.naturalHeight, area: v.r.width * v.r.height });
  }
  const icons = [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]')]
    .map((l) => ({ href: l.href, size: parseInt((l.sizes && l.sizes.value) || '0', 10) || (l.rel.includes('apple') ? 180 : 16) }))
    .sort((a, b) => b.size - a.size).map((x) => x.href);
  return {
    title: document.title,
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    siteName: meta('meta[property="og:site_name"]') || meta('meta[name="application-name"]'),
    themeColor: meta('meta[name="theme-color"]'),
    ogImage: meta('meta[property="og:image"]'),
    icons,
    h1: texts('h1', 4),
    h2: texts('h2', 10),
    paragraphs: texts('main p, section p, header p, p', 8, 40),
    ctas: texts('a, button', 60).filter((t) => t.split(' ').length <= 5),
    colors,
    pageBg: getComputedStyle(document.body).backgroundColor,
    fonts,
    logoRect: lr ? { x: lr.left, y: lr.top + scrollY, width: lr.width, height: lr.height } : null,
    logoSrc,
    images: images.sort((a, b) => b.area - a.area).slice(0, 8),
    height: document.documentElement.scrollHeight,
  };
})()`;

// Cookie and consent banners cover screenshots: accept them, then hide what is left.
const DISMISS = String.raw`(() => {
  const words = /^(accept|accept all|allow all|agree|i agree|ok|okay|got it|allow|continue)$/i;
  for (const b of document.querySelectorAll('button, a, [role="button"]')) {
    if (words.test((b.innerText || '').trim())) { try { b.click(); } catch {} }
  }
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    const t = (el.innerText || '').toLowerCase();
    if (/cookie|consent|privacy|gdpr/.test(t) && el.getBoundingClientRect().height < innerHeight * 0.8) el.style.display = 'none';
  }
})()`;

// --- Colors ---------------------------------------------------------------------------------

type RGB = [number, number, number];

export function parseColor(s: string): { rgb: RGB; a: number } | null {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { rgb: [+m[1], +m[2], +m[3]], a };
  }
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (h) {
    const x = h[1].length === 3 ? h[1].split('').map((c) => c + c).join('') : h[1];
    return { rgb: [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)], a: 1 };
  }
  return null;
}

export function hex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Relative luminance (WCAG). */
export function luminance([r, g, b]: RGB): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Colorfulness, 0 (gray) to about 1. */
export function chroma([r, g, b]: RGB): number {
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

function dist(a: RGB, b: RGB): number {
  // Weighted RGB distance, close enough to perceptual for merging near-identical colors.
  const rm = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db) / 3;
}

export interface ColorSample {
  color: string;
  weight: number;
  kind: string;
  /** Page y of the element, in CSS px. */
  top?: number;
}

interface Swatch {
  rgb: RGB;
  weight: number;
  kinds: Record<string, number>;
  /** Elements using it, and the highest one on the page. */
  count: number;
  top: number;
}

/** Merges near-identical colors (anti-aliasing, hover tints) and sums their weight. */
export function clusterColors(samples: ColorSample[], within = 14): Swatch[] {
  const out: Swatch[] = [];
  for (const s of samples) {
    const c = parseColor(s.color);
    if (!c || c.a < 0.6 || !(s.weight > 0)) continue;
    let hit = out.find((o) => dist(o.rgb, c.rgb) < within);
    if (!hit) {
      hit = { rgb: c.rgb, weight: 0, kinds: {}, count: 0, top: Infinity };
      out.push(hit);
    }
    hit.weight += s.weight;
    hit.kinds[s.kind] = (hit.kinds[s.kind] ?? 0) + s.weight;
    hit.count++;
    hit.top = Math.min(hit.top, s.top ?? 0);
  }
  return out.sort((a, b) => b.weight - a.weight);
}

/** Picks background, text and brand colors from the weighted samples of a page. */
export function pickColors(samples: ColorSample[], pageBg: string, themeColor = '', fold = 900): Brand['colors'] & { dark: boolean } {
  const sw = clusterColors(samples);
  const bgs = sw.filter((s) => (s.kinds.bg ?? 0) > 0).sort((a, b) => (b.kinds.bg ?? 0) - (a.kinds.bg ?? 0));
  const body = parseColor(pageBg);
  const bg = body && body.a > 0.6 ? body.rgb : bgs[0]?.rgb ?? [255, 255, 255];
  const dark = luminance(bg) < 0.2;
  const texts = sw.filter((s) => (s.kinds.text ?? 0) > 0).sort((a, b) => (b.kinds.text ?? 0) - (a.kinds.text ?? 0));
  const contrast = (c: RGB) => {
    const a = luminance(c);
    const b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const text = texts.find((t) => contrast(t.rgb) > 7)?.rgb ?? (dark ? [245, 245, 245] : [17, 17, 17]);
  const muted = texts.find((t) => contrast(t.rgb) > 2.5 && contrast(t.rgb) < 7 && chroma(t.rgb) < 0.2)?.rgb
    ?? text.map((v, i) => v * 0.55 + bg[i] * 0.45) as RGB;
  // Brand colors: saturated, used on buttons and links first, then large fills.
  const score = (s: Swatch) => ((s.kinds.button ?? 0) * 3 + (s.kinds.link ?? 0) * 2 + (s.kinds.bg ?? 0) * 0.15 + (s.kinds.text ?? 0) * 0.5) * (0.4 + chroma(s.rgb));
  // A brand color repeats: on buttons or links, on several elements, or near the top. One colored
  // card far down the page (a customer story) is someone else's color.
  const pageWeight = sw.filter((s) => dist(s.rgb, bg) >= 14).reduce((a, s) => a + s.weight, 0);
  const brand = sw
    .filter((s) => chroma(s.rgb) > 0.22 && contrast(s.rgb) > 1.3)
    .filter((s) => (s.kinds.button ?? 0) > 0 || (s.kinds.link ?? 0) > 0 || s.count >= 3 || s.top < fold * 1.5)
    .filter((s) => s.weight >= pageWeight * 0.01 || (s.kinds.button ?? 0) > 0)
    .sort((a, b) => score(b) - score(a));
  const theme = parseColor(themeColor);
  const picked: RGB[] = [];
  if (theme && chroma(theme.rgb) > 0.22) picked.push(theme.rgb);
  for (const b of brand) {
    if (picked.every((p) => dist(p, b.rgb) > 40)) picked.push(b.rgb);
    if (picked.length >= 3) break;
  }
  // No brand color on the page (monochrome sites): use the text color as the accent.
  const primary = picked[0] ?? text;
  return {
    background: hex(bg),
    text: hex(text),
    muted: hex(muted),
    primary: hex(primary),
    secondary: picked[1] ? hex(picked[1]) : undefined,
    accent: picked[2] ? hex(picked[2]) : undefined,
    palette: sw.slice(0, 10).map((s) => hex(s.rgb)),
    dark,
  };
}

// --- Fonts ----------------------------------------------------------------------------------

const BUNDLED: { name: string; test: RegExp }[] = [
  { name: 'Instrument Serif', test: /serif|garamond|times|georgia|playfair|tiempos|lora|merriweather|caslon|freight|canela|editorial|newsreader|fraunces|instrument|domaine|sectra|signifier|reckless|ivar|lyon|noe |tobias|gambetta/i },
  { name: 'JetBrains Mono', test: /mono|code|courier|consol|menlo/i },
  { name: 'Space Grotesk', test: /space|grotesk|neue machina|druk|aeonik/i },
  { name: 'Bricolage Grotesque', test: /bricolage|playful|rounded|nunito|quicksand|recoleta/i },
  { name: 'Sora', test: /sora|poppins|montserrat|gilroy|circular|product sans|google sans|outfit|lexend|figtree/i },
  { name: 'Manrope', test: /manrope|plus jakarta|dm sans|satoshi|general sans|avenir|proxima|graphik/i },
];

/** The bundled font closest to a family name (Inter when nothing fits). */
export function nearestBundled(family: string): string {
  for (const b of BUNDLED) {
    if (b.name === 'Instrument Serif' && /sans/i.test(family)) continue;
    if (b.test.test(family)) return b.name;
  }
  return 'Inter';
}

interface FaceRule {
  family: string;
  weight: string;
  style: string;
  urls: string[];
}

/** @font-face rules from stylesheet text, with their source URLs resolved against the sheet. */
export function parseFontFaces(css: string, base: string): FaceRule[] {
  const out: FaceRule[] = [];
  for (const m of css.matchAll(/@font-face\s*{([^}]*)}/gi)) {
    const body = m[1];
    const get = (k: string) => new RegExp(`${k}\\s*:\\s*([^;]+)`, 'i').exec(body)?.[1].trim() ?? '';
    const family = get('font-family').replace(/["']/g, '').trim();
    if (!family) continue;
    const urls: string[] = [];
    for (const u of body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      if (u[1].startsWith('data:')) continue;
      try {
        urls.push(new URL(u[1], base).href);
      } catch {
        // Ignore broken URLs.
      }
    }
    out.push({ family, weight: get('font-weight') || '400', style: get('font-style') || 'normal', urls });
  }
  return out;
}

/** Files the engine can read: woff, ttf and otf (not woff2). */
function usable(url: string): boolean {
  return /\.(woff|ttf|otf)(\?|#|$)/i.test(url);
}

function weightKey(weight: string, style: string): string {
  const w = /^\d+$/.test(weight.split(/\s+/)[0]) ? weight.split(/\s+/)[0] : weight === 'bold' ? '700' : '400';
  return /italic|oblique/i.test(style) ? `${w}italic` : w;
}

async function download(url: string, file: string): Promise<boolean> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' } });
    if (!r.ok) return false;
    await writeFile(file, Buffer.from(await r.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}

/** Google Fonts serves TrueType to clients that do not ask for woff2. */
async function googleFont(family: string, dir: string, slug: string): Promise<Record<string, string>> {
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:ital,wght@0,400;0,500;0,600;0,700;1,400`;
  let css: string;
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Wget/1.21' } });
    if (!r.ok) return {};
    css = await r.text();
  } catch {
    return {};
  }
  const files: Record<string, string> = {};
  for (const f of parseFontFaces(css, url)) {
    const src = f.urls.find(usable);
    if (!src) continue;
    const key = weightKey(f.weight, f.style);
    if (files[key]) continue;
    const name = `fonts/${slug}-${key}.${/\.otf/i.test(src) ? 'otf' : /\.woff(\?|$)/i.test(src) ? 'woff' : 'ttf'}`;
    if (await download(src, join(dir, name))) files[key] = name;
  }
  return files;
}

/** Text that says itself twice (a visible copy and a screen-reader copy): "A A" becomes "A". */
export function undouble(t: string): string {
  const words = t.split(' ');
  if (words.length % 2 === 0) {
    const half = words.length / 2;
    if (words.slice(0, half).join(' ') === words.slice(half).join(' ')) return words.slice(0, half).join(' ');
  }
  return t;
}

/** The family without variable-font and optical-size suffixes ("Inter Variable" is Inter). */
export function baseFamily(family: string): string {
  return family.replace(/\s+(variable|vf|var|display|text|web|ui)$/i, '').replace(/[-_]/g, ' ').trim() || family;
}

/** "inter tight" becomes "Inter Tight" (Google Fonts names are case-sensitive). */
export function titleCase(s: string): string {
  return s.split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'font';
}

// --- Import ---------------------------------------------------------------------------------

function siteName(f: PageFacts, url: string): string {
  if (f.siteName) return f.siteName;
  const host = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
  const fromTitle = f.title.split(/\s+[|\-:·]\s+/).map((s) => s.trim()).filter(Boolean);
  const match = fromTitle.find((t) => t.toLowerCase().replace(/\s+/g, '').includes(host.toLowerCase()));
  if (match) return match;
  // No domain to match (a local address) or a title without the name: the shortest part of the title.
  const short = fromTitle.filter((t) => t.split(/\s+/).length <= 3).sort((a, b) => a.length - b.length)[0];
  if (short && (fromTitle.length > 1 || /^[\d.]+$|^localhost$/.test(host))) return short;
  return host.charAt(0).toUpperCase() + host.slice(1);
}

export interface BrandOptions {
  /** Viewport width; screenshots are taken at twice this resolution. */
  width?: number;
  height?: number;
  /** Most page screenshots to keep (the first is the hero). */
  shots?: number;
}

export async function importBrand(url: string, outDir: string, o: BrandOptions = {}): Promise<Brand> {
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const dir = resolve(outDir);
  await mkdir(join(dir, 'fonts'), { recursive: true });
  await mkdir(join(dir, 'shots'), { recursive: true });
  const width = o.width ?? 1440;
  const height = o.height ?? 900;

  const browser = await puppeteer.launch({ headless: true, args: BROWSER_ARGS.filter((a) => !a.startsWith('--disable-web-security')) });
  const sheets: { url: string; text: string }[] = [];
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36');
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    page.on('response', (r: HTTPResponse) => {
      if (r.request().resourceType() !== 'stylesheet' || !r.ok()) return;
      r.text().then((text) => sheets.push({ url: r.url(), text })).catch(() => {});
    });
    log.step(`Opening ${url}`);
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    } catch {
      log.warn('The page kept loading; continuing with what arrived');
    }
    await settle(page);
    await page.evaluate(DISMISS).catch(() => {});
    await settle(page, 600);
    // Scroll through once so lazy images and fonts load, then back to the top.
    await autoscroll(page);
    const facts = (await page.evaluate(FACTS)) as PageFacts;
    await writeFile(join(dir, 'page-facts.json'), JSON.stringify(facts, null, 1));
    // Inline <style> blocks hold @font-face rules too.
    const inline = (await page.evaluate(`[...document.querySelectorAll('style')].map((s) => s.textContent).join(String.fromCharCode(10))`)) as string;
    sheets.push({ url, text: inline });

    const name = siteName(facts, url);
    log.info(`Brand: ${name}`);
    const picked = pickColors(facts.colors, facts.pageBg, facts.themeColor, height);
    const { dark, ...colors } = picked;

    // Screenshots: the hero, then distinct screens further down.
    const screenshots: string[] = [];
    const maxShots = o.shots ?? 5;
    let last: Buffer | null = null;
    for (let y = 0, i = 0; y < facts.height && screenshots.length < maxShots && i < 14; y += height, i++) {
      await page.evaluate(`window.scrollTo(0, ${y})`);
      await settle(page, 450);
      const buf = Buffer.from(await page.screenshot({ type: 'png' }));
      if (last && similar(buf, last)) continue;
      last = buf;
      const file = `shots/${screenshots.length === 0 ? 'hero' : `section-${screenshots.length}`}.png`;
      await writeFile(join(dir, file), buf);
      screenshots.push(file);
    }
    await page.evaluate('window.scrollTo(0, 0)');
    await settle(page, 300);

    // Logo: the original image file when it is one, else a transparent capture of the element.
    let logo: string | undefined;
    if (facts.logoSrc) {
      const ext = /\.svg(\?|$)/i.test(facts.logoSrc) ? 'svg' : /\.jpe?g(\?|$)/i.test(facts.logoSrc) ? 'jpg' : 'png';
      if (ext !== 'svg' && (await download(facts.logoSrc, join(dir, `logo.${ext}`)))) logo = `logo.${ext}`;
    }
    if (!logo && facts.logoRect) {
      const r = facts.logoRect;
      try {
        // Clear every background behind the logo so the capture keeps only the mark.
        // Hide everything but the logo: hidden parents paint nothing, the logo inside them still shows.
        await page.evaluate(`(() => { const st = document.createElement('style'); st.textContent = 'html, body { background: transparent !important; } body * { visibility: hidden !important; } [data-bemotion-logo], [data-bemotion-logo] * { visibility: visible !important; }'; document.head.appendChild(st); })()`);
        await settle(page, 200);
        const buf = await page.screenshot({ type: 'png', omitBackground: true, clip: { x: Math.max(0, r.x - 4), y: Math.max(0, r.y - 4), width: r.width + 8, height: r.height + 8 } });
        await writeFile(join(dir, 'logo.png'), buf);
        logo = 'logo.png';
      } catch {
        // No logo capture.
      }
    }
    let icon: string | undefined;
    for (const href of facts.icons) {
      const ext = /\.svg(\?|$)/i.test(href) ? 'svg' : /\.ico(\?|$)/i.test(href) ? 'ico' : 'png';
      if (ext === 'ico') continue;
      if (await download(href, join(dir, `icon.${ext}`))) {
        icon = `icon.${ext}`;
        break;
      }
    }

    // Large images on the page: product shots and illustrations, at full resolution.
    const images: string[] = [];
    for (const img of facts.images.slice(0, 6)) {
      const ext = /\.png(\?|$)/i.test(img.src) ? 'png' : /\.webp(\?|$)/i.test(img.src) ? 'webp' : /\.(jpe?g)(\?|$)/i.test(img.src) ? 'jpg' : 'png';
      const file = `shots/image-${images.length + 1}.${ext}`;
      if (await download(img.src, join(dir, file))) images.push(file);
    }

    // Fonts: the site's own files when the engine can read them, Google Fonts next, else bundled.
    const faces = sheets.flatMap((s) => parseFontFaces(s.text, s.url));
    const fonts: BrandFont[] = [];
    for (const f of facts.fonts) {
      if (!f.family || fonts.some((x) => x.family.toLowerCase() === f.family.toLowerCase())) {
        const same = fonts.find((x) => x.family.toLowerCase() === f.family.toLowerCase());
        if (same && f.role === 'body' && same.role === 'display') fonts.push({ ...same, role: 'body' });
        continue;
      }
      const slug = slugify(f.family);
      const files: Record<string, string> = {};
      for (const face of faces.filter((x) => x.family.toLowerCase() === f.family.toLowerCase())) {
        const src = face.urls.find(usable);
        if (!src) continue;
        const key = weightKey(face.weight, face.style);
        if (files[key]) continue;
        const ext = /\.otf/i.test(src) ? 'otf' : /\.ttf/i.test(src) ? 'ttf' : 'woff';
        const file = `fonts/${slug}-${key}.${ext}`;
        if (await download(src, join(dir, file))) files[key] = file;
      }
      let source: BrandFont['source'] = Object.keys(files).length ? 'site' : 'bundled';
      if (source === 'bundled') {
        const g = await googleFont(titleCase(baseFamily(f.family)), dir, slug);
        if (Object.keys(g).length) {
          Object.assign(files, g);
          source = 'google';
        }
      }
      fonts.push({ family: f.family, role: f.role, files, fallback: nearestBundled(baseFamily(f.family)), source });
    }

    const headlines = [...facts.h1, ...facts.h2].map(undouble).filter((t, i, a) => a.indexOf(t) === i).slice(0, 12);
    const ctas = facts.ctas.filter((t) => /get|start|try|sign|book|request|join|download|buy|demo|free|contact|talk/i.test(t)).slice(0, 6);
    const brand: Brand = {
      url,
      name,
      title: facts.title,
      description: facts.description,
      colors,
      dark,
      fonts,
      headlines,
      taglines: facts.paragraphs.slice(0, 6),
      ctas,
      logo,
      logoInk: logo ? (dark ? 'light' : 'dark') : undefined,
      icon,
      screenshots,
      images,
    };
    await writeFile(join(dir, 'brand.json'), JSON.stringify(brand, null, 2) + '\n');
    return brand;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function settle(page: Page, ms = 1200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  await page.evaluate('document.fonts && document.fonts.ready').catch(() => {});
}

async function autoscroll(page: Page): Promise<void> {
  const h = (await page.evaluate('document.documentElement.scrollHeight')) as number;
  for (let y = 0; y < Math.min(h, 14000); y += 700) {
    await page.evaluate(`window.scrollTo(0, ${y})`);
    await new Promise((r) => setTimeout(r, 120));
  }
  await page.evaluate('window.scrollTo(0, 0)');
  await new Promise((r) => setTimeout(r, 500));
}

/** Two screenshots that are the same screen (a sticky full-height section, the page end). */
function similar(a: Buffer, b: Buffer): boolean {
  if (Math.abs(a.length - b.length) > a.length * 0.02) return false;
  let same = 0;
  const n = Math.min(a.length, b.length);
  const step = Math.max(1, Math.floor(n / 4000));
  for (let i = 0; i < n; i += step) if (a[i] === b[i]) same++;
  return same / (n / step) > 0.97;
}

/** The spec fragments a brand gives: theme colors and font registrations. */
export function brandTheme(b: Brand, prefix = ''): { theme: Record<string, unknown>; fonts: Record<string, Record<string, string>> } {
  const fonts: Record<string, Record<string, string>> = {};
  const names: Record<string, string> = {};
  for (const f of b.fonts) {
    if (Object.keys(f.files).length) {
      fonts[f.family] = Object.fromEntries(Object.entries(f.files).map(([k, v]) => [k, prefix + v]));
      names[f.role] = f.family;
    } else {
      names[f.role] = f.fallback;
    }
  }
  return {
    theme: {
      fonts: { display: names.display ?? names.body ?? 'Inter', body: names.body ?? names.display ?? 'Inter' },
      colors: { primary: b.colors.primary, ...(b.colors.secondary ? { secondary: b.colors.secondary } : {}), ...(b.colors.accent ? { accent: b.colors.accent } : {}) },
    },
    fonts,
  };
}

/** A short text summary of a brand for prompts and the terminal. */
export function describeBrand(b: Brand, prefix = ''): string {
  const t = brandTheme(b, prefix);
  const lines = [
    `Name: ${b.name}`,
    `Site: ${b.url}`,
    b.description && `Description: ${b.description}`,
    `Colors: background ${b.colors.background} (${b.dark ? 'dark' : 'light'} site), text ${b.colors.text}, muted ${b.colors.muted}, primary ${b.colors.primary}${b.colors.secondary ? `, secondary ${b.colors.secondary}` : ''}${b.colors.accent ? `, accent ${b.colors.accent}` : ''}`,
    `Fonts: ${b.fonts.map((f) => `${f.role} "${f.family}" (${f.source === 'bundled' ? `not downloadable, use bundled "${f.fallback}"` : `files: ${Object.keys(f.files).join(', ')}`})`).join('; ')}`,
    `Spec fonts entry: ${JSON.stringify(t.fonts)}`,
    `Theme: ${JSON.stringify(t.theme)}`,
    b.headlines.length && `Headlines: ${b.headlines.map((h) => `"${h}"`).join(' / ')}`,
    b.taglines.length && `Copy: ${b.taglines.map((h) => `"${h}"`).join(' / ')}`,
    b.ctas.length && `Calls to action: ${b.ctas.map((h) => `"${h}"`).join(', ')}`,
    b.logo && `Logo: ${prefix}${b.logo} (transparent PNG, ${b.logoInk} ink, so it reads on ${b.logoInk === 'light' ? 'dark' : 'light'} backgrounds)`,
    b.icon && `Icon: ${prefix}${b.icon}`,
    b.screenshots.length && `Page screenshots (2880x1800, the first is the hero): ${b.screenshots.map((s) => prefix + s).join(', ')}`,
    b.images.length && `Product images from the page: ${b.images.map((s) => prefix + s).join(', ')}`,
  ];
  return lines.filter(Boolean).join('\n');
}
