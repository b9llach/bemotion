import * as THREE from 'three';
import { BatchedText, Text } from 'troika-three-text';
import type { CounterLayer as CounterSpec, TextAnim, TextGradient, TextLayer as TextSpec } from '../../spec/schema';
import { Layer, type SceneRuntime } from './base';
import { clamp01, lerp, resolveEase, type EaseFn } from '../anim/easing';
import { rng, noise1 } from '../util/random';
import { mixRGBA, toThreeColor, type RGBA } from '../util/color';

type TextStyleSpec = Pick<TextSpec, 'font' | 'weight' | 'italic' | 'size' | 'color' | 'align' | 'anchor' | 'maxWidth' | 'lineHeight' | 'letterSpacing' | 'uppercase' | 'glow' | 'stroke' | 'intensity'>;

export function syncText(t: Text): Promise<void> {
  return new Promise((resolve) => t.sync(() => resolve()));
}

interface Style {
  font: string;
  size: number;
  lineHeight: number;
  letterSpacing: number;
  color: RGBA;
}

function makeText(style: Style, str: string, spec: TextStyleSpec, ctx: { color(v: string): RGBA }): Text {
  const t = new Text();
  t.text = str;
  t.font = style.font;
  t.fontSize = style.size;
  t.lineHeight = style.lineHeight;
  t.letterSpacing = style.letterSpacing;
  t.color = toThreeColor(style.color).multiplyScalar(spec.intensity ?? 1);
  t.fillOpacity = style.color.a;
  t.sdfGlyphSize = style.size >= 110 ? 128 : 64;
  t.glyphGeometryDetail = 1;
  if (spec.glow) {
    const g = ctx.color(spec.glow.color ?? spec.color ?? '$primary');
    t.outlineWidth = 0;
    t.outlineBlur = spec.glow.size ?? style.size * 0.25;
    t.outlineColor = toThreeColor(g);
    t.outlineOpacity = (spec.glow.intensity ?? 0.8) * g.a;
  }
  if (spec.stroke) {
    const s = ctx.color(spec.stroke.color ?? '$text');
    t.strokeWidth = spec.stroke.width ?? 2;
    t.strokeColor = toThreeColor(s);
    t.strokeOpacity = s.a;
  }
  return t;
}

/** A gradient resolved for one run of characters: stops, direction and the box it spans (content space). */
interface GradientRun {
  stops: RGBA[];
  dir: [number, number];
  center: [number, number];
  half: number;
}

function gradientRun(g: TextGradient, box: { x0: number; x1: number; y0: number; y1: number }, color: (v: string) => RGBA): GradientRun {
  const a = ((g.angle ?? 90) * Math.PI) / 180;
  const dir: [number, number] = [Math.sin(a), Math.cos(a)];
  const hw = (box.x1 - box.x0) / 2;
  const hh = (box.y1 - box.y0) / 2;
  return {
    stops: g.colors.map(color),
    dir,
    center: [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2],
    half: Math.max(1, Math.abs(hw * dir[0]) + Math.abs(hh * dir[1])),
  };
}

/** Color of a gradient run at a content-space point (sRGB), used for blur silhouettes. */
function gradientAt(run: GradientRun, x: number, y: number): RGBA {
  const t = Math.min(1, Math.max(0, (((x - run.center[0]) * run.dir[0] + (y - run.center[1]) * run.dir[1]) / run.half) * 0.5 + 0.5));
  const n = run.stops.length - 1;
  const k = Math.min(n - 1, Math.floor(t * n));
  return mixRGBA(run.stops[k], run.stops[k + 1], t * n - k);
}

/**
 * Base material for a gradient-filled glyph. Troika derives its text material from this one and runs
 * our onBeforeCompile first, then renames `position` to the laid-out glyph position, so the varying
 * below carries the glyph quad in the mesh's local space. `offset` moves it into the gradient box.
 */
