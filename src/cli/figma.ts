import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { BUNDLED, baseFamily, googleFont, nearestBundled } from './brand';
import { validateVideo } from '../spec/schema';
import { log } from './log';

/**
 * Figma import: frames from a Figma file become scenes of editable Bemotion layers, like `capture`
 * does for web pages. Rectangles and ellipses become shapes (fill, gradient, stroke, radius, shadow),
 * text becomes text layers in the file's fonts, simple vectors become svg layers from their path
 * geometry, and anything the engine cannot draw natively (complex vectors, blurs, angular gradients)
 * is rendered by Figma to a PNG and placed as an image. Positions are absolute: auto layout is baked.
 *
 * The token (FIGMA_TOKEN) is only ever sent to api.figma.com, never logged or written anywhere.
 */

const API = 'https://api.figma.com';
/** Largest single download (an image fill or a rendered node). */
const MAX_FILE = 25_000_000;
/** Largest total of all downloads. */
const MAX_TOTAL = 400_000_000;

// --- The parts of the REST API's node shape that are read ------------------------------------

interface Rgba { r: number; g: number; b: number; a: number }
interface Paint {
  type: 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND' | 'IMAGE' | 'EMOJI' | 'VIDEO';
  visible?: boolean;
  opacity?: number;
  color?: Rgba;
  gradientHandlePositions?: { x: number; y: number }[];
  gradientStops?: { position: number; color: Rgba }[];
  scaleMode?: 'FILL' | 'FIT' | 'TILE' | 'STRETCH' | 'CROP';
  imageRef?: string;
}
interface Effect {
  type: 'DROP_SHADOW' | 'INNER_SHADOW' | 'LAYER_BLUR' | 'BACKGROUND_BLUR';
  visible?: boolean;
  radius: number;
  color?: Rgba;
  offset?: { x: number; y: number };
  spread?: number;
}
interface TypeStyle {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  italic?: boolean;
  letterSpacing?: number;
  lineHeightPx?: number;
  textAlignHorizontal?: 'LEFT' | 'RIGHT' | 'CENTER' | 'JUSTIFIED';
  textAlignVertical?: 'TOP' | 'CENTER' | 'BOTTOM';
  textCase?: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE' | 'SMALL_CAPS' | 'SMALL_CAPS_FORCED';
  textAutoResize?: 'NONE' | 'HEIGHT' | 'WIDTH_AND_HEIGHT' | 'TRUNCATE';
  fills?: Paint[];
}
interface Rect { x: number; y: number; width: number; height: number }
export interface FigmaNode {
  id: string;
  name?: string;
  type: string;
  visible?: boolean;
  opacity?: number;
  children?: FigmaNode[];
  absoluteBoundingBox?: Rect | null;
  absoluteRenderBounds?: Rect | null;
  size?: { x: number; y: number };
  relativeTransform?: number[][];
  fills?: Paint[];
  strokes?: Paint[];
  strokeWeight?: number;
  strokeAlign?: 'INSIDE' | 'OUTSIDE' | 'CENTER';
  effects?: Effect[];
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  clipsContent?: boolean;
  isMask?: boolean;
  characters?: string;
  style?: TypeStyle;
  characterStyleOverrides?: number[];
  styleOverrideTable?: Record<string, TypeStyle>;
  fillGeometry?: { path: string; windingRule?: string }[];
  strokeGeometry?: { path: string; windingRule?: string }[];
  arcData?: { startingAngle: number; endingAngle: number; innerRadius: number };
  backgroundColor?: Rgba;
}

type Layer = Record<string, unknown>;

// --- Small helpers ---------------------------------------------------------------------------

const CONTAINERS = new Set(['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION']);
const VECTORS = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'REGULAR_POLYGON', 'POLYGON']);

const r1 = (v: number) => Math.round(v * 10) / 10;
const shown = <T extends { visible?: boolean }>(list: T[] | undefined): T[] => (list ?? []).filter((p) => p.visible !== false);

