import { writeFile } from 'node:fs/promises';
import { mixSfx, SR, type Cue, type SfxOptions } from '../audio/sfx';

export type { Cue } from '../audio/sfx';

/** Renders cues to a stereo 16-bit WAV. */
export async function renderSfx(cues: Cue[], duration: number, file: string, volume = 0.7, opts: SfxOptions = {}): Promise<number> {
  const { audio: master, used } = mixSfx(cues, duration, volume, opts);
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
