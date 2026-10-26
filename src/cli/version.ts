import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PKG_ROOT } from './server';

export interface BuildInfo {
  /** package.json version. */
  version: string;
  /** Git commit of the install (with "-dirty" when it has local changes), or "unknown". */
  commit: string;
}

let cached: Promise<BuildInfo> | null = null;

function git(args: string[]): Promise<string | null> {
  return new Promise((res) => {
    execFile('git', args, { cwd: PKG_ROOT, windowsHide: true, timeout: 5000 }, (err, out) => res(err ? null : String(out).trim()));
  });
}

/** This install's version and commit, for comparing a render worker with its coordinator. */
export function buildInfo(): Promise<BuildInfo> {
  cached ??= (async () => {
    let version = 'unknown';
    try {
      version = String(JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8')).version ?? 'unknown');
    } catch {}
    const head = await git(['rev-parse', 'HEAD']);
    // Only tracked files count: render output and caches in the checkout are not changes to the engine.
    const dirty = head ? await git(['status', '--porcelain', '--untracked-files=no']) : null;
    return { version, commit: head ? `${head.slice(0, 12)}${dirty ? '-dirty' : ''}` : 'unknown' };
  })();
  return cached;
}
