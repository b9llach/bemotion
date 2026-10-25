import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { ffmpegPath } from './ffmpeg';
import { probe, readFrame, medianColor, toHex } from './trace/frames';
import { traceCamera } from './trace/camera';
import { validateVideo } from '../spec/schema';

export interface RemakeOptions {
  /** Project folder (default projects/<video name>). */
  out?: string;
  /** Scene change sensitivity for ffmpeg's scdet (lower finds softer cuts; default 8). */
  threshold?: number;
  /** Opacity of the reference overlay in each scene (default 0.35, 0 for none). */
  overlay?: number;
  /** Skip the camera trace (faster). */
  noCamera?: boolean;
  log?: (msg: string) => void;
}

export interface Shot {
  index: number;
  from: number;
  to: number;
  start: number;
  duration: number;
  background: string;
  palette: string[];
  camera: string;
  sheet: string;
}

function ff(args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const p = spawn(ffmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? res(err) : rej(new Error(`ffmpeg failed: ${err.slice(-300)}`))));
  });
}

/** Frames where a new shot starts (ffmpeg scene detection), merged when a cut spans neighbouring frames. */
export async function detectCuts(src: string, fps: number, threshold = 8): Promise<number[]> {
  const log = await ff(['-hide_banner', '-i', src, '-vf', `scdet=threshold=${threshold}`, '-an', '-f', 'null', '-']);
  const frames = [...log.matchAll(/lavfi\.scd\.time:\s*([\d.]+)/g)].map((m) => Math.round(parseFloat(m[1]) * fps));
  const cuts: number[] = [];
  for (const f of frames) {
    if (f < 3) continue;
    // A cut that dissolves over two or three frames reports each of them: keep the last.
    if (cuts.length && f - cuts[cuts.length - 1] <= 3) cuts[cuts.length - 1] = f;
    else cuts.push(f);
  }
  return cuts;
}

/** A grid of frames from a shot with frame numbers, for reading it at a glance. */
async function contactSheet(src: string, fps: number, from: number, to: number, out: string): Promise<void> {
  const n = to - from;
  const cells = Math.min(24, Math.max(4, n));
  const step = Math.max(1, Math.floor(n / cells));
  const cols = 6;
  const rows = Math.ceil(Math.min(cells, Math.ceil(n / step)) / cols);
  const select = `select='between(n\\,${from}\\,${to - 1})*not(mod(n-${from}\\,${step}))'`;
  const base = ['-loglevel', 'error', '-y', '-i', src];
  const tail = [`scale=384:-2`, `tile=${cols}x${rows}:padding=4:color=white`].join(',');
  try {
    await ff([...base, '-vf', `${select},scale=384:-2,drawtext=text='%{n}':x=6:y=6:fontsize=18:fontcolor=red:box=1:boxcolor=white@0.7,tile=${cols}x${rows}:padding=4:color=white`, '-frames:v', '1', out]);
  } catch {
    // No font for frame numbers on this machine: the grid alone.
    await ff([...base, '-vf', `${select},${tail}`, '-frames:v', '1', out]);
  }
  void fps;
}

