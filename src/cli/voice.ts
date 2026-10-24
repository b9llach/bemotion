import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpegPath } from './ffmpeg';

/**
 * When each word of a voiceover is spoken, from the audio and its script (no speech model needed).
 * Speech is found by loudness against the recording's own noise floor and split at pauses; the
 * script's words are then shared out over those stretches of speech by dynamic programming, which
 * matches each stretch's length to its words' estimated syllables and prefers to break at punctuation.
 * Inside a stretch, words get time in proportion to their syllables.
 *
 * Times are seconds into the file. Results are cached in .bemotion-cache/audio.
 */
export interface SpokenWord {
  text: string;
  start: number;
  end: number;
}

const SR = 16000;
/** Analysis frame, seconds. */
const FRAME = 0.01;

function decode(file: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-nostdin', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg could not read the voiceover: ${err.trim().slice(-300)}`));
      const b = Buffer.concat(out);
      resolve(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)));
    });
  });
}

/** Stretches of speech [start, end] in seconds, split where the voice pauses for at least `minPause`. */
export function speechSegments(x: Float32Array, rate = SR, minPause = 0.16): [number, number][] {
  const hop = Math.round(rate * FRAME);
  const n = Math.floor(x.length / hop);
  const db = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = 0; i < hop; i++) s += x[f * hop + i] ** 2;
    db[f] = 10 * Math.log10(s / hop + 1e-12);
  }
  const sorted = [...db].sort((a, b) => a - b);
  const floor = sorted[Math.floor(n * 0.1)] ?? -120;
  const loud = sorted[Math.floor(n * 0.95)] ?? 0;
  const threshold = floor + Math.max(10, (loud - floor) * 0.3);
  const on = Array.from(db, (v) => v > threshold);
  // Bridge gaps shorter than a pause, then drop blips shorter than 60 ms.
  const gap = Math.round(minPause / FRAME);
  const segs: [number, number][] = [];
  let f = 0;
  while (f < n) {
    if (!on[f]) {
      f++;
      continue;
    }
    let end = f;
    let g = f;
    while (g < n) {
      if (on[g]) end = g;
      else if (g - end > gap) break;
      g++;
    }
    if (end - f >= 6) segs.push([f * FRAME, (end + 1) * FRAME]);
    f = g;
  }
  return segs;
}

/** Rough syllable count: vowel groups, digits read out, at least one. */
function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z0-9']/g, '');
  if (/^\d+$/.test(w)) return Math.max(1, w.length * 1.6);
  const groups = w.replace(/e$/, '').match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

interface ScriptWord {
  text: string;
  syl: number;
  /** Strength of the break after this word: 2 sentence end, 1 comma or dash, 0 none. */
  brk: number;
}

function scriptWords(script: string): ScriptWord[] {
  return script
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ({ text: t, syl: syllables(t), brk: /[.!?]["')\]]*$/.test(t) ? 2 : /[,;:—-]["')\]]*$/.test(t) ? 1 : 0 }));
}

/** Shares the script's words out over the speech segments. Pure, for tests. */
export function alignScript(script: string, segments: [number, number][]): SpokenWord[] {
  const words = scriptWords(script);
  let segs = segments.slice();
  if (!words.length || !segs.length) return [];
  // More segments than words: join across the shortest pauses until they fit.
  while (segs.length > words.length) {
    let k = 0;
    for (let i = 1; i < segs.length - 1; i++) if (segs[i + 1][0] - segs[i][1] < segs[k + 1][0] - segs[k][1]) k = i;
    segs = [...segs.slice(0, k), [segs[k][0], segs[k + 1][1]], ...segs.slice(k + 2)];
  }
  const n = words.length;
  const m = segs.length;
  const totalSyl = words.reduce((a, w) => a + w.syl, 0);
  const totalDur = segs.reduce((a, s) => a + (s[1] - s[0]), 0);
  const perSyl = totalDur / totalSyl;
  const prefix = [0];
  for (const w of words) prefix.push(prefix[prefix.length - 1] + w.syl);
  // cost[j][i]: best cost of putting the first i words into the first j segments.
  const INF = 1e18;
  const cost = Array.from({ length: m + 1 }, () => new Float64Array(n + 1).fill(INF));
  const back = Array.from({ length: m + 1 }, () => new Int32Array(n + 1).fill(-1));
  cost[0][0] = 0;
  for (let j = 1; j <= m; j++) {
    const d = segs[j - 1][1] - segs[j - 1][0];
    for (let i = j; i <= n - (m - j); i++) {
      for (let a = j - 1; a < i; a++) {
        if (cost[j - 1][a] >= INF) continue;
        const syl = prefix[i] - prefix[a];
        const fit = Math.log(d / (syl * perSyl)) ** 2;
        // A pause where the script has no punctuation is less likely.
        const brk = words[i - 1].brk;
        const pause = j < m ? (brk === 2 ? 0 : brk === 1 ? 0.15 : 0.6) : 0;
        const c = cost[j - 1][a] + fit + pause;
        if (c < cost[j][i]) {
          cost[j][i] = c;
          back[j][i] = a;
        }
      }
    }
  }
  const groups: [number, number][] = [];
  for (let j = m, i = n; j > 0; j--) {
    const a = back[j][i];
    groups.push([a, i]);
    i = a;
  }
  groups.reverse();
  const out: SpokenWord[] = [];
  groups.forEach(([a, b], j) => {
    const [s0, s1] = segs[j];
    const syl = prefix[b] - prefix[a];
    let t = s0;
    for (let i = a; i < b; i++) {
      const d = ((s1 - s0) * words[i].syl) / syl;
      out.push({ text: words[i].text, start: Math.round(t * 1000) / 1000, end: Math.round((t + d) * 1000) / 1000 });
      t += d;
    }
  });
  return out;
}

export async function alignVoice(file: string, script: string): Promise<SpokenWord[]> {
  return alignScript(script, speechSegments(await decode(file)));
}

const building = new Map<string, Promise<SpokenWord[]>>();

export async function alignVoiceCached(file: string, script: string, specDir: string): Promise<SpokenWord[]> {
  const st = await stat(file);
  const key = createHash('sha1').update(`voice2|${file}|${st.size}|${st.mtimeMs}|${script}`).digest('hex').slice(0, 20);
  const dir = join(specDir, '.bemotion-cache', 'audio');
  const out = join(dir, `${key}.words.json`);
  try {
    return JSON.parse(await readFile(out, 'utf8')) as SpokenWord[];
  } catch {
    // not aligned yet
  }
  let p = building.get(out);
  if (!p) {
    p = (async () => {
      const words = await alignVoice(file, script);
      await mkdir(dir, { recursive: true });
      await writeFile(out, JSON.stringify(words));
      return words;
    })().finally(() => building.delete(out));
    building.set(out, p);
  }
  return p;
}
