/**
 * The score: music composed for a video and synthesized here, so there is nothing to license and the
 * same spec always gives the same track. Runs in Node (renders) and in the browser (preview).
 *
 * The composer follows a plan (src/spec/score.ts): a section per scene, starting on the beat where
 * the scene cuts in, each with an energy. Chords change with the sections (a cadence leads into the
 * last scene, which resolves on the tonic), and energy decides who plays: a pad and electric piano
 * throughout, bass from low energy, plucked guitar and brushed drums as it builds, a bell melody at
 * the peak. Every note is synthesized (FM electric piano, band-limited saw pad, Karplus-Strong guitar,
 * sine bass, noise drums) and mixed through a hall reverb.
 */
import { SR, type Stereo } from './sfx';
import { scoreTempo, type ScorePlan, type ScoreSpec, type ScoreStyle } from '../spec/score';

function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOTE: Record<string, number> = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
/** Keys that sit well for these instruments, for a score without one. */
const GOOD_KEYS = ['C', 'D', 'Eb', 'F', 'G', 'A', 'Bb'];
const mtof = (m: number) => 440 * 2 ** ((m - 69) / 12);
const mod12 = (x: number) => ((x % 12) + 12) % 12;

export type Inst = 'keys' | 'piano' | 'pad' | 'pluck' | 'stab' | 'bass' | 'bell' | 'kick' | 'snare' | 'clap' | 'shaker' | 'boom' | 'swell' | 'cymbal';

export interface NoteEvent {
  inst: Inst;
  /** Seconds. */
  t: number;
  dur: number;
  midi: number;
  vel: number;
  pan: number;
}

interface Chord {
  /** Pitch class of the bass note. */
  bass: number;
  /** Pitch classes of the four upper voices. */
  tones: number[];
}

/** Loops of scale degrees (0 = tonic). Calm ones change every two bars. */
const LOOPS = {
  major: [[0, 4, 5, 3], [5, 3, 0, 4], [3, 4, 2, 5], [0, 2, 3, 4], [3, 0, 4, 5], [0, 5, 3, 4], [1, 4, 0, 3]],
  minor: [[0, 5, 2, 6], [0, 3, 5, 4], [5, 6, 0, 0], [0, 6, 5, 6], [3, 4, 0, 5]],
};
const CALM = {
  major: [[0, 3], [3, 0], [0, 5]],
  minor: [[0, 5], [5, 0], [0, 3]],
};
/** Leads into the final scene's tonic. */
const CADENCE = { major: [3, 4], minor: [5, 6] };

/** A seventh chord on a scale degree, with the ninth instead of the root when the ninth is major. */
function chordOn(degree: number, scale: number[], key: number, sus: boolean): Chord {
  const deg = (k: number) => scale[(degree + k) % 7] + 12 * Math.floor((degree + k) / 7);
  const root = deg(0);
  const ninth = deg(8);
  const third = sus ? deg(3) : deg(2);
  const tones = mod12(ninth - root) === 2 ? [third, deg(4), deg(6), ninth] : [root, third, deg(4), deg(6)];
  return { bass: mod12(key + root), tones: tones.map((x) => mod12(key + x)) };
}

/** Places pitch classes as close to the previous voicing as possible, centred around E4. */
function voice(tones: number[], prev: number[] | null, lo = 53, hi = 77): number[] {
  const cands: number[][] = [];
  for (let base = lo; base < lo + 12; base++) {
    // Stack the tones upward from the first one at or above `base`, in every rotation.
    for (let r = 0; r < tones.length; r++) {
      const order = [...tones.slice(r), ...tones.slice(0, r)];
      const out: number[] = [];
      let cur = base - 1;
      for (const pc of order) {
        let m = cur + 1;
        while (mod12(m) !== pc) m++;
        out.push(m);
        cur = m;
      }
      if (out[out.length - 1] <= hi && out[0] === base) cands.push(out);
    }
  }
  const target = prev ?? [57, 62, 64, 69];
  const cost = (v: number[]) => v.reduce((s, m, i) => s + Math.abs(m - target[i]), 0) + Math.abs(v[0] + v[v.length - 1] - 128) * 0.15;
  return cands.sort((a, b) => cost(a) - cost(b))[0] ?? tones.map((pc) => 60 + pc);
}

/** Semitones from a chord's bass to its fifth (diminished and augmented fifths stay in key). */
function fifthOf(chord: Chord): number {
  const f = chord.tones.find((pc) => [6, 7, 8].includes(mod12(pc - chord.bass)));
  return f === undefined ? 7 : mod12(f - chord.bass);
}

function bassNote(pc: number): number {
  // D2 to C#3.
  return 38 + mod12(pc - 2);
}

interface Style {
  /** Drum kit: brushed (warm, bright), boom-bap (lofi), or none. */
  kit: 'brush' | 'lofi' | null;
  /** Energy where each part comes in (above 1: never). */
  bass: number;
  pluck: number;
  bell: number;
  /** String ostinato (cinematic). */
  stab: number;
  /** Low boom hits on the downbeats (cinematic). */
  boom: number;
  swing: number;
  /** The chord instrument and the melody instrument. */
  keys: 'keys' | 'piano';
  lead: 'bell' | 'piano' | 'keys';
  /** The bass part as piano left hand an octave up (solo piano). */
  pianoBass?: boolean;
  /** Pad level, reverb size, master low-pass, tape wobble and vinyl crackle. */
  pad: number;
  room: number;
  tone: number;
  wow?: boolean;
  crackle?: boolean;
}

