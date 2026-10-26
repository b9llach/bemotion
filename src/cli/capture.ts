import puppeteer, { type HTTPResponse } from 'puppeteer';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { WEB_BROWSER_ARGS } from './render';
import { baseFamily, nearestBundled, parseFontFaces } from './brand';
import { log } from './log';

/**
 * UI capture: turns part of a live web page into Bemotion layers instead of a flat screenshot. Boxes
 * become shapes (fill, border, radius, shadow), each line of text a text layer in the page's font,
 * images and inline icons image layers, all at their places, so every piece can be animated.
 */

interface Box {
  kind: 'box';
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  shadow?: { blur: number; y: number; opacity: number };
  opacity: number;
  path: string;
}
interface Line {
  kind: 'text';
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  font: string;
  size: number;
  weight: number;
  italic: boolean;
  color: string;
  letterSpacing: number;
  opacity: number;
  path: string;
}
interface Pic {
  kind: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  src?: string;
  svg?: string;
  radius?: number;
  fit: string;
  opacity: number;
  path: string;
}
type Item = Box | Line | Pic;

// Runs in the page (a string, so no bundler helpers leak in). Walks the region in paint order.
const WALK = String.raw`((sel, maxItems) => {
  const root = sel ? document.querySelector(sel) : document.body;
  if (!root) return { error: 'No element matches ' + sel };
  const rr = sel ? root.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
  const region = { x: rr.left, y: rr.top, w: rr.width, h: rr.height };
  const items = [];
  const clean = (s) => s.replace(/\s+/g, ' ').trim();
  const visible = (cs) => cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.02;
  const inside = (r) => r.right > region.x && r.left < region.x + region.w && r.bottom > region.y && r.top < region.y + region.h;
  const transparent = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
  const pathOf = (el) => {
    const parts = [];
    for (let e = el; e && e !== root && parts.length < 4; e = e.parentElement) {
      const id = e.id ? '#' + e.id : '';
      const cls = typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/)[0] : '';
      parts.unshift(e.tagName.toLowerCase() + (id || cls));
    }
    return parts.join(' > ');
  };
  const shadowOf = (cs) => {
    const m = /rgba?\([^)]*\)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/.exec(cs.boxShadow || '');
    if (!m || cs.boxShadow === 'none') return undefined;
    const a = /rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/.exec(cs.boxShadow);
    return { blur: Number(m[3]), y: -Number(m[2]), opacity: a ? Number(a[1]) : 0.25 };
  };
  // What ancestors with overflow hidden (or a clip) leave visible: screen-reader copies live in a
  // clipped 1px box and must not be captured.
  const meet = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const seen = (r, clip) => Math.min(r.right, clip.right) - Math.max(r.left, clip.left) > 1 && Math.min(r.bottom, clip.bottom) - Math.max(r.top, clip.top) > 1;
  const walk = (el, op, clip) => {
    if (items.length >= maxItems) return;
    const cs = getComputedStyle(el);
    if (!visible(cs)) return;
    // Blended overlays (noise, grain, glows with mix-blend-mode) do not read as plain layers.
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') return;
    const o = op * Number(cs.opacity);
    const r = el.getBoundingClientRect();
    let inner = clip;
    if (cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible') inner = meet(clip, r);
    if (cs.clip && /rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(cs.clip)) return;
    if (/inset\(\s*50%/.test(cs.clipPath || '')) return;
    if (!seen(r, clip) && cs.overflow !== 'visible') return;
    if (!inside(r) && el !== root) {
      // Children can overflow a clipped-away parent; skip only when nothing can show.
      if (cs.overflow === 'hidden') return;
    }
    const tag = el.tagName;
    if (r.width >= 1 && r.height >= 1 && inside(r) && seen(r, clip)) {
      if (tag === 'IMG' && el.currentSrc) {
        items.push({ kind: 'image', x: r.left, y: r.top, w: r.width, h: r.height, src: el.currentSrc, fit: cs.objectFit === 'contain' ? 'contain' : 'cover', radius: parseFloat(cs.borderTopLeftRadius) || 0, opacity: o, path: pathOf(el) });
        return;
      }
      if (tag === 'svg' || tag === 'SVG') {
        const clone = el.cloneNode(true);
        const color = cs.color;
        clone.setAttribute('width', String(r.width));
        clone.setAttribute('height', String(r.height));
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        let s = new XMLSerializer().serializeToString(clone).replace(/currentColor/g, color);
        if (!/fill=/.test(s.slice(0, 200))) s = s.replace('<svg', '<svg fill="' + (cs.fill && cs.fill !== 'none' ? cs.fill : color) + '"');
        items.push({ kind: 'image', x: r.left, y: r.top, w: r.width, h: r.height, svg: s, fit: 'fill', opacity: o, path: pathOf(el) });
        return;
      }
      const bg = cs.backgroundColor;
      const bw = parseFloat(cs.borderTopWidth) || 0;
      const hasBorder = bw > 0 && !transparent(cs.borderTopColor) && cs.borderTopStyle !== 'none';
      const shadow = shadowOf(cs);
      if (!transparent(bg) || hasBorder || shadow) {
        items.push({
          kind: 'box', x: r.left, y: r.top, w: r.width, h: r.height,
          fill: transparent(bg) ? undefined : bg, stroke: hasBorder ? cs.borderTopColor : undefined, strokeWidth: hasBorder ? bw : undefined,
          radius: parseFloat(cs.borderTopLeftRadius) || 0, shadow, opacity: o, path: pathOf(el),
        });
      }
      const bgi = /url\(["']?([^"')]+)["']?\)/.exec(cs.backgroundImage || '');
      // Tiled backgrounds are textures (noise, patterns), not pictures.
      if (bgi && !/gradient/.test(cs.backgroundImage) && /no-repeat/.test(cs.backgroundRepeat)) {
        items.push({ kind: 'image', x: r.left, y: r.top, w: r.width, h: r.height, src: new URL(bgi[1], location.href).href, fit: cs.backgroundSize === 'contain' ? 'contain' : 'cover', radius: parseFloat(cs.borderTopLeftRadius) || 0, opacity: o, path: pathOf(el) });
      }
    }
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        const text = n.textContent || '';
        if (!clean(text)) continue;
        // One text layer per rendered line: walk the words and split where the line box changes.
        const range = document.createRange();
        const words = [];
        const re = /\S+/g;
        let m;
        while ((m = re.exec(text))) {
          range.setStart(n, m.index);
          range.setEnd(n, m.index + m[0].length);
          const rects = range.getClientRects();
          if (!rects.length) continue;
          const b = rects[0];
          words.push({ w: m[0], l: b.left, t: b.top, r: b.right, b: b.bottom });
        }
        const lines = [];
        for (const w of words) {
          const last = lines[lines.length - 1];
          if (last && Math.abs(w.t - last.t) < 2) { last.text += ' ' + w.w; last.r = w.r; last.b = Math.max(last.b, w.b); }
          else lines.push({ text: w.w, l: w.l, t: w.t, r: w.r, b: w.b });
        }
        const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
        for (const ln of lines) {
          const box = { left: ln.l, right: ln.r, top: ln.t, bottom: ln.b };
          if (!inside(box) || !seen(box, inner)) continue;
          items.push({
            kind: 'text', x: ln.l, y: ln.t, w: ln.r - ln.l, h: ln.b - ln.t, text: cs.textTransform === 'uppercase' ? ln.text.toUpperCase() : ln.text,
            font: fam, size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight) || 400, italic: cs.fontStyle === 'italic', color: cs.color,
            letterSpacing: cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing) / parseFloat(cs.fontSize), opacity: o, path: pathOf(el),
          });
        }
      } else if (n.nodeType === 1) walk(n, o, inner);
    }
  };
  walk(root, 1, { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 });
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  return { region, items, background: transparent(bodyBg) ? getComputedStyle(document.documentElement).backgroundColor : bodyBg };
})`;

