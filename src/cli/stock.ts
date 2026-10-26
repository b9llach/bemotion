import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { log } from './log';

/**
 * Stock photos from Unsplash (UNSPLASH_ACCESS_KEY) or Pexels (PEXELS_API_KEY): searched, downloaded
 * into a folder next to the spec, credited. An image `src` of "stock:<query>" resolves through the
 * sidecar `media/stock/stock.json`, which maps each query to its file, so the spec keeps the query
 * and renders use the same picture every time (and offline, once fetched).
 */

export type Orientation = 'landscape' | 'portrait' | 'square';
type Fetch = typeof fetch;

export interface StockPhoto {
  provider: 'unsplash' | 'pexels';
  id: string;
  /** The image to download. */
  url: string;
  /** The photo's page on the provider's site. */
  page: string;
  photographer: string;
  photographerUrl: string;
  width: number;
  height: number;
  alt: string;
  /** Unsplash: the endpoint to call when the photo is downloaded (their API guidelines ask for it). */
  downloadLocation?: string;
}

export interface Credit {
  file: string;
  provider: 'unsplash' | 'pexels';
  query: string;
  photographer: string;
  photographerUrl: string;
  source: string;
}

interface Sidecar {
  queries: Record<string, string>;
  credits: Record<string, Credit>;
}

export const STOCK_DIR = 'media/stock';
/** Largest image accepted from a provider. */
export const MAX_IMAGE_BYTES = 25_000_000;
const TYPES: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const UTM = 'utm_source=bemotion&utm_medium=referral';

export const NO_KEY =
  'Stock photos need an API key: set UNSPLASH_ACCESS_KEY (https://unsplash.com/developers) or PEXELS_API_KEY (https://www.pexels.com/api/).';

/** The provider whose key is set (Unsplash first), or null. */
export function stockProvider(env: NodeJS.ProcessEnv = process.env): { name: 'unsplash' | 'pexels'; key: string } | null {
  if (env.UNSPLASH_ACCESS_KEY?.trim()) return { name: 'unsplash', key: env.UNSPLASH_ACCESS_KEY.trim() };
  if (env.PEXELS_API_KEY?.trim()) return { name: 'pexels', key: env.PEXELS_API_KEY.trim() };
  return null;
}

/** The query of a "stock:<query>" source, normalized (lowercase, single spaces), or null. */
export function stockQuery(src: unknown): string | null {
  if (typeof src !== 'string' || !src.startsWith('stock:')) return null;
  const q = src.slice(6).trim().toLowerCase().replace(/\s+/g, ' ');
  return q || null;
}

const withUtm = (url: string) => (url ? `${url}${url.includes('?') ? '&' : '?'}${UTM}` : url);

/** Searches the provider whose key is set. Throws a clear message when no key is set. */
export async function searchStock(query: string, o: { count?: number; orientation?: Orientation; fetch?: Fetch; env?: NodeJS.ProcessEnv } = {}): Promise<StockPhoto[]> {
  const p = stockProvider(o.env);
  if (!p) throw new Error(NO_KEY);
  const f = o.fetch ?? fetch;
  const count = Math.max(1, Math.min(30, o.count ?? 6));
  if (p.name === 'unsplash') {
    const u = new URL('https://api.unsplash.com/search/photos');
    u.searchParams.set('query', query);
    u.searchParams.set('per_page', String(count));
    u.searchParams.set('content_filter', 'high');
    if (o.orientation) u.searchParams.set('orientation', o.orientation === 'square' ? 'squarish' : o.orientation);
    const res = await f(u.toString(), { headers: { Authorization: `Client-ID ${p.key}`, 'Accept-Version': 'v1' } });
    if (!res.ok) throw new Error(`Unsplash search failed (${res.status})`);
    const body = (await res.json()) as { results?: any[] };
    return (body.results ?? []).map((r) => ({
      provider: 'unsplash' as const,
      id: String(r.id),
      // A large JPEG rather than the original (which can be 50 MB).
      url: r.urls?.raw ? `${r.urls.raw}${String(r.urls.raw).includes('?') ? '&' : '?'}w=2400&q=85&fm=jpg&fit=max` : r.urls?.full,
      page: withUtm(r.links?.html ?? ''),
      photographer: r.user?.name ?? 'Unknown',
      photographerUrl: withUtm(r.user?.links?.html ?? ''),
      width: r.width ?? 0,
      height: r.height ?? 0,
      alt: r.alt_description ?? r.description ?? '',
      downloadLocation: r.links?.download_location,
    }));
  }
  const u = new URL('https://api.pexels.com/v1/search');
  u.searchParams.set('query', query);
  u.searchParams.set('per_page', String(count));
  if (o.orientation) u.searchParams.set('orientation', o.orientation);
  const res = await f(u.toString(), { headers: { Authorization: p.key } });
  if (!res.ok) throw new Error(`Pexels search failed (${res.status})`);
  const body = (await res.json()) as { photos?: any[] };
  return (body.photos ?? []).map((r) => ({
    provider: 'pexels' as const,
    id: String(r.id),
    url: r.src?.original ? `${r.src.original}?auto=compress&cs=tinysrgb&w=2400` : r.src?.large2x,
    page: r.url ?? '',
    photographer: r.photographer ?? 'Unknown',
    photographerUrl: r.photographer_url ?? '',
    width: r.width ?? 0,
    height: r.height ?? 0,
    alt: r.alt ?? '',
  }));
}