const STYLES: Record<ScoreStyle, Style> = {
  warm: { kit: 'brush', bass: 0.35, pluck: 0.5, bell: 0.7, stab: 2, boom: 2, swing: 0.56, keys: 'keys', lead: 'bell', pad: 1, room: 0.84, tone: 11000 },
  ambient: { kit: null, bass: 0.55, pluck: 2, bell: 0.4, stab: 2, boom: 2, swing: 0.5, keys: 'keys', lead: 'bell', pad: 1, room: 0.84, tone: 11000 },
  bright: { kit: 'brush', bass: 0.3, pluck: 0.25, bell: 0.65, stab: 2, boom: 2, swing: 0.52, keys: 'keys', lead: 'bell', pad: 1, room: 0.84, tone: 11000 },
  cinematic: { kit: null, bass: 0.45, pluck: 2, bell: 0.75, stab: 0.45, boom: 0.6, swing: 0.5, keys: 'piano', lead: 'piano', pad: 1.5, room: 0.9, tone: 10000 },
  lofi: { kit: 'lofi', bass: 0.3, pluck: 2, bell: 0.65, stab: 2, boom: 2, swing: 0.6, keys: 'keys', lead: 'keys', pad: 0.7, room: 0.78, tone: 5200, wow: true, crackle: true },
  piano: { kit: null, bass: 0, pluck: 2, bell: 0.55, stab: 2, boom: 2, swing: 0.5, keys: 'piano', lead: 'piano', pianoBass: true, pad: 0.35, room: 0.86, tone: 11000 },
};

/** True when a note at t (lasting d) overlaps a span where the voiceover speaks. */
function under(spans: [number, number][] | undefined, t: number, d: number): boolean {
  return !!spans?.some(([a, b]) => t < b + 0.15 && t + d > a - 0.15);
}

/** Key of a score as a pitch class (C = 0), the given one or one picked from the seed. */
export function scoreKey(score: ScoreSpec, seed: number): number {
  if (score.key) return NOTE[score.key];
  return NOTE[GOOD_KEYS[Math.floor(rng(seed * 13 + 5)() * GOOD_KEYS.length)]];
}

