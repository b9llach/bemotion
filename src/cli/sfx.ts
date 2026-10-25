import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mixSfx, SR, type Cue, type SampleBank, type SfxOptions } from '../audio/sfx';
import manifest from '../audio/samples.json';
import { ffmpegPath } from './ffmpeg';
import { writeWav } from './wav';

const STUDIO = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/sfx/studio');
let bank: Promise<SampleBank> | null = null;

function decode(file: string): Promise<Float32Array> {
  return new Promise((res, rej) => {
    const p = spawn(ffmpegPath(), ['-loglevel', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.on('close', (code) => {
      if (code !== 0) return rej(new Error(`could not decode ${file}`));
      const b = Buffer.concat(out);
      res(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
    });
  });
}

/** The recorded sounds of the studio kit, decoded once per process. */
export function studioSamples(): Promise<SampleBank> {
  bank ??= (async () => {
    const out: SampleBank = {};
    for (const [kind, files] of Object.entries(manifest as Record<string, string[]>)) {
      out[kind] = await Promise.all(files.map((f) => decode(join(STUDIO, kind, f))));
    }
    return out;
  })();
  return bank;
}

export type { Cue } from '../audio/sfx';

/** Renders cues to a stereo 16-bit WAV. */
export async function renderSfx(cues: Cue[], duration: number, file: string, volume = 0.7, opts: SfxOptions = {}): Promise<number> {
  const samples = (opts.kit ?? 'studio') === 'studio' ? await studioSamples() : undefined;
  const { audio: master, used } = mixSfx(cues, duration, volume, { ...opts, samples });
  // Gentle bus processing: soft clip so stacked cues never distort.
  await writeWav(file, master, duration, (x) => Math.tanh(x * 1.1) * 0.9);
  return used;
}
