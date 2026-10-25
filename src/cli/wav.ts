import { writeFile } from 'node:fs/promises';
import { SR, type Stereo } from '../audio/sfx';

/** Writes stereo audio at SR as a 16-bit WAV, `seconds` long (padded or cut). `shape` maps each sample first. */
export async function writeWav(file: string, audio: Stereo, seconds: number, shape: (x: number) => number = (x) => x): Promise<void> {
  const n = Math.ceil(seconds * SR);
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
  const clamp = (x: number) => Math.round(Math.max(-1, Math.min(1, x)) * 32767);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(clamp(shape(audio.l[i] ?? 0)), 44 + i * 4);
    data.writeInt16LE(clamp(shape(audio.r[i] ?? 0)), 46 + i * 4);
  }
  await writeFile(file, data);
}
