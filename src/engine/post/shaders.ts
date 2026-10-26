export const quadVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const copyFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform float uWeight;
void main() {
  gl_FragColor = texture2D(tSrc, vUv) * uWeight;
}
`;

/**
 * A shared element in flight: both copies (rendered alone, premultiplied) are placed around the current
 * center at their own uniform scale, so neither stretches, and crossfaded.
 */
export const flightFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tA;
uniform sampler2D tB;
uniform vec2 uRes;
uniform vec2 uC;
uniform vec2 uCA;
uniform vec2 uCB;
uniform float uKA;
uniform float uKB;
uniform float uWA;
uniform float uWB;
float inside(vec2 u) { return step(0.0, u.x) * step(0.0, u.y) * step(u.x, 1.0) * step(u.y, 1.0); }
void main() {
  vec2 X = vUv * uRes;
  vec2 ua = (uCA + (X - uC) / uKA) / uRes;
  vec2 ub = (uCB + (X - uC) / uKB) / uRes;
  vec4 a = uWA > 0.0 ? texture2D(tA, ua) * inside(ua) : vec4(0.0);
  vec4 b = uWB > 0.0 ? texture2D(tB, ub) * inside(ub) : vec4(0.0);
  gl_FragColor = a * uWA + b * uWB;
}
`;

export const TRANSITIONS = ['fade', 'black', 'flash', 'slide', 'push', 'whip', 'zoom', 'zoomOut', 'glitch', 'wipe', 'circle', 'pixelate', 'blur', 'split', 'mask'];

export const transitionFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tA;
uniform sampler2D tB;
uniform float uP;
uniform int uType;
uniform vec2 uDir;
uniform vec3 uColor;
uniform vec2 uRes;
uniform float uSeed;
uniform sampler2D tMask;
uniform vec4 uMaskRect;
uniform vec2 uMaskP0;
uniform vec2 uMaskO;
uniform float uMaskS;
uniform float uMaskA;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

vec4 sA(vec2 uv) { return texture2D(tA, clamp(uv, 0.0, 1.0)); }
vec4 sB(vec2 uv) { return texture2D(tB, clamp(uv, 0.0, 1.0)); }
float inside(vec2 uv) { return step(0.0, uv.x) * step(0.0, uv.y) * step(uv.x, 1.0) * step(uv.y, 1.0); }

float jitter() { return hash(gl_FragCoord.xy + uSeed); }
vec4 zoomBlurA(vec2 uv, float scale, float strength) {
  vec2 c = vec2(0.5);
  vec4 acc = vec4(0.0);
  float j = jitter();
  for (int i = 0; i < 24; i++) { float f = (float(i) + j) / 24.0; vec2 u = c + (uv - c) / (scale * (1.0 + strength * f)); acc += sA(u); }
  return acc / 24.0;
}
vec4 zoomBlurB(vec2 uv, float scale, float strength) {
  vec2 c = vec2(0.5);
  vec4 acc = vec4(0.0);
  float j = jitter();
  for (int i = 0; i < 24; i++) { float f = (float(i) + j) / 24.0; vec2 u = c + (uv - c) / (scale * (1.0 + strength * f)); acc += sB(u); }
  return acc / 24.0;
}
vec4 pushSample(vec2 uv, float p) {
  vec2 ub = uv - uDir * (1.0 - p);
  return inside(ub) > 0.5 ? sB(ub) : sA(uv + uDir * p);
}
vec4 whipBlur(vec2 uv, vec2 d, float p) {
  vec4 acc = vec4(0.0);
  float j = jitter();
  for (int i = 0; i < 40; i++) { float f = (float(i) + j) / 40.0 - 0.5; acc += pushSample(uv + d * f, p); }
  return acc / 40.0;
}
vec4 boxBlurA(vec2 uv, float r) {
  vec4 acc = vec4(0.0);
  for (int x = -3; x <= 3; x++) for (int y = -3; y <= 3; y++) acc += sA(uv + vec2(float(x), float(y)) * r / uRes);
  return acc / 49.0;
}
vec4 boxBlurB(vec2 uv, float r) {
  vec4 acc = vec4(0.0);
  for (int x = -3; x <= 3; x++) for (int y = -3; y <= 3; y++) acc += sB(uv + vec2(float(x), float(y)) * r / uRes);
  return acc / 49.0;
}

