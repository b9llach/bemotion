import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { basename, dirname, extname, join, resolve } from 'node:path';
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
  .option('--encoder <where>', 'cpu (x264, default) or gpu (NVIDIA, AMD or Intel hardware encoder)', 'cpu')
  .option('--no-motion-blur', 'disable motion blur')
  .option('--no-gpu', 'force software rendering')
  .option('--music <file...>', 'add a music track (loops, fades out, ducks under voice)')
  .option('--music-volume <n>', 'music volume, 0-1 (default 0.8)', parseFloat)
  .option('--voice <file...>', 'add a voiceover track')
  .option('--voice-at <seconds>', 'when the voiceover starts', parseFloat)
  .option('--no-sfx', 'turn off the automatic sound effects')
  .option('-f, --format <formats>', `also or instead render other aspect ratios, comma separated: ${formatNames().join(', ')} (16:9 is the design itself)`)
  .option('--height <px>', 'output height, e.g. 1440 or 2160 (default: the design size)', (v) => parseInt(String(v).replace(/p$/i, ''), 10))
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
      encoder: opts.encoder,
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
      height: opts.height,
      });
    }
  });

program
  .command('still')
  .argument('<spec>', 'path to the video spec (.json)')
  .option('-t, --time <times...>', 'times to capture: output seconds (12.4), a scene time as written in the spec (ricki@3.5, 2@1.2) or a scene name for its middle', ['0'])
  .option('-o, --out <file>', 'output .png path (use {t} for the time)')
  .option('-s, --sheet [file]', 'also write a labelled contact sheet of all the stills (default: sheet.png next to them)')
  .option('--cols <n>', 'stills per row on the sheet', (v) => parseInt(v, 10))
  .option('--motion-blur', 'apply motion blur')
  .option('-f, --format <format>', `aspect ratio: ${formatNames().join(', ')}`)
  .option('--height <px>', 'image height, e.g. 1440 or 2160 (default: the design size)', (v) => parseInt(String(v).replace(/p$/i, ''), 10))
  .description('Render still frames to PNG')
  .action(async (spec: string, opts) => {
    const times = (opts.time as string[]).flatMap((s) => s.split(',')).filter(Boolean);
    const suffix = opts.format ? `-${formatSlug(opts.format)}_{t}.png` : '_{t}.png';
    const out = opts.out ?? defaultOut(spec, suffix);
    const sheet = opts.sheet === true ? join(dirname(resolve(out)), 'sheet.png') : opts.sheet;
    const files = await still(resolve(spec), times, out, { motionBlur: !!opts.motionBlur, format: opts.format, height: opts.height, sheet, cols: opts.cols });
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
  .argument('[prompt...]', 'what the ad is about: product, audience, tone, length, brand colors')
  .option('-o, --out <file>', 'output spec path', 'out/generated/ad.json')
  .option('-i, --image <files...>', 'screenshots or logos to use in the video')
  .option('-u, --url <url>', "the product's website: import its logo, colors, fonts, copy and screenshots first")
  .option('-r, --review <rounds>', 'render-and-review rounds (0 to skip)', (v) => parseInt(v, 10), 2)
  .option('-e, --effort <level>', 'low | medium | high | xhigh | max', 'high')
  .option('-b, --backend <name>', 'auto | api | claude-code (auto uses the API when ANTHROPIC_API_KEY is set, else Claude Code)', 'auto')
  .option('-m, --model <model>', 'model for the claude-code backend', 'opus')
  .option('--ref <techniques...>', 'techniques from the library to use (keys or words, see bemotion refs)')
  .option('-n, --variants <n>', 'write several different ads (flow, minimal, punchy, story) in parallel, each with a contact sheet', (v) => parseInt(v, 10), 1)
  .option('--render', 'render the MP4 when done')
  .description('Turn a prompt into a spec with Claude, then review rendered frames and revise')
  .action(async (words: string[], opts) => {
    if (!['auto', 'api', 'claude-code'].includes(opts.backend)) throw new Error(`Unknown backend "${opts.backend}". Use auto, api or claude-code.`);
    if (!words.length && !opts.url) throw new Error('Describe the ad, or give the product website with --url.');
    const o = { out: opts.out, images: opts.image, url: opts.url, refs: opts.ref, review: opts.review, effort: opts.effort, backend: opts.backend, model: opts.model };
    let specs: string[];
    if (opts.variants > 1) {
      const { generateVariants } = await import('./generate');
      const vs = await generateVariants(words.join(' '), { ...o, variants: opts.variants });
      console.log('');
      for (const v of vs) {
        if (v.error) console.log(`  ${v.name.padEnd(16)} failed: ${v.error}`);
        else console.log(`  ${v.name.padEnd(16)} ${v.path}${v.sheet ? `
  ${''.padEnd(16)} ${v.sheet}` : ''}${v.findings.length ? `  (${v.findings.length} problem${v.findings.length === 1 ? '' : 's'} left)` : ''}`);
      }
      specs = vs.filter((v) => !v.error).map((v) => v.path);
    } else {
      specs = [await generate(words.join(' '), o)];
    }
    for (const spec of specs) {
      if (opts.render) await render(spec, { out: spec.replace(/\.json$/i, '.mp4') });
      else log.info(`Next: bemotion preview ${spec}   or   bemotion render ${spec}`);
    }
  });

program
  .command('review')
  .argument('<spec>', 'path to the video spec (.json)')
  .option('-r, --rounds <n>', 'most review rounds', (v) => parseInt(v, 10), 2)
  .option('-e, --effort <level>', 'low | medium | high | xhigh | max', 'high')
  .option('-b, --backend <name>', 'auto | api | claude-code', 'auto')
  .option('-m, --model <model>', 'model for the claude-code backend', 'opus')
  .option('--comments', 'also address the open comments left in the preview (and resolve them)')
  .description('Have Claude review rendered frames and the measured problems of check, and revise the spec in place')
  .action(async (spec: string, opts) => {
    const { review } = await import('./generate');
    const r = await review(spec, { rounds: opts.rounds, effort: opts.effort, backend: opts.backend, model: opts.model, comments: opts.comments });
    if (r.approved) log.success('Approved');
    else if (r.findings.length) {
      log.warn(`${r.findings.length} problem${r.findings.length === 1 ? '' : 's'} left:`);
      for (const f of r.findings) console.log(`  ${f}`);
    } else log.info('Revised; run review again to look at the last revision');
  });

const refs = program.command('refs').description('The technique library: named motion techniques with runnable samples');
refs
  .argument('[query...]', 'words to search for, e.g. "morph logo" or "apple reveal"')
  .action(async (query: string[]) => {
    const { loadRefs, searchRefs } = await import('./refs');
    const list = searchRefs(await loadRefs(), query.join(' '));
    if (!list.length) return log.warn(`Nothing matches "${query.join(' ')}"`);
    for (const t of list) console.log(`  ${t.key.padEnd(22)} ${t.style.padEnd(8)} ${t.summary.length > 96 ? `${t.summary.slice(0, 94)}..` : t.summary}`);
    log.info('bemotion refs show <key> writes a runnable sample; generate --ref <key> uses it');
  });
refs
  .command('show')
  .argument('<technique>', 'key or search words')
  .option('-o, --out <file>', 'where to write the sample spec (default out/refs/<key>.json)')
  .description('Explain a technique and write its sample spec, ready to preview')
  .action(async (technique: string, opts) => {
    const { loadRefs, pickRefs } = await import('./refs');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const [t] = pickRefs(await loadRefs(), [technique]);
    const out = resolve(opts.out ?? `out/refs/${t.key}.json`);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(t.spec, null, 2) + '\n');
    console.log([`${t.name} (${t.style})`, '', t.summary, '', ...t.how.map((h) => `  - ${h}`), ''].join('\n'));
    log.success(`Wrote ${out}`);
    log.info(`Next: bemotion preview ${out}`);
  });

program
  .command('comments')
  .argument('<spec>', 'path to the video spec (.json)')
  .option('-a, --all', 'include resolved comments')
  .description('List the comments left in the preview (press C there to add one)')
  .action(async (spec: string, opts) => {
    const { readComments, commentLines } = await import('./comments');
    const list = await readComments(resolve(spec));
    const lines = commentLines(list, opts.all);
    if (!lines.length) return log.info(list.length ? 'All comments are resolved (--all lists them)' : 'No comments yet. In the preview, press C to leave one at the playhead.');
    for (const l of lines) console.log(`  ${l}`);
    log.info('bemotion review <spec> --comments has Claude address the open ones');
  });

program
  .command('fill')
  .argument('<template>', 'a spec with {{name}} placeholders')
  .option('-d, --data <file>', 'JSON file of values: { "name": "value" }')
  .option('--set <pairs...>', 'values as name=value')
  .option('-o, --out <file>', 'filled spec (default <template>-filled.json)')
  .description('Fill the {{placeholders}} of a template (missing ones take their slot default)')
  .action(async (template: string, opts) => {
    const { fillTemplate, slotNames } = await import('./template');
    const { readFile, writeFile, mkdir } = await import('node:fs/promises');
    const tpl = JSON.parse(await readFile(resolve(template), 'utf8'));
    const values: Record<string, string> = opts.data ? JSON.parse(await readFile(resolve(opts.data), 'utf8')) : {};
    for (const p of opts.set ?? []) {
      const i = p.indexOf('=');
      if (i > 0) values[p.slice(0, i)] = p.slice(i + 1);
    }
    const out = resolve(opts.out ?? template.replace(/\.json$/i, '') + '-filled.json');
    await mkdir(dirname(out), { recursive: true });
    const spec = fillTemplate(tpl, values, { templateDir: dirname(resolve(template)), valuesDir: opts.data ? dirname(resolve(opts.data)) : process.cwd(), outDir: dirname(out) });
    await writeFile(out, JSON.stringify(spec, null, 2) + '\n');
    log.info(`Slots: ${slotNames(tpl).join(', ') || 'none'}`);
    log.success(`Wrote ${out}`);
  });

program
  .command('batch')
  .argument('<template>', 'a spec with {{name}} placeholders')
  .argument('<csv>', 'one row per video; columns are placeholder names (a "name" column names the files)')
  .option('-o, --out <dir>', 'folder for the filled specs and videos', 'out/batch')
  .option('--render', 'render every video')
  .option('-q, --quality <q>', 'draft | standard | high', 'standard')
  .option('-f, --format <formats>', 'also render these formats, e.g. 9:16,1:1')
  .description('Fill a template once per CSV row (personalized or translated versions), and render them')
  .action(async (template: string, csv: string, opts) => {
    const { batch } = await import('./template');
    const items = await batch(template, csv, opts.out);
    let bad = 0;
    for (const it of items) {
      if (it.error) {
        bad++;
        log.warn(`${it.name}: ${it.error}`);
      } else log.info(`${it.name}: ${it.spec}`);
    }
    log.success(`${items.length - bad} of ${items.length} specs written to ${resolve(opts.out)}`);
    if (opts.render) {
      for (const it of items.filter((x) => !x.error)) {
        log.step(`Rendering ${it.name}`);
        await render(it.spec, { out: it.spec.replace(/\.json$/i, '.mp4'), quality: opts.quality, format: opts.format });
      }
    }
  });

program
  .command('capture')
  .argument('<url>', 'web page to capture')
  .option('-s, --selector <css>', 'capture one element (default: the first screen)')
  .option('-o, --out <file>', 'spec to write', 'out/capture/capture.json')
  .option('--width <px>', 'browser width', (v) => parseInt(v, 10), 1440)
  .option('--max <n>', 'most layers', (v) => parseInt(v, 10), 600)
  .description('Turn a live page (or one element) into editable layers: boxes, lines of text, images and icons at their places')
  .action(async (url: string, opts) => {
    const { captureUi } = await import('./capture');
    const r = await captureUi(url, opts.out, { selector: opts.selector, width: opts.width, max: opts.max });
    log.success(`Wrote ${r.file} (${r.layers} layers)`);
    log.info(`Next: bemotion preview ${r.file}`);
  });

program
  .command('brand')
  .argument('<url>', 'website of the product')
  .option('-o, --out <dir>', 'folder for brand.json and the files', 'out/brand')
  .option('--shots <n>', 'most page screenshots to keep', (v) => parseInt(v, 10), 5)
  .description('Import a brand from its website: name, logo, colors, fonts, headlines and screenshots')
  .action(async (url: string, opts) => {
    const { importBrand, describeBrand } = await import('./brand');
    const b = await importBrand(url, opts.out, { shots: opts.shots });
    console.log(describeBrand(b));
    log.success(`Wrote ${resolve(opts.out, 'brand.json')}`);
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
  .command('say')
  .argument('[text...]', 'what to say')
  .option('-o, --out <file>', 'output .wav or .mp3', 'voiceover.wav')
  .option('--script-file <file>', 'read the text from a file')
  .option('-p, --provider <name>', 'system (the computer\'s voice, free), elevenlabs or openai', 'system')
  .option('-v, --voice <name>', 'voice name or id')
  .option('-r, --rate <n>', 'speed from -10 to 10', (v) => Number(v), 0)
  .option('--instructions <text>', 'openai only: how to speak')
  .option('--voices', 'list the computer\'s voices')
  .description('Speak a script into an audio file (a voiceover). In a spec, a voice track with "tts" does this by itself')
  .action(async (text: string[], opts) => {
    const { synthesize, systemVoices } = await import('./tts');
    if (opts.voices) {
      for (const v of await systemVoices()) console.log(`  ${v}`);
      return;
    }
    const { readFile } = await import('node:fs/promises');
    const script = opts.scriptFile ? await readFile(resolve(opts.scriptFile), 'utf8') : text.join(' ');
    if (!script.trim()) throw new Error('Give the text, or --script-file script.txt');
    await synthesize(script, opts.out, { provider: opts.provider, voice: opts.voice, rate: opts.rate, instructions: opts.instructions });
    log.success(`Wrote ${resolve(opts.out)}`);
  });

program
  .command('voice')
  .argument('<audio>', 'voiceover file')
  .option('-s, --script <text>', 'what is said, word for word')
  .option('--script-file <file>', 'read the script from a text file')
  .option('--json', 'print every word with its start and end as JSON')
  .option('--loudness', 'align by loudness only, without speech recognition')
  .option('--model <name>', 'Whisper model when speech recognition is installed (default small)')
  .description('When each phrase and word of a voiceover is said, from the audio and its script (transcribed without one)')
  .action(async (audio: string, opts) => {
    const { readFile } = await import('node:fs/promises');
    const { alignVoice } = await import('./voice');
    const { phrases } = await import('../engine/voice');
    const script = opts.scriptFile ? await readFile(resolve(opts.scriptFile), 'utf8') : opts.script;
    const words = await alignVoice(resolve(audio), script ? String(script) : undefined, { model: opts.model, method: opts.loudness ? 'loudness' : 'auto' });
    if (opts.json) {
      console.log(JSON.stringify(words, null, 2));
      return;
    }
    for (const p of phrases(words, 8)) log.info(`${p.start.toFixed(2).padStart(6)}s - ${p.end.toFixed(2).padStart(6)}s  ${p.text}`);
  });

program
  .command('transcribe')
  .argument('<audio>', 'voiceover or any speech recording')
  .option('-m, --model <name>', 'Whisper model: tiny, base, small, medium, large-v3 (default small; .en with --language en)')
  .option('-l, --language <code>', 'spoken language, e.g. en or de (default: detected)')
  .option('--cpu', 'run on the CPU even when a GPU is available')
  .option('--script-out <file>', 'write the transcript as a script (text file)')
  .option('--json', 'print every word with its start, end and probability as JSON')
  .description('Speech recognition with word times (Whisper): prints what is said and when, or writes a script')
  .action(async (audio: string, opts) => {
    const { writeFile } = await import('node:fs/promises');
    const { transcribeCached, transcriptText, whisperAvailable, whisperPython } = await import('./transcribe');
    const { phrases } = await import('../engine/voice');
    if (!(await whisperAvailable())) throw new Error(`Whisper is not installed for ${whisperPython()}. See README, Speech recognition.`);
    const file = resolve(audio);
    const t = await transcribeCached(file, join(dirname(file), '.bemotion-cache', 'audio'), { model: opts.model, language: opts.language ?? null, device: opts.cpu ? 'cpu' : 'auto' });
    if (opts.json) console.log(JSON.stringify(t, null, 2));
    else {
      log.info(`${t.words.length} words, language ${t.language ?? 'unknown'} (${t.engine} ${t.model}, ${t.device})`);
      const ws = t.words.map((w) => ({ text: w.w, start: w.start, end: w.end }));
      for (const p of phrases(ws, 8)) log.info(`${p.start.toFixed(2).padStart(6)}s - ${p.end.toFixed(2).padStart(6)}s  ${p.text}`);
    }
    if (opts.scriptOut) {
      await writeFile(resolve(opts.scriptOut), transcriptText(t.words) + '\n');
      log.success(`Wrote ${resolve(opts.scriptOut)}`);
    }
  });

program
  .command('score')
  .argument('<spec>', 'path to the video spec (.json)')
  .option('-o, --out <file>', 'output .wav (default: next to the spec, <name>-score.wav)')
  .option('-s, --style <style>', 'try a style: warm, ambient, bright, cinematic, lofi, piano')
  .option('-k, --key <key>', 'try a key, e.g. D or Bb')
  .option('--mode <mode>', 'major or minor')
  .option('--seed <n>', 'try other chords, patterns and melody', (v) => parseInt(v, 10))
  .option('--all', 'write one WAV per style (<name>-score-<style>.wav) to compare them')
  .description("Write the spec's generated score alone to a WAV, without rendering the video")
  .action(async (spec: string, opts) => {
    const { writeScoreOnly } = await import('./score');
    const base: Record<string, unknown> = {};
    if (opts.style) base.style = opts.style;
    if (opts.key) base.key = opts.key;
    if (opts.mode) base.mode = opts.mode;
    if (opts.seed !== undefined) base.seed = opts.seed;
    const stem = spec.replace(/\.json$/i, '');
    const runs = opts.all
      ? ['warm', 'ambient', 'bright', 'cinematic', 'lofi', 'piano'].map((style) => ({ out: `${stem}-score-${style}.wav`, o: { ...base, style } }))
      : [{ out: opts.out ?? `${stem}-score.wav`, o: base }];
    for (const r of runs) {
      const { plan, key } = await writeScoreOnly(spec, r.out, r.o as Parameters<typeof writeScoreOnly>[2]);
      log.info(`${r.o.style ?? ''} ${key}, ${plan.bpm} bpm, ${plan.duration.toFixed(1)}s`.trim());
      if (!opts.all) for (const s of plan.sections) log.info(`  ${s.start.toFixed(2).padStart(6)}s  ${(s.id ?? String(s.index)).padEnd(14)} energy ${s.energy.toFixed(2)}`);
      log.success(`Wrote ${resolve(r.out)}`);
    }
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

program
  .command('compare')
  .argument('<spec>', 'path to the video spec (.json)')
  .argument('<reference>', 'video to compare against (same timing)')
  .option('--rate <n>', 'samples per second', '5')
  .option('--from <seconds>', 'start time')
  .option('--to <seconds>', 'end time')
  .option('--worst <n>', 'save this many of the worst moments side by side', '10')
  .option('-o, --out <dir>', 'folder for the side-by-side images', 'out/compare')
  .description('Score a render against a reference video moment by moment (for remakes), and save the worst matches side by side')
  .action(async (spec: string, reference: string, opts) => {
    const { compare } = await import('./compare');
    log.step(`Comparing ${spec} with ${reference}`);
    const r = await compare(spec, reference, {
      rate: Number(opts.rate), from: opts.from !== undefined ? Number(opts.from) : undefined, to: opts.to !== undefined ? Number(opts.to) : undefined,
      worst: Number(opts.worst), out: opts.out,
    });
    // Difference per second: 0 is identical; under ~6 reads as the same picture, over ~20 is a different picture.
    const bySec = new Map<number, number[]>();
    for (const s of r.samples) {
      const k = Math.floor(s.t);
      bySec.set(k, [...(bySec.get(k) ?? []), s.diff]);
    }
    for (const [sec, ds] of bySec) {
      const avg = ds.reduce((a, b) => a + b, 0) / ds.length;
      const bar = '#'.repeat(Math.min(40, Math.round(avg)));
      console.log(`  ${String(sec).padStart(4)}s  ${avg.toFixed(1).padStart(5)}  ${bar}`);
    }
    const mean = r.samples.reduce((a, b) => a + b.diff, 0) / Math.max(1, r.samples.length);
    log.info(`Mean difference ${mean.toFixed(2)} over ${r.samples.length} samples (0 = identical)`);
    log.info(`Worst moments, reference left: ${r.outDir}`);
    for (const w of r.worst) console.log(`  ${w.t.toFixed(2)}s  ${w.diff.toFixed(1)}`);
  });

program
  .command('check')
  .argument('<spec>', 'path to the video spec (.json)')
  .option('-f, --format <format>', `check a format: ${formatNames().join(', ')}`)
  .option('--hold <seconds>', 'report stretches without motion longer than this', '1.2')
  .option('--end-hold <seconds>', 'the same for the final shot', '2.5')
  .option('--rate <fps>', 'samples per second', '10')
  .option('--read <wps>', 'reading speed for the reading-time check, words per second', '4')
  .description('Play the video headlessly and report text that collides with other elements, text that leaves before it can be read, and stretches where nothing moves')
  .action(async (spec: string, opts) => {
    const { check } = await import('./check');
    const fmt = (t: number) => `${t.toFixed(2)}s`;
    log.step(`Checking ${spec}`);
    const r = await check(spec, { format: opts.format, hold: Number(opts.hold), endHold: Number(opts.endHold), rate: Number(opts.rate), read: Number(opts.read) });
    if (!r.collisions.length && !r.holds.length && !r.rushes.length) {
      log.success(`No collisions, all text stays long enough to read, nothing holds still for more than ${opts.hold}s`);
      return;
    }
    if (r.rushes.length) {
      log.warn(`${r.rushes.length} time${r.rushes.length > 1 ? "s" : ""} text leaves before it can be read`);
      for (const x of r.rushes) {
        const names = x.texts.slice(0, 4).map((t) => `"${t.length > 24 ? `${t.slice(0, 22)}..` : t}"`).join(', ') + (x.texts.length > 4 ? ` and ${x.texts.length - 4} more` : '');
        console.log(`  ${fmt(x.from)} - ${fmt(x.to)}  [${x.scene}]  ${x.words} words for ${(x.to - x.from).toFixed(1)}s, needs about ${x.need.toFixed(1)}s: ${names}`);
      }
    }
    if (r.collisions.length) {
      log.warn(`${r.collisions.length} collision${r.collisions.length > 1 ? 's' : ''}`);
      for (const c of r.collisions) console.log(`  ${fmt(c.from)} - ${fmt(c.to)}  [${c.scene}]  ${c.a}  overlaps  ${c.b}  (${Math.round(c.amount * 100)}%)`);
    }
    if (r.holds.length) {
      log.warn(`${r.holds.length} still stretch${r.holds.length > 1 ? 'es' : ''}`);
      for (const h of r.holds) console.log(`  ${fmt(h.from)} - ${fmt(h.to)}  [${h.scene}]  nothing moves for ${(h.to - h.from).toFixed(1)}s${h.end ? ' (final shot)' : ''}`);
    }
  });

program
  .command('remake')
  .argument('<video>', 'the video to recreate')
  .option('-o, --out <dir>', 'project folder (default projects/<video name>)')
  .option('--threshold <n>', 'scene change sensitivity, lower finds softer cuts', '8')
  .option('--overlay <opacity>', 'opacity of the reference drawn over each scene, 0 for none', '0.35')
  .option('--no-camera', 'skip measuring camera motion (faster)')
  .description('Start a recreation: find the shots, make a contact sheet per shot, measure camera motion and colors, and write a spec with one scene per shot')
  .action(async (video: string, o) => {
    const { remake } = await import('./remake');
    log.step(`Setting up a remake of ${video}`);
    const r = await remake(video, { out: o.out, threshold: Number(o.threshold), overlay: Number(o.overlay), noCamera: o.camera === false, log: (m) => log.info(m) });
    for (const s of r.shots) console.log(`  ${String(s.index).padStart(3)}  ${s.start.toFixed(2).padStart(6)}s  ${s.duration.toFixed(2).padStart(5)}s  ${s.background}  ${s.camera}`);
    log.success(`Wrote ${r.spec} and NOTES.md (${r.shots.length} shots)`);
  });

// ---------------------------------------------------------------- trace: measure a reference video for a remake

const trace = program.command('trace').description('Measure a reference video for a remake: dots, camera, text, letter timing, halftone');
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
async function emit(data: unknown, out?: string): Promise<void> {
  const text = JSON.stringify(data, null, 1);
  if (out) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(out, `${text}\n`);
    log.success(`Wrote ${out}`);
  } else console.log(text);
}

trace
  .command('dots')
  .argument('<video>', 'reference video')
  .requiredOption('--from <frame>', 'first frame')
  .requiredOption('--to <frame>', 'last frame')
  .option('--color <hex>', 'dot color to look for (default: anything unlike the background)')
  .option('--tolerance <n>', 'color distance that still counts')
  .option('--min <px>', 'smallest dot, video px', '3')
  .option('--max <px>', 'largest dot, video px', '160')
  .option('--gate <px>', 'furthest a dot may land from where it was heading', '90')
  .option('-o, --out <file>', 'write the tracks here (the `dots` layer format)')
  .description('Track every dot through a stretch of video; writes tracks for a `dots` layer (design px, frames of the video)')
  .action(async (video: string, o) => {
    const { traceDots } = await import('./trace/dots');
    const tracks = await traceDots(video, { from: +o.from, to: +o.to, color: o.color, tolerance: num(o.tolerance), minSize: +o.min, maxSize: +o.max, gate: +o.gate });
    log.info(`${tracks.length} tracks over frames ${o.from}-${o.to}`);
    await emit(tracks, o.out);
  });

trace
  .command('camera')
  .argument('<video>', 'reference video')
  .requiredOption('--from <frame>', 'first frame')
  .requiredOption('--to <frame>', 'last frame')
  .option('--anchor <frame>', 'frame whose layout the transforms map from (default --from)')
  .option('-o, --out <file>', 'write the result here')
  .description('Follow the camera: scale and shift per frame relative to an anchor frame, plus keyframes for a group laid out in that frame')
  .action(async (video: string, o) => {
    const { traceCamera } = await import('./trace/camera');
    const r = await traceCamera(video, { from: +o.from, to: +o.to, anchor: num(o.anchor) });
    if (r.lost.length) log.warn(`Lost the picture at frame ${r.lost.join(', ')} (a cut?). Trace each shot separately.`);
    await emit(r, o.out);
  });

trace
  .command('text')
  .argument('<video>', 'reference video or image')
  .requiredOption('--text <string>', 'the text as it reads')
  .requiredOption('--font <file>', 'font file (.ttf/.otf) to fit')
  .option('--frame <n>', 'frame to measure', '0')
  .option('--region <x0,y0,x1,y1>', 'where the line is, video px')
  .option('--family <name>', 'font family name for the layer')
  .option('--weight <n>', 'weight for the layer', '400')
  .option('-o, --out <file>', 'write the result here')
  .description('Fit a line of text: size, baseline, color, and a text layer that lands on it')
  .action(async (video: string, o) => {
    const { traceText } = await import('./trace/text');
    await emit(await traceText(video, { frame: +o.frame, region: o.region, text: o.text, font: o.font, family: o.family, weight: +o.weight }), o.out);
  });

trace
  .command('reveal')
  .argument('<video>', 'reference video')
  .requiredOption('--text <string>', 'the text as it reads')
  .requiredOption('--font <file>', 'font file used by `trace text`')
  .requiredOption('--size <px>', 'size from `trace text`')
  .requiredOption('--left <px>', 'inkLeft from `trace text`')
  .requiredOption('--baseline <px>', 'baseline from `trace text`')
  .requiredOption('--from <frame>', 'first frame')
  .requiredOption('--to <frame>', 'last frame')
  .option('--color <hex>', 'text color from `trace text` (recommended: other colors passing by are ignored)')
  .option('-o, --out <file>', 'write the result here')
  .description('When each letter of a line appears; gives `times` for a text animation')
  .action(async (video: string, o) => {
    const { traceReveal } = await import('./trace/text');
    await emit(await traceReveal(video, { from: +o.from, to: +o.to, text: o.text, font: o.font, size: +o.size, inkLeft: +o.left, baseline: +o.baseline, color: o.color }), o.out);
  });

trace
  .command('halftone')
  .argument('<video>', 'reference video or image')
  .requiredOption('--region <x0,y0,x1,y1>', 'the dotted area, video px')
  .requiredOption('-o, --out <file.png>', 'dot map to write (one pixel per dot)')
  .option('--frame <n>', 'frame to read', '0')
  .option('--color <hex>', 'dot color (default: found)')
  .option('--pitch <px>', 'dot spacing, video px (default: found)')
  .description('Read a halftone: dot pitch and each dot size, as an image for `halftone` with `levels` [0, 1]')
  .action(async (video: string, o) => {
    const { traceHalftone } = await import('./trace/halftone');
    await emit(await traceHalftone(video, { frame: +o.frame, region: o.region, color: o.color, pitch: num(o.pitch), out: o.out }));
  });

program.parseAsync(process.argv).catch((e) => {
  log.error((e as Error).message);
  process.exit(1);
});
