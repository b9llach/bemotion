import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Speech recognition with word timestamps (Whisper, run by scripts/transcribe.py). Used for voiceovers:
 * a voice track without a `script` is transcribed (the transcript becomes the script and the captions),
 * and a track with a script is aligned to the recognized words (`alignTranscript`), which is far more
 * precise than sharing words out over loudness.
 *
 * Python: BEMOTION_PYTHON, else the virtual environment at ~/.bemotion/whisper-venv, else `python`.
 * Model: BEMOTION_WHISPER_MODEL or `small` (with English the `.en` variant). Transcripts are cached by
 * the audio's content and the model in .bemotion-cache/audio.
 */
export interface HeardWord {
  w: string;
  start: number;
  end: number;
  /** Word probability, 0-1. */
  p: number;
}

export interface Transcript {
  model: string;
  device: string;
  language: string | null;
  engine: string;
  words: HeardWord[];
}

export interface TranscribeOptions {
  /** Whisper model: tiny, base, small, medium, large-v3 (or a `.en` variant). */
  model?: string;
  /** Language code; null or undefined detects it. */
  language?: string | null;
  device?: 'auto' | 'cuda' | 'cpu';
}

export const DEFAULT_MODEL = 'small';
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/transcribe.py');

export function whisperPython(): string {
  if (process.env.BEMOTION_PYTHON) return process.env.BEMOTION_PYTHON;
  const venv = join(homedir(), '.bemotion', 'whisper-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (existsSync(venv)) return venv;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function runPython(args: string[], input?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res) => {
    const p = spawn(whisperPython(), ['-I', SCRIPT, ...args], { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => res({ code: 127, out, err: e.message }));
    p.on('close', (code) => res({ code: code ?? 1, out, err }));
    p.stdin.end(input ?? '');
  });
}

let available: Promise<string | null> | null = null;

/** The Whisper package found ("faster_whisper" or "whisper"), or null. Checked once per process. */
export function whisperAvailable(): Promise<string | null> {
  if (process.env.BEMOTION_WHISPER === 'off') return Promise.resolve(null);
  available ??= runPython(['--check']).then((r) => (r.code === 0 ? r.out.trim() || 'whisper' : null));
  return available;
}

/** `small` with English becomes `small.en` (the English-only models are more accurate). */
export function modelFor(model: string | undefined, language: string | null | undefined): string {
  const m = model || process.env.BEMOTION_WHISPER_MODEL || DEFAULT_MODEL;
  return language === 'en' && /^(tiny|base|small|medium)$/.test(m) ? `${m}.en` : m;
}

const EN = new Set(['the', 'a', 'and', 'to', 'you', 'your', 'is', 'of', 'in', 'it', 'for', 'with', 'on', 'that', 'this', 'we', 'are', 'can', 'at', 'be']);
const OTHER = new Set(['der', 'die', 'das', 'und', 'ist', 'sie', 'wir', 'ein', 'eine', 'einem', 'nicht', 'mit', 'le', 'la', 'les', 'des', 'est', 'et', 'vous', 'nous', 'une', 'el', 'los', 'las', 'es', 'y', 'con', 'para', 'que', 'de', 'du', 'il', 'di', 'che', 'het', 'een', 'och']);

