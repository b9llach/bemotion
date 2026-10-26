import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import type { Video } from '../spec/schema';
import { log } from './log';

/**
 * A render job for another machine: the spec plus every file it references, each named by its path
 * relative to the spec and identified by its SHA-256, so a worker that already has a file is not sent
 * it again.
 */

/** Where bundled HDRI environments ("hdri:<id>") go inside a job; the worker serves them from there. */
export const HDRI_DIR = '.bemotion-hdri';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * A bundle path that is safe to create under a job folder on any OS, or null: relative, forward
 * slashes, no "." or ".." segments, no drive letters, streams or device names, no control characters.
 */
export function safeRelPath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0 || p.length > 400) return null;
  if (/[\u0000-\u001f\\:*?"<>|]/.test(p)) return null;
  if (p.startsWith('/')) return null;
  const parts = p.split('/');
  if (parts.length > 12) return null;
  for (const s of parts) {
    if (!s || s === '.' || s === '..' || s.length > 120) return null;
    if (/[. ]$/.test(s) || WINDOWS_RESERVED.test(s)) return null;
  }
  return parts.join('/');
}

export function sha256File(file: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', rej)
      .on('end', () => res(h.digest('hex')));
  });
}

export interface BundleFile {
  /** Path relative to the spec, as the spec refers to it. */
  path: string;
  /** The file on this machine. */
  file: string;
  sha256: string;
  size: number;
}

const URLISH = /^[a-z][a-z0-9+.-]*:/i;

/** Every string in a JSON value. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}

/** Files a Lottie animation or a glTF model loads next to itself. */
function innerRefs(json: any): string[] {
  const out: string[] = [];
  if (Array.isArray(json?.assets)) {
    for (const a of json.assets) {
      if (a && typeof a.p === 'string' && a.e !== 1 && !a.p.startsWith('data:')) out.push(`${typeof a.u === 'string' ? a.u : ''}${a.p}`);
    }
  }
  for (const key of ['buffers', 'images']) {
    if (Array.isArray(json?.[key])) for (const b of json[key]) if (b && typeof b.uri === 'string' && !b.uri.startsWith('data:')) out.push(b.uri);
  }
  return out;
}

/**
 * The files a spec uses, found the way the render server would serve them: every string in the spec
 * that names a file inside the spec's folder (after realpath, so links out of it are left behind), plus
 * what Lottie and glTF files load beside themselves, plus Poly Haven environments from this machine's
 * cache. Audio is included because beat sync and voice alignment run where the frames are rendered.
 */
export async function collectBundle(specPath: string, video: Video): Promise<BundleFile[]> {
  const dir = resolve(dirname(specPath));
  const realDir = await realpath(dir);
  const found = new Map<string, string>();
  const consider = async (ref: string, base: string) => {
    if (!ref || ref.length > 1024 || URLISH.test(ref) || ref.startsWith('/') || ref.startsWith('#') || /[\n\r]/.test(ref)) return;
    let clean = ref.replace(/^\.\//, '');
    try {
      clean = decodeURIComponent(clean.split(/[?#]/)[0]);
    } catch {}
    const abs = resolve(base, clean);
    if (!abs.startsWith(dir + sep)) return;
    const rel = relative(dir, abs).split(sep).join('/');
    if (found.has(rel)) return;
    try {
      const st = await lstat(abs);
      if (!st.isFile() && !st.isSymbolicLink()) return;
      const real = await realpath(abs);
      if (!real.startsWith(realDir + sep) || !(await lstat(real)).isFile()) return;
      if (!safeRelPath(rel)) {
        log.warn(`Not sending "${rel}" to remote workers: its name cannot be recreated safely there`);
        return;
      }
      found.set(rel, real);
      const ext = extname(abs).toLowerCase();
      if ((ext === '.json' || ext === '.gltf') && st.size < 50_000_000) {
        try {
          const inner = innerRefs(JSON.parse(await readFile(real, 'utf8')));
          for (const r of inner) await consider(r, dirname(abs));
        } catch {}
      }
    } catch {}
  };
  for (const s of strings(video)) await consider(s, dir);

  const out: BundleFile[] = [];
  for (const [path, file] of found) {
    const st = await lstat(file);
    out.push({ path, file, sha256: await sha256File(file), size: st.size });
  }
  // HDRI environments resolve on this machine (bundled or downloaded once); workers never download.
  const env = video.environment;
  const src = typeof env === 'string' ? env : env && typeof env === 'object' ? env.src : undefined;
  if (typeof src === 'string' && src.startsWith('hdri:')) {
    const res = (typeof env === 'object' && env.res) || '1k';
    const { resolveHdri } = await import('./hdri');
    const file = await resolveHdri(src.slice(5), res);
    const st = await lstat(file);
    out.push({ path: `${HDRI_DIR}/${src.slice(5)}_${res}.hdr`, file, sha256: await sha256File(file), size: st.size });
  }
  return out;
}