/** Writes the notes of the score. */
export function composeScore(score: ScoreSpec, plan: ScorePlan, seed: number): NoteEvent[] {
  const style = STYLES[score.style ?? 'warm'];
  const kit = score.drums === false ? null : style.kit;
  const spans = plan.voice;
  const mode = score.mode ?? 'major';
  const scale = mode === 'minor' ? MINOR : MAJOR;
  const key = scoreKey(score, seed);
  const spb = 60 / scoreTempo(score);
  const r = rng(seed * 7919 + 101);
  const ev: NoteEvent[] = [];
  // Everything plays a little softer in the quiet sections, so the build is felt.
  let dyn = 1;
  const add = (e: NoteEvent) => {
    if (!(e.t < plan.duration && e.vel > 0)) return;
    let vel = e.vel * (e.inst === 'swell' || e.inst === 'cymbal' ? 1 : dyn);
    // Under the voiceover the arrangement thins: no melody or backbeat, softer comping.
    if (spans && under(spans, e.t, e.dur)) {
      if (e.inst === style.lead && e.midi >= 72) return;
      if (e.inst === 'snare' || e.inst === 'clap' || e.inst === 'cymbal' || e.inst === 'boom') return;
      if (e.inst === 'keys' || e.inst === 'piano' || e.inst === 'pluck' || e.inst === 'stab' || e.inst === 'shaker') vel *= 0.7;
    }
    ev.push({ ...e, vel });
  };
  const jitter = () => (r() - 0.5) * 0.012;
  const sections = plan.sections;
  const last = sections.length - 1;
  let prevVoicing: number[] | null = null;
  let prevLoop = -1;
  // Penta for the melody: the notes that never clash over these chords.
  const penta = (mode === 'minor' ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9]).map((x) => mod12(key + x));
  const pentaNotes: number[] = [];
  for (let m = 72; m <= 86; m++) if (penta.includes(mod12(m))) pentaNotes.push(m);
  const motifs = [
    [[0, 1.5], [1.5, 0.5], [2, 2], [4, 1], [5, 1], [6, 2]],
    [[0.5, 1], [1.5, 1], [2.5, 1.5], [4.5, 1], [5.5, 2.5]],
    [[0, 1], [1, 1], [2, 2], [4, 0.5], [4.5, 0.5], [5, 3]],
  ];
  const motif = motifs[Math.floor(r() * motifs.length)];
  const keysPatterns = [
    [[0, 2.5, 0.62], [2.5, 1.5, 0.48]],
    [[0, 1.5, 0.6], [1.5, 1, 0.45], [3, 1, 0.42]],
    [[0, 3.5, 0.6], [3.5, 0.5, 0.4]],
  ];

  sections.forEach((sec, si) => {
    const e = sec.energy;
    const final = si === last && sections.length > 1;
    dyn = 0.7 + 0.4 * e;
    const beats = Math.max(1, Math.round((sec.end - sec.start) / spb));
    const at = (b: number) => sec.start + b * spb;
    // Chords: a loop per section (never the same one twice in a row), two bars each when calm.
    const calm = e < 0.35;
    const per = calm ? 8 : 4;
    let loop: number[];
    if (final) loop = [0];
    else {
      const pool = calm ? CALM[mode] : LOOPS[mode];
      let k = Math.floor(r() * pool.length);
      if (k === prevLoop && pool.length > 1) k = (k + 1) % pool.length;
      prevLoop = k;
      loop = pool[k];
    }
    const slots = Math.max(1, Math.ceil(beats / per));
    const degrees = Array.from({ length: slots }, (_, k) => loop[k % loop.length]);
    if (si === last - 1) {
      // Lead into the last scene: IV V (VI VII in minor) on the final slots.
      const cad = CADENCE[mode];
      if (slots >= 2) [degrees[slots - 2], degrees[slots - 1]] = cad;
      else degrees[slots - 1] = cad[1];
    }
    const kp = keysPatterns[Math.floor(r() * keysPatterns.length)];
    degrees.forEach((deg, k) => {
      const b0 = k * per;
      const len = Math.min(per, beats - b0);
      if (len <= 0) return;
      const sus = mode === 'major' && deg === 4;
      const chord = chordOn(deg, scale, key, sus);
      const v = voice(chord.tones, prevVoicing);
      prevVoicing = v;
      const t0 = at(b0);
      const dur = final ? plan.duration - t0 : len * spb;
      // Pad: the voicing held, slightly lower, overlapping into the next chord.
      for (const m of v) add({ inst: 'pad', t: t0, dur: dur + 0.25, midi: m - (m > 66 ? 12 : 0), vel: 0.5, pan: 0 });
      // Electric piano: a rolled chord when calm or ending, a comping rhythm as it builds.
      const roll = (t: number, d: number, vel: number) => v.forEach((m, i) => add({ inst: style.keys, t: t + i * 0.022 + jitter(), dur: d, midi: m, vel: vel * (0.9 + 0.2 * r()), pan: -0.3 + (i / 3) * 0.6 }));
      if (calm || final || e < 0.4) roll(t0, Math.min(dur, per * spb), 0.55);
      else {
        for (let bar = 0; bar * 4 < len; bar++) {
          for (const [o, d, vel] of kp) {
            const b = bar * 4 + o;
            if (b < len) roll(at(b0 + b), Math.min(d, len - b) * spb, vel + (e - 0.5) * 0.15);
          }
        }
      }
      // Bass: the root, held when quiet, a simple figure when the band is in.
      if (style.pianoBass) {
        // Solo piano: the left hand plays the root an octave up, and the fifth when it moves.
        const root = bassNote(chord.bass) + 12;
        add({ inst: 'piano', t: t0 + jitter(), dur: dur - 0.05, midi: root, vel: 0.55, pan: -0.35 });
        if (e >= 0.5 && !final && len >= 4) add({ inst: 'piano', t: at(b0 + 2) + jitter(), dur: 2 * spb, midi: root + fifthOf(chord), vel: 0.42, pan: -0.3 });
      } else if (e >= style.bass || final) {
        const root = bassNote(chord.bass);
        const fifth = root + 7 > 50 ? root - 5 : root + 7;
        if (e < 0.6 || final) add({ inst: 'bass', t: t0 + jitter(), dur: dur - 0.05, midi: root, vel: final ? 0.5 : 0.65, pan: 0 });
        else {
          for (let bar = 0; bar * 4 < len; bar++) {
            const fig: [number, number, number, number][] = [[0, 1.4, root, 0.75], [1.5, 0.9, root, 0.55], [3, 0.9, fifth, 0.6]];
            for (const [o, d, m, vel] of fig) {
              const b = bar * 4 + o;
              if (b < len) add({ inst: 'bass', t: at(b0 + b) + jitter(), dur: Math.min(d, len - b) * spb, midi: m, vel, pan: 0 });
            }
          }
        }
      }
      // Strings (cinematic): an eighth-note ostinato on the root, fifth and octave, accents on the beat.
      if (e >= style.stab && !final) {
        const root = bassNote(chord.bass) + 12;
        const fig = [root, root + 12, root + fifthOf(chord), root + 12];
        for (let s8 = 0; s8 < len * 2; s8++) {
          if (e < 0.65 && s8 % 2 === 1) continue;
          add({ inst: 'stab', t: at(b0 + s8 / 2) + jitter() * 0.4, dur: spb * 0.42, midi: fig[s8 % fig.length], vel: (s8 % 2 ? 0.45 : 0.7) * (0.9 + 0.15 * r()), pan: s8 % 2 ? 0.25 : -0.25 });
        }
      }
      // Low booms on the downbeat of each chord (every bar near the top).
      if (e >= style.boom && !final) {
        for (let bar = 0; bar * 4 < len; bar++) if (bar === 0 || e >= 0.8) add({ inst: 'boom', t: at(b0 + bar * 4), dur: 1.4, midi: 0, vel: bar === 0 ? 0.9 : 0.6, pan: 0 });
      }
      // Guitar: eighth-note arpeggios through the voicing, sparser below full energy.
      if (e >= style.pluck && !final) {
        const notes = [...v, v[1] + 12, v[2] + 12].filter((m) => m <= 81);
        const order = [0, 2, 1, 3, 2, 4, 3, 1];
        for (let s = 0; s < len * 2; s++) {
          const dense = e >= 0.7 || s % 4 !== 3;
          if (!dense || (e < 0.6 && r() < 0.3)) continue;
          const b = Math.floor(s / 2) + (s % 2 ? style.swing : 0);
          const m = notes[order[s % order.length] % notes.length];
          add({ inst: 'pluck', t: at(b0 + b) + jitter(), dur: 1.6 * spb, midi: m, vel: (s % 2 ? 0.45 : 0.62) * (0.9 + 0.2 * r()), pan: 0.35 });
        }
      }
    });

    // Bell melody at the peak: a two-bar motif and its answer, chord tones on the strong beats.
    if (e >= style.bell && !final) {
      let prev = pentaNotes[Math.floor(pentaNotes.length / 2)];
      for (let phrase = 0; phrase * 8 < beats; phrase++) {
        for (const [o, d] of motif) {
          const b = phrase * 8 + o;
          if (b >= beats - 0.5) break;
          const chord = chordOn(degrees[Math.min(degrees.length - 1, Math.floor(b / per))], scale, key, false);
          const tones = [chord.bass, ...chord.tones];
          const strong = o % 2 === 0;
          let pick: number;
          if (strong) {
            const opts = pentaNotes.filter((m) => tones.includes(mod12(m)));
            pick = (opts.length ? opts : pentaNotes).reduce((a, m) => (Math.abs(m - prev) < Math.abs(a - prev) ? m : a));
          } else {
            const i = pentaNotes.indexOf(prev);
            const step = r() < 0.5 ? -1 : 1;
            pick = pentaNotes[Math.max(0, Math.min(pentaNotes.length - 1, (i < 0 ? 4 : i) + step))];
          }
          prev = pick;
          add({ inst: style.lead, t: at(b) + jitter(), dur: d * spb, midi: pick, vel: (style.lead === 'bell' ? 0.38 : 0.5) * (0.9 + 0.2 * r()), pan: -0.25 });
        }
      }
    }
    if (final) {
      // A last bell figure: the fifth, then the tonic, as the logo settles.
      const tonic = pentaNotes.find((m) => mod12(m) === key) ?? 72;
      const lead = style.lead === 'keys' ? 'bell' : style.lead;
      add({ inst: lead, t: at(1), dur: spb, midi: tonic + 7, vel: lead === 'bell' ? 0.3 : 0.4, pan: -0.2 });
      add({ inst: lead, t: at(2), dur: 4 * spb, midi: tonic + 12, vel: lead === 'bell' ? 0.34 : 0.45, pan: -0.2 });
    }

    // Boom-bap (lofi): kick on one and the "and" of three, a lazy backbeat, swung hats, all soft.
    if (kit === 'lofi' && !final) {
      for (let s16 = 0; s16 < beats * 4; s16++) {
        const pos = s16 % 16;
        const swung = s16 % 4 === 2 ? style.swing - 0.5 : 0;
        const t = at(s16 / 4 + swung);
        if (e >= 0.3 && s16 % 2 === 0) add({ inst: 'shaker', t: t + jitter() * 0.5, dur: 0.08, midi: 0, vel: (s16 % 4 === 2 ? 0.55 : 0.35) * (0.85 + 0.3 * r()), pan: 0.25 });
        if (e >= 0.3 && (pos === 0 || pos === 10 || (e >= 0.7 && pos === 7))) add({ inst: 'kick', t, dur: 0.45, midi: 0, vel: pos === 0 ? 0.75 : 0.55, pan: 0 });
        if (e >= 0.4 && (pos === 4 || pos === 12)) add({ inst: 'snare', t: t + 0.012 + jitter(), dur: 0.3, midi: 0, vel: 0.5 * (0.9 + 0.2 * r()), pan: -0.05 });
      }
    }
    // Drums, brushed and quiet: shaker first, then kick, then the backbeat. Offbeat eighths swing.
    if (kit === 'brush' && !final) {
      const bright = score.style === 'bright';
      for (let s16 = 0; s16 < beats * 4; s16++) {
        const pos = s16 % 16;
        const swung = s16 % 4 === 2 ? style.swing - 0.5 : 0;
        const t = at(s16 / 4 + swung);
        if (e >= 0.45 && (s16 % 2 === 0 || e >= 0.75)) {
          const accent = s16 % 4 === 2 ? 0.8 : s16 % 4 === 0 ? 0.5 : 0.32;
          add({ inst: 'shaker', t: t + jitter() * 0.5, dur: 0.1, midi: 0, vel: accent * (0.85 + 0.3 * r()), pan: 0.3 });
        }
        if (e >= 0.55 && (pos === 0 || pos === (bright ? 8 : 10))) add({ inst: 'kick', t, dur: 0.45, midi: 0, vel: pos === 0 ? 0.8 : 0.6, pan: 0 });
        if (e >= 0.6 && (pos === 4 || pos === 12)) add({ inst: bright ? 'clap' : 'snare', t: t + jitter(), dur: 0.3, midi: 0, vel: 0.6 * (0.9 + 0.2 * r()), pan: -0.1 });
      }
    }

    // A swell into each lift (and into the ending), a soft cymbal when the band arrives.
    const prevE = si > 0 ? sections[si - 1].energy : e;
    if (si > 0 && (e - prevE >= 0.15 || final)) {
      const len = Math.min(4 * spb, sec.start - sections[si - 1].start);
      add({ inst: 'swell', t: sec.start - len, dur: len, midi: 0, vel: final ? 0.6 : 0.8, pan: 0 });
      if (e >= 0.6 || final) add({ inst: 'cymbal', t: sec.start, dur: 2.5, midi: 0, vel: final ? 0.4 : 0.7, pan: 0 });
    }
  });
  return ev.sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------------------------------------