/** The most common colors of a frame (quantized), most frequent first, near-duplicates merged. */
async function palette(src: string, frames: number[]): Promise<string[]> {
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (const f of frames) {
    const fr = await readFrame(src, f, { width: 160 });
    for (let i = 0; i < fr.width * fr.height; i++) {
      const r = fr.data[i * 3], g = fr.data[i * 3 + 1], b = fr.data[i * 3 + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const c = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      c.n++;
      c.r += r;
      c.g += g;
      c.b += b;
      counts.set(key, c);
    }
  }
  const total = [...counts.values()].reduce((s, c) => s + c.n, 0);
  const list = [...counts.values()].sort((a, b) => b.n - a.n).map((c) => ({ n: c.n, c: [c.r / c.n, c.g / c.n, c.b / c.n] }));
  const out: { n: number; c: number[] }[] = [];
  for (const it of list) {
    if (it.n / total < 0.004) break;
    if (out.some((o) => Math.hypot(o.c[0] - it.c[0], o.c[1] - it.c[1], o.c[2] - it.c[2]) < 40)) continue;
    out.push(it);
    if (out.length >= 6) break;
  }
  return out.map((o) => toHex(o.c));
}

/** Plain words for how the picture moves over a shot, and where the trace hit a cut (if it did). */
async function cameraSummary(src: string, from: number, to: number): Promise<{ text: string; cut?: number }> {
  if (to - from < 3) return { text: 'too short to tell' };
  // Trace both ways from the middle of the shot, so a blank or tiny opening frame does not stop it.
  const mid = Math.floor((from + to - 1) / 2);
  const r = await traceCamera(src, { from, to: to - 1, anchor: mid, work: 960 });
  const frames = Object.keys(r.frames).map(Number).sort((a, b) => a - b);
  const a = frames[0];
  const b = frames[frames.length - 1];
  const cuts = [...r.lost.filter((f) => f > mid), ...r.lost.filter((f) => f < mid).map((f) => f + 1)];
  if (b - a + 1 < Math.max(3, (to - from) * 0.25)) {
    return { text: 'could not follow (fast motion, a dissolve, or a repeating pattern); trace it with `trace camera` by parts', cut: cuts[0] };
  }
  // Motion from the first followed frame to the last: T_b composed with the inverse of T_a.
  const [sa, xa, ya] = r.frames[a];
  const [sb, xb, yb] = r.frames[b];
  const s = sb / sa;
  const tx = xb - s * xa;
  const ty = yb - s * ya;
  const dx = s * 960 + tx - 960;
  const dy = s * 540 + ty - 540;
  const parts: string[] = [];
  if (Math.abs(s - 1) > 0.03) parts.push(s > 1 ? `zooms in ${s.toFixed(2)}x` : `zooms out to ${s.toFixed(2)}x`);
  if (Math.hypot(dx, dy) > 12) {
    const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    parts.push(`content moves ${dir} ${Math.round(Math.hypot(dx, dy))}px`);
  }
  let text = parts.length ? parts.join(', ') : 'static';
  if (a > from || b < to - 1) text += ` (followed frames ${a}-${b})`;
  return { text, cut: cuts[0] };
}

export async function remake(video: string, o: RemakeOptions = {}) {
  const log = o.log ?? (() => {});
  const src = resolve(video);
  const name = basename(src, extname(src)).replace(/[^a-zA-Z0-9_-]+/g, '-');
  const dir = resolve(o.out ?? join('projects', name));
  await mkdir(join(dir, 'shots'), { recursive: true });
  const info = await probe(src);
  // The reference at the design size, frame-exact and seekable (keyframe every 10 frames).
  const H = Math.round(((1920 * info.height) / info.width) / 2) * 2;
  const ref = join(dir, 'reference.mp4');
  log(`Copying the reference at 1920x${H}`);
  await ff(['-loglevel', 'error', '-y', '-i', src, '-vf', `scale=1920:${H}:flags=lanczos`, '-c:v', 'libx264', '-crf', '14', '-preset', 'fast', '-g', '10', '-pix_fmt', 'yuv420p', '-c:a', 'aac', ref]);
  const fps = info.fps;
  const total = await frameCount(ref, fps);
  log('Finding the shots');
  const found = await detectCuts(ref, fps, o.threshold ?? 8);
  // A "shot" under a third of a second is usually a fast move or a flash, not a shot: merge it forward.
  const minLen = Math.round(fps / 3);
  const cuts: number[] = [];
  for (const c of found.filter((c) => c < total)) {
    if (c - (cuts[cuts.length - 1] ?? 0) < minLen) {
      if (cuts.length) cuts[cuts.length - 1] = c;
      continue;
    }
    cuts.push(c);
  }
  if (cuts.length && total - cuts[cuts.length - 1] < minLen) cuts.pop();
  const bounds = [0, ...cuts, total];
  const shots: Shot[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const from = bounds[i];
    const to = bounds[i + 1];
    if (to - from < 1) continue;
    let camera = 'not traced';
    if (!o.noCamera) {
      const c = await cameraSummary(ref, from, to);
      // The camera trace stopping well inside a shot is usually a cut scene detection missed (the same
      // layout jumping): split there and look at the rest as its own shot.
      if (c.cut !== undefined && c.cut - from >= minLen && to - c.cut >= minLen) {
        bounds.splice(i + 1, 0, c.cut);
        log(`Cut at frame ${c.cut} (found by the camera trace)`);
        // Look at the shorter shot again: it can hide another cut.
        i--;
        continue;
      }
      camera = c.text;
    }
    log(`Shot ${i + 1}: frames ${from}-${to - 1}`);
    const sheet = join(dir, 'shots', `shot${String(i + 1).padStart(2, '0')}.png`);
    await contactSheet(ref, fps, from, to, sheet);
    const mid = Math.floor((from + to) / 2);
    const bgFrame = await readFrame(ref, mid);
    shots.push({
      index: i + 1, from, to, start: from / fps, duration: (to - from) / fps,
      background: toHex(medianColor(bgFrame)), palette: await palette(ref, [from, mid, Math.max(from, to - 3)]), camera,
      sheet: relative(dir, sheet).replace(/\\/g, '/'),
    });
  }
  const overlay = o.overlay ?? 0.35;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const spec = {
    fps,
    width: 1920,
    height: H,
    post: { bloom: false, grain: 0, vignette: 0, chromatic: 0, tonemap: 'none' },
    sfx: false,
    scenes: shots.map((s) => ({
      id: `shot${s.index}`,
      duration: r3(s.duration),
      background: s.background,
      layers: overlay > 0
        ? [{ type: 'video', id: 'reference', src: 'reference.mp4', trim: r3(s.start), width: 1920, height: H, opacity: overlay }]
        : [],
    })),
  };
  const check = validateVideo(spec);
  if (!check.ok) throw new Error(`remake wrote an invalid spec: ${check.errors.join('; ')}`);
  await writeFile(join(dir, 'spec.json'), JSON.stringify(spec, null, 1) + '\n');
  const notes = [
    `# Remake of ${basename(src)}`,
    '',
    `${info.width}x${info.height} at ${fps} fps, ${(total / fps).toFixed(2)} s, ${shots.length} shots. The design size is 1920x${H}; \`reference.mp4\` is the video at that size.`,
    '',
    'Each scene of `spec.json` is one shot, timed to its frames, with the reference drawn over it at low opacity (the layer with id `reference`). Build the shot under it in the preview, then delete that layer.',
    '',
    '| Shot | Frames | Start | Length | Background | Colors | Camera | Sheet |',
    '|---|---|---|---|---|---|---|---|',
    ...shots.map((s) => `| ${s.index} | ${s.from}-${s.to - 1} | ${s.start.toFixed(2)} s | ${s.duration.toFixed(2)} s | ${s.background} | ${s.palette.join(' ')} | ${s.camera} | [${s.sheet}](${s.sheet}) |`),
    '',
    '## Next steps',
    '',
    '```',
    `node bin/bemotion.mjs preview ${relative(process.cwd(), join(dir, 'spec.json')).replace(/\\/g, '/')}`,
    `node bin/bemotion.mjs trace camera reference.mp4 --from <first> --to <last>      # a moving shot: keyframes for a group`,
    `node bin/bemotion.mjs trace text reference.mp4 --frame <n> --region x0,y0,x1,y1 --text "..." --font font.ttf`,
    `node bin/bemotion.mjs trace reveal reference.mp4 --text "..." --font font.ttf --size <px> --left <px> --baseline <px> --from <f> --to <f>`,
    `node bin/bemotion.mjs trace dots reference.mp4 --from <f> --to <f> --color "#hex" -o dots.json`,
    `node bin/bemotion.mjs trace halftone reference.mp4 --frame <n> --region x0,y0,x1,y1 -o map.png`,
    `node bin/bemotion.mjs compare spec.json reference.mp4                              # score the remake`,
    '```',
    '',
  ].join('\n');
  await writeFile(join(dir, 'NOTES.md'), notes);
  return { dir, shots, spec: join(dir, 'spec.json') };
}

/** Frames in the video stream (the container's duration can include longer audio). */
async function frameCount(src: string, _fps: number): Promise<number> {
  const err = await ff(['-hide_banner', '-i', src, '-map', '0:v:0', '-vf', 'scale=64:-2', '-f', 'null', '-']);
  const all = [...err.matchAll(/frame=\s*(\d+)/g)];
  if (!all.length) throw new Error(`could not count the frames of ${src}`);
  return +all[all.length - 1][1];
}
