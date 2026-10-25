import { toSeconds } from '../spec/time';
import { mixSfx, sfxSeed, SR, type Cue, type Kit, type SampleBank } from '../audio/sfx';

// The studio kit's recorded sounds, bundled with the preview.
const SAMPLE_URLS = import.meta.glob('../../assets/sfx/studio/*/*.ogg', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
let studio: Promise<SampleBank> | null = null;
function studioSamples(ctx: BaseAudioContext): Promise<SampleBank> {
  studio ??= (async () => {
    const out: SampleBank = {};
    // In file order (tick-1, tick-2, ...), the order the renderer reads them, so both pick the same takes.
    const entries = Object.entries(SAMPLE_URLS).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
    const decoded = await Promise.all(entries.map(async ([path, url]) => {
      const kind = path.split('/').slice(-2)[0];
      const data = await (await fetch(url)).arrayBuffer();
      const buf = await ctx.decodeAudioData(data);
      // Decoded at the context's rate: bring it to the mixer's rate.
      const src = buf.getChannelData(0);
      const k = buf.sampleRate / SR;
      const n = Math.floor(src.length / k);
      const mono = new Float32Array(n);
      for (let i = 0; i < n; i++) mono[i] = src[Math.min(src.length - 1, Math.round(i * k))];
      return [kind, mono] as const;
    }));
    for (const [kind, mono] of decoded) (out[kind] ??= []).push(mono);
    return out;
  })();
  return studio;
}
import type { Json } from './editor';
import type { ClipSound } from '../engine/engine';

/**
 * Plays the soundtrack in the preview, in sync with the timeline: the spec's music and voice tracks
 * (with the same looping, fades and ducking the render applies) plus the generated sound effects,
 * synthesized in the browser with the same code the renderer uses.
 */

type Role = 'music' | 'voice' | 'sfx';

interface Track {
  src: string;
  role: Role;
  at: number;
  volume: number;
  trim: number;
  fadeIn: number;
  fadeOut: number;
  loop: boolean;
  duck: boolean;
}

/** How far ducked music drops while a voice speaks (the render's compressor lands near this). */
const DUCK = 0.35;

export class PreviewAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private decoded = new Map<string, AudioBuffer>();
  private tracks: Track[] = [];
  private clips: ClipSound[] = [];
  private sfx: AudioBuffer | null = null;
  private sfxKey = '';
  private sfxTimer: ReturnType<typeof setTimeout> | undefined;
  private nodes: AudioScheduledSourceNode[] = [];
  private startedAt = 0;
  private startT = 0;
  private running = false;
  private duration = 0;
  muted = false;
  /** Called when something new becomes playable (a file decoded, effects mixed) so playback can restart. */
  onReady: () => void = () => {};

  constructor(private base: string) {}

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: SR });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /** Reads tracks and effect cues from the current spec. Cheap when nothing audible changed. */
  update(spec: Json, cues: Cue[], duration: number, clips: ClipSound[] = []): void {
    this.duration = duration;
    this.clips = clips;
    for (const c of clips) void this.load(c.src);
    const tctx = { fps: spec.fps ?? 30, bpm: spec.bpm };
    this.tracks = ((spec.audio ?? []) as Json[]).map((a) => {
      const role = (a.role ?? 'music') as Role;
      return {
        src: String(a.src),
        role,
        at: toSeconds(a.at, tctx, 0),
        volume: a.volume ?? (role === 'music' ? 0.8 : 1),
        trim: toSeconds(a.trim, tctx, 0),
        fadeIn: toSeconds(a.fadeIn, tctx, 0),
        fadeOut: toSeconds(a.fadeOut, tctx, role === 'music' ? 1.5 : 0),
        loop: a.loop ?? role === 'music',
        duck: a.duck ?? true,
      };
    });
    for (const t of this.tracks) void this.load(t.src);

    const cfg = spec.sfx === false ? null : typeof spec.sfx === 'object' ? spec.sfx : {};
    const hasMusic = this.tracks.some((t) => t.role === 'music');
    const explicit = ((spec.sounds ?? []) as Json[]).map((s) => ({ kind: s.sound, t: toSeconds(s.at, tctx), gain: s.gain ?? 1 }));
    const all = cfg ? [...cues, ...explicit].filter((c) => !(cfg.mute ?? []).includes(c.kind)).sort((a, b) => a.t - b.t) : [];
    const key = JSON.stringify([cfg, all, hasMusic, duration, spec.title]);
    if (key !== this.sfxKey) {
      this.sfxKey = key;
      clearTimeout(this.sfxTimer);
      // Mixing takes a moment for a long video; wait until edits settle.
      this.sfxTimer = setTimeout(async () => {
        if (!cfg || !all.length) {
          this.sfx = null;
          this.onReady();
          return;
        }
        const kit = (cfg.kit as Kit | undefined) ?? 'studio';
        const samples = kit === 'studio' ? await studioSamples(this.ensure()).catch(() => undefined) : undefined;
        if (this.sfxKey !== key) return;
        const { audio } = mixSfx(all, duration, cfg.volume ?? (hasMusic ? 0.45 : 0.9), {
          kit,
          samples,
          seed: cfg.seed ?? sfxSeed(spec.title ?? 'video'),
          reverb: cfg.reverb,
        });
        const ctx = this.ensure();
        const b = ctx.createBuffer(2, audio.l.length, SR);
        b.copyToChannel(audio.l as Float32Array<ArrayBuffer>, 0);
        b.copyToChannel(audio.r as Float32Array<ArrayBuffer>, 1);
        this.sfx = b;
        this.onReady();
      }, 250);
    }
  }

  private load(src: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(src);
    if (!p) {
      p = fetch(new URL(src, new URL(this.base, location.href)).href)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
        .then((data) => this.ensure().decodeAudioData(data))
        .then((b) => {
          this.decoded.set(src, b);
          this.onReady();
          return b;
        })
        .catch(() => null);
      this.buffers.set(src, p);
    }
    return p;
  }

  /** Length of a decoded file in seconds, for the track list. */
  lengthOf(src: string): number | null {
    return this.decoded.get(src)?.duration ?? null;
  }

  get playing(): boolean {
    return this.running;
  }

  /** Timeline time according to the audio clock, while playing. */
  now(): number | null {
    if (!this.running || !this.ctx) return null;
    return this.startT + (this.ctx.currentTime - this.startedAt);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.02);
  }

  stop(): void {
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
      n.disconnect();
    }
    this.nodes = [];
    this.running = false;
  }

  /** Starts everything at timeline time `t`. Files still loading join on the next restart. */
  start(t: number): void {
    this.stop();
    const ctx = this.ensure();
    void ctx.resume();
    this.master!.gain.value = this.muted ? 0 : 1;
    const when = ctx.currentTime + 0.04;
    this.startedAt = when;
    this.startT = t;
    this.running = true;
    const ct = (vt: number) => when + (vt - t);

    // Voice intervals drive the ducking envelope.
    const voices = this.tracks
      .filter((v) => v.role === 'voice' && this.decoded.has(v.src))
      .map((v) => [v.at, v.at + this.decoded.get(v.src)!.duration - v.trim] as const);

    for (const tr of this.tracks) {
      const b = this.decoded.get(tr.src);
      if (!b) continue;
      const len = b.duration - tr.trim;
      const off = t - tr.at;
      if (len <= 0 || (!tr.loop && off >= len)) continue;
      const src = ctx.createBufferSource();
      src.buffer = b;
      if (tr.loop) {
        src.loop = true;
        src.loopStart = tr.trim;
        src.loopEnd = b.duration;
      }
      const g = ctx.createGain();
      // Volume envelope: fade in after the start, fade out before the video ends.
      const env = (vt: number) => {
        let v = tr.volume;
        if (tr.fadeIn > 0) v *= Math.min(1, Math.max(0, (vt - tr.at) / tr.fadeIn));
        if (tr.fadeOut > 0) v *= Math.min(1, Math.max(0, (this.duration - vt) / tr.fadeOut));
        return v;
      };
      g.gain.setValueAtTime(env(Math.max(t, tr.at)), ctx.currentTime);
      const points = [tr.at + tr.fadeIn, this.duration - tr.fadeOut, this.duration].filter((p) => p > t);
      for (const p of points.sort((a, b) => a - b)) g.gain.linearRampToValueAtTime(env(p), ct(p));
      let out: AudioNode = g;
      if (tr.role === 'music' && tr.duck && voices.length) {
        const d = ctx.createGain();
        const inside = voices.some(([a, z]) => t >= a && t < z);
        d.gain.setValueAtTime(inside ? DUCK : 1, ctx.currentTime);
        for (const [a, z] of voices) {
          if (a > t) d.gain.setTargetAtTime(DUCK, ct(a), 0.03);
          if (z > t) d.gain.setTargetAtTime(1, ct(z), 0.2);
        }
        g.connect(d);
        out = d;
      }
      src.connect(g);
      out.connect(this.master!);
      if (off < 0) src.start(ct(tr.at), tr.trim);
      else src.start(when, tr.loop ? tr.trim + (off % len) : tr.trim + off);
      this.nodes.push(src);
    }
    // Sound from video layers, cut to the time each clip is on screen.
    for (const c of this.clips) {
      const b = this.decoded.get(c.src);
      const off = t - c.at;
      if (!b || off >= c.length) continue;
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.playbackRate.value = c.speed;
      if (c.repeat) {
        src.loop = true;
        src.loopStart = c.trim;
        src.loopEnd = b.duration;
      }
      const g = ctx.createGain();
      g.gain.value = c.volume;
      src.connect(g);
      g.connect(this.master!);
      const span = Math.max(0.0001, b.duration - c.trim);
      const at = Math.max(0, off) * c.speed;
      const from = c.trim + (c.repeat ? at % span : at);
      if (!c.repeat && from >= b.duration) continue;
      src.start(off < 0 ? ct(c.at) : when, from);
      src.stop(ct(c.at + c.length));
      this.nodes.push(src);
    }
    if (this.sfx && t < this.sfx.duration) {
      const src = ctx.createBufferSource();
      src.buffer = this.sfx;
      src.connect(this.master!);
      src.start(when, t);
      this.nodes.push(src);
    }
  }
}