/** A Figma color (0-1 channels) as #RRGGBB, or #RRGGBBAA when not opaque. */
export function figmaHex(c: Rgba, opacity = 1): string {
  const h = [c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
  const a = Math.max(0, Math.min(1, (c.a ?? 1) * opacity));
  return a >= 0.999 ? `#${h}` : `#${h}${Math.round(a * 255).toString(16).padStart(2, '0').toUpperCase()}`;
}

/** The file key and optional node id from a Figma link (file, design or proto) or a bare key. */
export function parseFigmaRef(ref: string): { key: string; node?: string } {
  const s = ref.trim();
  const m = /figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]+)/.exec(s);
  const key = m ? m[1] : s;
  if (!/^[A-Za-z0-9]{10,64}$/.test(key)) throw new Error(`Not a Figma file link or key: ${s.slice(0, 80)}`);
  let node: string | undefined;
  if (m) {
    try {
      const id = new URL(s.startsWith('http') ? s : `https://${s}`).searchParams.get('node-id');
      if (id) node = id.replace(/-/g, ':');
    } catch {
      // No node in the link.
    }
  }
  return { key, node };
}

/** Rotation of a node in degrees, counterclockwise (Bemotion's y is up). */
function angleOf(n: FigmaNode): number {
  const m = n.relativeTransform;
  if (!m) return 0;
  const deg = (Math.atan2(m[1][0], m[0][0]) * 180) / Math.PI;
  return Math.abs(deg) < 0.01 ? 0 : -deg;
}

function sizeOf(n: FigmaNode): { w: number; h: number } {
  if (n.size) return { w: n.size.x, h: n.size.y };
  const b = n.absoluteBoundingBox;
  return { w: b?.width ?? 0, h: b?.height ?? 0 };
}

