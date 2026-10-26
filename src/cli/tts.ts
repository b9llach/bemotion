import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ffmpegPath } from './ffmpeg';
import { log } from './log';

/**
 * Generated voiceover: speaks a script into an audio file. `system` uses the computer's own voice
 * (Windows speech, macOS `say`, Linux `espeak-ng`), good for drafts and free; `elevenlabs` and
 * `openai` use those services for a finished voice (ELEVENLABS_API_KEY, OPENAI_API_KEY).
 */
export type TtsProvider = 'system' | 'elevenlabs' | 'openai';

export interface TtsOptions {
  provider?: TtsProvider;
  /** A voice name (system), voice id (ElevenLabs) or voice (OpenAI: alloy, nova, sage...). */
  voice?: string;
  /** Speaking speed: -10 (slow) to 10 (fast), 0 normal. */
  rate?: number;
  /** ElevenLabs or OpenAI model. */
  model?: string;
  /** OpenAI only: how to speak ("calm and warm, like a friendly guide"). */
  instructions?: string;
}

function run(cmd: string, args: string[], input?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', rej);
    p.on('close', (code) => res({ code: code ?? 1, out, err }));
    if (input !== undefined) p.stdin.end(input);
    else p.stdin.end();
  });
}

/** Converts any audio file to a 24 kHz mono WAV (or keeps it when the target is not .wav). */
async function toTarget(src: string, out: string): Promise<void> {
  if (extname(out).toLowerCase() !== '.wav' && extname(out).toLowerCase() === extname(src).toLowerCase()) {
    await rename(src, out);
    return;
  }
  const r = await run(ffmpegPath(), ['-y', '-loglevel', 'error', '-i', src, '-ar', '24000', '-ac', '1', out]);
  await rm(src, { force: true });
  if (r.code !== 0) throw new Error(`Could not convert the voice: ${r.err.slice(0, 300)}`);
}

async function systemVoice(text: string, out: string, o: TtsOptions): Promise<void> {
  const tmp = join(tmpdir(), `bemotion-tts-${process.pid}-${Date.now()}`);
  const rate = Math.max(-10, Math.min(10, Math.round(o.rate ?? 0)));
  if (process.platform === 'win32') {
    // Text and settings go in through stdin as JSON, so nothing needs quoting.
    const ps = [
      'Add-Type -AssemblyName System.Speech',
      '$in = [Console]::In.ReadToEnd() | ConvertFrom-Json',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      '$s.Rate = [int]$in.rate',
      'if ($in.voice) { $s.SelectVoice($in.voice) }',
      '$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
      '$s.SetOutputToWaveFile($in.out, $f)',
      '$s.Speak($in.text)',
      '$s.Dispose()',
    ].join('; ');
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], JSON.stringify({ text, out: tmp + '.wav', rate, voice: o.voice ?? '' }));
    if (r.code !== 0) throw new Error(`Windows speech failed: ${(r.err || r.out).slice(0, 400)}`);
    await toTarget(tmp + '.wav', out);
  } else if (process.platform === 'darwin') {
    const words = 175 + rate * 15;
    const r = await run('say', ['-o', tmp + '.aiff', '-r', String(words), ...(o.voice ? ['-v', o.voice] : []), '-f', '-'], text);
    if (r.code !== 0) throw new Error(`say failed: ${r.err.slice(0, 300)}`);
    await toTarget(tmp + '.aiff', out);
  } else {
    const r = await run('espeak-ng', ['-w', tmp + '.wav', '-s', String(170 + rate * 12), ...(o.voice ? ['-v', o.voice] : []), '--stdin'], text);
    if (r.code !== 0) throw new Error(`espeak-ng failed (install it, or use provider elevenlabs or openai): ${r.err.slice(0, 300)}`);
    await toTarget(tmp + '.wav', out);
  }
}

