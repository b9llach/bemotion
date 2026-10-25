import type { Fill, Glow, ImageLayer as ImageSpec, Shadow, ShapeLayer as ShapeSpec } from '../../spec/schema';
import { Layer, type SceneRuntime } from './base';
import { SdfMesh, type SdfParams } from './sdf';
import type { EngineContext } from '../context';
import type { TrackSet } from '../anim/keyframes';
import type { RGBA } from '../util/color';

export function fillParams(fill: Fill | undefined, tracks: TrackSet, t: number, ctx: EngineContext, fallback = '$surface'): Pick<SdfParams, 'fillA' | 'fillB' | 'fillType' | 'angle' | 'center'> {
  const kf = tracks.color('fill', t);
  if (fill && typeof fill === 'object') {
    return {
      fillA: kf ?? ctx.color(fill.from),
      fillB: tracks.color('fillTo', t) ?? ctx.color(fill.to),
      fillType: fill.type,
      angle: tracks.num('angle', t, fill.angle ?? 180),
      center: fill.center ? [tracks.num('centerX', t, fill.center[0]), tracks.num('centerY', t, fill.center[1])] : undefined,
    };
  }
  return { fillA: kf ?? ctx.color(fill ?? fallback), fillType: 'solid' };
}

export function shadowParams(sh: Shadow | boolean | undefined, ctx: EngineContext): SdfParams['shadow'] {
  if (!sh) return null;
  const s: Shadow = sh === true ? {} : sh;
  const c = ctx.color(s.color ?? '#000000');
  return {
    color: { ...c, a: c.a * (s.opacity ?? 0.5) },
    blur: s.blur ?? 48,
    x: s.x ?? 0,
    y: s.y ?? -20,
    spread: s.spread ?? 0,
  };
}

export function glowParams(g: Glow | undefined, ctx: EngineContext, fallback: RGBA, intensityScale = 1): SdfParams['glow'] {
  if (!g) return null;
  const c = g.color ? ctx.color(g.color) : fallback;
  return { color: { ...c, a: c.a * (g.intensity ?? 0.6) * intensityScale }, size: g.size ?? 24 };
}

export class ShapeLayer extends Layer<ShapeSpec> {
  readonly mesh = new SdfMesh();

  constructor(spec: ShapeSpec, rt: SceneRuntime) {
    super(spec, rt);
  }

  private dims(t: number): { w: number; h: number } {
    const s = this.spec;
    const isRound = s.shape === 'circle' || s.shape === 'ring';
    const w = this.num('width', t, s.width ?? (isRound ? s.height ?? 200 : 200));
    const h = this.num('height', t, s.height ?? (isRound ? w : 200));
    return { w, h };
  }

  size() {
    return this.dims(0);
  }

  async load(): Promise<void> {
    this.setupMaterial(this.mesh, this.mesh.material);
    this.pivot.add(this.mesh);
  }

  protected updateContent(t: number, opacity: number, blur = 0): void {
    const s = this.spec;
    const { w, h } = this.dims(t);
    const shape = s.shape ?? 'rect';
    const code = (v?: string) => (v === 'circle' ? 'ellipse' : v === 'ring' ? 'ring' : v === 'sparkle' ? 'sparkle' : 'rect') as 'rect' | 'ellipse' | 'ring' | 'sparkle';
    const fill = fillParams(s.fill, this.tracks, t, this.ctx, shape === 'ring' ? '$primary' : '$surface');
    const strokeColor = this.tracks.color('stroke', t) ?? (s.stroke ? this.ctx.color(s.stroke) : undefined);
    this.mesh.setParams({
      width: w,
      height: h,
      radius: shape === 'pill' ? Math.min(w, h) / 2 : this.num('radius', t, s.radius ?? 0),
      shape: code(shape),
      morphTo: s.morphTo ? code(s.morphTo) : undefined,
      morph: this.num('morph', t, s.morph ?? 0),
      blur,
      ...fill,
      stroke: strokeColor,
      strokeWidth: this.num('strokeWidth', t, s.strokeWidth ?? (shape === 'ring' ? 12 : strokeColor ? 1.5 : 0)),
      shadow: shadowParams(s.shadow, this.ctx),
      glow: glowParams(s.glow, this.ctx, fill.fillA, this.num('glow', t, 1)),
      progress: this.num('progress', t, s.progress ?? 1),
      intensity: this.num('intensity', t, s.intensity ?? 1),
      // Internal: set by the glow component for a light-like falloff.
      falloff: (s as { falloff?: number }).falloff,
    });
    if (s.glass) {
      const g = s.glass;
      const tint = this.ctx.color(g.tint ?? '#FFFFFF');
      this.mesh.setGlass({
        blur: g.blur ?? 20,
        refract: g.refract ?? 24,
        edge: g.edge ?? 40,
        tint: { ...tint, a: g.tintAmount ?? (g.tint && tint.a < 1 ? tint.a : 0.3) },
        rim: g.rim ?? 0.15,
      });
    }
    this.mesh.setOpacity(opacity);
  }
}

export class ImageLayer extends Layer<ImageSpec> {
  readonly mesh = new SdfMesh();
  private w = 400;
  private h = 300;

  size() {
    return { w: this.w, h: this.h };
  }

  async load(): Promise<void> {
    const s = this.spec;
    const tex = await this.ctx.texture(s.src);
    const img = tex.image as { width: number; height: number };
    const aspect = img.width / img.height;
    this.w = s.width ?? (s.height ? s.height * aspect : img.width);
    this.h = s.height ?? this.w / aspect;
    this.setupMaterial(this.mesh, this.mesh.material);
    this.mesh.setParams({ width: this.w, height: this.h, fillA: { r: 1, g: 1, b: 1, a: 1 } });
    this.mesh.setMap(tex, s.fit ?? 'cover');
    this.pivot.add(this.mesh);
  }

  protected updateContent(t: number, opacity: number, blur = 0): void {
    const s = this.spec;
    this.mesh.setParams({
      blur: blur * 0.35,
      width: this.w,
      height: this.h,
      radius: this.num('radius', t, s.radius ?? 0),
      fillA: { r: 1, g: 1, b: 1, a: 1 },
      stroke: s.stroke ? this.ctx.color(s.stroke) : undefined,
      strokeWidth: s.strokeWidth ?? (s.stroke ? 1.5 : 0),
      shadow: shadowParams(s.shadow, this.ctx),
    });
    this.mesh.setMapBlur(blur);
    const ht = s.halftone;
    if (ht) {
      const cell = ht.cell ?? this.w / (ht.columns ?? 40);
      this.mesh.setHalftone({
        amount: this.num('halftone', t, ht.amount ?? 1),
        cell,
        color: this.ctx.color(ht.color ?? '$primary'),
        levels: ht.levels ?? [0, 1],
        invert: ht.invert ?? false,
        size: ht.size ?? 0.95,
      });
    }
    this.mesh.setOpacity(opacity);
  }
}
