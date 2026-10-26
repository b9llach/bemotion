import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { computeEnvelope, type Envelope } from '../audio/envelope';
import { decode } from './beats';

/**
 * Loudness envelopes of a music track for audio-reactive layers (`react` with `level` or `bass`):
 * decoded to mono with ffmpeg, then RMS and low-band energy 100 times per second (src/audio/envelope.ts).
 * Times are seconds into the file. Results are cached in .bemotion-cache/audio, like beats.
 */
export async function analyzeEnvelope(file: string): Promise<Envelope> {
  return computeEnvelope(await decode(file), 11025);
}

/**
 * A file the preview server may analyze: a regular file inside the spec folder once links are
 * resolved. Returns its real path, or null.
 */
export async function confinedFile(dir: string, file: string): Promise<string | null> {
  const base = await realpath(dir).catch(() => null);
  const real = await realpath(file).catch(() => null);
  if (!base || !real || !real.startsWith(base + sep)) return null;
  const st = await lstat(real).catch(() => null);
  return st?.isFile() ? real : null;
}

const building = new Map<string, Promise<Envelope>>();

export async function envelopeCached(file: string, specDir: string): Promise<Envelope> {
  const st = await stat(file);
  const key = createHash('sha1').update(`env1|${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20);
  const dir = join(specDir, '.bemotion-cache', 'audio');
  const out = join(dir, `${key}.env.json`);
  try {
    return JSON.parse(await readFile(out, 'utf8')) as Envelope;
  } catch {
    // not analyzed yet
  }
  let p = building.get(out);
  if (!p) {
    p = (async () => {
      const env = await analyzeEnvelope(file);
      await mkdir(dir, { recursive: true });
      await writeFile(out, JSON.stringify(env));
      return env;
    })().finally(() => building.delete(out));
    building.set(out, p);
  }
  return p;
}
