import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { ffmpegPath } from './ffmpeg';
import { log } from './log';
import { alignTranscript, looksEnglish, modelFor, transcribeCached, transcriptWords, whisperAvailable } from './transcribe';

/**
 * When each word of a voiceover is spoken.
 *
 * With Whisper installed (src/cli/transcribe.ts) the speech is recognized word by word: a track
 * without a script uses the transcript as its words, and a script is aligned to the recognized words.
 *
 * Without it (or when the recognized words do not match the script), the script is aligned from the
 * audio alone: speech is found by loudness against the recording's own noise floor and split at
 * pauses; the script's words are then shared out over those stretches of speech by dynamic
 * programming, which matches each stretch's length to its words' estimated syllables and prefers to
 * break at punctuation. Inside a stretch, words get time in proportion to their syllables.
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

/**
 * Recognized word times tend to start early after a pause (the silence is given to the next word).
 * A word that starts in silence is moved to where speech resumes, and one that ends in silence is
 * cut where speech stopped, as long as it keeps some of its length.
 */
export function snapToSpeech(words: SpokenWord[], segs: [number, number][]): SpokenWord[] {
  if (!segs.length) return words;
  const inside = (t: number) => segs.some(([a, b]) => t >= a && t <= b);
  return words.map((w) => {
    let { start, end } = w;
    if (!inside(start)) {
      const next = segs.find(([a]) => a > start && a < end - 0.04);
      if (next) start = next[0];
    }
    if (!inside(end)) {
      const prev = [...segs].reverse().find(([, b]) => b < end && b > start + 0.04);
      if (prev) end = prev[1];
    }
    return start === w.start && end === w.end ? w : { text: w.text, start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 };
  });
}

export interface AlignOptions {
  /** Where transcripts are cached (default: .bemotion-cache/audio next to the audio file). */
  cacheDir?: string;
  /** Whisper model (default small, see transcribe.ts). */
  model?: string;
  /** `loudness` skips speech recognition. */
  method?: 'auto' | 'loudness';
}

/** Below this share of script words found in the transcript, the loudness method is used instead. */
const MIN_MATCH = 0.5;

/**
 * Word times for a voiceover. With a script: aligned to recognized speech when Whisper is available,
 * otherwise by loudness. Without a script: the transcript (Whisper required).
 */
export async function alignVoice(file: string, script?: string, o: AlignOptions = {}): Promise<SpokenWord[]> {
  const text = script?.trim() ? script : '';
  if (o.method !== 'loudness') {
    if (await whisperAvailable()) {
      const cacheDir = o.cacheDir ?? join(dirname(file), '.bemotion-cache', 'audio');
      const language = text && looksEnglish(text) ? 'en' : null;
      try {
        const t = await transcribeCached(file, cacheDir, { model: o.model, language });
        if (!text) return snapToSpeech(transcriptWords(t.words), speechSegments(await decode(file)));
        const a = alignTranscript(text, t.words);
        if (a.matched >= MIN_MATCH) return snapToSpeech(a.words, speechSegments(await decode(file)));
        log.info(`Speech recognition found ${Math.round(a.matched * 100)}% of the script in ${file}; aligning by loudness instead`);
      } catch (e) {
        if (!text) throw e;
        log.info(`Speech recognition failed (${(e as Error).message}); aligning by loudness instead`);
      }
    } else if (text) {
      log.info('Speech recognition (Whisper) is not available: aligning the voiceover by loudness (install it for word-exact timing, see README)');
    }
  }
  if (!text) throw new Error('A voice track without a script needs speech recognition: install Whisper (see README, Speech recognition) or give the track its script');
  return alignScript(text, speechSegments(await decode(file)));
}

const building = new Map<string, Promise<SpokenWord[]>>();

export async function alignVoiceCached(file: string, script: string | undefined, specDir: string, o: AlignOptions = {}): Promise<SpokenWord[]> {
  const st = await stat(file);
  const engine = o.method === 'loudness' ? null : await whisperAvailable();
  const how = engine ? `whisper:${modelFor(o.model, script && looksEnglish(script) ? 'en' : null)}` : 'loudness';
  const key = createHash('sha1').update(`voice3|${how}|${file}|${st.size}|${st.mtimeMs}|${script ?? ''}`).digest('hex').slice(0, 20);
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
      const words = await alignVoice(file, script, { ...o, cacheDir: dir });
      await mkdir(dir, { recursive: true });
      await writeFile(out, JSON.stringify(words));
      return words;
    })().finally(() => building.delete(out));
    building.set(out, p);
  }
  return p;
}

/**
 * Before a spec plays or renders: aligns (or transcribes) the voice track the engine will ask for, so
 * a first transcription, which can take a while (a model download the first time), happens here with
 * a log line instead of inside a page load. Failures are left for the engine to report.
 */
export async function prepareVoiceWords(specPath: string, spec: unknown): Promise<void> {
  const v = spec as { audio?: { src?: string; role?: string; script?: string; align?: boolean }[]; captions?: unknown };
  const voice = Array.isArray(v?.audio) ? v.audio.find((a) => a?.role === 'voice' && (a.script || a.align || v.captions)) : undefined;
  if (!voice?.src || /^[a-z]+:/i.test(voice.src)) return;
  if (!voice.script && !(await whisperAvailable())) return;
  const dir = dirname(resolve(specPath));
  const file = resolve(dir, voice.src);
  if (!file.startsWith(dir + sep)) return;
  try {
    const st = await stat(file);
    if (!st.isFile()) return;
    await alignVoiceCached(file, voice.script, dir);
  } catch {
    // reported by the engine when it asks for the words
  }
}
