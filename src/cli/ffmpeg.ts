import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export function ffmpegPath(): string {
  const p = process.env.BEMOTION_FFMPEG ?? (ffmpegStatic as unknown as string | null);
  if (!p) throw new Error('ffmpeg not found. Install ffmpeg or set BEMOTION_FFMPEG.');
  return p;
}

export interface EncoderOptions {
  fps: number;
  input: 'png' | 'jpeg';
  crf: number;
  preset: string;
  out: string;
  /** A hardware H.264 encoder (h264_nvenc, h264_amf, h264_qsv) instead of x264. */
  encoder?: string | null;
  /**
   * Keep the images as they arrive (PNG or JPEG frames in a .mov), for outputs encoded in a second
   * pass (GIF, WebM, ProRes): nothing is lost, and PNG keeps the alpha channel.
   */
  copy?: boolean;
}

let gpuProbe: Promise<string | null> | null = null;

/** The first hardware H.264 encoder that actually works on this machine, or null. */
export function gpuEncoder(): Promise<string | null> {
  gpuProbe ??= (async () => {
    for (const enc of ['h264_nvenc', 'h264_amf', 'h264_qsv']) {
      const ok = await new Promise<boolean>((res) => {
        const p = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.2', '-c:v', enc, '-f', 'null', '-']);
        p.on('error', () => res(false));
        p.on('close', (code) => res(code === 0));
      });
      if (ok) return enc;
    }
    return null;
  })();
  return gpuProbe;
}

/** Codec arguments: x264 at a CRF, or a hardware encoder at a matching constant quality. */
function codecArgs(o: EncoderOptions): string[] {
  const q = String(o.crf + 2);
  if (o.encoder === 'h264_nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', q, '-b:v', '0'];
  if (o.encoder === 'h264_amf') return ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', q, '-qp_p', q];
  if (o.encoder === 'h264_qsv') return ['-c:v', 'h264_qsv', '-preset', 'slow', '-global_quality', q];
  return ['-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.crf)];
}

/** Starts an ffmpeg process that reads an image stream on stdin and writes H.264. */
export function startEncoder(o: EncoderOptions): { proc: ChildProcessWithoutNullStreams; done: Promise<void>; write(buf: Buffer): Promise<void> } {
  const args = o.copy ? [
    '-y',
    '-loglevel', 'error',
    '-f', 'image2pipe',
    '-framerate', String(o.fps),
    '-c:v', o.input === 'png' ? 'png' : 'mjpeg',
    '-i', '-',
    '-c:v', 'copy',
    o.out,
  ] : [
    '-y',
    '-loglevel', 'error',
    '-f', 'image2pipe',
    '-framerate', String(o.fps),
    '-c:v', o.input === 'png' ? 'png' : 'mjpeg',
    '-i', '-',
    ...codecArgs(o),
    '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-colorspace', 'bt709',
    '-r', String(o.fps),
    o.out,
  ];
  const proc = spawn(ffmpegPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d.toString()));
  const done = new Promise<void>((res, rej) => {
    proc.on('error', rej);
    proc.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`))));
  });
  let pipeError: Error | null = null;
  proc.stdin.on('error', (e) => (pipeError = e));
  const write = (buf: Buffer) =>
    new Promise<void>((res, rej) => {
      if (pipeError) return rej(new Error(`ffmpeg input closed: ${pipeError.message}. ${stderr.trim()}`));
      if (!proc.stdin.write(buf)) proc.stdin.once('drain', res);
      else res();
    });
  return { proc, done, write };
}

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const proc = spawn(ffmpegPath(), ['-y', '-loglevel', 'error', ...args]);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', rej);
    proc.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg failed (${code}): ${stderr.trim()}`))));
  });
}

