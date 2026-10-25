import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mixSfx, SR, type Cue, type SampleBank, type SfxOptions } from '../audio/sfx';
import manifest from '../audio/samples.json';
import { ffmpegPath } from './ffmpeg';

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
  const n = Math.ceil(duration * SR);
  const data = Buffer.alloc(44 + n * 4);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + n * 4, 4);
  data.write('WAVE', 8);
  data.write('fmt ', 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(SR, 24);
  data.writeUInt32LE(SR * 4, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const l = Math.tanh(master.l[i] * 1.1) * 0.9;
    const r = Math.tanh(master.r[i] * 1.1) * 0.9;
    data.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
    data.writeInt16LE(Math.round(r * 32767), 46 + i * 4);
  }
  await writeFile(file, data);
  return used;
}
