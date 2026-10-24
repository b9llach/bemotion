import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { basename, extname, resolve } from 'node:path';
import { readSpec, startServer } from './server';
import { render, still } from './render';
import { generate } from './generate';
import { validateVideo } from '../spec/schema';
import { layoutScenes } from '../spec/time';
import { applyFormat, formatNames, formatSlug } from '../spec/formats';
import { log } from './log';

const program = new Command();
program.name('bemotion').description('Prompt-to-video motion graphics engine for launch-grade SaaS ads.').version('0.1.0');

function defaultOut(spec: string, ext = '.mp4'): string {
  return resolve('out', basename(spec, extname(spec)) + ext);
}

/** Output path for one format: the given or default path with "-9x16" before the extension. */
function formatOut(out: string, format: string | undefined, many: boolean): string {
  if (!format || !many) return out;
  const ext = extname(out);
  return out.slice(0, out.length - ext.length) + `-${formatSlug(format)}` + ext;
}

function openBrowser(url: string) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

program
  .command('render')
  .argument('<spec>', 'path to the video spec (.json)')
  .option('-o, --out <file>', 'output .mp4 path')
  .option('-q, --quality <level>', 'draft | standard | high', 'standard')
  .option('-c, --concurrency <n>', 'parallel browser workers', (v) => parseInt(v, 10))
  .option('--from <seconds>', 'start time', parseFloat)
  .option('--to <seconds>', 'end time', parseFloat)
  .option('--frames <range>', 'frame range, e.g. 0-120')
  .option('--crf <n>', 'x264 CRF (lower is higher quality)', (v) => parseInt(v, 10))
  .option('--no-motion-blur', 'disable motion blur')
  .option('--no-gpu', 'force software rendering')
  .option('--music <file...>', 'add a music track (loops, fades out, ducks under voice)')
  .option('--music-volume <n>', 'music volume, 0-1 (default 0.8)', parseFloat)
  .option('--voice <file...>', 'add a voiceover track')
  .option('--voice-at <seconds>', 'when the voiceover starts', parseFloat)
  .option('--no-sfx', 'turn off the automatic sound effects')
  .option('-f, --format <formats>', `also or instead render other aspect ratios, comma separated: ${formatNames().join(', ')} (16:9 is the design itself)`)
  .description('Render a spec to MP4')
  .action(async (spec: string, opts) => {
    const formats: (string | undefined)[] = opts.format ? String(opts.format).split(',').map((f: string) => f.trim()) : [undefined];
    // One format with no -o writes ad-9x16.mp4; several always get suffixes.
    const many = formats.length > 1 || (!opts.out && !!opts.format);
    for (const format of formats) {
      const design = !format || format === '16:9';
      await render(resolve(spec), {
      out: formatOut(opts.out ?? defaultOut(spec), design ? undefined : format, many),
      format: design ? undefined : format,
      quality: opts.quality,
      concurrency: opts.concurrency,
      from: opts.from,
      to: opts.to,
      frames: opts.frames,
      crf: opts.crf,
      motionBlur: opts.motionBlur,
      gpu: opts.gpu,
      music: opts.music,
      musicVolume: opts.musicVolume,
      voice: opts.voice,
      voiceAt: opts.voiceAt,
      sfx: opts.sfx,
      });
    }
  });

program
  .command('still')
  .argument('<spec>', 'path to the video spec (.json)')
  .option('-t, --time <seconds...>', 'times to capture', ['0'])
  .option('-o, --out <file>', 'output .png path (use {t} for the time)')
  .option('--motion-blur', 'apply motion blur')
  .option('-f, --format <format>', `aspect ratio: ${formatNames().join(', ')}`)
  .description('Render still frames to PNG')
  .action(async (spec: string, opts) => {
    const times = (opts.time as string[]).flatMap((s) => s.split(',')).map(parseFloat);
    const suffix = opts.format ? `-${formatSlug(opts.format)}_{t}.png` : '_{t}.png';
    const files = await still(resolve(spec), times, opts.out ?? defaultOut(spec, suffix), { motionBlur: !!opts.motionBlur, format: opts.format });
    for (const f of files) log.success(f);
  });

program
  .command('preview')
  .argument('<spec>', 'path to the video spec (.json)')
  .option('-p, --port <n>', 'port', (v) => parseInt(v, 10), 4400)
  .option('--no-open', 'do not open a browser')
  .option('-f, --format <format>', `open in an aspect ratio: ${formatNames().join(', ')}`)
  .description('Live preview with scrubbing and hot reload on save')
  .action(async (spec: string, opts) => {
    const server = await startServer(resolve(spec), { port: opts.port });
    const url = opts.format ? `${server.url}/?format=${encodeURIComponent(opts.format)}` : server.url;
    log.success(`Preview running at ${url}`);
    log.info(`Watching ${resolve(spec)}. Save the file to reload. Ctrl+C to stop.`);
    if (opts.open) openBrowser(url);
  });

