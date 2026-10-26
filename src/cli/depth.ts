import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, rename, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { PKG_ROOT } from './server';
import { log } from './log';

/**
 * Depth maps for images with `depth` and no `map`: estimated by a monocular depth model
 * (scripts/depth.py, Depth Anything V2 Small through transformers) and cached in
 * .bemotion-cache/depth next to the spec, keyed by the image's contents and the model.
 */

export const DEPTH_MODEL = 'depth-anything/Depth-Anything-V2-Small-hf';

const HINT = 'Install the estimator (python -m pip install transformers==4.46.3, with torch and Pillow) or give the image a depth map: "depth": { "map": "photo-depth.png" } (white near, black far).';

/** The Python that runs the estimator: BEMOTION_PYTHON, else python (Windows) or python3. */
export function pythonCommand(): string {
  return process.env.BEMOTION_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

/** Runs the estimator on one image, writing a 16-bit PNG. Errors say what is missing and how to avoid the model. */
export function estimateDepth(image: string, out: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const script = join(PKG_ROOT, 'scripts', 'depth.py');
    const p = spawn(pythonCommand(), ['-I', script, image, out, '--model', DEPTH_MODEL], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    p.stdout.on('data', () => {});
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e: NodeJS.ErrnoException) => {
      reject(new Error(e.code === 'ENOENT' ? `Python was not found (${pythonCommand()}), so depth could not be estimated. ${HINT}` : `Could not run the depth estimator: ${e.message}`));
    });
    p.on('close', (code) => {
      if (code === 0) return resolvePromise();
      // The last lines carry the reason; torch and numpy print noise before it.
      const lines = err.trim().split('\n').map((l) => l.trim()).filter(Boolean);
      const reason = lines.filter((l) => /missing Python package|could not load|Error|usage/.test(l)).slice(-2).join(' ') || lines.slice(-2).join(' ');
      reject(new Error(`Depth estimation failed for ${image}: ${reason || `exit code ${code}`}. ${code === 2 ? HINT : 'Or give the image a depth map with depth.map.'}`));
    });
  });
}

const pending = new Map<string, Promise<string>>();

/** The cached depth map for an image, estimated on first use. Returns its path. */
export async function depthMapCached(image: string, specDir: string): Promise<string> {
  const data = await readFile(image);
  const key = createHash('sha1').update(DEPTH_MODEL).update('\0').update(data).digest('hex').slice(0, 20);
  const dir = join(specDir, '.bemotion-cache', 'depth');
  const file = join(dir, `${key}.png`);
  if (await stat(file).then((s) => s.size > 0, () => false)) return file;
  let p = pending.get(file);
  if (!p) {
    p = (async () => {
      await mkdir(dir, { recursive: true });
      const st = await lstat(dir);
      if (st.isSymbolicLink()) throw new Error(`${dir} is a link; depth maps are not written through links`);
      const tmp = `${file}.${process.pid}.tmp.png`;
      log.step(`Estimating depth for ${relative(specDir, image) || image}`);
      await estimateDepth(image, tmp);
      await rename(tmp, file);
      return file;
    })().finally(() => pending.delete(file));
    pending.set(file, p);
  }
  return p;
}

/** Resolves an image path from the spec, refusing anything outside the spec's folder (links included). */
export async function imageInside(specDir: string, src: string): Promise<string> {
  const base = await realpath(specDir);
  const real = await realpath(resolve(base, src)).catch(() => null);
  if (!real) throw new Error(`image "${src}" not found next to the spec`);
  const rel = relative(base, real);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`image "${src}" must be inside the spec's folder`);
  return real;
}

/** Image layers (anywhere in the spec) whose depth must be estimated: `depth` set, no `map`. */
export function depthImages(spec: unknown): string[] {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, any>;
      if (o.type === 'image' && o.depth && typeof o.src === 'string' && !(typeof o.depth === 'object' && o.depth.map)) {
        if (!/^(https?:|data:|blob:)/.test(o.src)) out.add(o.src);
      }
      for (const x of Object.values(o)) if (x && typeof x === 'object') visit(x);
    }
  };
  visit(spec);
  return [...out];
}

/**
 * Estimates the depth maps a spec needs before it plays or renders (like voices are spoken first),
 * so a missing model is one clear error up front instead of a failed frame.
 */
export async function ensureDepthMaps(specPath: string, spec: unknown): Promise<void> {
  const dir = dirname(resolve(specPath));
  for (const src of depthImages(spec)) await depthMapCached(await imageInside(dir, src), dir);
}

/** `bemotion depth <image> [-o out.png]`: writes a depth map next to the image (or to `out`). */
export async function depthCommand(image: string, out?: string): Promise<string> {
  const file = resolve(image);
  const target = resolve(out ?? file.replace(/\.[^./\\]+$/, '') + '-depth.png');
  const cached = await depthMapCached(file, dirname(file));
  await copyFile(cached, target);
  return target;
}