export async function concatChunks(chunks: string[], out: string, tmpDir: string): Promise<void> {
  const list = resolve(tmpDir, 'chunks.txt');
  await writeFile(list, chunks.map((c) => `file '${c.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
}

export interface AudioTrack {
  file: string;
  role: 'music' | 'voice' | 'sfx';
  at: number;
  volume: number;
  trim: number;
  fadeIn: number;
  fadeOut: number;
  loop: boolean;
  duck: boolean;
  /** Seconds of the source to use after `trim` (timeline seconds when `speed` is set). */
  length?: number;
  /** Playback rate, for sound that comes from a sped-up or slowed-down video clip. */
  speed?: number;
}

/** atempo only accepts 0.5-2 per stage, so larger changes are chained. */
function tempo(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push('atempo=2');
    s /= 2;
  }
  while (s < 0.5) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-3) out.push(`atempo=${s.toFixed(4)}`);
  return out;
}

/**
 * Mixes audio tracks onto a silent video, trimmed to the video duration. Music that should duck is
 * run through a sidechain compressor keyed by the voice tracks, so it dips while someone speaks and
 * swells back in the pauses.
 */
export async function muxAudio(
  video: string | null, tracks: AudioTrack[], duration: number, out: string,
  codecs: { video?: string[]; audio?: string[]; faststart?: boolean } = {},
): Promise<void> {
  // Without a video (a soundtrack on its own) the tracks are inputs 0.., else 1..
  const first = video ? 1 : 0;
  const inputs: string[] = video ? ['-i', video] : [];
  const filters: string[] = [];
  tracks.forEach((t, i) => {
    if (t.loop) inputs.push('-stream_loop', '-1');
    inputs.push('-i', t.file);
    const chain: string[] = ['aformat=sample_rates=48000:channel_layouts=stereo'];
    if (t.trim > 0) chain.push(`atrim=start=${t.trim}`, 'asetpts=PTS-STARTPTS');
    if (t.speed && t.speed !== 1) chain.push(...tempo(t.speed));
    if (t.length !== undefined) chain.push(`atrim=end=${t.length.toFixed(3)}`, 'asetpts=PTS-STARTPTS');
    if (t.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${t.fadeIn}`);
    const len = duration - t.at;
    if (t.fadeOut > 0 && len > t.fadeOut) chain.push(`afade=t=out:st=${(len - t.fadeOut).toFixed(3)}:d=${t.fadeOut}`);
    chain.push(`volume=${t.volume}`);
    const delay = Math.max(0, Math.round(t.at * 1000));
    // adelay only shifts timestamps; renumbering them turns the delay into real leading silence,
    // which the mixer keeps (it realigns inputs to their first timestamp otherwise).
    chain.push(`adelay=${delay}|${delay}`, 'asetpts=N/SR/TB');
    filters.push(`[${i + first}:a]${chain.join(',')}[a${i}]`);
  });
  const mix = (labels: string[], out: string) =>
    filters.push(labels.length === 1 ? `${labels[0]}anull[${out}]` : `${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[${out}]`);
  const voices = tracks.flatMap((t, i) => (t.role === 'voice' ? [`[a${i}]`] : []));
  const ducked = tracks.flatMap((t, i) => (t.role === 'music' && t.duck ? [`[a${i}]`] : []));
  const rest = tracks.flatMap((t, i) => (t.role === 'voice' || (t.role === 'music' && t.duck) ? [] : [`[a${i}]`]));
  const finals = [...rest];
  if (voices.length && ducked.length) {
    mix(voices, 'vmix');
    // The compressor stops when its key stream ends, so pad the key with silence.
    filters.push('[vmix]asplit=2[vk][vout]', '[vk]apad[vkey]');
    mix(ducked, 'mmix');
    // About -9 dB of gain reduction under normal speech, 80 ms in, 600 ms back out.
    filters.push('[mmix][vkey]sidechaincompress=threshold=0.03:ratio=8:attack=80:release=600:knee=4[mduck]');
    finals.push('[vout]', '[mduck]');
  } else {
    finals.push(...voices, ...ducked);
  }
  // A silent bed from 0: without it the mixer drops leading silence, so a track that starts late
  // (a clip at 0.5 s, a voice at 2 s) would slide to the start when nothing else plays before it.
  filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${duration.toFixed(3)}[bed]`);
  finals.push('[bed]');
  filters.push(`${finals.join('')}amix=inputs=${finals.length}:normalize=0:dropout_transition=0,atrim=0:${duration.toFixed(3)}[aout]`);
  if (process.env.BEMOTION_DEBUG_AUDIO) console.log(filters.join(' ; '));
  await runFfmpeg([
    ...inputs,
    '-filter_complex', filters.join(';'),
    ...(video ? ['-map', '0:v'] : []), '-map', '[aout]',
    '-t', duration.toFixed(3),
    ...(video ? codecs.video ?? ['-c:v', 'copy'] : []),
    ...(codecs.audio ?? ['-c:a', 'aac', '-b:a', '256k']),
    ...(codecs.faststart === false ? [] : ['-movflags', '+faststart']),
    out,
  ]);
}

const BT709 = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];

/** Video codec arguments for the second-pass outputs: VP9 WebM and ProRes .mov, with or without alpha. */
export function finalCodec(kind: 'webm' | 'mov', alpha: boolean, quality: 'draft' | 'standard' | 'high'): { video: string[]; audio: string[]; faststart: boolean } {
  if (kind === 'webm') {
    const crf = quality === 'high' ? 18 : quality === 'draft' ? 36 : 28;
    return {
      // Alpha in VP9 needs alt-ref frames off; it travels as a second stream ffmpeg and browsers read.
      video: ['-c:v', 'libvpx-vp9', '-pix_fmt', alpha ? 'yuva420p' : 'yuv420p', '-crf', String(crf), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', quality === 'draft' ? '5' : '2', ...(alpha ? ['-auto-alt-ref', '0'] : []), ...BT709],
      audio: ['-c:a', 'libopus', '-b:a', '160k'],
      faststart: false,
    };
  }
  return {
    // ProRes 4444 keeps a 16-bit alpha channel; without alpha, ProRes 422 HQ.
    video: alpha
      ? ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'apl0', ...BT709]
      : ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-vendor', 'apl0', ...BT709],
    audio: ['-c:a', 'pcm_s16le'],
    faststart: true,
  };
}

/**
 * A GIF from a video: one palette for the whole clip (built from the frames' differences, so moving
 * parts get the colors), at `fps` and at most `width` pixels wide. With alpha, one palette entry is
 * transparent and pixels under half opacity use it.
 */
export async function toGif(video: string, out: string, o: { fps: number; width: number; alpha: boolean }): Promise<void> {
  const pal = `palettegen=stats_mode=diff${o.alpha ? ':reserve_transparent=1' : ''}`;
  const use = `paletteuse=dither=sierra2_4a:diff_mode=rectangle${o.alpha ? ':alpha_threshold=128' : ''}`;
  const filter = `fps=${o.fps},scale='min(${o.width},iw)':-1:flags=lanczos,split[a][b];[a]${pal}[p];[b][p]${use}`;
  await runFfmpeg(['-i', video, '-filter_complex', filter, '-loop', '0', out]);
}