program
  .command('generate')
  .argument('<prompt...>', 'what the ad is about: product, audience, tone, length, brand colors')
  .option('-o, --out <file>', 'output spec path', 'out/generated/ad.json')
  .option('-i, --image <files...>', 'screenshots or logos to use in the video')
  .option('-r, --review <rounds>', 'render-and-review rounds (0 to skip)', (v) => parseInt(v, 10), 1)
  .option('-e, --effort <level>', 'low | medium | high | xhigh | max', 'high')
  .option('-b, --backend <name>', 'auto | api | claude-code (auto uses the API when ANTHROPIC_API_KEY is set, else Claude Code)', 'auto')
  .option('-m, --model <model>', 'model for the claude-code backend', 'opus')
  .option('--render', 'render the MP4 when done')
  .description('Turn a prompt into a spec with Claude, then review rendered frames and revise')
  .action(async (words: string[], opts) => {
    if (!['auto', 'api', 'claude-code'].includes(opts.backend)) throw new Error(`Unknown backend "${opts.backend}". Use auto, api or claude-code.`);
    const spec = await generate(words.join(' '), {
      out: opts.out,
      images: opts.image,
      review: opts.review,
      effort: opts.effort,
      backend: opts.backend,
      model: opts.model,
    });
    if (opts.render) {
      await render(spec, { out: spec.replace(/\.json$/i, '.mp4') });
    } else {
      log.info(`Next: bemotion preview ${spec}   or   bemotion render ${spec}`);
    }
  });

const hdri = program.command('hdri').description('Studio lighting environments from Poly Haven (CC0)');
hdri
  .command('list')
  .argument('[category]', 'Poly Haven category', 'studio')
  .description('List HDRIs; use one in a spec as "environment": "hdri:<id>"')
  .action(async (category: string) => {
    const { listHdris } = await import('./hdri');
    const items = await listHdris(category);
    for (const it of items.slice(0, 40)) console.log(`  ${it.id.padEnd(34)} ${it.name}`);
    log.info(`${items.length} HDRIs in "${category}". Preview them at https://polyhaven.com/hdris/${category}`);
  });
hdri
  .command('get')
  .argument('<id>', 'Poly Haven HDRI id, e.g. studio_small_09')
  .option('-r, --res <res>', '1k | 2k | 4k', '1k')
  .description('Download an HDRI into the local cache')
  .action(async (id: string, opts) => {
    const { resolveHdri } = await import('./hdri');
    log.success(await resolveHdri(id, opts.res));
  });

program
  .command('voice')
  .argument('<audio>', 'voiceover file')
  .option('-s, --script <text>', 'what is said, word for word')
  .option('--script-file <file>', 'read the script from a text file')
  .option('--json', 'print every word with its start and end as JSON')
  .description('When each phrase and word of a voiceover is said, from the audio and its script')
  .action(async (audio: string, opts) => {
    const { readFile } = await import('node:fs/promises');
    const { alignVoice } = await import('./voice');
    const { phrases } = await import('../engine/voice');
    const script = opts.scriptFile ? await readFile(resolve(opts.scriptFile), 'utf8') : opts.script;
    if (!script) throw new Error('Give the script with --script "..." or --script-file script.txt');
    const words = await alignVoice(resolve(audio), String(script));
    if (opts.json) {
      console.log(JSON.stringify(words, null, 2));
      return;
    }
    for (const p of phrases(words, 8)) log.info(`${p.start.toFixed(2).padStart(6)}s - ${p.end.toFixed(2).padStart(6)}s  ${p.text}`);
  });

program
  .command('validate')
  .argument('<spec>', 'path to the video spec (.json)')
  .option('-f, --format <format>', `also check a format's overrides: ${formatNames().join(', ')}`)
  .description('Check a spec against the schema and print its timeline')
  .action(async (spec: string, opts) => {
    const raw = await readSpec(resolve(spec));
    const v = validateVideo(opts.format ? applyFormat(raw, opts.format).spec : raw);
    if (!v.ok || !v.video) {
      log.error(`${spec} is invalid:`);
      for (const e of v.errors) console.error(`  - ${e}`);
      process.exitCode = 1;
      return;
    }
    const video = v.video;
    const fps = video.fps ?? 30;
    const { scenes, duration } = layoutScenes(video.scenes, { fps, bpm: video.bpm });
    log.success(`${spec} is valid`);
    log.info(`${video.width ?? 1920}x${video.height ?? 1080} @ ${fps}fps, ${duration.toFixed(2)}s, ${Math.round(duration * fps)} frames`);
    scenes.forEach((s, i) => {
      const sp = video.scenes[i];
      const tr = sp.transition && i > 0 ? `  <- ${sp.transition.type} ${s.transitionIn.toFixed(2)}s` : '';
      log.info(`  ${String(i).padStart(2)}  ${s.start.toFixed(2)}s - ${s.end.toFixed(2)}s  ${sp.id ?? ''}  (${sp.layers.length} layers)${tr}`);
    });
  });

program.parseAsync(process.argv).catch((e) => {
  log.error((e as Error).message);
  process.exit(1);
});
