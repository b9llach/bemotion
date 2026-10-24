import type { Video } from '../spec/schema';
import type { SceneTiming } from '../spec/time';

/**
 * Voiceover timing in the engine. With word times from the server (spec audio track with `script`):
 * - `lineTargets` pairs each top-level line of type with the moment its first words are spoken, for
 *   the time warp that makes the video follow the voice (`align`);
 * - `captionLayers` turns the words into phrase captions for each scene (`captions`).
 */
export interface Word {
  text: string;
  /** Output time, seconds. */
  start: number;
  end: number;
}

/** Layer specs the engine adds (captions): the editor leaves them alone. */
export const generated = new WeakSet<object>();

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9%$]+/g, ' ').trim();
const tokens = (s: string) => norm(s).split(' ').filter(Boolean);

/** How far ahead of its first spoken word a line starts, so its entrance lands as the word is said. */
const LEAD = 0.12;

/**
 * [design time, output time] for each line whose words are found in the narration, in order. Lines are
 * top-level text layers (by start, scene by scene) and the steps of morphing text; each is looked up
 * from where the previous one was found, so repeated words match in order.
 */
export function lineTargets(video: Video, timings: SceneTiming[], words: Word[], toSeconds: (v: unknown) => number): [number, number][] {
  type Line = { t: number; toks: string[] };
  const lines: Line[] = [];
  video.scenes.forEach((s, i) => {
    for (const l of s.layers) {
      if (l.type !== 'text') continue;
      const start = l.start === undefined ? 0 : toSeconds(l.start);
      lines.push({ t: timings[i].start + start, toks: tokens(l.text) });
      for (const m of l.morph ?? []) {
        // A morph step is said where its new words begin.
        const before = new Set(tokens(l.text));
        const fresh = tokens(m.text).filter((w) => !before.has(w));
        if (fresh.length) lines.push({ t: timings[i].start + toSeconds(m.at), toks: fresh });
      }
    }
  });
  lines.sort((a, b) => a.t - b.t);
  const spoken = words.map((w) => norm(w.text));
  const out: [number, number][] = [];
  let cursor = 0;
  for (const line of lines) {
    if (!line.toks.length) continue;
    // Numbers may be written as digits on screen and spoken as words: match on the words around them.
    const need = line.toks.filter((w) => !/\d/.test(w)).slice(0, 2);
    if (!need.length) continue;
    for (let k = cursor; k < spoken.length; k++) {
      if (spoken[k] !== need[0]) continue;
      // The second word must follow within a few words (a number read out, or a filler word, may sit between).
      const ok = need.length < 2 || [1, 2, 3, 4].some((d) => spoken[k + d] === need[1]);
      if (!ok) continue;
      out.push([line.t, Math.max(0, words[k].start - LEAD)]);
      cursor = k + need.length;
      break;
    }
  }
  return out;
}

export interface CaptionStyle {
  size?: number;
  color?: string;
  y?: number;
  weight?: number;
  font?: string;
  maxWords?: number;
}

/** Splits the narration into caption phrases: at pauses, sentence ends, and every few words. */
export function phrases(words: Word[], maxWords = 6): Word[] {
  const out: Word[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) out.push({ text: cur.map((w) => w.text).join(' '), start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    const pause = next ? next.start - w.end : Infinity;
    const end = (x: Word) => /[.!?]["')\]]*$/.test(x.text);
    const comma = (x: Word) => /[,;:]["')\]]*$/.test(x.text);
    // At the word limit, run on to a comma or sentence end a word or two away (no orphans).
    const tail = words.slice(i + 1, i + 3).findIndex((x) => end(x) || comma(x));
    const full = cur.length >= maxWords && tail < 0;
    if (pause > 0.3 || end(w) || (comma(w) && cur.length >= 2) || full) flush();
  });
  flush();
  return out;
}

/**
 * Caption layers per scene, in scene-local design time. A phrase shows from its first word until the
 * next phrase (or a moment after its last word), words revealing as they are said. A phrase running
 * across a scene change continues in the next scene without its entrance.
 */
export function captionLayers(words: Word[], toDesign: (t: number) => number, timings: SceneTiming[], height: number, style: CaptionStyle = {}): Record<string, unknown>[][] {
  const per: Record<string, unknown>[][] = timings.map(() => []);
  const list = phrases(words, style.maxWords ?? 6);
  list.forEach((p, i) => {
    const next = list[i + 1];
    const showEnd = Math.min(next ? next.start : Infinity, p.end + 0.6);
    const a = toDesign(p.start);
    const b = toDesign(showEnd);
    const n = p.text.split(' ').length;
    const stagger = n > 1 ? Math.max(0.04, (toDesign(p.end) - a) / n) : 0;
    timings.forEach((tm, s) => {
      const from = Math.max(a, tm.start);
      const to = Math.min(b, tm.end);
      if (to - from < 0.05) return;
      const first = from === a;
      const layer: Record<string, unknown> = {
        type: 'text',
        text: p.text,
        size: style.size ?? 44,
        weight: style.weight ?? 600,
        font: style.font ?? 'body',
        color: style.color ?? '$text',
        y: style.y ?? -height * 0.36,
        start: from - tm.start,
        end: to - tm.start,
        dof: false,
        ...(first ? { animate: { preset: 'rise', by: 'word', stagger, duration: 0.3, distance: 10 } } : {}),
      };
      generated.add(layer);
      per[s].push(layer);
    });
  });
  return per;
}
