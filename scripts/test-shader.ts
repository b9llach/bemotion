/**
 * Shader layers: source assembly and its checks, compile errors reported with the author's line
 * numbers (validate and render, naming the layer), frames that do not depend on the order they are
 * rendered in, keyframed uniforms and the built-ins.
 * Run: npx tsx scripts/test-shader.ts
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { buildFragment, formatShaderLog, uniformType } from '../src/engine/layers/shader-src';
import { checkShaders } from '../src/cli/shader-check';
import { ffmpegPath } from '../src/cli/ffmpeg';
import { still } from '../src/cli/render';
import { validateVideo } from '../src/spec/schema';

let failed = 0;
let n = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  n++;
  try {
    await fn();
    console.log(`ok  ${n}. ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${n}. ${name}\n     ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
async function throws(fn: () => unknown | Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected an error');
}

/** Raw RGB at 64x36. */
function pixels(file: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-loglevel', 'error', '-i', file, '-vf', 'scale=64:36:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const c: Buffer[] = [];
    p.stdout.on('data', (d) => c.push(d));
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(c)) : reject(new Error(`ffmpeg ${code}`))));
  });
}
const diff = (a: Buffer, b: Buffer) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
/** Mean of one channel over the frame. */
const mean = (a: Buffer, ch: number) => {
  let s = 0;
  for (let i = ch; i < a.length; i += 3) s += a[i];
  return s / (a.length / 3);
};

const DIR = 'out/dev/test-shader';
await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });
const spec = (layers: unknown[], duration = 2) => ({ title: 'shader', fps: 30, background: '#000000', post: { bloom: false, grain: 0, vignette: 0, chromatic: 0 }, scenes: [{ id: 's', duration, layers }] });

await check('uniform types: float, vec2-vec4, colors as vec3', () => {
  assert(uniformType(1) === 'float' && uniformType([1, 2]) === 'vec2' && uniformType([1, 2, 3, 4]) === 'vec4' && uniformType('#fff') === 'vec3', 'types');
  const f = buildFragment('vec4 shade(vec2 uv) { return vec4(uA, 1.0); }', { uA: '#ff0000', uB: [1, 2] });
  assert(f.includes('uniform vec3 uA;') && f.includes('uniform vec2 uB;') && f.includes('#line 1'), 'declarations');
});

await check('a missing shade() and reserved or bad uniform names are clear errors', async () => {
  assert((await throws(() => buildFragment('void main() {}'))).includes('vec4 shade(vec2 uv)'), 'no shade');
  assert((await throws(() => buildFragment('vec4 shade(vec2 uv) { return vec4(1.0); }', { uTime: 1 }))).includes('reserved'), 'reserved');
  assert((await throws(() => buildFragment('vec4 shade(vec2 uv) { return vec4(1.0); }', { 'u-x': 1 }))).includes('identifier'), 'identifier');
});

await check('the schema wants exactly one of frag or src', () => {
  assert(validateVideo(spec([{ type: 'shader', frag: 'x' }])).ok, 'frag alone');
  assert(!validateVideo(spec([{ type: 'shader' }])).ok, 'neither');
  assert(!validateVideo(spec([{ type: 'shader', frag: 'x', src: 'a.glsl' }])).ok, 'both');
  assert(!validateVideo(spec([{ type: 'shader', frag: 'x', uniforms: { a: [1] } }])).ok, 'one-number array');
});

await check('info logs map to lines of the author\'s code', () => {
  const code = 'vec4 shade(vec2 uv) {\n  float a = b;\n  return vec4(a);\n}';
  const out = formatShaderLog("ERROR: 0:2: 'b' : undeclared identifier\nERROR: 0:100001: '' : compilation terminated", code);
  assert(out.includes("line 2: 'b' : undeclared identifier") && out.includes('2 | float a = b;'), out);
  assert(out.includes('after the last line'), out);
});

const broken = 'vec4 shade(vec2 uv) {\n  float a = 1.0;\n  vec3 c = vec3(a, missing, 0.0);\n  return vec4(c, 1.0);\n}\n';
await writeFile(`${DIR}/broken.json`, JSON.stringify(spec([{ type: 'shader', id: 'sky', frag: broken }])));
await writeFile(`${DIR}/bad.glsl`, 'vec4 shade(vec2 uv) {\n  return vec4(uv, 0.0);\n}\n');
await writeFile(`${DIR}/broken-file.json`, JSON.stringify(spec([{ type: 'group', children: [{ type: 'shader', src: 'bad.glsl' }] }])));

