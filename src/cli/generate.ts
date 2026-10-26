import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { PKG_ROOT } from './server';
import { captureFrames, still } from './render';
import { validateVideo, type Video } from '../spec/schema';
import { layoutScenes } from '../spec/time';
import { log } from './log';
import { ApiBackend, ClaudeCodeBackend, type Backend, type Part } from './backends';

export type BackendChoice = 'auto' | 'api' | 'claude-code';

export interface GenerateOptions {
  out: string;
  images?: string[];
  /** The product's website: its brand (logo, colors, fonts, copy, screenshots) is imported first. */
  url?: string;
  /** Techniques from the library (keys or search words); techniques the prompt names are added too. */
  refs?: string[];
  review?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxFixes?: number;
  /** api: Anthropic SDK with an API key. claude-code: headless `claude -p` with the signed-in account. */
  backend?: BackendChoice;
  /** Model for the claude-code backend (alias or full id). */
  model?: string;
}

const ROLE = `You are a senior motion designer and creative director who builds launch-grade SaaS advertisements (think Linear, Vercel, Stripe and Apple launch films) using Bemotion, a code-driven motion graphics engine with real 3D, kinetic typography, camera moves, motion blur and shader transitions.

You write Bemotion scene specs: a single JSON document that follows the reference below exactly. The engine validates the JSON strictly (unknown fields are errors), so only use fields documented in the reference.

How to respond:
- Return the complete spec as one fenced \`\`\`json code block. No other code blocks.
- Before the code block, write at most three short lines on the creative concept (hook, story beats, look).
- Choose the Flow, Minimal or Hype style from the brief (section 9 of the reference) and follow that style's rules strictly. Default to Flow when the brief does not say.
- In Flow, tell the story as one continuous journey: every beat should morph, fly, dive or fold into the next (camera moveTo dives, shape morphs, motion paths with trails, depth-of-field rack focus, scatter clouds), and the cursor's clicks should cause what happens next.
- Every scene has intentional motion and camera movement appropriate to the style.
- Create an original concept for the brief's product. Never recreate a specific existing advertisement shot for shot.
- Invent believable product UI (sidebars, metrics, charts, notifications, cursor interactions) that sells the product described in the brief.
- Keep copy short and punchy. Never use emojis.`;

export function extractJson(text: string): string | null {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length) return blocks[blocks.length - 1];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

function mediaType(file: string): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' {
  const e = extname(file).toLowerCase();
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  return 'image/png';
}

async function buildSystem(): Promise<{ role: string; reference: string }> {
  const spec = await readFile(join(PKG_ROOT, 'docs/SPEC.md'), 'utf8');
  const flow = await readFile(join(PKG_ROOT, 'examples/clipfold-flow.json'), 'utf8');
  const minimal = await readFile(join(PKG_ROOT, 'examples/tempo-apple.json'), 'utf8');
  const hype = await readFile(join(PKG_ROOT, 'examples/flowstack-launch.json'), 'utf8');
  return {
    role: ROLE,
    reference: `<reference>
${spec}
</reference>

Three complete, approved ads follow, one per style. Match their level of craft; do not copy their products or copy.

<example name="clipfold-flow.json" style="flow">
${flow}
</example>

<example name="tempo-apple.json" style="minimal">
${minimal}
</example>

<example name="flowstack-launch.json" style="hype">
${hype}
</example>`,
  };
}

/** Picks the backend: an API key wins; otherwise the local Claude Code sign-in. */
export function pickBackend(o: GenerateOptions, system: { role: string; reference: string }, workDir: string): Backend {
  const choice = o.backend ?? 'auto';
  const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (choice === 'api' || (choice === 'auto' && hasKey)) return new ApiBackend(system, o.effort ?? 'high');
  if (choice === 'claude-code' || ClaudeCodeBackend.available()) return new ClaudeCodeBackend(system, workDir, o.model ?? 'opus', o.effort ?? 'high');
  throw new Error('No way to reach Claude: set ANTHROPIC_API_KEY (or run `ant auth login`), or install and sign in to Claude Code to use --backend claude-code.');
}

