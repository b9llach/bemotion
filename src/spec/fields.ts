import { z } from 'zod';
import { LayerS } from './schema';

/** How the inspector edits a layer property. Derived from the zod schema so it never drifts. */
export type FieldKind = 'number' | 'string' | 'text' | 'color' | 'boolean' | 'enum' | 'json';

export interface FieldInfo {
  name: string;
  kind: FieldKind;
  options?: string[];
  /** The engine reads this property through keyframe tracks, so it can be keyed. */
  animatable: boolean;
  /** The schema accepts a plain string here (used by free-form JSON fields). */
  acceptsString: boolean;
  required: boolean;
}

/** Edited in the Transform section or managed elsewhere. */
export const TRANSFORM_FIELDS = new Set(['type', 'x', 'y', 'z', 'rotate', 'rotateX', 'rotateY', 'rotateZ', 'scale', 'opacity', 'keyframes', 'children']);

/** Properties each layer class reads through keyframe tracks (besides x/y/z, rotation, scale and opacity). */
const ANIMATABLE: Record<string, string[]> = {
  '*': ['scaleX', 'scaleY', 'blur'],
  background: ['angle', 'intensity'],
  mesh: ['amount', 'speed', 'color'],
  particles: ['speed'],
  path: ['color', 'intensity', 'progress'],
  icon: ['color', 'intensity', 'progress'],
  shape: ['glow', 'height', 'intensity', 'morph', 'progress', 'radius', 'strokeWidth', 'width', 'fill', 'fillTo', 'stroke', 'angle', 'centerX', 'centerY'],
  image: ['radius', 'halftone'],
  group: ['radius', 'halftone'],
  video: ['radius'],
  svg: ['fill', 'stroke', 'progress'],
  text: ['color', 'pathOffset'],
  counter: ['color', 'value'],
};

const COLOR_NAMES = /^(color|fill|fillTo|stroke|background|tint|accent|emissive|area)$|Color$/;
const LONG_TEXT = new Set(['text', 'code', 'd']);

function unwrap(s: z.ZodType): z.ZodType {
  let cur: any = s;
  for (let i = 0; i < 8; i++) {
    if (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable || cur instanceof z.ZodDefault) cur = cur.unwrap();
    else if (cur instanceof z.ZodLazy) cur = cur._zod.def.getter();
    else break;
  }
  return cur;
}

/** Leaf schema kinds inside (possibly nested) unions. */
function leaves(s: z.ZodType): z.ZodType[] {
  const u = unwrap(s);
  if (u instanceof z.ZodUnion) return (u.options as z.ZodType[]).flatMap(leaves);
  return [u];
}

function describe(name: string, schema: z.ZodType, type: string): FieldInfo {
  const ls = leaves(schema);
  const isStr = (x: z.ZodType) => x instanceof z.ZodString;
  const acceptsString = ls.some((x) => isStr(x) || x instanceof z.ZodEnum);
  const animatable = (ANIMATABLE['*'].includes(name) || (ANIMATABLE[type] ?? []).includes(name));
  const required = !(schema instanceof z.ZodOptional);
  const base = { name, animatable, acceptsString, required };
  if (ls.length === 1) {
    const x = ls[0];
    if (x instanceof z.ZodNumber) return { ...base, kind: 'number' };
    if (x instanceof z.ZodBoolean) return { ...base, kind: 'boolean' };
    if (x instanceof z.ZodEnum) return { ...base, kind: 'enum', options: (x.options as unknown[]).map(String) };
    if (x instanceof z.ZodString) return { ...base, kind: COLOR_NAMES.test(name) ? 'color' : LONG_TEXT.has(name) ? 'text' : 'string' };
  }
  // A color that may also be a gradient object (fill): edit as a color when the value is a string.
  if (COLOR_NAMES.test(name) && ls.some(isStr)) return { ...base, kind: 'color' };
  return { ...base, kind: 'json' };
}

let byType: Map<string, FieldInfo[]> | null = null;

function index(): Map<string, FieldInfo[]> {
  if (byType) return byType;
  byType = new Map();
  const du: any = unwrap(LayerS);
  for (const opt of du.options as z.ZodObject[]) {
    const shape = opt.shape as Record<string, z.ZodType>;
    const lit: any = unwrap(shape.type);
    const type = String(lit.value ?? [...(lit._zod?.def?.values ?? [])][0]);
    byType.set(
      type,
      Object.entries(shape)
        .filter(([k]) => !TRANSFORM_FIELDS.has(k))
        .map(([k, s]) => describe(k, s, type)),
    );
  }
  return byType;
}

/** Editable properties of a layer type, in schema order, without the transform fields. */
export function layerFields(type: string): FieldInfo[] {
  return index().get(type) ?? [];
}

/** All layer types the schema knows. */
export function layerTypes(): string[] {
  return [...index().keys()];
}

/** True when keyframes on `prop` change what the engine draws for this layer type. */
export function isAnimatable(type: string, prop: string): boolean {
  return TRANSFORM_FIELDS.has(prop) || ANIMATABLE['*'].includes(prop) || (ANIMATABLE[type] ?? []).includes(prop);
}

/** "letterSpacing" -> "Letter spacing". */
export function labelOf(name: string): string {
  const s = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
