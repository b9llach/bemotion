import * as THREE from 'three';
import type { RGBA } from '../util/color';

const vert = /* glsl */ `
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const frag = /* glsl */ `
precision highp float;
varying vec2 vLocal;
uniform vec2 uSize;
uniform float uRadius;
uniform int uShape;          // 0 rounded rect, 1 ellipse, 2 ring, 3 sparkle
uniform int uShapeB;         // morph target shape
uniform float uMorph;        // 0 = uShape, 1 = uShapeB
uniform float uBlur;         // edge blur radius in px
uniform float uMapBias;      // texture LOD bias for blurred images
uniform vec4 uFillA;         // sRGB + alpha
uniform vec4 uFillB;
uniform int uFillType;       // 0 solid, 1 linear, 2 radial
uniform float uAngle;        // degrees, CSS convention (0 = to top)
uniform float uFalloff;      // radial: 1 = linear, >1 = light-like soft falloff
uniform vec2 uGradCenter;    // radial gradient center in px from the shape center
uniform vec4 uStroke;
uniform float uStrokeWidth;
uniform vec4 uShadow;
uniform float uShadowBlur;
uniform vec2 uShadowOffset;
uniform float uShadowSpread;
uniform vec4 uGlow;
uniform float uGlowSize;
uniform float uOpacity;
uniform float uDiscard;
uniform float uIntensity;
uniform float uProgress;
uniform sampler2D uMap;
uniform bool uHasMap;
uniform vec4 uMapTransform;  // scale.xy, offset.xy

vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

