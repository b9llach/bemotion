import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runFfmpeg } from './ffmpeg';

/**
 * Video layers play from a seek-friendly copy of each clip: H.264 at the video's frame rate with a
 * keyframe every 10 frames, so the browser can land on any exact frame quickly. It also converts
 * formats the browser cannot decode (ProRes .mov and others). Copies are cached by path, size, date
 * and frame rate in .bemotion-cache/video next to the spec.
 */
const building = new Map<string, Promise<string>>();

export async function videoProxy(file: string, specDir: string, fps: number): Promise<string> {
  const st = await stat(file);
  const key = createHash('sha1').update(`v2|${file}|${st.size}|${st.mtimeMs}|${fps}`).digest('hex').slice(0, 20);
  const dir = join(specDir, '.bemotion-cache', 'video');
  const out = join(dir, `${key}.mp4`);
  if (await stat(out).then(() => true, () => false)) return out;
  let p = building.get(out);
  if (!p) {
    p = (async () => {
      await mkdir(dir, { recursive: true });
      const tmp = `${out}.${process.pid}.tmp.mp4`;
      await runFfmpeg([
        '-i', file,
        '-an',
        // Convert to tagged BT.709 so the browser decodes colors exactly as ffmpeg reads the source
        // (untagged files are otherwise guessed differently by the two and hues shift).
        '-vf', `fps=${fps},scale='min(1920,iw)':-2:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p`,
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17',
        '-g', '10', '-keyint_min', '10', '-sc_threshold', '0',
        '-movflags', '+faststart',
        tmp,
      ]);
      await rename(tmp, out);
      return out;
    })().finally(() => building.delete(out));
    building.set(out, p);
  }
  return p;
}

/** Sends a file with HTTP range support, which media elements need in order to seek. */
export async function sendFile(req: IncomingMessage, res: ServerResponse, file: string, mime: string): Promise<void> {
  const st = await stat(file);
  if (!st.isFile()) throw new Error('not a file');
  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? parseInt(range[1], 10) : st.size - parseInt(range[2], 10);
    let end = range[1] && range[2] ? parseInt(range[2], 10) : st.size - 1;
    start = Math.max(0, start);
    end = Math.min(st.size - 1, end);
    if (start > end) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${st.size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.setHeader('Content-Length', String(st.size));
  createReadStream(file).pipe(res);
}