function hex(c: string | undefined): string | undefined {
  if (!c) return undefined;
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(c);
  if (!m) return c;
  const h = [m[1], m[2], m[3]].map((v) => Math.round(Number(v)).toString(16).padStart(2, '0')).join('').toUpperCase();
  const a = m[4] === undefined ? 1 : Number(m[4]);
  return a >= 0.999 ? `#${h}` : `#${h}${Math.round(a * 255).toString(16).padStart(2, '0').toUpperCase()}`;
}

export interface CaptureOptions {
  /** CSS selector of the part to capture (default: the first screen). */
  selector?: string;
  width?: number;
  height?: number;
  /** Most layers to make. */
  max?: number;
}

export interface CaptureResult {
  spec: Record<string, unknown>;
  layers: number;
  file: string;
}

/** Captures a page (or one element of it) into a spec with one scene holding the UI as layers. */
export async function captureUi(url: string, out: string, o: CaptureOptions = {}): Promise<CaptureResult> {
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const file = resolve(out);
  const dir = dirname(file);
  const media = join(dir, 'media', basename(file, '.json'));
  await mkdir(join(media, 'fonts'), { recursive: true });
  const width = o.width ?? 1440;
  const height = o.height ?? 900;
  const browser = await puppeteer.launch({ headless: true, args: WEB_BROWSER_ARGS });
  const sheets: { url: string; text: string }[] = [];
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36');
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    page.on('response', (r: HTTPResponse) => {
      if (r.request().resourceType() === 'stylesheet' && r.ok()) r.text().then((text) => sheets.push({ url: r.url(), text })).catch(() => {});
    });
    log.step(`Opening ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => log.warn('The page kept loading; continuing'));
    await new Promise((r) => setTimeout(r, 1200));
    await page.evaluate('document.fonts && document.fonts.ready');
    if (o.selector) await page.evaluate(`(document.querySelector(${JSON.stringify(o.selector)}) || document.body).scrollIntoView({ block: 'center' })`);
    await new Promise((r) => setTimeout(r, 500));
    const res = (await page.evaluate(`${WALK}(${JSON.stringify(o.selector ?? '')}, ${o.max ?? 600})`)) as { error?: string; region: { x: number; y: number; w: number; h: number }; items: Item[]; background: string };
    if (res.error) throw new Error(res.error);
    const inline = (await page.evaluate(`[...document.querySelectorAll('style')].map((s) => s.textContent).join(String.fromCharCode(10))`)) as string;
    sheets.push({ url, text: inline });

    // Images: downloaded next to the spec; inline SVG icons written as files.
    const files = new Map<string, string>();
    let n = 0;
    // SVG (inline icons, .svg images) is drawn to PNG by the page itself at twice its size: what the
    // browser shows is what the video gets, and icons that reference sprites or fonts still come out.
    const rasterize = async (svg: string, w: number, h: number): Promise<Buffer | undefined> => {
      const url = (await page.evaluate(
        `(async (svg, w, h) => {
          const img = new Image();
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
          try { await img.decode(); } catch { return null; }
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * 2));
          c.height = Math.max(1, Math.round(h * 2));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          return c.toDataURL('image/png');
        })(${JSON.stringify(svg)}, ${w}, ${h})`,
      )) as string | null;
      return url ? Buffer.from(url.slice(url.indexOf(',') + 1), 'base64') : undefined;
    };
    const save = async (it: Pic): Promise<string | undefined> => {
      if (it.svg) {
        const png = await rasterize(it.svg, it.w, it.h);
        if (!png) return undefined;
        const name = `icon-${++n}.png`;
        await writeFile(join(media, name), png);
        return name;
      }
      if (!it.src) return undefined;
      const key = `${it.src}|${Math.round(it.w)}x${Math.round(it.h)}`;
      if (files.has(key)) return files.get(key);
      try {
        const r = await fetch(it.src);
        if (!r.ok) return undefined;
        const buf = Buffer.from(await r.arrayBuffer());
        const isSvg = /\.svg(\?|$)/i.test(it.src) || (r.headers.get('content-type') ?? '').includes('svg');
        let name: string;
        if (isSvg) {
          const png = await rasterize(buf.toString('utf8'), it.w, it.h);
          if (!png) return undefined;
          name = `image-${++n}.png`;
          await writeFile(join(media, name), png);
        } else {
          const ext = /\.png(\?|$)/i.test(it.src) ? 'png' : /\.webp(\?|$)/i.test(it.src) ? 'webp' : /\.gif(\?|$)/i.test(it.src) ? 'gif' : 'jpg';
          name = `image-${++n}.${ext}`;
          await writeFile(join(media, name), buf);
        }
        files.set(key, name);
        return name;
      } catch {
        return undefined;
      }
    };

    // Fonts the text uses: the site's woff/ttf files, Google Fonts by name, else the nearest bundled.
    const faces = sheets.flatMap((s) => parseFontFaces(s.text, s.url));
    const fontMap = new Map<string, string>();
    const fonts: Record<string, Record<string, string>> = {};
    for (const fam of new Set(res.items.filter((i): i is Line => i.kind === 'text').map((i) => i.font))) {
      const got: Record<string, string> = {};
      for (const f of faces.filter((x) => x.family.toLowerCase() === fam.toLowerCase())) {
        const src = f.urls.find((u) => /\.(woff|ttf|otf)(\?|#|$)/i.test(u));
        if (!src) continue;
        const w = /^\d+/.exec(f.weight)?.[0] ?? (f.weight === 'bold' ? '700' : '400');
        const key = /italic|oblique/i.test(f.style) ? `${w}italic` : w;
        if (got[key]) continue;
        const ext = /\.otf/i.test(src) ? 'otf' : /\.ttf/i.test(src) ? 'ttf' : 'woff';
        const name = `fonts/${fam.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${key}.${ext}`;
        try {
          const r = await fetch(src);
          if (r.ok) {
            await writeFile(join(media, name), Buffer.from(await r.arrayBuffer()));
            got[key] = relative(dir, join(media, name)).replace(/\\/g, '/');
          }
        } catch {
          // Use a fallback.
        }
      }
      if (Object.keys(got).length) {
        fonts[fam] = got;
        fontMap.set(fam, fam);
      } else {
        fontMap.set(fam, nearestBundled(baseFamily(fam)));
      }
    }

    // Layers, centered on the captured region, y up.
    const cx = res.region.x + res.region.w / 2;
    const cy = res.region.y + res.region.h / 2;
    const pos = (it: { x: number; y: number; w: number; h: number }) => ({ x: +(it.x + it.w / 2 - cx).toFixed(1), y: +(cy - (it.y + it.h / 2)).toFixed(1) });
    const layers: Record<string, unknown>[] = [];
    for (const it of res.items) {
      const op = it.opacity < 0.999 ? { opacity: +it.opacity.toFixed(3) } : {};
      if (it.kind === 'box') {
        layers.push({
          type: 'shape', ...pos(it), width: +it.w.toFixed(1), height: +it.h.toFixed(1),
          ...(it.radius ? { radius: Math.min(it.radius, Math.min(it.w, it.h) / 2) } : {}),
          fill: hex(it.fill) ?? 'none', ...(it.stroke ? { stroke: hex(it.stroke), strokeWidth: it.strokeWidth } : {}),
          ...(it.shadow ? { shadow: it.shadow } : {}), ...op,
        });
      } else if (it.kind === 'text') {
        layers.push({
          type: 'text', text: it.text, x: +(it.x - cx).toFixed(1), y: +(cy - (it.y + it.h / 2)).toFixed(1), anchor: 'left', align: 'left',
          font: fontMap.get(it.font) ?? 'Inter', size: +it.size.toFixed(1), weight: it.weight, ...(it.italic ? { italic: true } : {}),
          color: hex(it.color), letterSpacing: +it.letterSpacing.toFixed(3), lineHeight: 1, ...op,
        });
      } else {
        const src = await save(it);
        if (!src) continue;
        layers.push({
          type: 'image', src: relative(dir, join(media, src)).replace(/\\/g, '/'), ...pos(it), width: +it.w.toFixed(1), height: +it.h.toFixed(1),
          fit: it.fit, ...(it.radius ? { radius: it.radius } : {}), ...op,
        });
      }
    }
    const spec = {
      title: `Capture of ${new URL(url).hostname}${o.selector ? ` ${o.selector}` : ''}`,
      width: 1920,
      height: 1080,
      ...(Object.keys(fonts).length ? { fonts } : {}),
      post: { bloom: false, grain: 0, vignette: 0 },
      scenes: [{
        id: 'capture',
        duration: 4,
        background: hex(res.background) ?? '#FFFFFF',
        layers: [{ type: 'group', id: 'ui', ...(res.region.w > 1720 ? { scale: +(1720 / res.region.w).toFixed(3) } : {}), children: layers }],
      }],
    };
    await writeFile(file, JSON.stringify(spec, null, 2) + '\n');
    return { spec, layers: layers.length, file };
  } finally {
    await browser.close().catch(() => {});
  }
}
