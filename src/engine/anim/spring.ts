/**
 * Spring motion (`spring` on a layer): transform channels follow their animated target through a
 * damped spring, so moves overshoot a little and settle instead of stopping exactly with the curve.
 *
 * Deterministic for seeking: the spring is stepped with a fixed step (1/240 s) from the layer's start,
 * and every step is stored in a table. A seek reads the table (extending it in order when needed) and
 * interpolates between two stored steps, so any time gives the same value whatever was asked before.
 * Each step is exact for a target held at its value in the middle of the step (the 2x2 transition
 * matrix of the oscillator, computed once per spring).
 */

export interface SpringParams {
  stiffness: number;
  damping: number;
  mass: number;
}

export const SPRING_PRESETS: Record<'gentle' | 'snappy' | 'bouncy' | 'heavy' | 'default', SpringParams> = {
  // damping ratio ~0.58: a soft overshoot, about 10% of the distance it lags behind
  default: { stiffness: 170, damping: 15, mass: 1 },
  gentle: { stiffness: 100, damping: 16, mass: 1 },
  snappy: { stiffness: 400, damping: 28, mass: 1 },
  bouncy: { stiffness: 220, damping: 8, mass: 1 },
  heavy: { stiffness: 120, damping: 20, mass: 3 },
};

export type SpringSpec =
  | boolean
  | 'gentle' | 'snappy' | 'bouncy' | 'heavy'
  | { preset?: 'gentle' | 'snappy' | 'bouncy' | 'heavy'; stiffness?: number; damping?: number; mass?: number; props?: string[]; lag?: number };

/** The parameters a `spring` field asks for, or null when it is off. */
export function springParams(s: SpringSpec | undefined): SpringParams | null {
  if (!s) return null;
  if (s === true) return SPRING_PRESETS.default;
  if (typeof s === 'string') return SPRING_PRESETS[s] ?? SPRING_PRESETS.default;
  const p = SPRING_PRESETS[s.preset ?? 'default'] ?? SPRING_PRESETS.default;
  return {
    stiffness: Math.max(1e-3, s.stiffness ?? p.stiffness),
    damping: Math.max(0, s.damping ?? p.damping),
    mass: Math.max(1e-3, s.mass ?? p.mass),
  };
}

export const SPRING_STEP = 1 / 240;

/** exp(A h) for A = [[0, 1], [-k/m, -c/m]], by scaling and squaring a Taylor series. */
function transition(p: SpringParams, h: number): [number, number, number, number] {
  const a10 = -p.stiffness / p.mass;
  const a11 = -p.damping / p.mass;
  const norm = Math.max(1, Math.abs(a10) * h, (1 + Math.abs(a11)) * h);
  let sq = 0;
  while (norm / 2 ** sq > 0.25) sq++;
  const s = h / 2 ** sq;
  // M = A s; E = I + M + M^2/2! + ...
  const m = [0, s, a10 * s, a11 * s];
  let e = [1, 0, 0, 1];
  let term = [1, 0, 0, 1];
  for (let k = 1; k <= 14; k++) {
    term = [
      (term[0] * m[0] + term[1] * m[2]) / k,
      (term[0] * m[1] + term[1] * m[3]) / k,
      (term[2] * m[0] + term[3] * m[2]) / k,
      (term[2] * m[1] + term[3] * m[3]) / k,
    ];
    e = [e[0] + term[0], e[1] + term[1], e[2] + term[2], e[3] + term[3]];
  }
  for (let i = 0; i < sq; i++) {
    e = [e[0] * e[0] + e[1] * e[2], e[0] * e[1] + e[1] * e[3], e[2] * e[0] + e[3] * e[2], e[2] * e[1] + e[3] * e[3]];
  }
  return [e[0], e[1], e[2], e[3]];
}

/**
 * A spring over `channels` values. `target(t, out)` writes the target of every channel at time t
 * (it must be a pure function of t). Before `start` the spring rests at the target at `start`.
 */
export class SpringTable {
  private readonly e: [number, number, number, number];
  /** Position and velocity per channel per step: [x0, v0, x1, v1, ...] for each step. */
  private table: Float64Array;
  private steps = 0;
  private readonly tmp: number[];
  private readonly stride: number;

  constructor(
    readonly params: SpringParams,
    readonly channels: number,
    readonly start: number,
    private readonly target: (t: number, out: number[]) => void,
    /** Channels that follow the spring; the others are the target exactly. */
    readonly sprung: boolean[] = new Array(channels).fill(true),
    readonly step = SPRING_STEP,
  ) {
    this.e = transition(params, step);
    this.stride = channels * 2;
    this.table = new Float64Array(this.stride * 256);
    this.tmp = new Array(channels).fill(0);
  }

  private ensure(k: number): void {
    if (k < this.steps) return;
    const need = (k + 1) * this.stride;
    if (need > this.table.length) {
      let n = this.table.length;
      while (n < need) n *= 2;
      const next = new Float64Array(n);
      next.set(this.table.subarray(0, this.steps * this.stride));
      this.table = next;
    }
    const tb = this.table;
    const S = this.stride;
    const [e00, e01, e10, e11] = this.e;
    if (this.steps === 0) {
      this.target(this.start, this.tmp);
      for (let c = 0; c < this.channels; c++) {
        tb[c * 2] = this.tmp[c];
        tb[c * 2 + 1] = 0;
      }
      this.steps = 1;
    }
    for (let i = this.steps; i <= k; i++) {
      // The target held at its value in the middle of the step.
      this.target(this.start + (i - 0.5) * this.step, this.tmp);
      const p = (i - 1) * S;
      const q = i * S;
      for (let c = 0; c < this.channels; c++) {
        const T = this.tmp[c];
        const x = tb[p + c * 2] - T;
        const v = tb[p + c * 2 + 1];
        tb[q + c * 2] = T + e00 * x + e01 * v;
        tb[q + c * 2 + 1] = e10 * x + e11 * v;
      }
    }
    this.steps = k + 1;
  }

  /**
   * The sprung values at time t into `out`. Only channels that follow the spring are written; the
   * caller fills `out` with the target at t first.
   */
  at(t: number, out: number[]): number[] {
    const u = Math.max(0, (t - this.start) / this.step);
    const k = Math.floor(u);
    const f = u - k;
    this.ensure(k + 1);
    const tb = this.table;
    const a = k * this.stride;
    const b = a + this.stride;
    for (let c = 0; c < this.channels; c++) {
      if (this.sprung[c]) out[c] = tb[a + c * 2] + (tb[b + c * 2] - tb[a + c * 2]) * f;
    }
    return out;
  }
}
