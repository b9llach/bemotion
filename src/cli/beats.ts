import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpegPath } from './ffmpeg';

/**
 * Beat tracking for music sync. The track is decoded to mono, an onset envelope is built from
 * spectral flux, the tempo is the strongest autocorrelation lag (weighted toward ~120 BPM), and beats
 * are placed by dynamic programming (each beat rewards onset strength and penalizes drifting from the
 * tempo). Bars group beats in fours, starting on the phase whose beats are strongest.
 *
 * Times are seconds into the file. Results are cached in .bemotion-cache/audio.
 */
export interface BeatInfo {
  bpm: number;
  beats: number[];
  /** First beat of each bar (every fourth beat). */
  bars: number[];
}

const SR = 11025;
const HOP = 128;
const FFT = 1024;

function decode(file: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-nostdin', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg could not read the track: ${err.trim().slice(-300)}`));
      const b = Buffer.concat(out);
      resolve(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)));
    });
  });
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    const wr = Math.cos(a);
    const wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Onset strength per hop: positive change in log spectrum, with the local average removed. */
function onsets(x: Float32Array): Float64Array {
  const frames = Math.max(0, Math.floor((x.length - FFT) / HOP));
  const env = new Float64Array(frames);
  const win = new Float64Array(FFT).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT));
  let prev = new Float64Array(FFT / 2);
  const re = new Float64Array(FFT);
  const im = new Float64Array(FFT);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < FFT; i++) {
      re[i] = x[f * HOP + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float64Array(FFT / 2);
    let flux = 0;
    for (let k = 1; k < FFT / 2; k++) {
      mag[k] = Math.log(1 + 100 * Math.hypot(re[k], im[k]));
      const d = mag[k] - prev[k];
      // Kick and bass carry the beat: low bins (under ~250 Hz) count four times.
      if (d > 0) flux += k * SR < 250 * FFT ? 4 * d : d;
    }
    env[f] = flux;
    prev = mag;
  }
  // Remove the slowly varying level so only onsets stand out.
  const out = new Float64Array(frames);
  const half = Math.round((0.5 * SR) / HOP);
  let sum = 0;
  let lo = 0;
  let hi = -1;
  for (let f = 0; f < frames; f++) {
    while (hi < Math.min(frames - 1, f + half)) sum += env[++hi];
    while (lo < f - half) sum -= env[lo++];
    out[f] = Math.max(0, env[f] - sum / (hi - lo + 1));
  }
  let sd = 0;
  for (const v of out) sd += v * v;
  sd = Math.sqrt(sd / Math.max(1, frames)) || 1;
  for (let f = 0; f < frames; f++) out[f] /= sd;
  return out;
}

/** Beats from an onset envelope sampled at `rate` per second. Pure, for tests. */
export function trackBeats(env: Float64Array, rate: number): BeatInfo {
  const n = env.length;
  if (n < rate * 2) return { bpm: 0, beats: [], bars: [] };
  // Tempo: autocorrelation over 60-200 BPM, weighted toward 120.
  let bestLag = 0;
  let bestScore = -Infinity;
  const minLag = Math.round((rate * 60) / 200);
  const maxLag = Math.round((rate * 60) / 60);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
    s /= n - lag;
    const bpm = (60 * rate) / lag;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    if (s * w > bestScore) {
      bestScore = s * w;
      bestLag = lag;
    }
  }
  const P = bestLag;
  // Dynamic programming: score(t) = onset(t) + best earlier beat, penalized for leaving the tempo.
  const score = new Float64Array(n);
  const from = new Int32Array(n).fill(-1);
  const alpha = 100;
  for (let t = 0; t < n; t++) {
    let best = 0;
    let arg = -1;
    for (let p = t - Math.round(2 * P); p <= t - Math.round(P / 2); p++) {
      if (p < 0) continue;
      const v = score[p] - alpha * Math.pow(Math.log((t - p) / P), 2);
      if (v > best) {
        best = v;
        arg = p;
      }
    }
    score[t] = env[t] + best;
    from[t] = arg;
  }
  // Backtrack from the best-scoring frame near the end.
  let end = n - 1;
  for (let t = Math.max(0, n - P); t < n; t++) if (score[t] > score[end]) end = t;
  const idx: number[] = [];
  for (let t = end; t >= 0; t = from[t]) idx.push(t);
  idx.reverse();
  // An onset peaks in the flux about 0.85 of a window after the frame starts (measured on clicks).
  const latency = (FFT / SR) * 0.85;
  const beats = idx.map((t) => Math.round((t / rate + latency) * 1000) / 1000);
  // Bars: the phase (0-3) whose beats carry the most onset energy.
  let phase = 0;
  let strongest = -1;
  for (let ph = 0; ph < 4; ph++) {
    let s = 0;
    for (let i = ph; i < idx.length; i += 4) s += env[idx[i]];
    if (s > strongest) {
      strongest = s;
      phase = ph;
    }
  }
  const bars = beats.filter((_, i) => i % 4 === phase);
  const bpm = beats.length > 1 ? (60 * (beats.length - 1)) / (beats[beats.length - 1] - beats[0]) : 0;
  return { bpm: Math.round(bpm * 10) / 10, beats, bars };
}

export async function analyzeBeats(file: string): Promise<BeatInfo> {
  return trackBeats(onsets(await decode(file)), SR / HOP);
}

const building = new Map<string, Promise<BeatInfo>>();

export async function trackBeatsCached(file: string, specDir: string): Promise<BeatInfo> {
  const st = await stat(file);
  const key = createHash('sha1').update(`beats1|${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20);
  const dir = join(specDir, '.bemotion-cache', 'audio');
  const out = join(dir, `${key}.beats.json`);
  try {
    return JSON.parse(await readFile(out, 'utf8')) as BeatInfo;
  } catch {
    // not analyzed yet
  }
  let p = building.get(out);
  if (!p) {
    p = (async () => {
      const info = await analyzeBeats(file);
      await mkdir(dir, { recursive: true });
      await writeFile(out, JSON.stringify(info));
      return info;
    })().finally(() => building.delete(out));
    building.set(out, p);
  }
  return p;
}