/** Whether a script reads as English (Latin letters and common English words), to pick the English model. */
export function looksEnglish(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z']+|[^\sa-z0-9'.,!?;:"()-]+/g) ?? [];
  if (!words.length) return false;
  const foreign = words.filter((w) => /[^a-z']/.test(w)).length;
  const common = words.filter((w) => EN.has(w)).length;
  const other = words.filter((w) => OTHER.has(w)).length;
  return foreign / words.length < 0.05 && common / words.length > 0.12 && other < common / 2;
}

async function hashFile(file: string): Promise<string> {
  const h = createHash('sha1');
  await new Promise<void>((res, rej) => {
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => res()).on('error', rej);
  });
  return h.digest('hex').slice(0, 20);
}

/** Transcribes an audio file. Throws when Whisper is not installed or fails. */
export async function transcribe(file: string, out: string, o: TranscribeOptions = {}): Promise<Transcript> {
  if (!(await whisperAvailable())) throw new Error('Whisper is not installed (see README: Speech recognition)');
  const req = { audio: resolve(file), out, model: modelFor(o.model, o.language), language: o.language ?? null, device: o.device ?? 'auto' };
  const r = await runPython([], JSON.stringify(req));
  if (r.code !== 0) throw new Error(`Whisper failed: ${r.err.trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
  return JSON.parse(await readFile(out, 'utf8')) as Transcript;
}

const building = new Map<string, Promise<Transcript>>();

/** Transcribes once per audio content, model and language; later calls read the cache in `cacheDir`. */
export async function transcribeCached(file: string, cacheDir: string, o: TranscribeOptions = {}): Promise<Transcript> {
  const model = modelFor(o.model, o.language);
  const key = `${await hashFile(file)}.${model.replace(/[^\w.-]/g, '_')}.${o.language ?? 'auto'}`;
  const out = join(cacheDir, `${key}.whisper.json`);
  try {
    return JSON.parse(await readFile(out, 'utf8')) as Transcript;
  } catch {
    // not transcribed yet
  }
  let p = building.get(out);
  if (!p) {
    p = (async () => {
      await mkdir(cacheDir, { recursive: true });
      // On stderr, so `--json` output stays clean.
      process.stderr.write(`> Transcribing ${basename(file)} (Whisper ${model})\n`);
      const tmp = `${out}.${process.pid}.tmp`;
      try {
        const t = await transcribe(file, tmp, o);
        await rename(tmp, out);
        return t;
      } finally {
        await rm(tmp, { force: true });
      }
    })().finally(() => building.delete(out));
    building.set(out, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// Aligning a known script to recognized words.

export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** An integer read out in English words ("150" -> one hundred fifty). */
export function numberWords(n: number): string[] {
  if (!Number.isFinite(n) || n < 0 || n >= 1e12) return [String(n)];
  if (n < 20) return [ONES[n]];
  if (n < 100) return [TENS[Math.floor(n / 10)], ...(n % 10 ? [ONES[n % 10]] : [])];
  if (n < 1000) return [ONES[Math.floor(n / 100)], 'hundred', ...(n % 100 ? numberWords(n % 100) : [])];
  for (const [size, name] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']] as const) {
    if (n >= size) return [...numberWords(Math.floor(n / size)), name, ...(n % size ? numberWords(n % size) : [])];
  }
  return [String(n)];
}

const norm = (s: string) => s.toLowerCase().replace(/(\d),(?=\d)/g, '$1').replace(/[’']/g, '').replace(/[^\p{L}\p{N}%$.]+/gu, ' ').replace(/\.(?!\d)/g, ' ').trim();

/** The tokens a word is spoken as, for matching: numbers read out, % as percent. */
export function spokenTokens(word: string): string[] {
  const out: string[] = [];
  for (const t of norm(word).split(' ').filter(Boolean)) {
    const m = t.match(/^\$?(\d[\d,]*)(?:\.(\d+))?(%?)$/);
    if (m) {
      const whole = Number(m[1].replace(/,/g, ''));
      out.push(...numberWords(whole));
      if (m[2]) out.push('point', ...m[2].split('').map((d) => ONES[Number(d)]));
      if (m[3]) out.push('percent');
      if (t.startsWith('$')) out.push('dollars');
      continue;
    }
    const clean = t.replace(/[$%.]/g, '');
    if (clean) out.push(clean);
    if (t.endsWith('%')) out.push('percent');
  }
  return out;
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

function syl(word: string): number {
  const g = word.toLowerCase().replace(/e$/, '').match(/[aeiouy]+/g);
  return Math.max(1, g ? g.length : Math.ceil(word.length / 3));
}

export interface ScriptAlignment {
  words: TimedWord[];
  /** Share of the script's tokens that matched a heard word exactly. */
  matched: number;
}

/**
 * Times for each word of `script` from recognized words: both sides are split into spoken tokens
 * (numbers read out), aligned by edit distance (match, near match, insertion, deletion), and each
 * script word takes the times of the heard tokens it lines up with. Script words nothing was heard
 * for share out the time between their neighbors (or the heard words left over there).
 */
export function alignTranscript(script: string, heard: HeardWord[]): ScriptAlignment {
  const sw = script.split(/\s+/).filter(Boolean);
  type Tok = { t: string; word: number; start: number; end: number };
  const a: Tok[] = [];
  sw.forEach((w, i) => spokenTokens(w).forEach((t) => a.push({ t, word: i, start: 0, end: 0 })));
  const b: Tok[] = [];
  heard.forEach((h, i) => {
    const toks = spokenTokens(h.w);
    const weights = toks.map(syl);
    const total = weights.reduce((x, y) => x + y, 0);
    let t = h.start;
    toks.forEach((tok, k) => {
      const d = ((h.end - h.start) * weights[k]) / total;
      b.push({ t: tok, word: i, start: t, end: t + d });
      t += d;
    });
  });
  const n = a.length;
  const m = b.length;
  const out: TimedWord[] = sw.map((text) => ({ text, start: NaN, end: NaN }));
  if (!n || !m) return { words: n ? [] : out, matched: 0 };
  // Edit distance alignment over tokens.
  const GAP = 1;
  const cost = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const back = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let i = 1; i <= n; i++) (cost[i][0] = i * GAP), (back[i][0] = 1);
  for (let j = 1; j <= m; j++) (cost[0][j] = j * GAP), (back[0][j] = 2);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = similarity(a[i - 1].t, b[j - 1].t);
      const sub = cost[i - 1][j - 1] + (s === 1 ? 0 : 1.6 * (1 - s) + 0.2);
      const del = cost[i - 1][j] + GAP;
      const ins = cost[i][j - 1] + GAP;
      if (sub <= del && sub <= ins) (cost[i][j] = sub), (back[i][j] = 0);
      else if (del <= ins) (cost[i][j] = del), (back[i][j] = 1);
      else (cost[i][j] = ins), (back[i][j] = 2);
    }
  }
  const pair = new Int32Array(n).fill(-1);
  const heardUsed = new Uint8Array(m);
  let exact = 0;
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const k = back[i][j];
    if (i > 0 && j > 0 && k === 0) {
      pair[i - 1] = j - 1;
      heardUsed[j - 1] = 1;
      if (a[i - 1].t === b[j - 1].t) exact++;
      i--;
      j--;
    } else if (i > 0 && (k === 1 || j === 0)) i--;
    else j--;
  }
  for (let i = 0; i < n; i++) {
    const j = pair[i];
    if (j < 0) continue;
    const w = out[a[i].word];
    w.start = Number.isNaN(w.start) ? b[j].start : Math.min(w.start, b[j].start);
    w.end = Number.isNaN(w.end) ? b[j].end : Math.max(w.end, b[j].end);
  }
  // Heard tokens nothing lined up with, kept for the gaps they sit in.
  const spare = b.filter((_, j) => !heardUsed[j]);
  // Script words without times: share out the stretch between their timed neighbors.
  for (let i = 0; i < out.length; ) {
    if (!Number.isNaN(out[i].start)) {
      i++;
      continue;
    }
    let k = i;
    while (k < out.length && Number.isNaN(out[k].start)) k++;
    const prevEnd = i > 0 ? out[i - 1].end : (heard[0]?.start ?? 0);
    const nextStart = k < out.length ? out[k].start : (heard[heard.length - 1]?.end ?? prevEnd);
    const inGap = spare.filter((t) => t.start >= prevEnd - 0.01 && t.end <= nextStart + 0.01);
    let s0 = inGap.length ? inGap[0].start : prevEnd;
    let s1 = inGap.length ? inGap[inGap.length - 1].end : nextStart;
    const run = out.slice(i, k);
    const weights = run.map((w) => syl(w.text));
    const total = weights.reduce((x, y) => x + y, 0);
    if (s1 - s0 < 0.06 * run.length) {
      // No room: squeeze in after the previous word.
      s0 = prevEnd;
      s1 = Math.max(nextStart, prevEnd + 0.06 * run.length);
    }
    let t = s0;
    run.forEach((w, q) => {
      const d = ((s1 - s0) * weights[q]) / total;
      w.start = t;
      w.end = t + d;
      t += d;
    });
    i = k;
  }
  const r = (x: number) => Math.round(x * 1000) / 1000;
  let last = 0;
  const words = out.map((w) => {
    const start = Math.max(last, w.start);
    const end = Math.max(start, w.end);
    last = start;
    return { text: w.text, start: r(start), end: r(end) };
  });
  return { words, matched: exact / n };
}

/** The transcript as timed words (for a voice track without a script). */
export function transcriptWords(heard: HeardWord[]): TimedWord[] {
  return heard.filter((h) => h.w.trim()).map((h) => ({ text: h.w.trim(), start: h.start, end: h.end }));
}

/** The transcript as plain text, for a script file. */
export function transcriptText(heard: HeardWord[]): string {
  return transcriptWords(heard).map((w) => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1');
}
