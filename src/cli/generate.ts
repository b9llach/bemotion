import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { PKG_ROOT } from './server';
import { captureFrames } from './render';
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
function pickBackend(o: GenerateOptions, system: { role: string; reference: string }, workDir: string): Backend {
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

/** Picks review frames: one mid-scene and one late in each scene, after entrances settle. */
function reviewTimes(video: Video): { t: number; label: string }[] {
  const { scenes } = layoutScenes(video.scenes, { fps: video.fps ?? 30, bpm: video.bpm });
  const out: { t: number; label: string }[] = [];
  scenes.forEach((s, i) => {
    const id = video.scenes[i].id ?? `scene ${i + 1}`;
    const settle = s.start + s.transitionIn;
    const mid = settle + (s.end - settle) * 0.45;
    const late = settle + (s.end - settle) * 0.85;
    out.push({ t: mid, label: `${id} at ${mid.toFixed(2)}s (mid)` }, { t: late, label: `${id} at ${late.toFixed(2)}s (settled)` });
  });
  return out.slice(0, 18);
}

export async function generate(prompt: string, o: GenerateOptions): Promise<string> {
  const outPath = resolve(o.out);
  const outDir = dirname(outPath);
  await mkdir(outDir, { recursive: true });
  const workDir = join(outDir, '.bemotion-generate');

  // Copy reference images next to the spec so the video can use them.
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

  const backend = pickBackend(o, await buildSystem(), workDir);
  log.step(`Generating with ${backend.name}`);
  const parts: Part[] = [];
  for (const a of assets) parts.push({ type: 'image', mediaType: mediaType(a.file), data: await readFile(a.file), file: a.file });
  parts.push({
    type: 'text',
    text: `<brief>\n${prompt || 'An ad for the product on the website below.'}\n</brief>${
      brandText
        ? `\n\n<brand>\n${brandText}\n</brand>\n\nThis brand was imported from the product's website. Use it: the colors for the theme and accents, the fonts exactly as given (copy the fonts entry into the spec and set theme.fonts), the logo on the end card, and the screenshots as the real product (inside a browser or device frame, or cropped to one panel and zoomed). Draw new copy from the headlines but keep lines short. Match the site's light or dark look.`
        : ''
    }${
      assets.length
        ? `\n\nThe images above are the user's assets. They are available to the spec as: ${assets.map((a) => `"${a.name}"`).join(', ')}. Use product screenshots inside a browser, phone or laptop where they fit.`
        : ''
    }\n\nWrite the full Bemotion spec for this ad.`,
  });
  const first = await backend.send(parts, 'Writing spec');
  let video = await untilValid(backend, first, o.maxFixes ?? 3);
  await writeFile(outPath, JSON.stringify(video, null, 2) + '\n');
  log.success(`Wrote ${outPath}`);

  for (let round = 1; round <= (o.review ?? 1); round++) {
    log.step(`Review round ${round}: rendering frames`);
    const shots = reviewTimes(video);
    const frames = await captureFrames(outPath, video, shots.map((s) => s.t));
    const review: Part[] = [];
    frames.forEach((buf, i) => {
      review.push({ type: 'text', text: `Frame ${i + 1}: ${shots[i].label}` });
      review.push({ type: 'image', mediaType: 'image/jpeg', data: buf });
    });
    review.push({
      type: 'text',
      text: `These frames were rendered from your spec. Review them as a creative director would before a launch:
- Text cut off, overflowing the frame, or overlapping other elements
- Elements colliding, misaligned, or crowding the edges (safe area x in [-860, 860], y in [-470, 470])
- Copy that is hard to read (contrast, busy or bright backgrounds behind it)
- Empty or static-looking frames, weak hierarchy, or anything that looks like a slideshow rather than a premium launch film
- 3D objects covering copy

If the frames are launch-ready, reply with exactly APPROVED and nothing else. Otherwise list the problems briefly and return the complete corrected spec as one json code block.`,
    });
    const reply = await backend.send(review, `Reviewing ${frames.length} frames`);
    if (/^\s*APPROVED\s*$/i.test(reply) || !extractJson(reply)) {
      log.success('Review approved the spec');
      break;
    }
    video = await untilValid(backend, reply, o.maxFixes ?? 3);
    await writeFile(outPath, JSON.stringify(video, null, 2) + '\n');
    log.success(`Revised ${outPath}`);
  }

  log.info(backend.summary());
  return outPath;
}
