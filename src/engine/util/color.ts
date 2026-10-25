import * as THREE from 'three';

/** sRGB color with alpha, components in 0..1. */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = {
  white: '#ffffff',
  black: '#000000',
  transparent: '#00000000',
  red: '#ff3b30',
  green: '#34c759',
  blue: '#0a84ff',
  yellow: '#ffd60a',
  orange: '#ff9f0a',
  purple: '#bf5af2',
  pink: '#ff375f',
  gray: '#8e8e93',
  grey: '#8e8e93',
};

export function parseColor(input: string): RGBA {
  let s = input.trim().toLowerCase();
  // No paint: a shape with only its stroke, a hidden fill.
  if (s === 'none' || s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (NAMED[s]) s = NAMED[s];
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) throw new Error(`Invalid hex color "${input}"`);
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  const m = /^(rgba?|hsla?)\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[2].split(/[\s,/]+/).filter(Boolean);
    const num = (p: string, scale: number) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / scale);
    if (m[1].startsWith('rgb')) {
      return { r: num(parts[0], 255), g: num(parts[1], 255), b: num(parts[2], 255), a: parts[3] !== undefined ? num(parts[3], 1) : 1 };
    }
    const h = parseFloat(parts[0]) / 360;
    const sat = num(parts[1], 100);
    const l = num(parts[2], 100);
    const c = new THREE.Color();
    c.setHSL(h, sat, l, THREE.SRGBColorSpace);
    const out = c.clone().convertLinearToSRGB();
    return { r: out.r, g: out.g, b: out.b, a: parts[3] !== undefined ? num(parts[3], 1) : 1 };
  }
  throw new Error(`Unsupported color "${input}"`);
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function toThreeColor(c: RGBA): THREE.Color {
  // Three's working color space is linear sRGB.
  return new THREE.Color(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
}

export function mixRGBA(a: RGBA, b: RGBA, t: number): RGBA {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t };
}

export function rgbaToCss(c: RGBA): string {
  const f = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgba(${f(c.r)},${f(c.g)},${f(c.b)},${c.a.toFixed(3)})`;
}

export function rgbaToHex(c: RGBA): string {
  const f = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${f(c.r)}${f(c.g)}${f(c.b)}`;
}

export function isColorString(v: unknown): v is string {
  return typeof v === 'string' && (/^#[0-9a-f]{3,8}$/i.test(v) || /^(rgba?|hsla?)\(/i.test(v) || v.startsWith('$') || v in NAMED);
}