await check('validate compiles shaders and reports the line in the author\'s code', async () => {
  const errs = await checkShaders(`${DIR}/broken.json`, spec([{ type: 'shader', id: 'sky', frag: broken }]));
  assert(errs.length === 1, JSON.stringify(errs));
  assert(errs[0].includes('("sky")') && errs[0].includes('line 3') && errs[0].includes('missing'), errs[0]);
  const fileErrs = await checkShaders(`${DIR}/broken-file.json`, spec([{ type: 'group', children: [{ type: 'shader', src: 'bad.glsl' }] }]));
  assert(fileErrs.length === 1 && fileErrs[0].includes('children[0]') && fileErrs[0].includes('line 2'), JSON.stringify(fileErrs));
  const none = await checkShaders(`${DIR}/broken.json`, spec([{ type: 'text', text: 'x' }]));
  assert(none.length === 0, 'no shader, no errors');
});

await check('a shader file outside the spec folder is refused', async () => {
  const errs = await checkShaders(`${DIR}/x.json`, spec([{ type: 'shader', src: '../../../package.json' }]));
  assert(errs.length === 1 && errs[0].includes('inside the spec'), JSON.stringify(errs));
});

await check('a render with a broken shader fails naming the layer and line, not a black frame', async () => {
  const msg = await throws(() => still(`${DIR}/broken.json`, [0.5], `${DIR}/broken.png`));
  assert(msg.includes('"sky" layer') && msg.includes('line 3') && msg.includes('missing'), msg);
});

// Brightness follows a keyframed uniform; red follows uProgress; green is a function of uTime.
const probe = `vec4 shade(vec2 uv) {
  return vec4(uProgress, fract(uTime * 0.37 + noise(uv * 9.0 + uTime) * 0.2), uLevel, 1.0);
}`;
await writeFile(`${DIR}/probe.json`, JSON.stringify(spec([
  { type: 'shader', frag: probe, uniforms: { uLevel: 0 }, keyframes: { uLevel: [{ t: 0, v: 0 }, { t: 2, v: 1, ease: 'linear' }] } },
])));

await check('frames are the same whatever order they are rendered in', async () => {
  const [a, b] = await still(`${DIR}/probe.json`, [1.2, 0.4], `${DIR}/seekA_{t}.png`);
  const [, , c] = await still(`${DIR}/probe.json`, [1.9, 0.4, 1.2], `${DIR}/seekB_{t}.png`);
  const d = diff(await pixels(a), await pixels(c));
  assert(d === 0, `the same time rendered twice differs by ${d}`);
  assert(diff(await pixels(a), await pixels(b)) > 1, 'different times look different');
});

await check('keyframed uniforms and uProgress reach the shader (sRGB in, sRGB out)', async () => {
  const [f0, f1] = await still(`${DIR}/probe.json`, [0.5, 1.5], `${DIR}/kf_{t}.png`);
  const p0 = await pixels(f0);
  const p1 = await pixels(f1);
  // uLevel is 0.25 then 0.75; uProgress (layer 0..2 s) the same. Values pass through unchanged.
  const near = (v: number, want: number) => Math.abs(v - want * 255) < 6;
  assert(near(mean(p0, 2), 0.25) && near(mean(p1, 2), 0.75), `blue ${mean(p0, 2).toFixed(1)} ${mean(p1, 2).toFixed(1)}`);
  assert(near(mean(p0, 0), 0.25) && near(mean(p1, 0), 0.75), `red ${mean(p0, 0).toFixed(1)} ${mean(p1, 0).toFixed(1)}`);
});

await check('color uniforms keyframe between colors; opacity premultiplies over what is below', async () => {
  await writeFile(`${DIR}/color.json`, JSON.stringify(spec([
    { type: 'shape', width: 4000, height: 3000, fill: '#FFFFFF' },
    { type: 'shader', frag: 'vec4 shade(vec2 uv) { return vec4(uC, 1.0); }', uniforms: { uC: '#FF0000' }, opacity: 0.5, keyframes: { uC: [{ t: 0, v: '#FF0000' }, { t: 1, v: '#0000FF', ease: 'linear' }] } },
  ])));
  const [a, b] = await still(`${DIR}/color.json`, [0, 1.5], `${DIR}/color_{t}.png`);
  const pa = await pixels(a);
  const pb = await pixels(b);
  // Half-opaque red over white: red stays full, green and blue land midway in linear light (~188 sRGB).
  assert(mean(pa, 0) > 245 && Math.abs(mean(pa, 1) - 188) < 8 && Math.abs(mean(pa, 2) - 188) < 8, `start ${[0, 1, 2].map((c) => mean(pa, c).toFixed(0))}`);
  assert(mean(pb, 2) > 245 && Math.abs(mean(pb, 0) - 188) < 8, `end ${[0, 1, 2].map((c) => mean(pb, c).toFixed(0))}`);
});

await check('the example shaders validate and compile', async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = JSON.parse(await readFile('examples/shaders/shaders.json', 'utf8'));
  const v = validateVideo(raw);
  assert(v.ok, v.errors.join('; '));
  const errs = await checkShaders('examples/shaders/shaders.json', raw);
  assert(errs.length === 0, errs.join('\n'));
});

console.log(failed ? `${failed} of ${n} checks failed` : `${n} checks passed`);
process.exit(failed ? 1 : 0);
