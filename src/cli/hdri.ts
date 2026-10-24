import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PKG_ROOT } from './server';

/**
 * HDRI environments from Poly Haven (CC0). `hdri:<id>` in a spec resolves to a bundled file in
 * assets/hdri, or downloads once into ~/.bemotion/hdri.
 */
const BUNDLED = join(PKG_ROOT, 'assets', 'hdri');
const CACHE = join(homedir(), '.bemotion', 'hdri');
const API = 'https://api.polyhaven.com';

export type HdriRes = '1k' | '2k' | '4k';

const inflight = new Map<string, Promise<string>>();

export async function resolveHdri(id: string, res: HdriRes = '1k'): Promise<string> {
  if (!/^[a-z0-9_]+$/.test(id)) throw new Error(`Invalid HDRI id "${id}"`);
  const name = `${id}_${res}.hdr`;
  for (const dir of [BUNDLED, CACHE]) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  const key = name;
  let p = inflight.get(key);
  if (!p) {
    p = download(id, res).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

async function download(id: string, res: HdriRes): Promise<string> {
  const meta = await fetch(`${API}/files/${id}`);
  if (!meta.ok) throw new Error(`Poly Haven has no HDRI "${id}" (${meta.status}). Try \`bemotion hdri list\`.`);
  const files = (await meta.json()) as { hdri?: Record<string, { hdr?: { url: string } }> };
  const url = files.hdri?.[res]?.hdr?.url;
  if (!url) throw new Error(`HDRI "${id}" has no ${res} .hdr file`);
  await mkdir(CACHE, { recursive: true });
  const out = join(CACHE, `${id}_${res}.hdr`);
  const tmp = `${out}.part`;
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`Download failed for ${url} (${r.status})`);
  await pipeline(Readable.fromWeb(r.body as never), createWriteStream(tmp));
  await rename(tmp, out);
  return out;
}

export async function listHdris(category = 'studio'): Promise<{ id: string; name: string; downloads: number }[]> {
  const r = await fetch(`${API}/assets?type=hdris&categories=${encodeURIComponent(category)}`);
  if (!r.ok) throw new Error(`Poly Haven request failed (${r.status})`);
  const d = (await r.json()) as Record<string, { name: string; download_count: number }>;
  return Object.entries(d)
    .map(([id, v]) => ({ id, name: v.name, downloads: v.download_count }))
    .sort((a, b) => b.downloads - a.downloads);
}
