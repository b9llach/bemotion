/**
 * Source assembly for `shader` layers, shared by the engine and by `bemotion validate` (which compiles
 * the same text in a headless browser). No three.js here, so the CLI can import it.
 *
 * The author writes `vec4 shade(vec2 uv)` returning an sRGB color with straight alpha. The prelude
 * declares the built-in and spec uniforms and a few helpers; the epilogue converts to linear and
 * premultiplies, like every other flat layer.
 */

export type UniformValue = number | number[] | string;

/** GLSL type of a spec uniform: numbers are floats, arrays vec2-vec4, color strings vec3 (sRGB). */
export function uniformType(v: UniformValue): 'float' | 'vec2' | 'vec3' | 'vec4' {
  if (typeof v === 'number') return 'float';
  if (typeof v === 'string') return 'vec3';
  if (v.length < 2 || v.length > 4) throw new Error(`uniform arrays need 2 to 4 numbers, got ${v.length}`);
  return `vec${v.length}` as 'vec2' | 'vec3' | 'vec4';
}

const BUILTINS = ['uTime', 'uResolution', 'uProgress', 'uOpacity', 'uDiscard', 'vUv', 'shade', 'main'];
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Line the epilogue starts at (so errors there read as "after the end of the code"). */
export const EPILOGUE_LINE = 100000;

export const SHADER_VERT = /* glsl */ `precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const HELPERS = /* glsl */ `
#define PI 3.14159265359
#define TAU 6.28318530718
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * noise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return s;
}
`;

/**
 * The fragment shader for three.js (GLSL ES 3.00 without the `#version` line, which three adds).
 * `uniforms` are the spec's; their names are checked here.
 */
export function buildFragment(code: string, uniforms: Record<string, UniformValue> = {}): string {
  if (!/\bvec4\s+shade\s*\(\s*(in\s+)?vec2\s+\w+\s*\)/.test(code)) {
    throw new Error('the shader must define `vec4 shade(vec2 uv)`, returning an sRGB color with alpha');
  }
  const decls = Object.entries(uniforms).map(([name, v]) => {
    if (!NAME.test(name)) throw new Error(`uniform name "${name}" is not a GLSL identifier`);
    if (BUILTINS.includes(name) || name.startsWith('gl_')) throw new Error(`uniform name "${name}" is reserved`);
    return `uniform ${uniformType(v)} ${name};`;
  });
  return [
    'precision highp float;',
    'precision highp int;',
    'in vec2 vUv;',
    'out vec4 bemotionFragColor;',
    '/** Scene-local seconds. */',
    'uniform float uTime;',
    '/** Layer size in px. */',
    'uniform vec2 uResolution;',
    '/** 0 to 1 over the layer\'s life. */',
    'uniform float uProgress;',
    'uniform float uOpacity;',
    'uniform float uDiscard;',
    ...decls,
    HELPERS,
    '#line 1',
    code,
    `#line ${EPILOGUE_LINE}`,
    'void main() {',
    '  vec4 c = shade(vUv);',
    '  float a = clamp(c.a, 0.0, 1.0) * uOpacity;',
    '  bemotionFragColor = vec4(toLinear(max(c.rgb, vec3(0.0))) * a, a);',
    '  if (bemotionFragColor.a < uDiscard) discard;',
    '}',
    '',
  ].join('\n');
}

/**
 * Turns a GLSL info log into readable lines with line numbers in the author's code, each followed by
 * that line of code. Returns '' when the log has no errors.
 */
export function formatShaderLog(log: string, code: string): string {
  const lines = code.split('\n');
  const out: string[] = [];
  for (const raw of log.split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    const m = /^(ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/.exec(l);
    if (!m) {
      if (/error/i.test(l)) out.push(`  ${l}`);
      continue;
    }
    if (m[1] !== 'ERROR') continue;
    const n = Number(m[2]);
    const msg = m[3].replace(/\s+/g, ' ');
    if (n >= EPILOGUE_LINE || n > lines.length) {
      out.push(`  after the last line: ${msg}`);
      continue;
    }
    out.push(`  line ${n}: ${msg}`);
    if (n >= 1 && lines[n - 1] !== undefined) out.push(`    ${n} | ${lines[n - 1].trim()}`);
  }
  return out.join('\n');
}

/** Compiles the fragment shader with a WebGL2 context; returns the formatted errors, or '' when it compiles. */
export function compileCheck(gl: WebGL2RenderingContext, frag: string, code: string): string {
  const sh = gl.createShader(gl.FRAGMENT_SHADER);
  if (!sh) return '';
  gl.shaderSource(sh, `#version 300 es\n${frag}`);
  gl.compileShader(sh);
  const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean;
  const log = gl.getShaderInfoLog(sh) ?? '';
  gl.deleteShader(sh);
  if (ok) return '';
  return formatShaderLog(log, code) || `  ${log.trim()}`;
}