void main() {
  vec2 uv = vUv;
  float p = uP;
  vec4 c;
  if (uType == 0) {
    c = mix(sA(uv), sB(uv), p);
  } else if (uType == 1 || uType == 2) {
    vec4 mid = vec4(uColor * (uType == 2 ? 3.0 : 1.0), 1.0);
    c = p < 0.5 ? mix(sA(uv), mid, smoothstep(0.0, 1.0, p * 2.0)) : mix(mid, sB(uv), smoothstep(0.0, 1.0, (p - 0.5) * 2.0));
  } else if (uType == 3) {
    vec2 ub = uv - uDir * (1.0 - p);
    c = inside(ub) > 0.5 ? sB(ub) : sA(uv) * (1.0 - 0.4 * p);
  } else if (uType == 4) {
    vec2 ua = uv + uDir * p;
    vec2 ub = uv - uDir * (1.0 - p);
    c = inside(ub) > 0.5 ? sB(ub) : sA(ua);
  } else if (uType == 5) {
    float speed = sin(p * 3.14159265);
    vec2 blur = uDir * speed * speed * 0.22;
    c = whipBlur(uv, blur, p);
  } else if (uType == 6) {
    float k = smoothstep(0.35, 0.65, p);
    vec4 a = zoomBlurA(uv, 1.0 + p * p * 4.0, p * 0.5);
    vec4 b = zoomBlurB(uv, 0.35 + 0.65 * smoothstep(0.0, 1.0, p), (1.0 - p) * 0.5);
    c = mix(a, b, k);
  } else if (uType == 7) {
    float k = smoothstep(0.35, 0.65, p);
    vec4 a = zoomBlurA(uv, 1.0 - 0.65 * smoothstep(0.0, 1.0, p), p * 0.4);
    vec4 b = zoomBlurB(uv, 1.0 + (1.0 - p) * (1.0 - p) * 4.0, (1.0 - p) * 0.5);
    c = mix(a, b, k);
  } else if (uType == 8) {
    float slot = floor(p * 18.0);
    float band = floor(uv.y * 24.0);
    float r = hash(vec2(band, slot + uSeed));
    float amt = sin(p * 3.14159265);
    float shift = (r - 0.5) * 0.25 * amt * step(0.55, r);
    vec2 u2 = uv + vec2(shift, 0.0);
    float useB = step(r * 0.6 + 0.2, p);
    float ca = 0.012 * amt;
    vec4 a = vec4(sA(u2 + vec2(ca, 0.0)).r, sA(u2).g, sA(u2 - vec2(ca, 0.0)).b, sA(u2).a);
    vec4 b = vec4(sB(u2 + vec2(ca, 0.0)).r, sB(u2).g, sB(u2 - vec2(ca, 0.0)).b, sB(u2).a);
    c = mix(a, b, useB);
  } else if (uType == 9) {
    float d = dot(uv - 0.5, normalize(uDir)) + 0.5;
    float edge = 0.04;
    float m = 1.0 - smoothstep(p * (1.0 + edge) - edge, p * (1.0 + edge), 1.0 - d);
    c = mix(sA(uv), sB(uv), m);
  } else if (uType == 10) {
    vec2 q = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
    float r = p * 1.05 * length(vec2(uRes.x / uRes.y, 1.0)) * 0.5;
    float m = smoothstep(r, r - 0.01, length(q));
    c = mix(sA(uv), sB(uv), m);
  } else if (uType == 11) {
    float amt = 1.0 - abs(p - 0.5) * 2.0;
    float px = max(1.0, floor(amt * amt * 80.0));
    vec2 cell = px / uRes;
    vec2 u2 = (floor(uv / cell) + 0.5) * cell;
    c = p < 0.5 ? sA(u2) : sB(u2);
  } else if (uType == 12) {
    float amt = 1.0 - abs(p - 0.5) * 2.0;
    float r = amt * 10.0;
    c = mix(boxBlurA(uv, r), boxBlurB(uv, r), smoothstep(0.3, 0.7, p));
  } else if (uType == 14) {
    // The next scene through a word or logo: screen pixels map back into the mask around its deepest
    // point, which travels to the center while the zoom grows.
    vec2 X = uv * uRes;
    vec2 X1 = uMaskP0 + (X - uMaskO) / uMaskS;
    vec2 mu = (X1 - uMaskRect.xy) / uMaskRect.zw;
    float m = inside(mu) * texture2D(tMask, clamp(mu, 0.0, 1.0)).a * uMaskA;
    c = mix(sA(uv), sB(uv), m);
  } else {
    float bands = 6.0;
    float i = floor(uv.y * bands);
    float dir = mod(i, 2.0) < 1.0 ? 1.0 : -1.0;
    float delay = i / bands * 0.25;
    float q = smoothstep(delay, delay + 0.75, p);
    vec2 ub = uv - vec2(dir * (1.0 - q), 0.0);
    c = inside(ub) > 0.5 ? sB(ub) : sA(uv + vec2(dir * q * 0.3, 0.0));
  }
  gl_FragColor = c;
}
`;

export const finalFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uRes;
uniform float uChromatic;
uniform float uVignette;
uniform float uGrain;
uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
uniform int uTonemap;
uniform float uFrame;
uniform float uAlpha;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

vec3 aces(vec3 x) {
  const float a = 2.51; const float b = 0.03; const float c = 2.43; const float d = 0.59; const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 agx(vec3 v) {
  // Compact AgX-like curve: log encode + sigmoid.
  v = max(v, 1e-6);
  vec3 l = clamp((log2(v) + 12.47) / 16.5, 0.0, 1.0);
  vec3 l2 = l * l; vec3 l4 = l2 * l2;
  return clamp(15.5 * l4 * l2 - 40.14 * l4 * l + 31.96 * l4 - 6.868 * l2 * l + 0.4298 * l2 + 0.1191 * l - 0.00232, 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

void main() {
  vec2 uv = vUv;
  vec3 col;
  // Scene buffers hold premultiplied color. Opaque output ignores alpha (it is 1 wherever a
  // background was drawn). Transparent output keeps it, raised where additive light (glows, bloom)
  // brightened empty pixels, and grades the unpremultiplied color.
  float alpha = 1.0;
  if (uAlpha > 0.5) alpha = clamp(texture2D(tSrc, uv).a, 0.0, 1.0);
  if (uChromatic > 0.0) {
    vec2 d = (uv - 0.5);
    vec2 off = d * length(d) * uChromatic / uRes * 2.0;
    col = vec3(texture2D(tSrc, uv + off).r, texture2D(tSrc, uv).g, texture2D(tSrc, uv - off).b);
  } else {
    col = texture2D(tSrc, uv).rgb;
  }
  if (uAlpha > 0.5) {
    alpha = clamp(max(alpha, max(col.r, max(col.g, col.b))), 0.0, 1.0);
    col = alpha > 0.0 ? col / alpha : vec3(0.0);
  }
  col *= uExposure;
  if (uTonemap == 1) col = aces(col);
  else if (uTonemap == 2) col = agx(col);
  else if (uTonemap == 3) {
    // Highlight roll-off: everything up to 1.0 is untouched (white sets stay white); brighter pixels
    // desaturate toward white like film instead of clipping into flat color.
    float peak = max(col.r, max(col.g, col.b));
    if (peak > 1.0) col = mix(col / peak, vec3(1.0), clamp((peak - 1.0) / 3.0, 0.0, 1.0));
  }
  vec3 s = toSRGB(col);
  s = (s - 0.5) * uContrast + 0.5;
  float luma = dot(s, vec3(0.2126, 0.7152, 0.0722));
  s = mix(vec3(luma), s, uSaturation);
  if (uVignette > 0.0 && uAlpha < 0.5) {
    vec2 q = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
    s *= 1.0 - uVignette * smoothstep(0.35, 1.05, length(q));
  }
  float n = hash(uv * uRes + vec2(uFrame * 17.13, uFrame * 9.71));
  if (uGrain > 0.0) s += (n - 0.5) * uGrain;
  // Dither to kill banding in dark gradients.
  s += (hash(uv * uRes + 3.7 + uFrame) - 0.5) / 255.0;
  gl_FragColor = vec4(clamp(s, 0.0, 1.0), alpha);
}
`;

/** One direction of a separable Gaussian blur. `uStep` is one texel along the blur direction; `uSigma` in texels. */
export const blurFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uStep;
uniform float uSigma;
void main() {
  float spacing = max(1.0, uSigma / 4.0);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -12; i <= 12; i++) {
    float x = float(i) * spacing;
    float w = exp(-0.5 * x * x / max(uSigma * uSigma, 1e-4));
    acc += texture2D(tSrc, vUv + uStep * x) * w;
    wsum += w;
  }
  gl_FragColor = acc / wsum;
}
`;