function gradientMaterial(run: GradientRun, offset: [number, number], intensity: number): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
  const stops = [0, 1, 2, 3].map((i) => {
    const c = run.stops[Math.min(i, run.stops.length - 1)];
    return new THREE.Vector3(c.r, c.g, c.b);
  });
  const uniforms = {
    uGradStops: { value: stops },
    uGradCount: { value: run.stops.length },
    uGradDir: { value: new THREE.Vector2(...run.dir) },
    uGradOffset: { value: new THREE.Vector2(offset[0], offset[1]) },
    uGradHalf: { value: run.half },
    uGradIntensity: { value: intensity },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGradP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGradP = position.xy;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec2 vGradP;
uniform vec3 uGradStops[4];
uniform int uGradCount;
uniform vec2 uGradDir;
uniform vec2 uGradOffset;
uniform float uGradHalf;
uniform float uGradIntensity;
vec3 gradToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float gt = clamp(dot(vGradP + uGradOffset, uGradDir) / uGradHalf * 0.5 + 0.5, 0.0, 1.0);
  float f = gt * float(uGradCount - 1);
  vec3 gc = mix(uGradStops[0], uGradStops[1], clamp(f, 0.0, 1.0));
  if (uGradCount > 2) gc = mix(gc, uGradStops[2], clamp(f - 1.0, 0.0, 1.0));
  if (uGradCount > 3) gc = mix(gc, uGradStops[3], clamp(f - 2.0, 0.0, 1.0));
  diffuseColor.rgb = gradToLinear(gc) * uGradIntensity;
}`,
      );
  };
  m.customProgramCacheKey = () => 'bemotion-text-gradient';
  return m;
}

/** One letter's place in one morph state. */
interface MorphSlot {
  x: number;
  y: number;
  /** Scale relative to the glyph mesh's font size. */
  s: number;
  color: THREE.Color;
}

/** A letter that lives through a morph: kept while consecutive states share it, gone otherwise. */
interface MorphGlyph {
  glyph: Glyph;
  unit: Unit;
  slots: (MorphSlot | null)[];
}

interface MorphStepRt {
  at: number;
  dur: number;
  ease: EaseFn;
}

/** Longest common subsequence of two letter sequences: the letters that carry over between states. */
function lcsPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}

const smooth01 = (x: number) => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};

interface TextLook {
  fill: number;
  outline: number;
  stroke: number;
  color: THREE.Color;
  glow: { blur: number; color: THREE.Color } | null;
}

function lookOf(t: Text, alpha: number): TextLook {
  const hasGlow = !!t.outlineBlur && t.outlineBlur !== 0;
  return {
    fill: alpha,
    outline: t.outlineOpacity ?? 1,
    stroke: t.strokeOpacity ?? 1,
    color: (t.color as THREE.Color).clone(),
    glow: hasGlow ? { blur: Number(t.outlineBlur), color: (t.outlineColor as THREE.Color).clone() } : null,
  };
}

/**
 * Applies opacity and blur. Blur reuses troika's outline: with zero width and a blur radius the outline
 * is a soft silhouette of the glyph, which reads as a gaussian-blurred letter. It crossfades with the
 * sharp fill over the first few pixels so focus pulls look continuous.
 */
function setTextLook(t: Text, o: number, look: TextLook, blur: number): void {
  if (blur > 0.25) {
    const k = clamp01(blur / 3);
    // The sharp fill draws over the blurred silhouette, so their opacities do not simply add. Pick the
    // silhouette's opacity so the letter's body keeps the full opacity throughout the crossfade:
    // f + g(1 - f) = a. Plain linear weights dip to 75% halfway, which reads as a pulse.
    const a = look.fill * o;
    const f = a * (1 - k);
    const g = f >= 1 ? 0 : clamp01((a - f) / (1 - f));
    t.fillOpacity = f;
    t.strokeOpacity = look.stroke * o * (1 - k);
    t.outlineWidth = 0;
    t.outlineBlur = blur;
    t.outlineColor = look.color;
    t.outlineOpacity = g;
    return;
  }
  t.fillOpacity = look.fill * o;
  t.strokeOpacity = look.stroke * o;
  if (look.glow) {
    t.outlineBlur = look.glow.blur;
    t.outlineColor = look.glow.color;
    t.outlineOpacity = look.outline * o;
  } else if (t.outlineBlur) {
    t.outlineBlur = 0;
    t.outlineOpacity = 0;
  }
}

/**
 * A batch packs each letter's color as a hex number through three's color management (linear to sRGB),
 * while unbatched text hands its color to the shader as is. Undo that conversion up front so a batched
 * letter shows exactly the color an unbatched one does.
 */
function batchColor(c: THREE.Color): THREE.Color {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return new THREE.Color(lin(c.r), lin(c.g), lin(c.b));
}

interface Unit {
  group: THREE.Group;
  chars: Glyph[];
  cx: number;
  cy: number;
  x0: number;
  x1: number;
  line: number;
  index: number;
  order: number;
  orderOut: number;
}

interface Glyph {
  mesh: Text;
  char: string;
  unit: number;
  look: TextLook;
  color: RGBA;
  current: string;
}

type UnitDelta = { x: number; y: number; z: number; rx: number; ry: number; rz: number; s: number; opacity: number; blur: number; clip?: boolean };
type UnitPreset = (q: number, dir: number, u: Unit, p: Record<string, any>, L: TextLayer) => Partial<UnitDelta>;

const DEG = Math.PI / 180;


/**
 * The lift motion: words float in a short way while fading in and coming into focus. `direction` (up,
 * down, left, right, none) is where they travel to; `depth` brings them from behind; `scale` starts
 * them larger (above 1) or smaller and settles to 1; `tilt` leans them in 3D.
 */
const liftFn: UnitPreset = (q, dir, _u, p, L) => {
  const d = (1 - q) * (p.distance ?? L.fontSize * 0.32) * dir;
  const way = p.direction ?? 'up';
  return {
    x: way === 'left' ? d : way === 'right' ? -d : 0,
    y: way === 'up' ? -d : way === 'down' ? d : 0,
    z: -(1 - q) * (p.depth ?? 0) * dir,
    rx: (1 - q) * (p.tilt ?? 0) * dir,
    s: lerp(p.scale ?? 1, 1, q),
    opacity: clamp01(q * 1.5),
    blur: (1 - q) * (p.blur ?? L.fontSize * 0.1),
  };
};

/**
 * Line styles: named ways for a whole line to come together (and leave), built on the lift motion.
 * `defaults` are lift parameters scaled to the font size; anything set in the spec overrides them.
 * Each works as an entrance (`animate`) or an exit (`animateOut`). As an exit the motion carries on
 * in the same direction: `fromLeft` leaves to the right, `riseOut` floats up and away, `recede` moves
 * back into the distance.
 */
type LineStyle = { by: 'char' | 'word' | 'line'; duration: number; stagger: number; ease: string; from?: string; defaults: (em: number) => Record<string, any> };
const LINE_STYLES: Record<string, LineStyle> = {
  // The line grows from the middle: each new word arrives on the right and nudges the line left.
  push: { by: 'word', duration: 0.7, stagger: 0.14, ease: 'outQuart', defaults: () => ({ glide: true }) },
  pushPop: { by: 'word', duration: 0.6, stagger: 0.12, ease: 'springSoft', defaults: (em) => ({ glide: true, direction: 'none', scale: 0.55, blur: em * 0.05 }) },
  // Words drop from above into their final places with a small bounce.
  plop: { by: 'word', duration: 0.5, stagger: 0.1, ease: 'outBack', defaults: (em) => ({ direction: 'down', distance: em * 0.7, scale: 1.08, blur: em * 0.04 }) },
  // Words pop up in place in a random order.
  scatter: { by: 'word', duration: 0.45, stagger: 0.09, ease: 'outBack', from: 'random', defaults: () => ({ direction: 'none', scale: 0.3, blur: 0 }) },
  // The whole line slides in from one side and settles in the center.
  fromLeft: { by: 'line', duration: 0.75, stagger: 0, ease: 'outQuart', defaults: (em) => ({ direction: 'right', distance: em * 5, blur: em * 0.08 }) },
  fromRight: { by: 'line', duration: 0.75, stagger: 0, ease: 'outQuart', defaults: (em) => ({ direction: 'left', distance: em * 5, blur: em * 0.08 }) },
  // The line comes forward from behind, or settles down from large like a focus pull.
  depth: { by: 'line', duration: 0.8, stagger: 0.1, ease: 'outQuart', defaults: (em) => ({ direction: 'none', depth: 900, scale: 0.9, blur: em * 0.18 }) },
  focusPull: { by: 'line', duration: 0.75, stagger: 0.1, ease: 'outQuart', defaults: (em) => ({ direction: 'none', scale: 1.4, blur: em * 0.16 }) },
  // Letters rise outward from the middle of the line, or tip up from lying back.
  ripple: { by: 'char', duration: 0.6, stagger: 0.025, ease: 'outQuart', from: 'center', defaults: (em) => ({ distance: em * 0.5 }) },
  tipUp: { by: 'char', duration: 0.7, stagger: 0.03, ease: 'outQuart', defaults: (em) => ({ direction: 'none', tilt: -85, distance: 0, blur: em * 0.06 }) },
  // Exits (also usable as entrances).
  riseOut: { by: 'line', duration: 0.32, stagger: 0, ease: 'outQuart', defaults: (em) => ({ distance: em * 0.5, blur: em * 0.14 }) },
  sinkOut: { by: 'line', duration: 0.32, stagger: 0, ease: 'outQuart', defaults: (em) => ({ direction: 'down', distance: em * 0.5, blur: em * 0.14 }) },
  exitLeft: { by: 'line', duration: 0.38, stagger: 0, ease: 'outQuart', defaults: (em) => ({ direction: 'left', distance: em * 4, blur: em * 0.1 }) },
  exitRight: { by: 'line', duration: 0.38, stagger: 0, ease: 'outQuart', defaults: (em) => ({ direction: 'right', distance: em * 4, blur: em * 0.1 }) },
  recede: { by: 'line', duration: 0.36, stagger: 0, ease: 'outQuart', defaults: (em) => ({ direction: 'none', depth: -700, scale: 0.92, blur: em * 0.2 }) },
};

/** Letters gather to the line's center (as an exit) or burst out from it (as an entrance). */
const collapseFn: UnitPreset = (q, _dir, u, p, L) => ({
  x: -(u.cx - L.blockCenterX) * (1 - q) * (p.amount ?? 0.85),
  s: lerp(p.scale ?? 0.2, 1, q),
  opacity: clamp01(q * 1.4),
  blur: (1 - q) * (p.blur ?? L.fontSize * 0.08),
});

export const TEXT_PRESETS: Record<string, { by: 'char' | 'word' | 'line'; duration: number; stagger: number; ease: string; fn: UnitPreset; from?: string; defaults?: (em: number) => Record<string, any> }> = {
  fade: { by: 'char', duration: 0.5, stagger: 0.03, ease: 'outCubic', fn: (q) => ({ opacity: q }) },
  rise: {
    by: 'word',
    duration: 0.7,
    stagger: 0.06,
    ease: 'outExpo',
    fn: (q, dir, _u, p, L) => ({ y: -(1 - q) * (p.distance ?? L.fontSize * 0.7) * dir, opacity: clamp01(q * 1.8) }),
  },
  drop: {
    by: 'word',
    duration: 0.7,
    stagger: 0.06,
    ease: 'outExpo',
    fn: (q, dir, _u, p, L) => ({ y: (1 - q) * (p.distance ?? L.fontSize * 0.7) * dir, opacity: clamp01(q * 1.8) }),
  },
  slideLeft: {
    by: 'word',
    duration: 0.7,
    stagger: 0.05,
    ease: 'outExpo',
    fn: (q, dir, _u, p, L) => ({ x: (1 - q) * (p.distance ?? L.fontSize) * dir, opacity: clamp01(q * 1.8) }),
  },
  slideRight: {
    by: 'word',
    duration: 0.7,
    stagger: 0.05,
    ease: 'outExpo',
    fn: (q, dir, _u, p, L) => ({ x: -(1 - q) * (p.distance ?? L.fontSize) * dir, opacity: clamp01(q * 1.8) }),
  },
  pop: {
    by: 'char',
    duration: 0.6,
    stagger: 0.035,
    ease: 'springBouncy',
    fn: (q) => ({ s: Math.max(q, 0.0001), opacity: clamp01(q * 4) }),
  },
  cascade: {
    by: 'char',
    duration: 0.8,
    stagger: 0.035,
    ease: 'outExpo',
    fn: (q, dir, _u, _p, L) => ({ y: -(1 - q) * L.fontSize * 0.4 * dir, rx: (1 - q) * -100 * dir, z: (1 - q) * L.fontSize * 0.3, opacity: clamp01(q * 2) }),
  },
  flip: {
    by: 'char',
    duration: 0.7,
    stagger: 0.04,
    ease: 'outBack',
    fn: (q, dir) => ({ ry: (1 - q) * 90 * dir, opacity: clamp01(q * 2) }),
  },
  spin: {
    by: 'char',
    duration: 0.7,
    stagger: 0.04,
    ease: 'outBack',
    fn: (q, dir) => ({ rz: (1 - q) * 180 * dir, s: Math.max(q, 0.0001), opacity: clamp01(q * 2) }),
  },
  slam: {
    by: 'word',
    duration: 0.4,
    stagger: 0.12,
    ease: 'outExpo',
    fn: (q, _d, _u, p) => ({ s: lerp(p.from ?? 2.6, 1, q), opacity: clamp01(q * 5) }),
  },
  zoom: {
    by: 'char',
    duration: 0.6,
    stagger: 0.03,
    ease: 'outExpo',
    fn: (q, dir, _u, _p, L) => ({ z: (1 - q) * L.fontSize * 6 * dir, opacity: clamp01(q * 3) }),
  },
  blur: {
    by: 'char',
    duration: 0.8,
    stagger: 0.03,
    ease: 'outQuart',
    fn: (q, _d, _u, p, L) => ({ s: lerp(p.from ?? 1.15, 1, q), opacity: clamp01(q * 1.6), blur: (1 - q) * (p.blur ?? L.fontSize * 0.28) }),
  },
  build: {
    by: 'word',
    duration: 0.7,
    stagger: 0.35,
    ease: 'outQuart',
    fn: (q, _d, _u, p, L) => ({ s: lerp(p.from ?? 1.06, 1, q), opacity: clamp01(q * 1.5), blur: (1 - q) * (p.blur ?? L.fontSize * 0.3) }),
  },
  lift: {
    // Words float up a short way while fading in and coming into focus. Nothing clips them, so there
    // is no hard edge: the soft keynote entrance.
    by: 'word',
    duration: 0.75,
    stagger: 0.08,
    ease: 'outQuart',
    fn: liftFn,
  },
  ...Object.fromEntries(Object.entries(LINE_STYLES).map(([k, s]) => [k, { ...s, fn: liftFn }])),
  collapse: { by: 'char', duration: 0.34, stagger: 0.012, ease: 'outQuart', from: 'edges', fn: collapseFn },
  mask: {
    by: 'line',
    duration: 0.8,
    stagger: 0.1,
    ease: 'outExpo',
    fn: (q, dir, _u, _p, L) => ({ y: -(1 - q) * L.fontSize * L.lineHeightMul * 1.05 * dir, clip: true }),
  },
  tracking: {
    by: 'char',
    duration: 1.0,
    stagger: 0,
    ease: 'outExpo',
    fn: (q, dir, u, p, L) => ({ x: (u.cx - L.blockCenterX) * (1 - q) * (p.amount ?? 0.6) * dir, opacity: q }),
  },
  typewriter: {
    by: 'char',
    duration: 0.001,
    stagger: 0.045,
    ease: 'linear',
    fn: (q) => ({ opacity: q > 0 ? 1 : 0 }),
  },
  scramble: {
    by: 'char',
    duration: 0.5,
    stagger: 0.03,
    ease: 'linear',
    fn: (q) => ({ opacity: q > 0 ? 1 : 0 }),
  },
  glitch: {
    by: 'char',
    duration: 0.5,
    stagger: 0.02,
    ease: 'linear',
    fn: (q, _d, u, _p, L) => {
      if (q >= 1) return {};
      const n = noise1(u.index * 3.1 + q * 40, 7);
      return { x: n * L.fontSize * 0.25 * (1 - q), opacity: q > 0 ? (n > 0.6 ? 0.3 : 1) : 0 };
    },
  },
};

const SCRAMBLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+<>/';
/** Advance width of single letters, by font, size and spacing. */
const ADVANCES = new Map<string, number>();

interface ResolvedTextAnim {
  dir: number;
  by: 'char' | 'word' | 'line';
  at: number;
  duration: number;
  stagger: number;
  ease: EaseFn;
  name: string;
  params: Record<string, any>;
  from: string;
  customEase: boolean;
  /** Explicit start of each unit (in order) after `at`; units past the list keep the stagger. */
  times?: number[];
}

/** When the unit at `order` (in animation order) starts. */
function unitStart(a: ResolvedTextAnim, order: number): number {
  const ts = a.times;
  if (!ts || !ts.length) return a.at + order * a.stagger;
  if (order < ts.length) return a.at + ts[Math.max(0, Math.floor(order))];
  return a.at + ts[ts.length - 1] + (order - ts.length + 1) * a.stagger;
}

export class TextLayer extends Layer<TextSpec> {
  fontSize = 72;
  lineHeightMul = 1.1;
  blockCenterX = 0;
  private w = 0;
  private h = 0;
  private units: Unit[] = [];
  private glyphs: Glyph[] = [];
  private inAnim?: ResolvedTextAnim;
  private outAnim?: ResolvedTextAnim;
  private content = new THREE.Group();
  /** Text whose letters never move on their own draws all of them in one call. */
  private batch?: BatchedText;
  /** Text set along a curve: the curve, its length, and where the line starts and sits. */
  private onPath?: { curve: THREE.Curve<THREE.Vector3>; length: number; left: number; width: number; base: number };
  private pathPt = new THREE.Vector3();
  private pathTan = new THREE.Vector3();
  private lineBounds: { minX: number; maxX: number; minY: number; maxY: number }[] = [];
  private lastColorKey = '';
  private morphSteps: MorphStepRt[] = [];
  private morphGlyphs: MorphGlyph[] = [];

  constructor(spec: TextSpec, rt: SceneRuntime) {
    super(spec, rt);
    this.pivot.add(this.content);
  }

  size() {
    return { w: this.w, h: this.h };
  }

  private resolveAnim(a: TextAnim | undefined, dir: number, unitCount: (by: string) => number): ResolvedTextAnim | undefined {
    if (!a) return undefined;
    const def = TEXT_PRESETS[a.preset];
    if (!def) throw new Error(`Unknown text animation "${a.preset}". Available: ${Object.keys(TEXT_PRESETS).join(', ')}`);
    const { preset, by, at, duration, stagger, ease, from, times, ...own } = a;
    const params = { ...(def.defaults?.(this.fontSize) ?? {}), ...own };
    const rb = by ?? def.by;
    const dur = this.ctx.time(duration, def.duration);
    const stg = this.ctx.time(stagger, def.stagger);
    const n = unitCount(rb);
    const ts = Array.isArray(times) ? (times as (number | string)[]).map((v) => this.ctx.time(v as any, 0)) : undefined;
    const lastAt = ts?.length ? ts[Math.min(n, ts.length) - 1] + stg * Math.max(0, n - ts.length) : stg * Math.max(0, n - 1);
    const total = dur + lastAt;
    const start = dir > 0 ? this.ctx.time(at, this.start) : this.ctx.time(at, this.end - total);
    return {
      dir,
      by: rb,
      at: start,
      duration: dur,
      stagger: stg,
      ease: resolveEase(ease, def.ease),
      name: preset,
      params,
      from: from ?? def.from ?? 'start',
      customEase: ease !== undefined,
      times: ts,
    };
  }

  async load(): Promise<void> {
    const s = this.spec;
    const ctx = this.ctx;
    this.fontSize = s.size ?? 72;
    this.lineHeightMul = s.lineHeight ?? 1.12;
    const style: Style = {
      font: ctx.fontUrl(s.font ?? 'display', s.weight ?? 600, s.italic ?? false),
      size: this.fontSize,
      lineHeight: this.lineHeightMul,
      letterSpacing: s.letterSpacing ?? -0.02,
      color: ctx.color(s.color ?? '$text'),
    };
    const str = s.uppercase ? s.text.toUpperCase() : s.text;
    if (s.morph?.length) return this.loadMorph(style, str);

    // Lay out the whole block once to get per-character caret positions.
    const layout = makeText(style, str, s, ctx);
    layout.textAlign = s.align ?? 'center';
    layout.anchorX = 'left';
    layout.anchorY = 'top-baseline';
    await this.syncWrapped(layout);
    const info = layout.textRenderInfo!;
    const caret = info.caretPositions!;
    const bb = info.blockBounds;
    layout.dispose();

    const firstBottom = caret[2];
    const anchor = s.anchor ?? (s.align === 'left' ? 'left' : s.align === 'right' ? 'right' : 'center');
    const offX = anchor === 'left' ? -bb[0] : anchor === 'right' ? -bb[2] : -(bb[0] + bb[2]) / 2;
    const offY = -(bb[1] + bb[3]) / 2;
    this.w = bb[2] - bb[0];
    this.h = bb[3] - bb[1];
    this.blockCenterX = (bb[0] + bb[2]) / 2 + offX;

    // Map highlight colors onto character indices. Gradients are resolved once glyph boxes are known.
    const colors: RGBA[] = [];
    for (let i = 0; i < str.length; i++) colors.push(style.color);
    const gradSpans: { from: number; to: number; g: TextGradient }[] = [];
    if (s.gradient) gradSpans.push({ from: 0, to: str.length, g: s.gradient });
    const italics = new Set<number>();
    for (const h of s.highlight ?? []) {
      const target = s.uppercase ? h.text.toUpperCase() : h.text;
      let idx = str.indexOf(target);
      const c = h.color ? ctx.color(h.color) : undefined;
      let n = 0;
      while (idx >= 0 && target.length) {
        if (h.nth === undefined || h.nth === n) {
          if (c) for (let k = 0; k < target.length; k++) colors[idx + k] = c;
          if (h.italic && !s.italic) for (let k = 0; k < target.length; k++) italics.add(idx + k);
          if (h.gradient) gradSpans.push({ from: idx, to: idx + target.length, g: h.gradient });
        }
        n++;
        idx = str.indexOf(target, idx + target.length);
      }
    }

    // Character, word and line indices.
    let word = 0;
    let line = 0;
    let prevWasSpace = true;
    // Lines are a whole line height apart. Letters from a fallback font (accents, other scripts) report
    // their own caret top and bottom, so a line is recognized by its distance from the first line, and
    // every letter on it shares that line's baseline.
    const lineStep = this.fontSize * this.lineHeightMul;
    const charInfo: { i: number; ch: string; word: number; line: number; x0: number; x1: number; base: number; mid: number }[] = [];
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      const bottom = caret[i * 4 + 2];
      const at = Math.max(line, Math.round((firstBottom - bottom) / lineStep));
      if (at !== line) {
        line = at;
        if (!prevWasSpace) word++;
        prevWasSpace = true;
      }
      if (/\s/.test(ch)) {
        if (!prevWasSpace) word++;
        prevWasSpace = true;
        continue;
      }
      prevWasSpace = false;
      const base = -line * lineStep;
      const top = caret[i * 4 + 3];
      charInfo.push({ i, ch, word, line, x0: caret[i * 4] + offX, x1: caret[i * 4 + 1] + offX, base: base + offY, mid: base + (top - bottom) / 2 + offY });
    }

    await this.unligate(charInfo, str, style, s);
    if (s.justify) this.justifyLines(charInfo, s.justify === 'all', s.maxWidth, anchor);

    // Gradient runs: each spans the box of the characters it covers, so a gradient on a highlighted
    // word runs across that word only. Later spans (highlights) win over the whole-text gradient.
    const runOf = new Map<number, GradientRun>();
    for (const span of gradSpans) {
      const cs = charInfo.filter((c) => c.i >= span.from && c.i < span.to);
      if (!cs.length) continue;
      const box = {
        x0: Math.min(...cs.map((c) => c.x0)),
        x1: Math.max(...cs.map((c) => c.x1)),
        y0: Math.min(...cs.map((c) => c.base)) - this.fontSize * 0.2,
        y1: Math.max(...cs.map((c) => c.base)) + this.fontSize * 0.72,
      };
      const run = gradientRun(span.g, box, (v) => ctx.color(v));
      for (const c of cs) runOf.set(c.i, run);
    }

    // Line bounds for mask clipping (in content space).
    const lineCount = charInfo.length ? charInfo[charInfo.length - 1].line + 1 : 0;
    for (let l = 0; l < lineCount; l++) {
      const cs = charInfo.filter((c) => c.line === l);
      const lh = this.fontSize * this.lineHeightMul;
      if (!cs.length) {
        // A blank line (two line breaks in a row) has no letters to bound: borrow the previous line's box one line lower.
        const prev = this.lineBounds[this.lineBounds.length - 1];
        this.lineBounds.push(prev ? { ...prev, minY: prev.minY - lh, maxY: prev.maxY - lh } : { minX: 0, maxX: 0, minY: -lh * 0.32, maxY: lh * 0.82 });
        continue;
      }
      const base = cs[0].base;
      this.lineBounds.push({
        minX: Math.min(...cs.map((c) => c.x0)) - this.fontSize,
        maxX: Math.max(...cs.map((c) => c.x1)) + this.fontSize,
        minY: base - lh * 0.32,
        maxY: base + lh * 0.82,
      });
    }

    const unitCount = (by: string) => {
      if (by === 'char') return charInfo.length;
      if (by === 'word') return charInfo.length ? charInfo[charInfo.length - 1].word + 1 : 0;
      return lineCount;
    };
    this.inAnim = this.resolveAnim(s.animate, 1, unitCount);
    this.outAnim = this.resolveAnim(s.animateOut, -1, unitCount);
    // Text on a path places every letter on its own, so each is a unit.
    const by = s.path ? 'char' : this.inAnim?.by ?? this.outAnim?.by ?? 'word';
    if (s.path) {
      if (this.inAnim) this.inAnim.by = 'char';
      if (this.outAnim) this.outAnim.by = 'char';
      const pts = s.path.points.map((p) => new THREE.Vector3(p[0], p[1], 0));
      let curve: THREE.Curve<THREE.Vector3>;
      if (s.path.smooth === false) {
        const cp = new THREE.CurvePath<THREE.Vector3>();
        for (let i = 1; i < pts.length; i++) cp.add(new THREE.LineCurve3(pts[i - 1], pts[i]));
        curve = cp;
      } else curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
      const xs = charInfo.map((c) => c.x0).concat(charInfo.map((c) => c.x1));
      this.onPath = { curve, length: curve.getLength(), left: Math.min(...xs), width: Math.max(...xs) - Math.min(...xs), base: charInfo[0]?.base ?? 0 };
    }
    if (this.inAnim && this.outAnim && this.inAnim.by !== this.outAnim.by) this.outAnim.by = this.inAnim.by;

    // Build units.
    const keyOf = (c: (typeof charInfo)[number]) => (by === 'char' ? c.i : by === 'word' ? c.word : c.line);
    const groups = new Map<number, (typeof charInfo)[number][]>();
    for (const c of charInfo) {
      const k = keyOf(c);
      const arr = groups.get(k) ?? [];
      arr.push(c);
      groups.set(k, arr);
    }
    const pending: Promise<void>[] = [];
    let unitIndex = 0;
    for (const cs of groups.values()) {
      const cx = (Math.min(...cs.map((c) => c.x0)) + Math.max(...cs.map((c) => c.x1))) / 2;
      const cy = cs.reduce((a, c) => a + c.mid, 0) / cs.length;
      const group = new THREE.Group();
      group.position.set(cx, cy, 0);
      const x0 = Math.min(...cs.map((c) => c.x0));
      const x1 = Math.max(...cs.map((c) => c.x1));
      const unit: Unit = { group, chars: [], cx, cy, x0, x1, line: cs[0].line, index: unitIndex, order: unitIndex, orderOut: unitIndex };
      for (const c of cs) {
        const run = runOf.get(c.i);
        const col = run ? gradientAt(run, (c.x0 + c.x1) / 2, c.mid) : colors[c.i];
        const font = italics.has(c.i) ? ctx.fontUrl(s.font ?? 'display', s.weight ?? 600, true) : style.font;
        const mesh = makeText({ ...style, font, color: col }, c.ch, s, ctx);
        if (run) mesh.material = gradientMaterial(run, [c.x0 - run.center[0], c.base - run.center[1]], s.intensity ?? 1);
        mesh.anchorX = 'left';
        mesh.anchorY = 'top-baseline';
        mesh.position.set(c.x0 - cx, c.base - cy, 0);
        mesh.renderOrder = this.order;
        if (s.blend === 'add') {
          (mesh.material as THREE.Material).blending = THREE.AdditiveBlending;
        }
        const glyph: Glyph = {
          mesh,
          char: c.ch,
          unit: unitIndex,
          look: lookOf(mesh, col.a),
          color: col,
          current: c.ch,
        };
        unit.chars.push(glyph);
        this.glyphs.push(glyph);
        group.add(mesh);
        pending.push(syncText(mesh));
      }
      this.units.push(unit);
      this.content.add(group);
      unitIndex++;
    }
    this.assignOrder(this.inAnim, 'order');
    this.assignOrder(this.outAnim, 'orderOut');
    this.emitSounds();
    await Promise.all(pending);
    for (const g of this.glyphs) {
      const mat = g.mesh.material as THREE.Material;
      mat.depthWrite = false;
      mat.transparent = true;
    }
    // Letters that never move on their own (no letter animation, no path) draw in one call: a paragraph
    // is otherwise hundreds of draw calls, every motion blur sample.
    // (Glow and stroke draw a second outline pass that a batch blends a little differently: leave those alone.)
    const still = !s.animate && !s.animateOut && !s.path && !gradSpans.length && s.blend !== 'add' && (s.intensity ?? 1) <= 1 && !s.glow && !s.stroke && this.glyphs.length > 1;
    if (still) {
      const batch = new BatchedText();
      batch.renderOrder = this.order;
      batch.font = style.font;
      batch.fontSize = style.size;
      batch.sdfGlyphSize = this.glyphs[0].mesh.sdfGlyphSize;
      for (const u of this.units) {
        for (const g of u.chars) {
          u.group.remove(g.mesh);
          g.mesh.position.add(u.group.position);
          g.mesh.updateMatrix();
          batch.add(g.mesh);
          g.mesh.color = batchColor(g.mesh.color as THREE.Color);
          // Blur reuses the outline, drawn in the letter's color.
          g.look.color = batchColor(g.look.color);
        }
      }
      const mat = batch.material as THREE.Material;
      mat.depthWrite = false;
      mat.transparent = true;
      this.content.add(batch);
      await new Promise<void>((resolve) => batch.sync(() => resolve()));
      this.batch = batch;
    }
  }

  /** Sound cues for kinetic type: a tick per word for builds, keys for typing, impacts for slams. */
  private emitSounds(): void {
    const a = this.inAnim;
    if (!a) return;
    const per: Record<string, [import('../context').SfxKind, number] | undefined> = {
      build: ['tick', 0.9], lift: ['tick', 0.45], push: ['tick', 0.45], pushPop: ['pop', 0.4], plop: ['tick', 0.5], scatter: ['pop', 0.35], ripple: ['tick', 0.3], tipUp: ['tick', 0.3], pop: ['tick', 0.5], typewriter: ['key', 0.35], scramble: ['key', 0.3], slam: ['impact', 0.7],
      spin: ['tick', 0.4], flip: ['tick', 0.4], cascade: ['tick', 0.35], zoom: ['tick', 0.4],
    };
    const cue = per[a.name];
    if (cue) {
      const times = [...new Set(this.units.map((u) => +unitStart(a, u.order).toFixed(3)))].sort((x, y) => x - y);
      for (const t of times) this.ctx.event(cue[0], t, cue[1]);
    } else {
      this.ctx.event('soft', a.at, 0.6);
    }
  }

  private assignOrder(a: ResolvedTextAnim | undefined, key: 'order' | 'orderOut'): void {
    if (!a) return;
    const n = this.units.length;
    const r = rng(this.seed + (key === 'order' ? 1 : 2));
    const shuffled = [...Array(n).keys()].sort(() => r() - 0.5);
    this.units.forEach((u, i) => {
      const mid = (n - 1) / 2;
      switch (a.from) {
        case 'end':
          u[key] = n - 1 - i;
          break;
        case 'center':
          u[key] = Math.abs(i - mid);
          break;
        case 'edges':
          u[key] = mid - Math.abs(i - mid);
          break;
        case 'random':
          u[key] = shuffled[i];
          break;
        default:
          u[key] = i;
      }
    });
  }

  private unitDelta(a: ResolvedTextAnim, u: Unit, t: number, d: UnitDelta, orderKey: 'order' | 'orderOut'): number {
    const def = TEXT_PRESETS[a.name];
    const start = unitStart(a, u[orderKey]);
    const p = a.duration <= 0.0011 ? (t >= start ? 1 : 0) : clamp01((t - start) / a.duration);
    let q: number;
    if (a.dir > 0) {
      if (p >= 1 && a.name !== 'glitch') return p;
      q = a.ease(p);
    } else {
      if (p <= 0) return p;
      q = a.customEase ? 1 - a.ease(p) : a.ease(1 - p);
    }
    if (a.dir > 0 && t < start) q = 0;
    const r = def.fn(q, a.dir, u, a.params, this);
    d.x += r.x ?? 0;
    d.y += r.y ?? 0;
    d.z += r.z ?? 0;
    d.rx += r.rx ?? 0;
    d.ry += r.ry ?? 0;
    d.rz += r.rz ?? 0;
    d.s *= r.s ?? 1;
    d.opacity *= r.opacity ?? 1;
    d.blur += r.blur ?? 0;
    if (r.clip) d.clip = true;
    return p;
  }

  /**
   * The reading position: the center of the word (or letter) arriving at time `t`, gliding from one to
   * the next as they appear. Once everything has arrived it eases to the middle of the text, or, for a
   * line wider than the view (`settle`, half the visible width in world pixels), only as far as keeps
   * its end in view. `settle: false` stays on the last word. Text without an entrance is read from
   * its middle.
   */
  override focusPoint(t: number, out: THREE.Vector3, settle: number | false = Infinity): THREE.Vector3 {
    const units = this.units;
    if (!units.length) return super.focusPoint(t, out, settle);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const u of units) {
      x0 = Math.min(x0, u.x0);
      x1 = Math.max(x1, u.x1);
      y0 = Math.min(y0, u.cy);
      y1 = Math.max(y1, u.cy);
    }
    let x = (x0 + x1) / 2;
    let y = (y0 + y1) / 2;
    const a = this.inAnim;
    if (a && units.length > 1) {
      const sorted = [...units].sort((p, q) => p.order - q.order || p.line - q.line || p.x0 - q.x0);
      let f = 0;
      for (let i = 1; i < sorted.length; i++) f += this.unitQ(a, sorted[i], t);
      const k = Math.max(0, Math.min(sorted.length - 2, Math.floor(f)));
      const u = sorted[k];
      const v = sorted[k + 1];
      const w = clamp01(f - k);
      const rx = lerp(u.cx, v.cx, w);
      const ry = lerp(u.cy, v.cy, w);
      let e = 0;
      if (settle !== false) {
        // Keep the end of a wide text in view: shift the settled point toward its end.
        const ws = this.content.getWorldScale(new THREE.Vector3()).x || 1;
        const half = (settle / Math.abs(ws)) * 0.9;
        x = Math.max(x1 - half, Math.min(x0 + half, x));
        const last = sorted[sorted.length - 1];
        const done = unitStart(a, last.order) + Math.max(a.duration, 0.0011) * 1.3;
        const p = clamp01((t - done - 0.05) / 0.9);
        e = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
      }
      x = lerp(rx, x, e);
      y = lerp(ry, y, e);
    }
    this.content.updateWorldMatrix(true, false);
    return this.content.localToWorld(out.set(x, y, 0));
  }

  /**
   * Letters are drawn one by one, so a ligature in the layout (fi, ffi, fl...) must not decide their
   * places: the layout splits a ligature's width evenly between its letters, which leaves gaps once
   * each letter is drawn on its own. Runs of letters with exactly equal widths are re-spaced with
   * each letter's own advance (other runs come out unchanged).
   */
  private async unligate(chars: { i: number; ch: string; line: number; x0: number; x1: number }[], str: string, style: Style, spec: TextSpec): Promise<void> {
    const runs: (typeof chars)[] = [];
    for (let k = 0; k < chars.length; k++) {
      const c = chars[k];
      const prev = chars[k - 1];
      const w = c.x1 - c.x0;
      const same = prev && prev.line === c.line && prev.i === c.i - 1 && Math.abs(prev.x1 - prev.x0 - w) < 1e-3 && Math.abs(prev.x1 - c.x0) < 1e-3;
      if (same) runs[runs.length - 1].push(c);
      else runs.push([c]);
    }
    const suspect = runs.filter((r) => r.length > 1 && /[ft]/.test(r.map((c) => c.ch).join('')));
    if (!suspect.length) return;
    const advance = async (ch: string) => {
      const key = `${style.font}|${style.size}|${style.letterSpacing}|${ch}`;
      let v = ADVANCES.get(key);
      if (v === undefined) {
        const t = makeText(style, ch, spec, this.ctx);
        t.anchorX = 'left';
        await syncText(t);
        const cp = t.textRenderInfo!.caretPositions!;
        v = cp[1] - cp[0];
        t.dispose();
        ADVANCES.set(key, v);
      }
      return v;
    };
    for (const run of suspect) {
      const total = run[run.length - 1].x1 - run[0].x0;
      const adv = await Promise.all(run.map((c) => advance(c.ch)));
      const sum = adv.reduce((a, b) => a + b, 0);
      // Keep the run's overall width; place each letter by its own advance within it.
      const k = sum > 0 ? total / sum : 1;
      let x = run[0].x0;
      run.forEach((c, j) => {
        c.x0 = x;
        x += adv[j] * k;
        c.x1 = x;
      });
    }
  }

  /**
   * Spreads each line's letters evenly so the line spans the block width (maxWidth, or the widest
   * line), keeping the block where its anchor puts it. The last line keeps its natural spacing unless `all`.
   */
  private justifyLines(chars: { line: number; x0: number; x1: number }[], all: boolean, maxWidth: number | undefined, anchor: string): void {
    if (!chars.length) return;
    const lines = new Map<number, { line: number; x0: number; x1: number }[]>();
    for (const c of chars) lines.set(c.line, [...(lines.get(c.line) ?? []), c]);
    const left = Math.min(...chars.map((c) => c.x0));
    const widest = Math.max(...[...lines.values()].map((cs) => Math.max(...cs.map((c) => c.x1)) - Math.min(...cs.map((c) => c.x0))));
    const width = maxWidth !== undefined && Number.isFinite(maxWidth) ? maxWidth : widest;
    const lastLine = Math.max(...lines.keys());
    for (const [line, cs] of lines) {
      cs.sort((a, b) => a.x0 - b.x0);
      const l0 = cs[0].x0;
      const natural = cs[cs.length - 1].x1 - l0;
      const stretch = cs.length > 1 && (all || line !== lastLine);
      const extra = stretch ? (width - natural) / (cs.length - 1) : 0;
      cs.forEach((c, k) => {
        const dx = left - l0 + k * extra;
        c.x0 += dx;
        c.x1 += dx;
      });
    }
    // Re-anchor the block at its new width.
    const shift = anchor === 'left' ? 0 : anchor === 'right' ? -(width - (this.w)) : -(width - this.w) / 2;
    if (shift) for (const c of chars) {
      c.x0 += shift;
      c.x1 += shift;
    }
    this.w = width;
  }

  /** Eased entrance progress of one unit, 0 before it starts. */
  private unitQ(a: ResolvedTextAnim, u: Unit, t: number): number {
    const start = unitStart(a, u.order);
    if (t < start) return 0;
    // The line glides on its own gentle ease-in-out over a longer span than the word entrance: a fast
    // out-ease moves the whole line abruptly, which smears every settled word under motion blur.
    const span = Math.max(a.duration, 0.0011) * 1.3;
    const p = clamp01((t - start) / span);
    return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
  }

  /**
   * For `build` (or any preset with `glide: true`): shift each line so the words that have appeared
   * so far stay centered, gliding as each new word arrives.
   */
  private buildOffsets(t: number): Map<number, number> {
    const out = new Map<number, number>();
    const a = this.inAnim;
    const centered = (this.spec.align ?? 'center') === 'center';
    if (!a || !(a.params.glide ?? a.name === 'build') || !centered) return out;
    const lines = new Map<number, Unit[]>();
    for (const u of this.units) {
      const arr = lines.get(u.line) ?? [];
      arr.push(u);
      lines.set(u.line, arr);
    }
    const follow = a.params.glide === 'follow';
    for (const [line, units] of lines) {
      const sorted = [...units].sort((p, q) => p.x0 - q.x0);
      if (follow) {
        out.set(line, this.followOffset(a, sorted, t));
        continue;
      }
      const left = sorted[0].x0;
      const fullRight = sorted[sorted.length - 1].x1;
      let right = left;
      let prev = left;
      for (const u of sorted) {
        right += (u.x1 - prev) * this.unitQ(a, u, t);
        prev = u.x1;
      }
      out.set(line, (left + fullRight) / 2 - (left + right) / 2);
    }
    return out;
  }

  /**
   * `glide: "follow"`: the newest word sits at the center of the frame and pushes the words before it to
   * the left as it arrives; once the sentence is complete the whole line eases back to center
   * (`settle: false` keeps the last word centered instead).
   */
  private followOffset(a: ResolvedTextAnim, sorted: Unit[], t: number): number {
    const lineCenter = (sorted[0].x0 + sorted[sorted.length - 1].x1) / 2;
    // Continuous index of the word in focus: 0 while only the first word is up, n-1 once all are.
    let f = 0;
    for (let i = 1; i < sorted.length; i++) f += this.unitQ(a, sorted[i], t);
    const k = Math.min(sorted.length - 2, Math.floor(f));
    const cx = sorted.length === 1 ? sorted[0].cx : sorted[Math.max(0, k)].cx + (sorted[Math.max(0, k) + 1].cx - sorted[Math.max(0, k)].cx) * (f - Math.max(0, k));
    let shift = -cx;
    if (a.params.settle !== false && sorted.length > 1) {
      const last = sorted[sorted.length - 1];
      const done = unitStart(a, last.order) + Math.max(a.duration, 0.0011) * 1.3;
      const p = clamp01((t - done - 0.05) / 0.7);
      const e = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
      shift = lerp(shift, -lineCenter, e);
    }
    return shift;
  }

  /**
   * Line width the text wraps at: its maxWidth, or in a narrower format (vertical, square) the room
   * between where the text is anchored and the frame's edges (with a margin), so long lines wrap
   * instead of running off. Measured in the layer's own units (scene zoom and layer scale undone).
   */
  private wrapWidth(): number {
    const s = this.spec;
    if (s.maxWidth !== undefined) return s.maxWidth;
    const frame = this.ctx.wrap;
    if (!frame) return Infinity;
    const half = (frame / 2 / (this.ctx.sceneZoom ?? 1)) * 0.93;
    const x = s.x ?? 0;
    const anchor = s.anchor ?? (s.align === 'left' ? 'left' : s.align === 'right' ? 'right' : 'center');
    const room = anchor === 'left' ? half - x : anchor === 'right' ? half + x : 2 * (half - Math.abs(x));
    return Math.max(half * 0.6, room) / Math.max(0.05, Math.abs(s.scale ?? 1));
  }

  /**
   * Lays out a text at its wrap width. When a narrower format makes a line wrap, the width is evened
   * out so the lines come out about the same length instead of leaving one word on the last line.
   */
  private async syncWrapped(t: Text): Promise<void> {
    const limit = this.wrapWidth();
    if (this.spec.maxWidth !== undefined || !Number.isFinite(limit)) {
      t.maxWidth = limit;
      await syncText(t);
      return;
    }
    t.maxWidth = Infinity;
    await syncText(t);
    const bb = t.textRenderInfo!.blockBounds;
    const w = bb[2] - bb[0];
    if (w <= limit) return;
    const lines = Math.ceil(w / limit);
    t.maxWidth = Math.min(limit, (w / lines) * 1.12);
    await syncText(t);
  }

  /** Letter positions of one text, laid out like the main block (same alignment and anchor). */
  private async layoutState(style: Style, text: string, size: number): Promise<{ chars: { ch: string; x0: number; x1: number; base: number }[]; w: number; h: number }> {
    const s = this.spec;
    const t = makeText({ ...style, size }, text, s, this.ctx);
    t.textAlign = s.align ?? 'center';
    t.anchorX = 'left';
    t.anchorY = 'top-baseline';
    await this.syncWrapped(t);
    const info = t.textRenderInfo!;
    const caret = info.caretPositions!;
    const bb = info.blockBounds;
    t.dispose();
    const anchor = s.anchor ?? (s.align === 'left' ? 'left' : s.align === 'right' ? 'right' : 'center');
    const offX = anchor === 'left' ? -bb[0] : anchor === 'right' ? -bb[2] : -(bb[0] + bb[2]) / 2;
    const offY = -(bb[1] + bb[3]) / 2;
    const firstBottom = caret[2];
    const chars: { ch: string; x0: number; x1: number; base: number }[] = [];
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) continue;
      chars.push({ ch: text[i], x0: caret[i * 4] + offX, x1: caret[i * 4 + 1] + offX, base: caret[i * 4 + 2] - firstBottom + offY });
    }
    return { chars, w: bb[2] - bb[0], h: bb[3] - bb[1] };
  }

  /**
   * Builds a morphing text: every state is laid out, consecutive states are matched letter by letter
   * (longest common subsequence), and each letter gets one mesh that lives as long as it is matched.
   */
  private async loadMorph(style: Style, first: string): Promise<void> {
    const s = this.spec;
    const ctx = this.ctx;
    const steps = s.morph!;
    const up = (v: string) => (s.uppercase ? v.toUpperCase() : v);
    const texts = [first, ...steps.map((m) => up(m.text))];
    const sizes: number[] = [this.fontSize];
    const colors: RGBA[] = [style.color];
    // A state with a gradient colors each letter at its place along it; otherwise the color carries over.
    const grads: (TextGradient | undefined)[] = [s.gradient];
    steps.forEach((m, i) => {
      sizes.push(m.size ?? sizes[i]);
      colors.push(m.color ? ctx.color(m.color) : colors[i]);
      grads.push(m.gradient ?? (m.color ? undefined : grads[i]));
    });
    const layouts = await Promise.all(texts.map((txt, i) => this.layoutState(style, txt, sizes[i])));
    const runs = layouts.map((l, k) => {
      const g = grads[k];
      if (!g || !l.chars.length) return null;
      const x0 = Math.min(...l.chars.map((c) => c.x0));
      const x1 = Math.max(...l.chars.map((c) => c.x1));
      return gradientRun(g, { x0, x1, y0: -l.h / 2, y1: l.h / 2 }, (v) => ctx.color(v));
    });
    this.w = layouts[0].w;
    this.h = layouts[0].h;
    this.morphSteps = steps.map((m) => ({ at: ctx.time(m.at), dur: Math.max(0.05, ctx.time(m.duration, 0.7)), ease: resolveEase(m.ease, 'inOutCubic') }));
    const n = texts.length;

    type Proto = { ch: string; slots: ({ x: number; y: number; x1: number; size: number; color: RGBA } | null)[] };
    const slotOf = (k: number, c: { x0: number; x1: number; base: number }) => {
      const run = runs[k];
      const color = run ? gradientAt(run, (c.x0 + c.x1) / 2, c.base + sizes[k] * 0.35) : colors[k];
      return { x: c.x0, y: c.base, x1: c.x1, size: sizes[k], color };
    };
    const all: Proto[] = [];
    let current: Proto[] = layouts[0].chars.map((c) => {
      const p: Proto = { ch: c.ch, slots: new Array(n).fill(null) };
      p.slots[0] = slotOf(0, c);
      all.push(p);
      return p;
    });
    for (let k = 1; k < n; k++) {
      const next = layouts[k].chars;
      const pairs = new Map(lcsPairs(current.map((p) => p.ch), next.map((c) => c.ch)).map(([i, j]) => [j, i]));
      current = next.map((c, j) => {
        const i = pairs.get(j);
        let p: Proto;
        if (i !== undefined) p = current[i];
        else {
          p = { ch: c.ch, slots: new Array(n).fill(null) };
          all.push(p);
        }
        p.slots[k] = slotOf(k, c);
        return p;
      });
    }

    const pending: Promise<void>[] = [];
    this.morphGlyphs = all.map((p, index) => {
      const present = p.slots.filter((x): x is NonNullable<typeof x> => !!x);
      const meshSize = Math.max(...present.map((x) => x.size));
      const firstSlot = present[0];
      const mesh = makeText({ ...style, size: meshSize, color: firstSlot.color }, p.ch, s, ctx);
      mesh.anchorX = 'left';
      mesh.anchorY = 'top-baseline';
      mesh.renderOrder = this.order;
      if (s.blend === 'add') (mesh.material as THREE.Material).blending = THREE.AdditiveBlending;
      const group = new THREE.Group();
      group.add(mesh);
      this.content.add(group);
      pending.push(syncText(mesh));
      const glyph: Glyph = { mesh, char: p.ch, unit: index, look: lookOf(mesh, firstSlot.color.a), color: firstSlot.color, current: p.ch };
      const cx = (firstSlot.x + firstSlot.x1) / 2;
      const unit: Unit = { group, chars: [glyph], cx, cy: firstSlot.y, x0: firstSlot.x, x1: firstSlot.x1, line: 0, index, order: 0, orderOut: 0 };
      this.glyphs.push(glyph);
      return {
        glyph,
        unit,
        slots: p.slots.map((x) => (x ? { x: x.x, y: x.y, s: x.size / meshSize, color: toThreeColor(x.color).multiplyScalar(s.intensity ?? 1) } : null)),
      };
    });

    // Entrance plays on the first text, exit on the last, letter by letter.
    const firstUnits = this.morphGlyphs.filter((g) => g.slots[0]).map((g) => g.unit).sort((a, b) => a.x0 - b.x0);
    const lastUnits = this.morphGlyphs.filter((g) => g.slots[n - 1]).map((g) => g.unit).sort((a, b) => a.x0 - b.x0);
    // Morph letters animate one by one. A word or line stagger becomes a letter stagger that takes the
    // same total time, so the line still finishes arriving when its author meant it to.
    const asChar = (a: TextAnim | undefined, text: string) => {
      if (!a) return undefined;
      const words = text.split(/\s+/).filter(Boolean).length;
      const letters = text.replace(/\s+/g, '').length;
      let stagger = a.stagger === undefined ? undefined : this.ctx.time(a.stagger);
      if (stagger !== undefined && a.by === 'word') stagger = (stagger * Math.max(0, words - 1)) / Math.max(1, letters - 1);
      else if (a.by === 'line') stagger = 0;
      return { ...a, by: 'char' as const, ...(stagger !== undefined ? { stagger } : {}) };
    };
    this.inAnim = this.resolveAnim(asChar(s.animate, texts[0]), 1, () => firstUnits.length);
    this.outAnim = this.resolveAnim(asChar(s.animateOut, texts[n - 1]), -1, () => lastUnits.length);
    this.units = firstUnits;
    this.assignOrder(this.inAnim, 'order');
    this.units = lastUnits;
    this.assignOrder(this.outAnim, 'orderOut');
    this.units = [];
    if (this.inAnim) this.ctx.event('soft', this.inAnim.at, 0.6);
    for (const st of this.morphSteps) this.ctx.event('swoosh', st.at, 0.5);
    await Promise.all(pending);
    for (const g of this.glyphs) {
      const mat = g.mesh.material as THREE.Material;
      mat.depthWrite = false;
      mat.transparent = true;
    }
  }

  /** Places every morph letter for time t: settled in a state, or travelling between two. */
  private updateMorph(t: number, opacity: number, blur: number): void {
    const steps = this.morphSteps;
    let from = 0;
    let to = 0;
    let p = 1;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      if (t >= st.at + st.dur) from = to = i + 1;
      else if (t >= st.at) {
        from = i;
        to = i + 1;
        p = (t - st.at) / st.dur;
        break;
      } else break;
    }
    const q = from === to ? 1 : steps[from].ease(clamp01(p));
    const em = this.fontSize;
    const last = this.morphGlyphs.length ? this.morphGlyphs[0].slots.length - 1 : 0;
    const tmp = new THREE.Color();
    for (const g of this.morphGlyphs) {
      const A = g.slots[from];
      const B = g.slots[to];
      const group = g.unit.group;
      let slot: MorphSlot | null;
      let o = 1;
      let dy = 0;
      let k = 1;
      let bl = 0;
      if (from === to) slot = A;
      else if (A && B) {
        slot = { x: lerp(A.x, B.x, q), y: lerp(A.y, B.y, q), s: lerp(A.s, B.s, q), color: tmp.copy(A.color).lerp(B.color, q) };
      } else if (A) {
        // Leaving: lifts away and blurs out in the first half of the move.
        const e = smooth01(p * 1.8);
        slot = A;
        o = 1 - e;
        dy = e * em * 0.22;
        k = 1 - 0.12 * e;
        bl = e * em * 0.12;
      } else if (B) {
        // Arriving: settles in during the second half, after the shared letters have started moving.
        const e = smooth01((p - 0.45) / 0.55);
        slot = B;
        o = e;
        dy = -(1 - e) * em * 0.22;
        k = 0.88 + 0.12 * e;
        bl = (1 - e) * em * 0.12;
      } else slot = null;
      if (!slot || o <= 0.001) {
        group.visible = false;
        continue;
      }
      const d: UnitDelta = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, s: 1, opacity: 1, blur: 0 };
      if (this.inAnim && g.slots[0]) this.unitDelta(this.inAnim, g.unit, t, d, 'order');
      if (this.outAnim && g.slots[last]) this.unitDelta(this.outAnim, g.unit, t, d, 'orderOut');
      group.position.set(slot.x + d.x, slot.y + dy + d.y, d.z);
      group.rotation.set(d.rx * DEG, d.ry * DEG, d.rz * DEG);
      group.scale.setScalar(Math.max(1e-4, slot.s * k * d.s));
      const op = opacity * o * d.opacity;
      group.visible = op > 0.001;
      const mesh = g.glyph.mesh;
      (mesh.color as THREE.Color).copy(slot.color);
      g.glyph.look.color = mesh.color as THREE.Color;
      setTextLook(mesh, op, g.glyph.look, blur + bl + d.blur);
    }
  }

  protected updateContent(t: number, opacity: number, blur = 0): void {
    if (this.morphGlyphs.length) return this.updateMorph(t, opacity, blur);
    const colorTrack = this.tracks.color('color', t);
    const colorKey = colorTrack ? `${colorTrack.r},${colorTrack.g},${colorTrack.b}` : '';
    if (colorTrack && colorKey !== this.lastColorKey) {
      for (const g of this.glyphs) {
        g.mesh.color = toThreeColor(colorTrack).multiplyScalar(this.spec.intensity ?? 1);
        if (this.batch) g.mesh.color = batchColor(g.mesh.color as THREE.Color);
        g.look.color = g.mesh.color as THREE.Color;
      }
      this.lastColorKey = colorKey;
    }
    if (this.batch) {
      // Still text: only opacity and blur change; the batch reads each letter's look as it draws.
      for (const g of this.glyphs) setTextLook(g.mesh, opacity, g.look, blur);
      return;
    }
    const shift = this.buildOffsets(t);
    for (const u of this.units) {
      const d: UnitDelta = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, s: 1, opacity: 1, blur: 0 };
      let pIn = 1;
      if (this.inAnim) pIn = this.unitDelta(this.inAnim, u, t, d, 'order');
      if (this.outAnim) this.unitDelta(this.outAnim, u, t, d, 'orderOut');
      if (this.onPath) {
        // Along the curve: the letter's center travels its distance from the line start, sits on the
        // curve at its height above the baseline, and turns with the curve.
        const P = this.onPath;
        const sp = this.spec.path!;
        const lead = sp.align === 'center' ? (P.length - P.width) / 2 : sp.align === 'end' ? P.length - P.width : 0;
        const dist = lead + this.num('pathOffset', t, sp.offset ?? 0) + (u.cx - P.left);
        const k = Math.min(1, Math.max(0, dist / Math.max(1e-6, P.length)));
        P.curve.getPointAt(k, this.pathPt);
        P.curve.getTangentAt(Math.min(0.9999, Math.max(0.0001, k)), this.pathTan);
        const ang = Math.atan2(this.pathTan.y, this.pathTan.x);
        // Past either end the letter keeps going straight along the end tangent.
        const over = dist < 0 ? dist : dist > P.length ? dist - P.length : 0;
        const h = u.cy - P.base;
        u.group.position.set(this.pathPt.x + this.pathTan.x * over - Math.sin(ang) * h + d.x, this.pathPt.y + this.pathTan.y * over + Math.cos(ang) * h + d.y, d.z);
        u.group.rotation.set(d.rx * DEG, d.ry * DEG, ang + d.rz * DEG);
      } else {
        u.group.position.set(u.cx + d.x + (shift.get(u.line) ?? 0), u.cy + d.y, d.z);
        u.group.rotation.set(d.rx * DEG, d.ry * DEG, d.rz * DEG);
      }
      u.group.scale.setScalar(Math.max(d.s, 1e-4));
      const o = opacity * d.opacity;
      u.group.visible = o > 0.001;
      const lb = this.lineBounds[u.line];
      for (const g of u.chars) {
        setTextLook(g.mesh, o, g.look, blur + d.blur);
        if (d.clip && lb) {
          // Clip rect is in the glyph's local space; the line box stays fixed in content space.
          const ox = u.group.position.x + g.mesh.position.x;
          const oy = u.group.position.y + g.mesh.position.y;
          g.mesh.clipRect = [lb.minX - ox, lb.minY - oy, lb.maxX - ox, lb.maxY - oy];
        } else if (g.mesh.clipRect) {
          g.mesh.clipRect = null;
        }
        if (this.inAnim?.name === 'scramble') {
          // `chars` picks the stand-in letters ("lower", "upper", or a string of its own).
          const cp = this.inAnim.params.chars;
          const set = cp === 'lower' ? 'abcdefghijklmnopqrstuvwxyz' : cp === 'upper' ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' : typeof cp === 'string' && cp ? cp : SCRAMBLE;
          const keep = /\s/.test(g.char);
          const want = pIn >= 1 || keep ? g.char : set[Math.floor(Math.abs(noise1(g.unit * 7.7 + Math.floor(t * 24) * 1.3, 3)) * set.length) % set.length];
          if (want !== g.current) {
            g.current = want;
            g.mesh.text = want;
            this.rt.waitFor(syncText(g.mesh));
          }
        }
      }
    }
  }
}

function formatNumber(v: number, decimals: number, sep: boolean): string {
  const fixed = v.toFixed(decimals);
  if (!sep) return fixed;
  const [int, frac] = fixed.split('.');
  const neg = int.startsWith('-');
  const digits = neg ? int.slice(1) : int;
  const withSep = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + withSep + (frac ? '.' + frac : '');
}

/** A number that counts from `from` to `to`. */
export class CounterLayer extends Layer<CounterSpec> {
  private mesh!: Text;
  private current = '';
  private look!: TextLook;
  private w = 0;
  private h = 0;
  private ease!: EaseFn;
  private at = 0;
  private dur = 1.5;

  size() {
    return { w: this.w, h: this.h };
  }

  private format(v: number): string {
    const s = this.spec;
    return `${s.prefix ?? ''}${formatNumber(v, s.decimals ?? 0, s.separator ?? true)}${s.suffix ?? ''}`;
  }

  async load(): Promise<void> {
    const s = this.spec;
    const ctx = this.ctx;
    const size = s.size ?? 96;
    const style: Style = {
      font: ctx.fontUrl(s.font ?? 'display', s.weight ?? 700, s.italic ?? false),
      size,
      lineHeight: s.lineHeight ?? 1.1,
      letterSpacing: s.letterSpacing ?? -0.02,
      color: ctx.color(s.color ?? '$text'),
    };
    this.ease = resolveEase(s.ease, 'outExpo');
    this.at = ctx.time(s.at, this.start);
    this.dur = ctx.time(s.duration, 1.6);
    // Measure at the final value so the layout box stays stable.
    this.mesh = makeText(style, this.format(s.to), s, ctx);
    const anchor = s.anchor ?? s.align ?? 'center';
    this.mesh.anchorX = anchor;
    this.mesh.anchorY = 'middle';
    this.mesh.renderOrder = this.order;
    await syncText(this.mesh);
    const bb = this.mesh.textRenderInfo!.blockBounds;
    this.w = bb[2] - bb[0];
    this.h = bb[3] - bb[1];
    this.current = this.format(s.to);
    this.look = lookOf(this.mesh, style.color.a);
    const mat = this.mesh.material as THREE.Material;
    mat.depthWrite = false;
    this.pivot.add(this.mesh);
  }

  protected updateContent(t: number, opacity: number, blur = 0): void {
    const s = this.spec;
    const from = s.from ?? 0;
    // The number changes once per video frame: motion blur samples within a frame all show the same
    // digits, so a rolling count stays readable instead of blending several values.
    const fps = this.ctx.fps;
    const tf = Math.round(t * fps) / fps;
    const pf = this.dur <= 0 ? 1 : clamp01((tf - this.at) / this.dur);
    const v = this.tracks.has('value') ? this.num('value', tf, s.to) : from + (s.to - from) * this.ease(pf);
    const str = this.format(v);
    if (str !== this.current) {
      this.current = str;
      this.mesh.text = str;
      this.rt.waitFor(syncText(this.mesh));
    }
    const c = this.tracks.color('color', t);
    if (c) this.mesh.color = toThreeColor(c);
    setTextLook(this.mesh, opacity, this.look, blur);
  }
}