float sdRoundBox(vec2 p, vec2 b, float r) {
  r = min(r, min(b.x, b.y));
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Concave four-point star (sparkle / glint). Radial distance, good enough for AA and blur.
float sdSparkle(vec2 p, vec2 b) {
  vec2 q = p / b;
  float ang = atan(q.y, q.x);
  float k = 0.58;
  float c = abs(cos(ang));
  float s = abs(sin(ang));
  float rr = pow(pow(c, k) + pow(s, k), -1.0 / k);
  return (length(q) - rr) * min(b.x, b.y) * 0.75;
}

float sdOf(int shape, vec2 p) {
  vec2 b = uSize * 0.5;
  if (shape == 0) return sdRoundBox(p, b, uRadius);
  if (shape == 3) return sdSparkle(p, b);
  float m = min(b.x, b.y);
  if (abs(b.x - b.y) < 0.5) return length(p) - m;
  return (length(p / b) - 1.0) * m;
}

float sdShape(vec2 p) {
  float d = sdOf(uShape, p);
  if (uMorph > 0.0) d = mix(d, sdOf(uShapeB, p), clamp(uMorph, 0.0, 1.0));
  return d;
}

void main() {
  vec2 p = vLocal;
  float d = sdShape(p);
  float aa = max(fwidth(d), 0.0001);
  float inside = 1.0 - smoothstep(-aa * 0.5 - uBlur, aa * 0.5 + uBlur, d);

  // Fill
  vec4 fill = uFillA;
  if (uFillType == 1) {
    float a = radians(uAngle);
    vec2 dir = vec2(sin(a), cos(a));
    float half_ = abs(uSize.x * 0.5 * dir.x) + abs(uSize.y * 0.5 * dir.y);
    float t = clamp(dot(p, dir) / max(half_, 1.0) * 0.5 + 0.5, 0.0, 1.0);
    fill = mix(uFillA, uFillB, t);
  } else if (uFillType == 2) {
    float t = clamp(length((p - uGradCenter) / (uSize * 0.5)), 0.0, 1.0);
    if (uFalloff > 1.0) t = 1.0 - pow(1.0 - t, uFalloff);
    fill = mix(uFillA, uFillB, t);
  }
  vec3 fillLin = toLinear(fill.rgb);
  float fillA = fill.a;
  if (uHasMap) {
    vec2 uv = (p / uSize + 0.5) * uMapTransform.xy + uMapTransform.zw;
    vec4 tex = texture2D(uMap, uv, uMapBias);
    float inUv = step(0.0, uv.x) * step(0.0, uv.y) * step(uv.x, 1.0) * step(uv.y, 1.0);
    fillLin = tex.rgb;
    fillA = tex.a * inUv;
  }

  // Ring: stroke-only ellipse with an arc progress that sweeps clockwise from the top.
  float shapeMask = inside;
  if (uShape == 2) {
    float band = 1.0 - smoothstep(-aa * 0.5, aa * 0.5, -d - uStrokeWidth);
    shapeMask = inside * band;
    float ang = atan(p.x, p.y);
    float frac = (ang < 0.0 ? ang + 6.28318530718 : ang) / 6.28318530718;
    float arcAA = aa / max(length(p) * 6.28318530718, 1.0);
    shapeMask *= 1.0 - smoothstep(uProgress - arcAA, uProgress + arcAA, frac);
    if (uProgress >= 0.9999) shapeMask = inside * band;
  }

  // Inner stroke
  vec3 col = fillLin;
  float alpha = fillA;
  if (uShape != 2 && uStrokeWidth > 0.0 && uStroke.a > 0.0) {
    float sm = smoothstep(-uStrokeWidth - aa * 0.5, -uStrokeWidth + aa * 0.5, d);
    float sa = sm * uStroke.a;
    vec3 sl = toLinear(uStroke.rgb);
    // Stroke composited over fill
    col = (sl * sa + col * alpha * (1.0 - sa)) / max(sa + alpha * (1.0 - sa), 1e-4);
    alpha = sa + alpha * (1.0 - sa);
  }
  vec4 shape = vec4(col * uIntensity * alpha, alpha) * shapeMask;

  // Glow (outside the shape)
  vec4 glow = vec4(0.0);
  if (uGlow.a > 0.0 && uGlowSize > 0.0) {
    float g = exp(-max(d, 0.0) / uGlowSize * 2.2) * (1.0 - inside * 0.0);
    float ga = g * uGlow.a;
    glow = vec4(toLinear(uGlow.rgb) * uIntensity * ga, ga);
  }

  // Drop shadow
  vec4 shadow = vec4(0.0);
  if (uShadow.a > 0.0) {
    float ds = sdShape(p - uShadowOffset) - uShadowSpread;
    float blur = max(uShadowBlur, 1.0);
    float s = 1.0 - smoothstep(-blur * 0.5, blur, ds);
    s *= s;
    float sa = s * uShadow.a;
    shadow = vec4(toLinear(uShadow.rgb) * sa, sa);
  }

  // Premultiplied compositing: shadow, then glow, then shape.
  vec4 outc = shadow;
  outc = glow + outc * (1.0 - glow.a);
  outc = shape + outc * (1.0 - shape.a);
  gl_FragColor = outc * uOpacity;
  // Masks draw only into the stencil: drop the transparent part of the quad.
  if (gl_FragColor.a < uDiscard) discard;
}
`;

export interface SdfParams {
  width: number;
  height: number;
  radius?: number;
  shape?: 'rect' | 'ellipse' | 'ring' | 'sparkle';
  morphTo?: 'rect' | 'ellipse' | 'ring' | 'sparkle';
  morph?: number;
  blur?: number;
  fillA: RGBA;
  fillB?: RGBA;
  fillType?: 'solid' | 'linear' | 'radial';
  angle?: number;
  falloff?: number;
  /** Radial gradient center as a fraction of the size, -0.5..0.5. */
  center?: [number, number];
  stroke?: RGBA;
  strokeWidth?: number;
  shadow?: { color: RGBA; blur: number; x: number; y: number; spread: number } | null;
  glow?: { color: RGBA; size: number } | null;
  progress?: number;
  intensity?: number;
}

const v4 = (c: RGBA) => new THREE.Vector4(c.r, c.g, c.b, c.a);

/** A flat SDF-rendered shape. Coordinates are pixels, centered. */
export class SdfMesh extends THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  private pad = -1;
  private w = -1;
  private h = -1;

  constructor() {
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
      uniforms: {
        uSize: { value: new THREE.Vector2(100, 100) },
        uRadius: { value: 0 },
        uShape: { value: 0 },
        uShapeB: { value: 0 },
        uMorph: { value: 0 },
        uBlur: { value: 0 },
        uMapBias: { value: 0 },
        uFillA: { value: new THREE.Vector4(1, 1, 1, 1) },
        uFillB: { value: new THREE.Vector4(1, 1, 1, 1) },
        uFillType: { value: 0 },
        uAngle: { value: 180 },
        uFalloff: { value: 1 },
        uGradCenter: { value: new THREE.Vector2(0, 0) },
        uStroke: { value: new THREE.Vector4(0, 0, 0, 0) },
        uStrokeWidth: { value: 0 },
        uShadow: { value: new THREE.Vector4(0, 0, 0, 0) },
        uShadowBlur: { value: 0 },
        uShadowOffset: { value: new THREE.Vector2(0, 0) },
        uShadowSpread: { value: 0 },
        uGlow: { value: new THREE.Vector4(0, 0, 0, 0) },
        uGlowSize: { value: 0 },
        uOpacity: { value: 1 },
        uDiscard: { value: 0 },
        uIntensity: { value: 1 },
        uProgress: { value: 1 },
        uMap: { value: null },
        uHasMap: { value: false },
        uMapTransform: { value: new THREE.Vector4(1, 1, 0, 0) },
      },
    });
    super(new THREE.PlaneGeometry(1, 1), mat);
  }

  setParams(p: SdfParams): void {
    const u = this.material.uniforms;
    const shadowPad = p.shadow ? p.shadow.blur * 1.5 + Math.max(Math.abs(p.shadow.x), Math.abs(p.shadow.y)) + p.shadow.spread : 0;
    const glowPad = p.glow ? p.glow.size * 3 : 0;
    const blurPad = (p.blur ?? 0) * 2;
    const pad = Math.ceil(Math.max(2, shadowPad, glowPad, blurPad));
    if (pad !== this.pad || p.width !== this.w || p.height !== this.h) {
      this.geometry.dispose();
      this.geometry = new THREE.PlaneGeometry(Math.max(1, p.width) + pad * 2, Math.max(1, p.height) + pad * 2);
      this.pad = pad;
      this.w = p.width;
      this.h = p.height;
    }
    u.uSize.value.set(Math.max(0.001, p.width), Math.max(0.001, p.height));
    u.uRadius.value = p.radius ?? 0;
    const code = (s?: string) => (s === 'ellipse' ? 1 : s === 'ring' ? 2 : s === 'sparkle' ? 3 : 0);
    u.uShape.value = code(p.shape);
    u.uShapeB.value = code(p.morphTo ?? p.shape);
    u.uMorph.value = p.morphTo ? p.morph ?? 0 : 0;
    u.uBlur.value = p.blur ?? 0;
    u.uFillA.value.copy(v4(p.fillA));
    u.uFillB.value.copy(v4(p.fillB ?? p.fillA));
    u.uFillType.value = p.fillType === 'linear' ? 1 : p.fillType === 'radial' ? 2 : 0;
    u.uAngle.value = p.angle ?? 180;
    u.uFalloff.value = p.falloff ?? 1;
    u.uGradCenter.value.set((p.center?.[0] ?? 0) * p.width, (p.center?.[1] ?? 0) * p.height);
    u.uStroke.value.copy(p.stroke ? v4(p.stroke) : new THREE.Vector4(0, 0, 0, 0));
    u.uStrokeWidth.value = p.strokeWidth ?? 0;
    if (p.shadow) {
      u.uShadow.value.copy(v4(p.shadow.color));
      u.uShadowBlur.value = p.shadow.blur;
      u.uShadowOffset.value.set(p.shadow.x, p.shadow.y);
      u.uShadowSpread.value = p.shadow.spread;
    } else {
      u.uShadow.value.set(0, 0, 0, 0);
    }
    if (p.glow) {
      u.uGlow.value.copy(v4(p.glow.color));
      u.uGlowSize.value = p.glow.size;
    } else {
      u.uGlow.value.set(0, 0, 0, 0);
    }
    u.uProgress.value = p.progress ?? 1;
    u.uIntensity.value = p.intensity ?? 1;
  }

  setOpacity(o: number): void {
    this.material.uniforms.uOpacity.value = o;
  }

  /** Blurs a texture by sampling a lower mip level. `blur` is in screen px. */
  setMapBlur(blur: number): void {
    const u = this.material.uniforms;
    const tex = u.uMap.value as THREE.Texture | null;
    if (!tex || blur <= 0.3) {
      u.uMapBias.value = 0;
      return;
    }
    const img = tex.image as { width: number };
    const texelsPerPx = img.width / Math.max(1, this.w);
    u.uMapBias.value = Math.log2(1 + blur * texelsPerPx * 0.9);
  }

  setMap(tex: THREE.Texture | null, fit: 'cover' | 'contain' | 'fill' = 'cover'): void {
    const u = this.material.uniforms;
    u.uMap.value = tex;
    u.uHasMap.value = !!tex;
    if (!tex) return;
    // Videos report their size as videoWidth/videoHeight (width/height are the element's, often 0).
    const img = tex.image as { width: number; height: number; videoWidth?: number; videoHeight?: number };
    const ta = (img.videoWidth || img.width) / (img.videoHeight || img.height);
    const sa = this.w / this.h;
    let sx = 1;
    let sy = 1;
    if (fit === 'cover') {
      if (ta > sa) sx = sa / ta;
      else sy = ta / sa;
    } else if (fit === 'contain') {
      if (ta > sa) sy = ta / sa;
      else sx = sa / ta;
    }
    u.uMapTransform.value.set(sx, sy, (1 - sx) / 2, (1 - sy) / 2);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  }
}
