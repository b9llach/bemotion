import type { Keyframe } from '../../spec/schema';
import { resolveEase, type EaseFn } from './easing';
import { isColorString, mixRGBA, type RGBA } from '../util/color';
import type { EngineContext } from '../context';

export type TrackValue = number | number[] | RGBA | string;

interface Key {
  t: number;
  v: TrackValue;
  ease: EaseFn;
}

/**
 * A keyframe track. The `ease` on a keyframe controls the motion arriving at that keyframe.
 * Numbers, number arrays and colors interpolate; any other string holds until the next key.
 */
export class Track {
  readonly keys: Key[];
  readonly kind: 'number' | 'array' | 'color' | 'string';

  constructor(keys: Keyframe[], ctx: EngineContext, defaultEase = 'inOutCubic') {
    if (keys.length === 0) throw new Error('Keyframe track needs at least one key');
    const first = keys[0].v;
    this.kind = typeof first === 'number' ? 'number' : Array.isArray(first) ? 'array' : isColorString(first) ? 'color' : 'string';
    this.keys = keys
      .map((k) => ({
        t: ctx.time(k.t),
        v: this.kind === 'color' ? ctx.color(String(k.v)) : k.v,
        ease: resolveEase(k.ease, defaultEase),
      }))
      .sort((a, b) => a.t - b.t);
  }

  get start(): number {
    return this.keys[0].t;
  }

  get end(): number {
    return this.keys[this.keys.length - 1].t;
  }

  eval(t: number): TrackValue {
    const ks = this.keys;
    if (t <= ks[0].t) return ks[0].v;
    const last = ks[ks.length - 1];
    if (t >= last.t) return last.v;
    let i = 1;
    while (i < ks.length && ks[i].t < t) i++;
    const a = ks[i - 1];
    const b = ks[i];
    const span = b.t - a.t;
    const p = span <= 0 ? 1 : b.ease((t - a.t) / span);
    switch (this.kind) {
      case 'number':
        return (a.v as number) + ((b.v as number) - (a.v as number)) * p;
      case 'array': {
        const av = a.v as number[];
        const bv = b.v as number[];
        return av.map((x, j) => x + ((bv[j] ?? x) - x) * p);
      }
      case 'color':
        return mixRGBA(a.v as RGBA, b.v as RGBA, p);
      default:
        return p >= 1 ? b.v : a.v;
    }
  }
}

export class TrackSet {
  private tracks = new Map<string, Track>();

  constructor(spec: Record<string, Keyframe[]> | undefined, ctx: EngineContext, defaultEase?: string) {
    if (!spec) return;
    for (const [name, keys] of Object.entries(spec)) {
      if (keys.length) this.tracks.set(name, new Track(keys, ctx, defaultEase));
    }
  }

  has(name: string): boolean {
    return this.tracks.has(name);
  }

  get(name: string): Track | undefined {
    return this.tracks.get(name);
  }

  num(name: string, t: number, fallback: number): number {
    const tr = this.tracks.get(name);
    if (!tr) return fallback;
    const v = tr.eval(t);
    return typeof v === 'number' ? v : fallback;
  }

  color(name: string, t: number): RGBA | undefined {
    const tr = this.tracks.get(name);
    if (!tr || tr.kind !== 'color') return undefined;
    return tr.eval(t) as RGBA;
  }

  names(): string[] {
    return [...this.tracks.keys()];
  }
}