// Synthesis

type Bus = Stereo;

function bus(n: number): Bus {
  return { l: new Float32Array(n), r: new Float32Array(n) };
}

const panL = (p: number) => Math.cos(((p + 1) * Math.PI) / 4);
const panR = (p: number) => Math.sin(((p + 1) * Math.PI) / 4);

/** Zavalishin state-variable filter (stable at any cutoff). */
class SVF {
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private k = 1;

  set(freq: number, q: number): this {
    const g = Math.tan((Math.PI * Math.min(freq, SR * 0.45)) / SR);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
    return this;
  }

  /** Returns [low, band, high]. */
  run(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.band = v1;
    this.high = x - this.k * v1 - v2;
    return v2;
  }

  band = 0;
  high = 0;
}

function addAt(b: Bus, i: number, x: number, pan: number): void {
  if (i < 0 || i >= b.l.length) return;
  b.l[i] += x * panL(pan);
  b.r[i] += x * panR(pan);
}

/** FM electric piano: one modulator at the carrier frequency, a brief bell-like tine on the attack. */
function keys(b: Bus, e: NoteEvent): void {
  const f = mtof(e.midi);
  const rel = 0.35;
  const n = Math.floor(Math.min(e.dur + rel, 8) * SR);
  const i0 = Math.floor(e.t * SR);
  const tau = 1.1 + 160 / f;
  const pl = panL(e.pan);
  const pr = panR(e.pan);
  let pc = 0;
  let pt = 0;
  const w = (2 * Math.PI * f) / SR;
  for (let i = 0; i < n; i++) {
    const j = i0 + i;
    if (j >= b.l.length) break;
    const t = i / SR;
    let env = Math.min(1, t / 0.004) * (0.25 + 0.75 * Math.exp(-t / tau));
    if (t > e.dur) env *= Math.exp(-(t - e.dur) / 0.09);
    const idx = (0.6 + 1.3 * e.vel) * Math.exp(-t * 5) + 0.22;
    pc += w;
    pt += w * 13;
    const x = (Math.sin(pc + idx * Math.sin(pc)) + Math.sin(pt) * 0.05 * e.vel * Math.exp(-t * 40)) * env * e.vel;
    const trem = 1 + 0.1 * Math.sin(2 * Math.PI * 4.2 * (j / SR));
    b.l[j] += x * pl * trem;
    b.r[j] += x * pr * (2 - trem);
  }
}