async function elevenLabs(text: string, out: string, o: TtsOptions): Promise<void> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('Set ELEVENLABS_API_KEY to use ElevenLabs voices.');
  const voice = o.voice ?? 'JBFqnCBsd6RMkjVDRZzb';
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: o.model ?? 'eleven_multilingual_v2', ...(o.rate ? { voice_settings: { speed: 1 + Math.max(-10, Math.min(10, o.rate)) * 0.02 } } : {}) }),
  });
  if (!res.ok) throw new Error(`ElevenLabs error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const tmp = join(tmpdir(), `bemotion-tts-${process.pid}-${Date.now()}.mp3`);
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await toTarget(tmp, out);
}

async function openAi(text: string, out: string, o: TtsOptions): Promise<void> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Set OPENAI_API_KEY to use OpenAI voices.');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: o.model ?? 'gpt-4o-mini-tts',
      voice: o.voice ?? 'sage',
      input: text,
      response_format: 'wav',
      ...(o.instructions ? { instructions: o.instructions } : {}),
      ...(o.rate ? { speed: 1 + Math.max(-10, Math.min(10, o.rate)) * 0.04 } : {}),
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const tmp = join(tmpdir(), `bemotion-tts-${process.pid}-${Date.now()}.src.wav`);
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await toTarget(tmp, out);
}

/** Speaks `text` into `out` (.wav or .mp3). */
export async function synthesize(text: string, out: string, o: TtsOptions = {}): Promise<void> {
  const file = resolve(out);
  await mkdir(dirname(file), { recursive: true });
  const provider = o.provider ?? 'system';
  if (provider === 'elevenlabs') await elevenLabs(text, file, o);
  else if (provider === 'openai') await openAi(text, file, o);
  else await systemVoice(text, file, o);
}

/** The computer's installed voices (system provider). */
export async function systemVoices(): Promise<string[]> {
  if (process.platform === 'win32') {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }']);
    return r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  if (process.platform === 'darwin') {
    const r = await run('say', ['-v', '?']);
    return r.out.split('\n').map((l) => l.split(/\s{2,}/)[0].trim()).filter(Boolean);
  }
  const r = await run('espeak-ng', ['--voices']).catch(() => ({ out: '' }));
  return r.out.split('\n').slice(1).map((l) => l.trim().split(/\s+/)[3]).filter(Boolean);
}

const AUDIO_EXTS = ['.wav', '.mp3'];

/**
 * Where a generated voice may be written: an audio file inside the spec's folder. A spec can come
 * from elsewhere (generated, shared), so its `src` must not reach outside the project, directly or
 * through a symbolic link.
 */
export async function voicePath(specPath: string, src: string): Promise<string> {
  const base = await realpath(dirname(resolve(specPath)));
  const file = resolve(base, src);
  const inside = (p: string) => {
    const rel = relative(base, p);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  };
  if (!inside(file)) throw new Error(`A generated voiceover must be written inside the spec's folder: "${src}"`);
  if (!AUDIO_EXTS.includes(extname(file).toLowerCase())) throw new Error(`A generated voiceover must be a .wav or .mp3 file: "${src}"`);
  // Follow links: the file if it exists, and the nearest folder on the way that exists.
  const deny = () => new Error(`A generated voiceover must be written inside the spec's folder: "${src}"`);
  const realFile = await realpath(file).catch(() => null);
  if (realFile && !inside(realFile)) throw deny();
  let dir = dirname(file);
  while (dir !== base && inside(dir)) {
    const real = await realpath(dir).catch(() => null);
    if (real) {
      if (real !== base && !inside(real)) throw deny();
      break;
    }
    dir = dirname(dir);
  }
  return file;
}

/** Creates the folders for a voice file, then checks where they really are before anything is written. */
async function prepareVoiceDir(specPath: string, file: string): Promise<void> {
  const base = await realpath(dirname(resolve(specPath)));
  await mkdir(dirname(file), { recursive: true });
  const real = await realpath(dirname(file));
  const rel = relative(base, real);
  if (real !== base && (rel === '' || rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error(`A generated voiceover must be written inside the spec's folder: "${file}"`);
  }
  // A link at the file (or its stamp) would be followed by the write, even one pointing at nothing yet.
  for (const p of [file, `${file}.tts`]) {
    const st = await lstat(p).catch(() => null);
    if (st?.isSymbolicLink()) throw new Error(`A generated voiceover is not written through a link: "${p}"`);
  }
}

/**
 * Voice tracks with `tts` get their file spoken from the `script` before the video plays or renders.
 * The file is remade only when the script or the voice settings change (a hash is kept next to it).
 */
export async function ensureVoices(specPath: string, spec: unknown, opts: { paid?: boolean } = {}): Promise<void> {
  const audio = (spec as { audio?: unknown[] })?.audio;
  if (!Array.isArray(audio)) return;
  for (const raw of audio) {
    const a = raw as { src?: string; role?: string; script?: string; tts?: boolean | TtsOptions };
    if (!a?.tts || !a.script || !a.src || a.role !== 'voice') continue;
    const o: TtsOptions = a.tts === true ? {} : a.tts;
    // Paid voices run only when asked for (render, say), never just because a preview opened a spec.
    if ((o.provider ?? 'system') !== 'system' && opts.paid === false) {
      log.info(`${a.src}: ${o.provider} voice not made in the preview; it is made when you render (or run bemotion say)`);
      continue;
    }
    const file = await voicePath(specPath, a.src);
    const hash = createHash('sha1').update(JSON.stringify([a.script, o])).digest('hex').slice(0, 16);
    const stamp = `${file}.tts`;
    const old = await readFile(stamp, 'utf8').catch(() => '');
    const exists = await readFile(file).then(() => true, () => false);
    if (exists && old.trim() === hash) continue;
    log.step(`Speaking the voiceover into ${a.src} (${o.provider ?? 'system'} voice)`);
    await prepareVoiceDir(specPath, file);
    await synthesize(a.script, file, o);
    await writeFile(stamp, hash + '\n');
  }
}