function centerOf(b: Rect): { x: number; y: number } {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

function radiusOf(n: FigmaNode): number | undefined {
  const r = n.rectangleCornerRadii?.length ? Math.max(...n.rectangleCornerRadii) : n.cornerRadius;
  return r ? r1(r) : undefined;
}

/** A Bemotion fill from one paint, or null when the engine cannot draw it. */
function fillOf(p: Paint, w: number, h: number): string | Record<string, unknown> | null {
  const op = p.opacity ?? 1;
  if (p.type === 'SOLID' && p.color) return figmaHex(p.color, op);
  if ((p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL') && p.gradientStops?.length && p.gradientHandlePositions?.length) {
    const stops = p.gradientStops;
    const from = figmaHex(stops[0].color, op);
    const to = figmaHex(stops[stops.length - 1].color, op);
    const [a, b] = p.gradientHandlePositions;
    if (p.type === 'GRADIENT_LINEAR') {
      // CSS-style angle: 0 points up, 90 to the right. Handles are in the node's 0-1 box, y down.
      const dx = (b.x - a.x) * w;
      const dy = (b.y - a.y) * h;
      const angle = Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360);
      return { type: 'linear', from, to, angle };
    }
    return { type: 'radial', from, to, center: [r1(a.x - 0.5), r1(0.5 - a.y)] };
  }
  return null;
}

function shadowOf(n: FigmaNode): Record<string, unknown> | undefined {
  const s = shown(n.effects).find((e) => e.type === 'DROP_SHADOW');
  if (!s) return undefined;
  return {
    ...(s.color ? { color: figmaHex({ ...s.color, a: 1 }), opacity: +(s.color.a ?? 0.25).toFixed(3) } : {}),
    blur: r1(s.radius),
    ...(s.offset?.x ? { x: r1(s.offset.x) } : {}),
    y: r1(-(s.offset?.y ?? 0)),
    ...(s.spread ? { spread: r1(s.spread) } : {}),
  };
}

/** Paints and effects the engine draws natively; anything else is rendered by Figma instead. */
function plainPaints(n: FigmaNode): boolean {
  const ok = shown(n.fills).every((p) => p.type === 'SOLID' || p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL' || p.type === 'IMAGE');
  const strokes = shown(n.strokes);
  const effects = shown(n.effects).every((e) => e.type === 'DROP_SHADOW' || e.type === 'BACKGROUND_BLUR');
  return ok && effects && strokes.length <= 1 && strokes.every((p) => p.type === 'SOLID');
}

/** How a leaf node is imported. */
type Plan = 'shape' | 'ellipse' | 'line' | 'text' | 'svg' | 'render' | 'skip';

export function planOf(n: FigmaNode): Plan {
  const { w, h } = sizeOf(n);
  switch (n.type) {
    case 'RECTANGLE':
      return plainPaints(n) ? 'shape' : 'render';
    case 'ELLIPSE': {
      const arc = n.arcData;
      const full = !arc || (Math.abs(arc.endingAngle - arc.startingAngle - 2 * Math.PI) < 0.01 && arc.innerRadius === 0);
      return full && plainPaints(n) && !shown(n.fills).some((p) => p.type === 'IMAGE') ? 'ellipse' : 'render';
    }
    case 'LINE':
      return shown(n.strokes).length === 1 && shown(n.strokes)[0].type === 'SOLID' && !shown(n.effects).length ? 'line' : 'render';
    case 'TEXT':
      return n.characters ? 'text' : 'skip';
    case 'SLICE':
      return 'skip';
    default:
      break;
  }
  if (VECTORS.has(n.type)) {
    // One solid fill and at most one solid stroke, drawn from Figma's own path geometry.
    const fills = shown(n.fills);
    const strokes = shown(n.strokes);
    const simple =
      fills.length <= 1 && fills.every((p) => p.type === 'SOLID') && strokes.length <= 1 && strokes.every((p) => p.type === 'SOLID') &&
      fills.length + strokes.length > 0 && !shown(n.effects).length && w >= 0.5 && h >= 0.5 &&
      (!fills.length || !!n.fillGeometry?.length) && (!strokes.length || !!n.strokeGeometry?.length);
    return simple ? 'svg' : 'render';
  }
  return n.absoluteBoundingBox ? 'render' : 'skip';
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'layer';
}

function caseOf(text: string, tc: TypeStyle['textCase']): { text: string; uppercase?: boolean } {
  if (tc === 'UPPER') return { text, uppercase: true };
  if (tc === 'LOWER') return { text: text.toLowerCase() };
  if (tc === 'TITLE') return { text: text.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) };
  return { text };
}

// --- Fetching --------------------------------------------------------------------------------

export interface FigmaOptions {
  /** Node id to import (a frame); default: every top-level frame of the first page. */
  node?: string;
  /** Page (canvas) name when no node is given. */
  page?: string;
  /** Personal access token; default FIGMA_TOKEN. */
  token?: string;
  /** Scale of nodes Figma renders to PNG. */
  scale?: number;
  /** Seconds per scene. */
  duration?: number;
}

export interface FigmaResult {
  file: string;
  scenes: number;
  layers: number;
  rendered: number;
  images: number;
}

/** Reads a response body, refusing more than `max` bytes. */
async function readCapped(r: Response, max: number): Promise<Buffer> {
  const len = Number(r.headers.get('content-length') ?? 0);
  if (len > max) throw new Error(`Download too large (${Math.round(len / 1e6)} MB)`);
  if (!r.body) return Buffer.from(await r.arrayBuffer());
  const reader = r.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`Download too large (over ${Math.round(max / 1e6)} MB)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Writes a file inside `dir` only: the name is ours, and neither the folder nor the file may be a link out of it. */
async function writeInside(dir: string, name: string, data: Buffer): Promise<string> {
  const base = await realpath(dir);
  const file = resolve(base, name);
  if (!file.startsWith(base + sep)) throw new Error('Refusing to write outside the output folder');
  const st = await lstat(file).catch(() => null);
  if (st?.isSymbolicLink()) throw new Error(`Refusing to write through a link: ${name}`);
  const parent = await realpath(dirname(file));
  if (parent !== base && !parent.startsWith(base + sep)) throw new Error('Refusing to write outside the output folder');
  await writeFile(file, data);
  return file;
}

function sniffExt(buf: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | null {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// --- Import ----------------------------------------------------------------------------------

/** Imports Figma frames into a spec (one scene per frame) with its images and fonts next to it. */
export async function importFigma(ref: string, out: string, o: FigmaOptions = {}): Promise<FigmaResult> {
  const token = o.token ?? process.env.FIGMA_TOKEN;
  if (!token) throw new Error('Set FIGMA_TOKEN to a Figma personal access token (Settings > Security > Personal access tokens, file content read access).');
  const { key, node: linkNode } = parseFigmaRef(ref);
  const nodeId = o.node ?? linkNode;
  const file = resolve(out);
  const dir = dirname(file);
  const mediaRel = join('media', basename(file, '.json'));
  const media = join(dir, mediaRel);
  await mkdir(join(media, 'fonts'), { recursive: true });

  const api = async <T>(path: string): Promise<T> => {
    const r = await fetch(`${API}${path}`, { headers: { 'X-Figma-Token': token } });
    if (!r.ok) {
      let why = '';
      try {
        const j = (await r.json()) as { err?: string; message?: string };
        why = String(j.err ?? j.message ?? '').slice(0, 200);
      } catch {
        // No JSON error body.
      }
      const hint = r.status === 403 ? ' (check FIGMA_TOKEN and that it can read this file)' : r.status === 404 ? ' (no such file or node)' : '';
      throw new Error(`Figma API ${r.status} for ${path.split('?')[0]}${why ? `: ${why}` : ''}${hint}`);
    }
    return JSON.parse((await readCapped(r, 200_000_000)).toString('utf8')) as T;
  };

  // The document tree, with path geometry for vectors and unrotated sizes.
  log.step(`Reading Figma file ${key}`);
  let frames: FigmaNode[];
  let title = 'Figma import';
  if (nodeId) {
    const res = await api<{ name?: string; nodes: Record<string, { document: FigmaNode } | null> }>(`/v1/files/${key}/nodes?ids=${encodeURIComponent(nodeId)}&geometry=paths`);
    const doc = res.nodes?.[nodeId]?.document;
    if (!doc) throw new Error(`Node ${nodeId} is not in the file`);
    title = res.name ?? title;
    // A page (canvas) imports its frames; anything else is one scene.
    frames = doc.type === 'CANVAS' ? (doc.children ?? []).filter((c) => c.visible !== false && c.absoluteBoundingBox) : [doc];
  } else {
    const res = await api<{ name?: string; document: FigmaNode }>(`/v1/files/${key}?geometry=paths`);
    title = res.name ?? title;
    const pages = (res.document.children ?? []).filter((c) => c.type === 'CANVAS');
    const page = o.page ? pages.find((p) => (p.name ?? '').toLowerCase() === o.page!.toLowerCase()) : pages[0];
    if (!page) throw new Error(o.page ? `No page named ${o.page}` : 'The file has no pages');
    frames = (page.children ?? []).filter((c) => c.visible !== false && c.absoluteBoundingBox && CONTAINERS.has(c.type));
  }
  if (!frames.length) throw new Error('Nothing to import: no frames found');

  // First pass: what needs rendering by Figma, which image fills are used, which fonts.
  const renderIds: string[] = [];
  const imageRefs = new Set<string>();
  const families = new Set<string>();
  const visit = (n: FigmaNode) => {
    if (n.visible === false) return;
    for (const p of shown(n.fills)) if (p.type === 'IMAGE' && p.imageRef) imageRefs.add(p.imageRef);
    if (CONTAINERS.has(n.type)) {
      // A frame with paints the engine cannot draw is rendered whole.
      if (!plainPaints(n)) renderIds.push(n.id);
      else for (const c of n.children ?? []) visit(c);
      return;
    }
    const plan = planOf(n);
    if (plan === 'render') renderIds.push(n.id);
    if (plan === 'text') {
      if (n.style?.fontFamily) families.add(n.style.fontFamily);
      for (const s of Object.values(n.styleOverrideTable ?? {})) if (s.fontFamily) families.add(s.fontFamily);
    }
  };
  for (const f of frames) visit(f);

  // Downloads: Figma's image URLs (no token sent), size-limited, saved under names we choose.
  let total = 0;
  let count = 0;
  const download = async (url: string, prefix: string): Promise<string | undefined> => {
    if (!/^https:\/\//i.test(url)) return undefined;
    try {
      const r = await fetch(url);
      if (!r.ok) return undefined;
      const buf = await readCapped(r, MAX_FILE);
      total += buf.length;
      if (total > MAX_TOTAL) throw new Error('Downloads exceed the total limit');
      const ext = sniffExt(buf);
      if (!ext) return undefined;
      const name = `${prefix}-${++count}.${ext}`;
      await writeInside(media, name, buf);
      return `${mediaRel}/${name}`.replace(/\\/g, '/');
    } catch (e) {
      log.warn(`Could not download ${prefix === 'render' ? 'a rendered node' : 'an image fill'}: ${(e as Error).message}`);
      return undefined;
    }
  };

  const fillImages = new Map<string, string>();
  if (imageRefs.size) {
    log.step(`Downloading ${imageRefs.size} image fill${imageRefs.size === 1 ? '' : 's'}`);
    const res = await api<{ meta?: { images?: Record<string, string> } }>(`/v1/files/${key}/images`);
    for (const ref of imageRefs) {
      const url = res.meta?.images?.[ref];
      const got = url ? await download(url, 'image') : undefined;
      if (got) fillImages.set(ref, got);
    }
  }
  const rendered = new Map<string, string>();
  if (renderIds.length) {
    log.step(`Rendering ${renderIds.length} node${renderIds.length === 1 ? '' : 's'} in Figma`);
    for (let i = 0; i < renderIds.length; i += 50) {
      const ids = renderIds.slice(i, i + 50);
      const res = await api<{ err?: string | null; images?: Record<string, string | null> }>(
        `/v1/images/${key}?ids=${encodeURIComponent(ids.join(','))}&format=png&scale=${o.scale ?? 2}`,
      );
      for (const id of ids) {
        const url = res.images?.[id];
        const got = url ? await download(url, 'render') : undefined;
        if (got) rendered.set(id, got);
      }
    }
  }

  // Fonts: bundled ones as they are, then Google Fonts by name, else the nearest bundled.
  const fonts: Record<string, Record<string, string>> = {};
  const fontMap = new Map<string, string>();
  const bundled = ['Inter', ...BUNDLED.map((b) => b.name)];
  for (const fam of families) {
    const exact = bundled.find((b) => b.toLowerCase() === fam.toLowerCase());
    if (exact) {
      fontMap.set(fam, exact);
      continue;
    }
    const got = await googleFont(fam, media, slug(fam));
    if (Object.keys(got).length) {
      fonts[fam] = Object.fromEntries(Object.entries(got).map(([k, v]) => [k, `${mediaRel}/${v}`.replace(/\\/g, '/')]));
      fontMap.set(fam, fam);
    } else {
      const near = nearestBundled(baseFamily(fam));
      fontMap.set(fam, near);
      log.info(`Font ${fam} is not on Google Fonts; using ${near}`);
    }
  }

  // Second pass: layers. Positions are relative to the parent group's center, y up.
  let layerCount = 0;
  const ids = new Set<string>();
  const idFor = (n: FigmaNode, fallback: string): string => {
    const b = slug(n.name ?? fallback);
    let id = b;
    for (let i = 2; ids.has(id); i++) id = `${b}-${i}`;
    ids.add(id);
    return id;
  };
  const place = (b: Rect, pc: { x: number; y: number }) => {
    const c = centerOf(b);
    return { x: r1(c.x - pc.x), y: r1(pc.y - c.y) };
  };
  const opacityOf = (n: FigmaNode) => (n.opacity !== undefined && n.opacity < 0.999 ? { opacity: +n.opacity.toFixed(3) } : {});

  /** Background and border of a box (rectangle or frame): one layer per fill, bottom first. */
  const boxLayers = (n: FigmaNode, pos: { x: number; y: number }, rot: number, round: boolean): Layer[] => {
    const { w, h } = sizeOf(n);
    const out: Layer[] = [];
    const radius = round ? undefined : radiusOf(n);
    const stroke = shown(n.strokes)[0];
    const shadow = shadowOf(n);
    const blur = shown(n.effects).find((e) => e.type === 'BACKGROUND_BLUR');
    const fills = shown(n.fills);
    const geom = { ...pos, ...(rot ? { rotate: r1(rot) } : {}) };
    fills.forEach((p, i) => {
      const first = i === 0;
      if (p.type === 'IMAGE') {
        const src = p.imageRef ? fillImages.get(p.imageRef) : undefined;
        if (!src) return;
        out.push({
          type: 'image', src, ...geom, width: r1(w), height: r1(h),
          fit: p.scaleMode === 'FIT' ? 'contain' : p.scaleMode === 'STRETCH' ? 'fill' : 'cover',
          ...(radius ? { radius } : {}), ...(p.opacity !== undefined && p.opacity < 0.999 ? { opacity: +p.opacity.toFixed(3) } : {}),
          ...(first && shadow ? { shadow } : {}),
        });
        return;
      }
      const fill = fillOf(p, w, h);
      if (!fill) return;
      out.push({
        type: 'shape', ...(round ? { shape: 'circle' } : {}), ...geom, width: r1(w), height: r1(h), ...(radius ? { radius } : {}), fill,
        ...(first && shadow ? { shadow } : {}),
        ...(first && blur ? { glass: { blur: r1(blur.radius) } } : {}),
      });
    });
    if (stroke?.color && (n.strokeWeight ?? 0) > 0) {
      const color = figmaHex(stroke.color, stroke.opacity ?? 1);
      // The engine draws strokes inside the edge: grow the outline for centered and outside strokes.
      const grow = n.strokeAlign === 'OUTSIDE' ? n.strokeWeight! * 2 : n.strokeAlign === 'CENTER' ? n.strokeWeight! : 0;
      const last = out[out.length - 1];
      if (last && last.type === 'shape' && !grow) {
        last.stroke = color;
        last.strokeWidth = r1(n.strokeWeight!);
      } else {
        out.push({
          type: 'shape', ...(round ? { shape: 'circle' } : {}), ...geom, width: r1(w + grow), height: r1(h + grow),
          ...(radius ? { radius: r1(radius + grow / 2) } : {}), fill: 'none', stroke: color, strokeWidth: r1(n.strokeWeight!),
          ...(!fills.length && shadow ? { shadow } : {}),
        });
      }
    }
    return out;
  };

  const textLayers = (n: FigmaNode, pc: { x: number; y: number }, rot: number): Layer[] => {
    const st = n.style ?? {};
    const size = st.fontSize ?? 16;
    const lh = st.lineHeightPx ?? size * 1.2;
    const fam = st.fontFamily ?? 'Inter';
    const paint = shown(n.fills).find((p) => p.type === 'SOLID' || p.type.startsWith('GRADIENT'));
    const { w, h } = sizeOf(n);
    const c = centerOf(n.absoluteBoundingBox!);
    const left = c.x - w / 2;
    const top = c.y - h / 2;
    const align = st.textAlignHorizontal === 'CENTER' ? 'center' : st.textAlignHorizontal === 'RIGHT' ? 'right' : 'left';
    const ax = align === 'center' ? c.x : align === 'right' ? left + w : left;
    const color: Record<string, unknown> = {};
    if (paint?.type === 'SOLID' && paint.color) color.color = figmaHex(paint.color, paint.opacity ?? 1);
    else if (paint) {
      const g = fillOf(paint, w, h);
      if (g && typeof g === 'object') color.gradient = { colors: [g.from, g.to], ...(g.type === 'linear' ? { angle: g.angle } : {}) };
    }
    const base: Layer = {
      type: 'text', font: fontMap.get(fam) ?? 'Inter', size: r1(size), weight: st.fontWeight ?? 400, ...(st.italic ? { italic: true } : {}),
      ...color, align, anchor: align, lineHeight: +(lh / size).toFixed(3), letterSpacing: +((st.letterSpacing ?? 0) / size).toFixed(3),
      ...(rot ? { rotate: r1(rot) } : {}), ...opacityOf(n),
    };
    const chars = n.characters ?? '';
    // Colored runs (per-character overrides) become highlights.
    const runs: { from: number; to: number; color: string }[] = [];
    const ov = n.characterStyleOverrides ?? [];
    for (let i = 0; i < ov.length; ) {
      const id = ov[i];
      let j = i;
      while (j < ov.length && ov[j] === id) j++;
      const s = id ? n.styleOverrideTable?.[String(id)] : undefined;
      const p = shown(s?.fills).find((q) => q.type === 'SOLID');
      if (p?.color) runs.push({ from: i, to: j, color: figmaHex(p.color, p.opacity ?? 1) });
      i = j;
    }
    const highlightsFor = (text: string, offset: number) => {
      const out: Record<string, unknown>[] = [];
      for (const r of runs) {
        const from = Math.max(r.from - offset, 0);
        const to = Math.min(r.to - offset, text.length);
        const piece = text.slice(from, to);
        if (to <= from || !piece.trim()) continue;
        let nth = 0;
        for (let k = text.indexOf(piece); k >= 0 && k < from; k = text.indexOf(piece, k + 1)) nth++;
        out.push({ text: piece, color: r.color, ...(nth ? { nth } : {}) });
      }
      return out.length ? { highlight: out } : {};
    };
    const lines = chars.split(/\r?\n|\u2028/);
    const fits = st.textAutoResize === 'WIDTH_AND_HEIGHT' || h <= lines.length * lh * 1.25;
    if (!fits || lines.length === 1) {
      const one = caseOf(chars.replace(/\u2028/g, '\n'), st.textCase);
      return [{
        ...base, ...one, x: r1(ax - pc.x), y: r1(pc.y - c.y),
        // Wrapped text keeps Figma's box width (a little slack so lines break where Figma breaks them).
        ...(!fits ? { maxWidth: r1(w + 1) } : {}),
        ...highlightsFor(chars, 0),
      }];
    }
    // One layer per line, so each line can animate on its own (like capture).
    const blockTop = st.textAlignVertical === 'CENTER' ? top + (h - lines.length * lh) / 2 : st.textAlignVertical === 'BOTTOM' ? top + h - lines.length * lh : top;
    const out: Layer[] = [];
    let offset = 0;
    lines.forEach((line, i) => {
      if (line.trim()) {
        const cy = blockTop + (i + 0.5) * lh;
        out.push({ ...base, ...caseOf(line, st.textCase), x: r1(ax - pc.x), y: r1(pc.y - cy), ...highlightsFor(line, offset) });
      }
      offset += line.length + 1;
    });
    return out;
  };

  /** Layers for one node, positioned relative to `pc` (the parent's center, absolute, y down). */
  const convert = (n: FigmaNode, pc: { x: number; y: number }, rotParent: number): Layer[] => {
    if (n.visible === false || !n.absoluteBoundingBox) return [];
    const own = angleOf(n);
    // Groups carry no transform of their own: their children are placed by the enclosing frame.
    const rot = rotParent + (n.type === 'GROUP' || n.type === 'BOOLEAN_OPERATION' ? 0 : own);
    const pos = place(n.absoluteBoundingBox, pc);
    const id = idFor(n, n.type.toLowerCase());
    const renderedSrc = rendered.get(n.id);
    if (renderedSrc) {
      // Figma drew it (effects and strokes included): placed at its render bounds, already rotated.
      const b = n.absoluteRenderBounds ?? n.absoluteBoundingBox;
      layerCount++;
      return [{ type: 'image', id, src: renderedSrc, ...place(b, pc), width: r1(b.width), height: r1(b.height), fit: 'fill', ...opacityOf(n) }];
    }
    if (CONTAINERS.has(n.type)) {
      const c = centerOf(n.absoluteBoundingBox);
      const kids: Layer[] = n.type === 'GROUP' ? [] : boxLayers(n, { x: 0, y: 0 }, rot, false);
      layerCount += kids.length;
      const content = convertChildren(n.children ?? [], c, rot);
      const { w, h } = sizeOf(n);
      if (n.clipsContent && n.type !== 'GROUP' && content.length) {
        const radius = radiusOf(n);
        kids.push({ type: 'group', id: `${id}-clip`, mask: { type: 'shape', width: r1(w), height: r1(h), ...(radius ? { radius } : {}), fill: '#FFFFFF', ...(rot ? { rotate: r1(rot) } : {}) }, children: content });
      } else kids.push(...content);
      if (!kids.length) return [];
      return [{ type: 'group', id, ...pos, ...opacityOf(n), children: kids }];
    }
    const plan = planOf(n);
    const { w, h } = sizeOf(n);
    if (plan === 'shape' || plan === 'ellipse') {
      const ls = boxLayers(n, pos, rot, plan === 'ellipse');
      ls.forEach((l, i) => {
        l.id = i ? `${id}-${i + 1}` : id;
        Object.assign(l, opacityOf(n));
      });
      layerCount += ls.length;
      return ls;
    }
    if (plan === 'line') {
      const s = shown(n.strokes)[0];
      layerCount++;
      return [{ type: 'shape', id, ...pos, width: r1(Math.max(w, n.strokeWeight ?? 1)), height: r1(n.strokeWeight ?? 1), fill: figmaHex(s.color!, s.opacity ?? 1), ...(rot ? { rotate: r1(rot) } : {}), ...opacityOf(n) }];
    }
    if (plan === 'text') {
      const ls = textLayers(n, pc, rot);
      ls.forEach((l, i) => (l.id = ls.length > 1 ? `${id}-${i + 1}` : id));
      layerCount += ls.length;
      return ls;
    }
    if (plan === 'svg') {
      const out: Layer[] = [];
      const f = shown(n.fills)[0];
      const s = shown(n.strokes)[0];
      const geom = { ...pos, viewBox: [0, 0, r1(w), r1(h)], width: r1(w), ...(rot ? { rotate: r1(rot) } : {}), ...opacityOf(n) };
      if (f?.color && n.fillGeometry?.length) out.push({ type: 'svg', id, d: n.fillGeometry.map((g) => g.path).join(' '), fill: figmaHex(f.color, f.opacity ?? 1), ...geom });
      // The stroke's outline as a filled shape: exact for any join, cap and alignment.
      if (s?.color && n.strokeGeometry?.length) out.push({ type: 'svg', id: out.length ? `${id}-stroke` : id, d: n.strokeGeometry.map((g) => g.path).join(' '), fill: figmaHex(s.color, s.opacity ?? 1), ...geom });
      layerCount += out.length;
      return out;
    }
    return [];
  };

  /** Children in paint order; a child marked as a mask clips the siblings above it. */
  const convertChildren = (children: FigmaNode[], pc: { x: number; y: number }, rot: number): Layer[] => {
    const out: Layer[] = [];
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (c.isMask && c.visible !== false) {
        const mask = convert({ ...c, isMask: false, opacity: 1 }, pc, rot)[0];
        const rest = children.slice(i + 1).flatMap((k) => convert(k, pc, rot));
        if (mask && rest.length) {
          delete mask.id;
          out.push({ type: 'group', id: `${slug(c.name ?? 'mask')}-masked`, mask, children: rest });
        } else out.push(...rest);
        break;
      }
      out.push(...convert(c, pc, rot));
    }
    return out;
  };

  const scenes = frames.map((f, i) => {
    ids.clear();
    const b = f.absoluteBoundingBox!;
    const c = centerOf(b);
    const fills = shown(f.fills);
    const solidBg = fills.length === 1 && fills[0].type === 'SOLID' && fills[0].color && (fills[0].opacity ?? 1) >= 0.999 && (fills[0].color.a ?? 1) >= 0.999;
    let layers: Layer[];
    const rendered0 = rendered.get(f.id);
    if (rendered0) {
      layers = [{ type: 'image', id: 'frame', src: rendered0, x: 0, y: 0, width: r1(b.width), height: r1(b.height), fit: 'fill' }];
      layerCount++;
    } else {
      const bg = solidBg ? [] : boxLayers({ ...f, effects: [] }, { x: 0, y: 0 }, 0, false);
      layerCount += bg.length;
      layers = [...bg, ...convertChildren(f.children ?? [], c, 0)];
    }
    // The frame fills the 1920x1080 video (scaled up or down, never cropped).
    const fit = Math.min(1920 / b.width, 1080 / b.height);
    return {
      id: slug(f.name ?? `frame-${i + 1}`),
      duration: o.duration ?? 4,
      background: solidBg ? figmaHex(fills[0].color!) : '#FFFFFF',
      layers: [{ type: 'group', id: 'frame', ...(Math.abs(fit - 1) > 0.001 ? { scale: +fit.toFixed(3) } : {}), children: layers }],
    };
  });
  // Scene ids must be unique across scenes.
  const seen = new Map<string, number>();
  for (const s of scenes) {
    const k = seen.get(s.id) ?? 0;
    seen.set(s.id, k + 1);
    if (k) s.id = `${s.id}-${k + 1}`;
  }

  const spec = {
    title,
    width: 1920,
    height: 1080,
    ...(Object.keys(fonts).length ? { fonts } : {}),
    post: { bloom: false, grain: 0, vignette: 0 },
    scenes,
  };
  const v = validateVideo(spec);
  if (!v.ok) log.warn(`The imported spec has ${v.errors.length} validation problem(s):\n${v.errors.slice(0, 10).map((e) => `  - ${e}`).join('\n')}`);
  await writeFile(file, JSON.stringify(spec, null, 2) + '\n');
  return { file, scenes: scenes.length, layers: layerCount, rendered: rendered.size, images: fillImages.size };
}