/**
 * Acoustic piano: stiff-string partials (slightly sharp as they rise), each decaying in two stages
 * (a fast drop, then a long sustain), brighter when played harder, with a felt hammer knock.
 */
function piano(b: Bus, e: NoteEvent, r: () => number): void {
  const f = mtof(e.midi);
  const B = 0.00035 * (f / 261.6) ** 0.5;
  const P = Math.max(3, Math.min(10, Math.floor(5200 / f)));
  const t60 = 3.2 * Math.sqrt(220 / f) + 0.6;
  const n = Math.floor(Math.min(e.dur + 0.25, t60 + 0.3, 7) * SR);
  const i0 = Math.floor(e.t * SR);
  const parts = Array.from({ length: P }, (_, k) => {
    const h = k + 1;
    const amp = (1 / h ** (1.5 - 0.5 * e.vel)) * (h === 1 ? 1 : 0.9);
    return { w: (2 * Math.PI * f * h * Math.sqrt(1 + B * h * h)) / SR, amp, fast: 2.5 + h * 1.4, slow: 6.9 / (t60 / (1 + h * 0.35)), ph: r() * 6.28 };
  });
  const hammer = new SVF().set(2600 + 2000 * e.vel, 0.7);
  const pl = panL(e.pan);
  const pr = panR(e.pan);
  for (let i = 0; i < n; i++) {
    const j = i0 + i;
    if (j >= b.l.length) break;
    const t = i / SR;
    let x = 0;
    for (const p of parts) {
      p.ph += p.w;
      x += Math.sin(p.ph) * p.amp * (0.55 * Math.exp(-t * p.fast) + 0.45 * Math.exp(-t * p.slow));
    }
    if (t < 0.02) x += hammer.run(r() * 2 - 1) * 0.5 * Math.exp(-t * 260) * e.vel;
    let env = Math.min(1, t / 0.003);
    if (t > e.dur) env *= Math.exp(-(t - e.dur) / 0.08);
    x *= env * e.vel * 0.55;
    b.l[j] += x * pl;
    b.r[j] += x * pr;
  }
}

/** A short bowed string (ostinato): two detuned saws through a low-pass, a quick swell and fall. */
function stab(b: Bus, e: NoteEvent, r: () => number): void {
  const f = mtof(e.midi);
  const n = Math.floor((e.dur + 0.18) * SR);
  const i0 = Math.floor(e.t * SR);
  const lp = new SVF().set(1400 + 1600 * e.vel, 0.7);
  const ph = [r(), r()];
  const det = [-0.004, 0.004];
  for (let i = 0; i < n; i++) {
    const j = i0 + i;
    if (j >= b.l.length) break;
    const t = i / SR;
    let s = 0;
    for (let k = 0; k < 2; k++) {
      const dt = (f * (1 + det[k])) / SR;
      ph[k] += dt;
      if (ph[k] >= 1) ph[k] -= 1;
      s += 2 * ph[k] - 1 - polyblep(ph[k], dt);
    }
    let env = Math.min(1, t / 0.025) * Math.exp(-t * 3.2);
    if (t > e.dur) env *= Math.max(0, 1 - (t - e.dur) / 0.18);
    addAt(b, j, lp.run(s * 0.5) * env * e.vel, e.pan);
  }
}