/** `dir` resolved for writing: created, and (when `base` is given) really inside it, links followed. */
async function prepareDir(dir: string, base?: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const real = await realpath(dir);
  if (base) {
    const realBase = await realpath(base);
    const rel = relative(realBase, real);
    if (real !== realBase && (rel.startsWith('..') || isAbsolute(rel))) throw new Error(`Stock photos are written only inside the spec's folder: "${dir}"`);
  }
  return real;
}

/** Writes a file that is not a link (a link would be followed by the write). */
async function writeSafe(file: string, data: Buffer | string): Promise<void> {
  const st = await lstat(file).catch(() => null);
  if (st && !st.isFile()) throw new Error(`Not writing through a link or folder: "${file}"`);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data, { flag: 'wx' });
  await rename(tmp, file);
}

/** Reads a response body, refusing more than `max` bytes. */
async function readLimited(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) throw new Error(`Image too large (${declared} bytes, ${max} max)`);
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`Image too large (over ${max} bytes)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'photo';

/**
 * Downloads one photo into `dir` (inside `base` when given) as an image file, checking its type and
 * size, and tells Unsplash about the download. Returns the file name.
 */
export async function downloadStock(photo: StockPhoto, dir: string, o: { query: string; base?: string; fetch?: Fetch; env?: NodeJS.ProcessEnv; maxBytes?: number }): Promise<string> {
  const f = o.fetch ?? fetch;
  const host = new URL(photo.url).hostname;
  if (new URL(photo.url).protocol !== 'https:') throw new Error(`Refusing a non-https image URL from ${photo.provider}`);
  const res = await f(photo.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not download the photo from ${host} (${res.status})`);
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const ext = TYPES[type];
  if (!ext) throw new Error(`Not an image: ${host} sent "${type || 'no content type'}"`);
  const data = await readLimited(res, o.maxBytes ?? MAX_IMAGE_BYTES);
  const real = await prepareDir(dir, o.base);
  const name = `${slug(o.query)}-${photo.provider}-${slug(photo.id)}${ext}`;
  await writeSafe(join(real, name), data);
  if (photo.provider === 'unsplash' && photo.downloadLocation) {
    // Unsplash's API guidelines: count the download by calling its download endpoint.
    const p = stockProvider(o.env);
    try {
      await f(photo.downloadLocation, { headers: p?.name === 'unsplash' ? { Authorization: `Client-ID ${p.key}`, 'Accept-Version': 'v1' } : {} });
    } catch {
      log.warn('Could not report the download to Unsplash');
    }
  }
  return name;
}

async function readSidecar(dir: string): Promise<Sidecar> {
  try {
    const s = JSON.parse(await readFile(join(dir, 'stock.json'), 'utf8')) as Partial<Sidecar>;
    return { queries: s.queries ?? {}, credits: s.credits ?? {} };
  } catch {
    return { queries: {}, credits: {} };
  }
}

/** Saves the sidecar and a readable CREDITS.md next to the photos. */
async function writeSidecar(dir: string, s: Sidecar): Promise<void> {
  await writeSafe(join(dir, 'stock.json'), JSON.stringify(s, null, 2) + '\n');
  const lines = ['# Photo credits', '', 'Stock photos used in this project. Credit the photographers where the video is published.', ''];
  for (const c of Object.values(s.credits).sort((a, b) => a.file.localeCompare(b.file))) {
    const site = c.provider === 'unsplash' ? 'Unsplash' : 'Pexels';
    lines.push(`- ${c.file}: Photo by [${c.photographer}](${c.photographerUrl}) on [${site}](${c.source}) (search: "${c.query}")`);
  }
  await writeSafe(join(dir, 'CREDITS.md'), lines.join('\n') + '\n');
}