/** Ask Claude for a spec until it parses and validates, feeding errors back. */
async function untilValid(backend: Backend, first: string, maxFixes: number): Promise<Video> {
  let text = first;
  for (let attempt = 0; ; attempt++) {
    const raw = extractJson(text);
    let errors: string[];
    if (!raw) {
      errors = ['No JSON code block found in the response.'];
    } else {
      try {
        const v = validateVideo(JSON.parse(raw));
        if (v.ok && v.video) return v.video;
        errors = v.errors;
      } catch (e) {
        errors = [`JSON syntax error: ${(e as Error).message}`];
      }
    }
    if (attempt >= maxFixes) throw new Error(`Spec still invalid after ${maxFixes} fix attempts:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    log.warn(`Spec has ${errors.length} validation error(s), asking for a fix`);
    text = await backend.send(
      [{ type: 'text', text: `The spec failed validation:\n${errors.slice(0, 40).map((e) => `- ${e}`).join('\n')}\n\nFix every error and return the complete corrected spec as one json code block.` }],
      `Fixing spec (attempt ${attempt + 1})`,
    );
  }
}

/**
 * Picks review frames: one mid-scene and one late in each scene (after entrances settle), and the
 * middle of every transition, where a weak handoff shows.
 */
export function reviewTimes(video: Video, max = 24): { t: number; label: string }[] {
  const { scenes } = layoutScenes(video.scenes, { fps: video.fps ?? 30, bpm: video.bpm });
  const out: { t: number; label: string }[] = [];
  scenes.forEach((s, i) => {
    const id = video.scenes[i].id ?? `scene ${i + 1}`;
    if (i > 0 && s.transitionIn > 0.2) {
      const t = s.start + s.transitionIn / 2;
      out.push({ t, label: `transition into ${id} at ${t.toFixed(2)}s (halfway)` });
    }
    const settle = s.start + s.transitionIn;
    const mid = settle + (s.end - settle) * 0.45;
    const late = settle + (s.end - settle) * 0.85;
    out.push({ t: mid, label: `${id} at ${mid.toFixed(2)}s (mid)` }, { t: late, label: `${id} at ${late.toFixed(2)}s (settled)` });
  });
  if (out.length <= max) return out;
  // Too many: keep an even spread.
  return Array.from({ length: max }, (_, k) => out[Math.round((k * (out.length - 1)) / (max - 1))]);
}

const CHECKLIST = `Review them as a creative director would before a launch:
- Text cut off, overflowing the frame, or overlapping other elements
- Elements colliding, misaligned, or crowding the edges (safe area x in [-860, 860], y in [-470, 470])
- Copy that is hard to read (contrast, busy or bright backgrounds behind it)
- Product UI or copy too small to read on a phone: UI text under 20 px on screen, a whole app shown wide for more than 1.5 s, a small card floating in an empty canvas. Dive the camera in on the part that matters (\`moveTo\` with \`target\` and \`zoom\`), scale it up, or show fewer, larger elements
- Empty or static-looking frames, weak hierarchy, or anything that looks like a slideshow rather than a premium launch film
- Transitions: the halfway frames should look designed, not like two shots fading through each other
- 3D objects covering copy
- The chosen style's rules (section 9 of the reference), and the brand's colors and fonts when one was given`;

/**
 * Render-and-review rounds: frames plus the measured findings of `check` (collisions, text that
 * leaves too soon, still stretches). A round passes when the frames are approved and nothing was
 * measured; otherwise the reply's corrected spec is validated, saved and reviewed again.
 */
async function reviewRounds(
  backend: Backend,
  outPath: string,
  video: Video,
  rounds: number,
  maxFixes: number,
  context = '',
): Promise<{ video: Video; approved: boolean; findings: string[]; notes: string }> {
  const { check, findingLines } = await import('./check');
  let findings: string[] = [];
  // What the reviewer wrote before its spec (one short line), for the auto director's status.
  let notes = '';
  // What the file held when the review last read or wrote it: edits made meanwhile (in the preview) win.
  let expected = await readFile(outPath, 'utf8').catch(() => '');
  for (let round = 1; round <= rounds; round++) {
    log.step(`Review round ${round} of ${rounds}: checking and rendering frames`);
    findings = findingLines(await check(outPath));
    const shots = reviewTimes(video);
    const frames = await captureFrames(outPath, video, shots.map((s) => s.t));
    const parts: Part[] = [];
    if (round === 1 && context) parts.push({ type: 'text', text: context });
    frames.forEach((buf, i) => {
      parts.push({ type: 'text', text: `Frame ${i + 1}: ${shots[i].label}` });
      parts.push({ type: 'image', mediaType: 'image/jpeg', data: buf });
    });
    const measured = findings.length
      ? [
          '',
          'Playing the video headlessly also measured these problems (times are in seconds of the video):',
          ...findings.map((f) => `- ${f}`),
          '',
          'Fix every one of them (move or resize the layers, give text more time, add motion to still stretches) unless it is clearly intended, and say which you kept and why.',
        ].join('\n')
      : '';
    const ask = findings.length
      ? 'Return the complete corrected spec as one json code block.'
      : 'If the frames are launch-ready, reply with exactly APPROVED and nothing else. Otherwise list the problems briefly and return the complete corrected spec as one json code block.';
    parts.push({ type: 'text', text: `These frames were rendered from the spec. ${CHECKLIST}\n${measured}\n\n${ask}` });
    log.info(`${frames.length} frames, ${findings.length} measured problem${findings.length === 1 ? '' : 's'}`);
    const reply = await backend.send(parts, `Reviewing ${frames.length} frames`);
    notes = reply.split('```')[0].replace(/\s+/g, ' ').trim().slice(0, 240);
    if (/^\s*APPROVED\s*$/i.test(reply) || !extractJson(reply)) {
      if (findings.length) log.warn('The review kept the spec despite the measured problems');
      else log.success('Review approved the spec');
      return { video, approved: !findings.length, findings, notes };
    }
    video = await untilValid(backend, reply, maxFixes);
    const text = JSON.stringify(video, null, 2) + '\n';
    if ((await readFile(outPath, 'utf8').catch(() => '')) !== expected) {
      const aside = outPath.replace(/\.json$/i, '') + '.review.json';
      await writeFile(aside, text);
      throw new Error(`The spec was edited while the review ran, so the revision was not applied. It is saved as ${aside}.`);
    }
    await writeFile(outPath, text);
    expected = text;
    log.success(`Revised ${outPath}`);
  }
  // The last revision has not been looked at: report what check measures on it.
  findings = findingLines(await check(outPath));
  return { video, approved: false, findings, notes };
}

export interface ReviewOptions {
  rounds?: number;
  /** Also address the open comments left in the preview, and resolve them once revised. */
  comments?: boolean;
  effort?: GenerateOptions['effort'];
  backend?: BackendChoice;
  model?: string;
  maxFixes?: number;
}

/** Reviews an existing spec (hand-written, from the skill or an earlier generate) and revises it in place. */
export async function review(specPath: string, o: ReviewOptions = {}): Promise<{ approved: boolean; findings: string[]; revised: boolean; resolved: number; notes: string }> {
  const path = resolve(specPath);
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const v = validateVideo(raw);
  if (!v.ok || !v.video) throw new Error(`Invalid spec:\n${v.errors.map((e) => `  - ${e}`).join('\n')}`);
  const backend = pickBackend({ out: path, ...o }, await buildSystem(), join(dirname(path), '.bemotion-generate'));
  log.step(`Reviewing with ${backend.name}`);
  const fence = '```';
  let context = `This is the spec under review:\n\n${fence}json\n${JSON.stringify(raw, null, 2)}\n${fence}\n\nKeep its concept, copy and brand; change only what the review finds.`;
  // Comments left in the preview: the person's own notes, to address first.
  const { readComments, applyComment, commentLines } = await import('./comments');
  const open = o.comments ? (await readComments(path)).filter((c) => !c.resolved) : [];
  if (open.length) {
    context += `\n\nThe person reviewing the video left these comments at moments of it (output seconds, the scene and the time inside it, the layer they had selected). Address every one; they come before your own findings:\n${commentLines(open).map((l) => `- ${l}`).join('\n')}`;
    log.info(`${open.length} open comment${open.length === 1 ? '' : 's'} from the preview`);
  }
  const r = await reviewRounds(backend, path, v.video, o.rounds ?? 2, o.maxFixes ?? 3, context);
  // Revised with the comments in hand: mark them resolved (they can be reopened in the preview).
  const revised = JSON.stringify(JSON.parse(await readFile(path, 'utf8'))) !== JSON.stringify(raw);
  if (open.length && revised) {
    for (const c of open) await applyComment(path, { op: 'resolve', id: c.id, resolved: true });
    log.success(`Resolved ${open.length} comment${open.length === 1 ? '' : 's'}`);
  }
  log.info(backend.summary());
  return { approved: r.approved, findings: r.findings, revised, resolved: revised ? open.length : 0, notes: r.notes };
}

/** Different takes for variants: each sets a concept, pacing and music style. */
export const DIRECTIONS = [
  {
    key: 'flow',
    name: 'Flow journey',
    text: 'Flow style: one continuous journey where every beat morphs, flies or dives into the next, with a cursor whose clicks cause what happens. 25 to 30 seconds. Music: a generated score, "score": { "style": "warm" }.',
  },
  {
    key: 'minimal',
    name: 'Minimal keynote',
    text: 'Minimal style, an Apple keynote film: few words, one accent color, slow lifts and a calm product reveal. About 20 seconds. Music: "score": { "style": "ambient" }.',
  },
  {
    key: 'punchy',
    name: 'Punchy cut',
    text: 'Fast and confident: about 15 seconds of short scenes, bold type that fills the frame, camera punches on the reveals (Hype motion rules, but keep the brand look). Music: "score": { "style": "bright" }.',
  },
  {
    key: 'story',
    name: 'Customer story',
    text: 'A story: open on one person and a specific problem, show the product solving it step by step with the cursor, land on the result and the product. Flow style, about 30 seconds. Music: "score": { "style": "warm", "energy": { "0": 0.2 } } so it starts quietly.',
  },
] as const;

interface Prepared {
  assets: { name: string; file: string }[];
  brandText: string;
  references: string;
}

/** Copies the user's images next to the spec and imports the brand: shared by every variant. */
async function prepare(prompt: string, o: GenerateOptions, outDir: string): Promise<Prepared> {
  const assets: { name: string; file: string }[] = [];
  for (const img of o.images ?? []) {
    const name = `assets/${basename(img)}`;
    await mkdir(join(outDir, 'assets'), { recursive: true });
    await copyFile(resolve(img), join(outDir, name));
    assets.push({ name, file: join(outDir, name) });
  }
  // Brand import: the site's own logo, colors, fonts, copy and screenshots.
  let brandText = '';
  if (o.url) {
    const { importBrand, describeBrand } = await import('./brand');
    log.step('Importing the brand');
    const b = await importBrand(o.url, join(outDir, 'brand'));
    brandText = describeBrand(b, 'brand/');
    const picks = [b.logo, b.screenshots[0], ...b.images.slice(0, 2), ...b.screenshots.slice(1, 3)].filter((f): f is string => !!f);
    for (const f of picks) {
      const file = join(outDir, 'brand', f);
      // The API takes images up to 5 MB; larger ones stay usable in the spec but are not shown.
      if ((await stat(file)).size < 4.5e6 && !/\.svg$/i.test(f)) assets.push({ name: `brand/${f}`, file });
    }
  }
  // Techniques from the library: asked for with --ref, or named in the prompt.
  const { loadRefs, namedInPrompt, pickRefs, refContext } = await import('./refs');
  const lib = await loadRefs();
  const picked = pickRefs(lib, o.refs ?? []);
  for (const t of namedInPrompt(lib, prompt)) if (!picked.includes(t)) picked.push(t);
  if (picked.length) log.info(`Techniques: ${picked.map((t) => t.name).join(', ')}`);
  return { assets, brandText, references: refContext(picked) };
}

/** One conversation: write the spec, fix it until valid, review it. */
async function writeOne(prompt: string, prep: Prepared, o: GenerateOptions, outPath: string, direction?: string): Promise<{ path: string; findings: string[] }> {
  const backend = pickBackend(o, await buildSystem(), join(dirname(outPath), '.bemotion-generate', basename(outPath, '.json')));
  log.step(`Generating ${basename(outPath)} with ${backend.name}`);
  const { assets, brandText } = prep;
  const parts: Part[] = [];
  for (const a of assets) parts.push({ type: 'image', mediaType: mediaType(a.file), data: await readFile(a.file), file: a.file });
  const sections = [`<brief>\n${prompt || 'An ad for the product on the website below.'}\n</brief>`];
  if (direction) sections.push(`<direction>\n${direction}\n</direction>\n\nFollow this direction for concept, pacing and music. Where the brief is specific (length, style, music), the brief wins.`);
  if (brandText) {
    sections.push(
      `<brand>\n${brandText}\n</brand>\n\nThis brand was imported from the product's website. Use it: the colors for the theme and accents, the fonts exactly as given (copy the fonts entry into the spec and set theme.fonts), the logo on the end card, and the screenshots as the real product (inside a browser or device frame, or cropped to one panel and zoomed). Draw new copy from the headlines but keep lines short. Match the site's light or dark look.`,
    );
  }
  if (prep.references) sections.push(prep.references);
  if (assets.length) {
    sections.push(`The images above are the user's assets. They are available to the spec as: ${assets.map((a) => `"${a.name}"`).join(', ')}. Use product screenshots inside a browser, phone or laptop where they fit.`);
  }
  const { stockProvider } = await import('./stock');
  sections.push(
    stockProvider()
      ? 'Stock photos are available: an image whose "src" is "stock:<a few descriptive words>" (for example "stock:team meeting in a bright office") is found and downloaded when the spec first renders. Use them for people, places and moods the product shots cannot show, never in place of the product itself.'
      : 'No stock photo key is set: do not use "stock:" image sources.',
  );
  sections.push('Write the full Bemotion spec for this ad.');
  parts.push({ type: 'text', text: sections.join('\n\n') });
  const first = await backend.send(parts, `Writing ${basename(outPath)}`);
  const video = await untilValid(backend, first, o.maxFixes ?? 3);
  await writeFile(outPath, JSON.stringify(video, null, 2) + '\n');
  log.success(`Wrote ${outPath}`);
  let findings: string[] = [];
  if ((o.review ?? 2) > 0) {
    const r = await reviewRounds(backend, outPath, video, o.review ?? 2, o.maxFixes ?? 3);
    findings = r.findings;
    if (findings.length) log.warn(`${basename(outPath)}: ${findings.length} problem${findings.length === 1 ? '' : 's'} left (run bemotion check ${outPath} for details)`);
  }
  log.info(`${basename(outPath)}: ${backend.summary()}`);
  return { path: outPath, findings };
}

export async function generate(prompt: string, o: GenerateOptions): Promise<string> {
  const outPath = resolve(o.out);
  const outDir = dirname(outPath);
  await mkdir(outDir, { recursive: true });
  const prep = await prepare(prompt, o, outDir);
  return (await writeOne(prompt, prep, o, outPath)).path;
}

export interface Variant {
  key: string;
  name: string;
  path: string;
  sheet?: string;
  findings: string[];
  error?: string;
}

/**
 * Several different ads from one prompt, written and reviewed in parallel, each with a contact sheet
 * (`<name>-<key>.png`) to compare them side by side.
 */
export async function generateVariants(prompt: string, o: GenerateOptions & { variants: number }): Promise<Variant[]> {
  const outPath = resolve(o.out);
  const outDir = dirname(outPath);
  await mkdir(outDir, { recursive: true });
  const prep = await prepare(prompt, o, outDir);
  const picks = DIRECTIONS.slice(0, Math.max(1, Math.min(DIRECTIONS.length, o.variants)));
  const stem = basename(outPath, '.json');
  log.step(`Writing ${picks.length} variants: ${picks.map((d) => d.name).join(', ')}`);
  const results = await Promise.all(
    picks.map(async (d): Promise<Variant> => {
      const path = join(outDir, `${stem}-${d.key}.json`);
      try {
        const r = await writeOne(prompt, prep, o, path, d.text);
        return { key: d.key, name: d.name, path, findings: r.findings };
      } catch (e) {
        log.error(`${d.name}: ${(e as Error).message}`);
        return { key: d.key, name: d.name, path, findings: [], error: (e as Error).message };
      }
    }),
  );
  // Contact sheets, one at a time (each opens a browser).
  for (const v of results) {
    if (v.error) continue;
    try {
      const raw = JSON.parse(await readFile(v.path, 'utf8'));
      const val = validateVideo(raw);
      if (!val.ok || !val.video) continue;
      const times = reviewTimes(val.video, 12).filter((s) => !s.label.includes('halfway')).map((s) => Number(s.t.toFixed(2)));
      v.sheet = join(outDir, `${stem}-${v.key}.png`);
      await still(v.path, times, join(outDir, '.bemotion-generate', `${stem}-${v.key}`, 'f_{t}.png'), { sheet: v.sheet, cols: 4 });
    } catch (e) {
      log.warn(`No contact sheet for ${v.name}: ${(e as Error).message}`);
    }
  }
  return results;
}