/** A low cinematic hit: a sine dropping from 90 to 42 Hz with a felt thump and a long tail. */
function boom(b: Bus, e: NoteEvent, r: () => number): void {
  const n = Math.floor(e.dur * SR);
  const i0 = Math.floor(e.t * SR);
  const lp = new SVF().set(220, 0.8);
  let p = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    p += (2 * Math.PI * (42 + 48 * Math.exp(-t * 14))) / SR;
    const thump = lp.run(r() * 2 - 1) * Math.exp(-t * 30);
    addAt(b, i0 + i, (Math.sin(p) * Math.exp(-t * 2.4) + thump * 0.6) * Math.min(1, t / 0.003) * e.vel, 0);
  }
}

function polyblep(p: number, dt: number): number {
  if (p < dt) {
    const x = p / dt;
    return x + x - x * x - 1;
  }
  if (p > 1 - dt) {
    const x = (p - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** Three detuned band-limited saws per note, slow attack and release; filtered on the bus. */
function pad(b: Bus, e: NoteEvent, r: () => number): void {
  const f = mtof(e.midi);
  const att = 0.9;
  const rel = 1.4;
  const n = Math.floor((e.dur + rel) * SR);
  const i0 = Math.floor(e.t * SR);
  const det = [-0.0045, 0, 0.0052];
  const pans = [-0.7, 0, 0.7];
  const ph = det.map(() => r());
  for (let i = 0; i < n; i++) {
    const j = i0 + i;
    if (j >= b.l.length) break;
    const t = i / SR;
    let env = t < att ? Math.sin((t / att) * Math.PI * 0.5) ** 2 : 1;
    if (t > e.dur) env *= Math.max(0, 1 - (t - e.dur) / rel) ** 2;
    let l = 0;
    let rr = 0;
    for (let k = 0; k < 3; k++) {
      const dt = (f * (1 + det[k])) / SR;
      ph[k] += dt;
      if (ph[k] >= 1) ph[k] -= 1;
      const s = 2 * ph[k] - 1 - polyblep(ph[k], dt);
      l += s * panL(pans[k]);
      rr += s * panR(pans[k]);
    }
    b.l[j] += l * env * e.vel * 0.33;
    b.r[j] += rr * env * e.vel * 0.33;
  }
}

/** Karplus-Strong string with a fractional-delay allpass for tuning and a pick-position comb. */
function pluck(b: Bus, e: NoteEvent, r: () => number): void {
  const f = mtof(e.midi);
  const D = SR / f - 0.5;
  let L = Math.floor(D);
  let frac = D - L;
  if (frac < 0.1) {
    L -= 1;
    frac += 1;
  }
  const c = (1 - frac) / (1 + frac);
  const line = new Float32Array(L);
  // Excitation: noise, softened by velocity, with a notch from plucking a fifth of the way along.
  const lp = new SVF().set(1800 + 4000 * e.vel, 0.6);
  const raw = Array.from({ length: L }, () => lp.run(r() * 2 - 1));
  const pick = Math.max(1, Math.floor(L * 0.2));
  for (let i = 0; i < L; i++) line[i] = raw[i] - (i >= pick ? raw[i - pick] : 0) * 0.8;
  const t60 = 2.6 * Math.sqrt(220 / f);
  const loss = 10 ** (-3 / (t60 * f));
  const lossOff = 10 ** (-3 / (0.12 * f));
  const n = Math.floor(Math.min(e.dur + 0.3, t60) * SR);
  const i0 = Math.floor(e.t * SR);
  const body = new SVF().set(3200, 0.7);
  let prev = 0;
  let apx = 0;
  let apy = 0;
  let k = 0;
  const pl = panL(e.pan) * e.vel;
  const pr = panR(e.pan) * e.vel;
  for (let i = 0; i < n; i++) {
    const j = i0 + i;
    if (j >= b.l.length) break;
    const y = line[k];
    const g = i / SR > e.dur ? lossOff : loss;
    const avg = 0.5 * (y + prev) * g;
    prev = y;
    const ap = c * avg + apx - c * apy;
    apx = avg;
    apy = ap;
    line[k] = ap;
    k = (k + 1) % L;
    const x = body.run(y) * Math.min(1, i / 48);
    b.l[j] += x * pl;
    b.r[j] += x * pr;
  }
}

function bassNoteSynth(b: Bus, e: NoteEvent): void {
  const f = mtof(e.midi);
  const n = Math.floor((e.dur + 0.12) * SR);
  const i0 = Math.floor(e.t * SR);
  let p = 0;
  const w = (2 * Math.PI * f) / SR;
  for (let i = 0; i < n; i++) {
    const j = i0 + i;
    if (j >= b.l.length) break;
    const t = i / SR;
    let env = Math.min(1, t / 0.012) * (0.45 + 0.55 * Math.exp(-t * 2.2));
    if (t > e.dur) env *= Math.max(0, 1 - (t - e.dur) / 0.12);
    p += w;
    const x = Math.tanh((Math.sin(p) + 0.22 * Math.sin(2 * p) + 0.08 * Math.sin(3 * p)) * 1.4) * env * e.vel;
    b.l[j] += x * 0.7071;
    b.r[j] += x * 0.7071;
  }
}

/** Celesta-like bell: inharmonic partials, the high ones dying first. */
function bell(b: Bus, e: NoteEvent): void {
  const f = mtof(e.midi);
  const parts: [number, number, number][] = [[1, 1, 1.4], [2.76, 0.32, 3.5], [5.4, 0.12, 7], [8.93, 0.05, 11]];
  const n = Math.floor(Math.min(e.dur + 1.6, 5) * SR);
  const i0 = Math.floor(e.t * SR);
  const ph = parts.map(() => 0);
  for (let i = 0; i < n; i++) {
    const j = i0 + i;
    if (j >= b.l.length) break;
    const t = i / SR;
    let x = 0;
    parts.forEach(([m, a, d], k) => {
      ph[k] += (2 * Math.PI * f * m) / SR;
      x += Math.sin(ph[k]) * a * Math.exp(-t * d);
    });
    x *= Math.min(1, t / 0.002) * e.vel;
    addAt(b, j, x, e.pan);
  }
}

function kick(b: Bus, e: NoteEvent): void {
  const n = Math.floor(0.45 * SR);
  const i0 = Math.floor(e.t * SR);
  let p = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    p += (2 * Math.PI * (46 + 44 * Math.exp(-t * 28))) / SR;
    addAt(b, i0 + i, Math.sin(p) * Math.exp(-t * 7.5) * Math.min(1, t / 0.002) * e.vel, 0);
  }
}

function noiseHit(b: Bus, e: NoteEvent, r: () => number, freq: number, q: number, attack: number, decay: number, tail = 0, tailDecay = 1): void {
  const f = new SVF().set(freq, q);
  const n = Math.floor(e.dur * SR);
  const i0 = Math.floor(e.t * SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t / attack) * (Math.exp(-t * decay) + tail * Math.exp(-t * tailDecay));
    f.run(r() * 2 - 1);
    addAt(b, i0 + i, f.band * env * e.vel, e.pan);
  }
}

function snare(b: Bus, e: NoteEvent, r: () => number): void {
  noiseHit(b, e, r, 2600, 0.6, 0.006, 14, 0.22, 4);
  const n = Math.floor(0.12 * SR);
  const i0 = Math.floor(e.t * SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    addAt(b, i0 + i, Math.sin(2 * Math.PI * 196 * t) * Math.exp(-t * 28) * 0.35 * e.vel, e.pan);
  }
}

function clap(b: Bus, e: NoteEvent, r: () => number): void {
  for (let k = 0; k < 3; k++) noiseHit(b, { ...e, t: e.t + k * 0.011, vel: e.vel * (k === 2 ? 1 : 0.6) }, r, 1500, 0.9, 0.002, k === 2 ? 16 : 90);
}

function shaker(b: Bus, e: NoteEvent, r: () => number): void {
  noiseHit(b, e, r, 7200, 1.1, 0.01, 42);
}

function cymbal(b: Bus, e: NoteEvent, r: () => number): void {
  const f = new SVF().set(6500, 0.5);
  const n = Math.floor(e.dur * SR);
  const i0 = Math.floor(e.t * SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    f.run(r() * 2 - 1);
    addAt(b, i0 + i, f.high * Math.exp(-t * 1.9) * Math.min(1, t / 0.03) * e.vel, (r() - 0.5) * 0.6);
  }
}

/** Filtered noise rising into a moment, cut just before it lands. */
function swell(b: Bus, e: NoteEvent, r: () => number): void {
  const f = new SVF();
  const n = Math.floor(e.dur * SR);
  const i0 = Math.floor(e.t * SR);
  for (let i = 0; i < n; i++) {
    const p = i / n;
    if (i % 32 === 0) f.set(300 * (4000 / 300) ** p, 1.2);
    f.run(r() * 2 - 1);
    const env = p ** 2.4 * Math.min(1, (1 - p) / 0.02);
    addAt(b, i0 + i, f.band * env * e.vel, Math.sin(p * Math.PI * 2) * 0.4);
  }
}

/** Freeverb-style hall: eight damped combs and four allpasses per side, a little pre-delay. */
function hall(src: Bus, size = 0.84, damp = 0.3): Bus {
  const k = SR / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const aps = [556, 441, 341, 225];
  const pre = Math.floor(0.022 * SR);
  const run = (x: Float32Array, spread: number): Float32Array => {
    const n = x.length;
    const y = new Float32Array(n);
    for (const d0 of combs) {
      const d = Math.floor((d0 + spread) * k);
      const line = new Float32Array(d);
      let lp = 0;
      for (let i = 0, j = 0; i < n; i++, j = j + 1 === d ? 0 : j + 1) {
        const out = line[j];
        lp = out * (1 - damp) + lp * damp;
        line[j] = (i >= pre ? x[i - pre] : 0) * 0.015 + lp * size;
        y[i] += out;
      }
    }
    for (const d0 of aps) {
      const d = Math.floor((d0 + spread) * k);
      const line = new Float32Array(d);
      for (let i = 0, j = 0; i < n; i++, j = j + 1 === d ? 0 : j + 1) {
        const b = line[j];
        line[j] = y[i] + b * 0.5;
        y[i] = b - y[i];
      }
    }
    return y;
  };
  return { l: run(src.l, 0), r: run(src.r, 23) };
}

/** Level and reverb send per part. */
const MIX: Record<Inst, [number, number]> = {
  keys: [0.34, 0.3],
  piano: [0.42, 0.34],
  stab: [0.15, 0.4],
  boom: [0.32, 0.3],
  pad: [0.2, 0.5],
  pluck: [0.3, 0.28],
  bass: [0.26, 0],
  bell: [0.17, 0.55],
  kick: [0.3, 0],
  snare: [0.16, 0.18],
  clap: [0.14, 0.2],
  shaker: [0.055, 0.12],
  swell: [0.06, 0.45],
  cymbal: [0.05, 0.35],
};

/** Composes and synthesizes the score for a plan, at SR, `plan.duration` seconds long. */
export function renderScore(score: ScoreSpec, plan: ScorePlan, seed: number): Stereo {
  const notes = composeScore(score, plan, seed);
  const n = Math.ceil(plan.duration * SR);
  const parts = new Map<Inst, Bus>();
  const get = (k: Inst) => {
    let b = parts.get(k);
    if (!b) parts.set(k, (b = bus(n)));
    return b;
  };
  const r = rng(seed * 31337 + 3);
  for (const e of notes) {
    const b = get(e.inst);
    switch (e.inst) {
      case 'keys': keys(b, e); break;
      case 'piano': piano(b, e, r); break;
      case 'stab': stab(b, e, r); break;
      case 'boom': boom(b, e, r); break;
      case 'pad': pad(b, e, r); break;
      case 'pluck': pluck(b, e, r); break;
      case 'bass': bassNoteSynth(b, e); break;
      case 'bell': bell(b, e); break;
      case 'kick': kick(b, e); break;
      case 'snare': snare(b, e, r); break;
      case 'clap': clap(b, e, r); break;
      case 'shaker': shaker(b, e, r); break;
      case 'cymbal': cymbal(b, e, r); break;
      case 'swell': swell(b, e, r); break;
    }
  }
  const style = STYLES[score.style ?? 'warm'];
  // Tape wobble (lofi): the keys drift in pitch through a slowly modulated delay.
  const keysBus = parts.get('keys');
  if (style.wow && keysBus) {
    for (const ch of [keysBus.l, keysBus.r]) {
      const src = ch.slice();
      for (let i = 0; i < n; i++) {
        const d = (0.006 + 0.0022 * Math.sin((2 * Math.PI * 0.55 * i) / SR) + 0.0008 * Math.sin((2 * Math.PI * 3.1 * i) / SR)) * SR;
        const k = i - d;
        const k0 = Math.floor(k);
        const fr = k - k0;
        ch[i] = k0 >= 0 && k0 + 1 < n ? src[k0] * (1 - fr) + src[k0 + 1] * fr : 0;
      }
    }
  }
  // The pad opens up with the energy of each section.
  const padBus = parts.get('pad');
  if (padBus) {
    const fl = new SVF();
    const fr = new SVF();
    let si = 0;
    for (let i = 0; i < n; i++) {
      if (i % 64 === 0) {
        const t = i / SR;
        while (si < plan.sections.length - 1 && plan.sections[si + 1].start <= t) si++;
        const cut = 700 + 1300 * plan.sections[si].energy + 150 * Math.sin(2 * Math.PI * 0.07 * t);
        fl.set(cut, 0.8);
        fr.set(cut, 0.8);
      }
      padBus.l[i] = fl.run(padBus.l[i]);
      padBus.r[i] = fr.run(padBus.r[i]);
    }
  }
  const out = bus(n);
  const send = bus(n);
  for (const [k, b] of parts) {
    const [lvl0, wet] = MIX[k];
    const lvl = k === 'pad' ? lvl0 * style.pad : lvl0;
    for (let i = 0; i < n; i++) {
      out.l[i] += b.l[i] * lvl;
      out.r[i] += b.r[i] * lvl;
      send.l[i] += b.l[i] * lvl * wet;
      send.r[i] += b.r[i] * lvl * wet;
    }
  }
  const wet = hall(send, style.room);
  // Vinyl (lofi): a quiet hiss bed and sparse crackles.
  if (style.crackle) {
    const cr = rng(seed * 977 + 41);
    const hiss = new SVF().set(3000, 0.5);
    for (let i = 0; i < n; i++) {
      hiss.run(cr() * 2 - 1);
      let x = hiss.band * 0.0022;
      if (cr() < 0.00008) x += (cr() - 0.5) * 0.12;
      out.l[i] += x;
      out.r[i] += x * 0.9;
    }
  }
  // High-pass the sum at 30 Hz, then bring it to a steady level (about -19 dBFS RMS) with a soft limit.
  // A gentle low-pass at 11 kHz keeps the top soft.
  const hl = new SVF().set(30, 0.7);
  const hr = new SVF().set(30, 0.7);
  const ll = new SVF().set(style.tone, 0.6);
  const lr = new SVF().set(style.tone, 0.6);
  // A dark style rolls off twice as steeply (a second stage), like a worn tape or a small speaker.
  const dark = style.tone < 8000;
  const ll2 = new SVF().set(style.tone, 0.6);
  const lr2 = new SVF().set(style.tone, 0.6);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    hl.run(out.l[i] + wet.l[i]);
    hr.run(out.r[i] + wet.r[i]);
    out.l[i] = dark ? ll2.run(ll.run(hl.high)) : ll.run(hl.high);
    out.r[i] = dark ? lr2.run(lr.run(hr.high)) : lr.run(hr.high);
    sum += out.l[i] ** 2 + out.r[i] ** 2;
  }
  const rms = Math.sqrt(sum / (2 * n)) || 1;
  const gain = (0.11 / rms) * (score.volume ?? 1);
  const fadeIn = Math.floor(0.03 * SR);
  const fadeOut = Math.floor(Math.min(1.8, plan.duration / 4) * SR);
  for (let i = 0; i < n; i++) {
    let g = gain;
    if (i < fadeIn) g *= i / fadeIn;
    if (i > n - fadeOut) g *= Math.max(0, (n - i) / fadeOut) ** 1.5;
    out.l[i] = Math.tanh(out.l[i] * g * 1.1) / 1.1;
    out.r[i] = Math.tanh(out.r[i] * g * 1.1) / 1.1;
  }
  return out;
}