function creditOf(p: StockPhoto, file: string, query: string): Credit {
  return { file, provider: p.provider, query, photographer: p.photographer, photographerUrl: p.photographerUrl, source: p.page };
}

/** `bemotion stock`: downloads the top results into `dir` and credits them. Returns the files. */
export async function stockCommand(query: string, o: { count?: number; orientation?: Orientation; dir: string; fetch?: Fetch; env?: NodeJS.ProcessEnv }): Promise<{ files: string[]; dir: string }> {
  const photos = await searchStock(query, o);
  if (!photos.length) throw new Error(`No photos found for "${query}"`);
  const dir = await prepareDir(resolve(o.dir));
  const side = await readSidecar(dir);
  const files: string[] = [];
  const q = stockQuery(`stock:${query}`)!;
  for (const p of photos) {
    try {
      const file = await downloadStock(p, dir, { ...o, query: q });
      side.credits[file] = creditOf(p, file, q);
      files.push(file);
      log.info(`${file}  by ${p.photographer}`);
    } catch (e) {
      log.warn(`Skipped a photo: ${(e as Error).message}`);
    }
  }
  // The first photo also answers "stock:<query>" in a spec next to this folder.
  if (files[0] && !side.queries[q]) side.queries[q] = files[0];
  await writeSidecar(dir, side);
  return { files, dir };
}

/** Every "stock:" query in a spec (any `src`, nested anywhere). */
export function stockQueries(spec: unknown): string[] {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'src') {
          const q = stockQuery(x);
          if (q) out.add(q);
        } else visit(x);
      }
    }
  };
  visit(spec);
  return [...out];
}

/**
 * The local file for a "stock:" query next to the spec, fetched on first use. Returns its absolute
 * path. The file must be inside the spec's folder and not a link.
 */
const pending = new Map<string, Promise<string>>();

export function resolveStock(specPath: string, query: string, o: { fetch?: Fetch; env?: NodeJS.ProcessEnv; orientation?: Orientation } = {}): Promise<string> {
  // The preview asks for the spec and the image at about the same time: one download per query.
  const key = `${resolve(specPath)}
${query}`;
  let p = pending.get(key);
  if (!p) {
    p = resolveStockOnce(specPath, query, o).finally(() => pending.delete(key));
    pending.set(key, p);
  }
  return p;
}

async function resolveStockOnce(specPath: string, query: string, o: { fetch?: Fetch; env?: NodeJS.ProcessEnv; orientation?: Orientation }): Promise<string> {
  const base = dirname(resolve(specPath));
  const dir = join(base, STOCK_DIR);
  const side = await readSidecar(dir);
  const known = side.queries[query];
  if (known && !/[\\/]/.test(known)) {
    const file = join(dir, known);
    const st = await lstat(file).catch(() => null);
    if (st?.isFile()) {
      const realBase = await realpath(base);
      const rel = relative(realBase, await realpath(file));
      if (!rel.startsWith('..') && !isAbsolute(rel)) return file;
    }
  }
  if (!stockProvider(o.env)) throw new Error(`"stock:${query}": ${NO_KEY}`);
  log.step(`Finding a stock photo for "${query}"`);
  const photos = await searchStock(query, { count: 5, orientation: o.orientation ?? 'landscape', fetch: o.fetch, env: o.env });
  if (!photos.length) throw new Error(`"stock:${query}": no photos found`);
  let lastError: Error | undefined;
  for (const p of photos) {
    try {
      const file = await downloadStock(p, dir, { query, base, fetch: o.fetch, env: o.env });
      const fresh = await readSidecar(dir);
      fresh.queries[query] = file;
      fresh.credits[file] = creditOf(p, file, query);
      await writeSidecar(await prepareDir(dir, base), fresh);
      log.info(`${STOCK_DIR}/${file}: photo by ${p.photographer} (${p.provider}); credits in ${STOCK_DIR}/CREDITS.md`);
      return join(dir, file);
    } catch (e) {
      lastError = e as Error;
    }
  }
  throw new Error(`"stock:${query}": ${lastError?.message ?? 'no photo could be downloaded'}`);
}

/** Fetches every "stock:" image of a spec that is not local yet (like ensureVoices for voices). */
export async function ensureStock(specPath: string, spec: unknown, o: { fetch?: Fetch; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  for (const q of stockQueries(spec)) await resolveStock(specPath, q, o);
}
