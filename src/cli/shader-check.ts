import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import puppeteer from 'puppeteer';
import { buildFragment, formatShaderLog, type UniformValue } from '../engine/layers/shader-src';
import { BROWSER_ARGS } from './render';

interface Found {
  where: string;
  code: string;
  frag?: string;
  error?: string;
}

/** Every `shader` layer in a spec (inside groups, components and masks too), with its JSON path. */
export function findShaders(spec: unknown): { where: string; layer: Record<string, any> }[] {
  const out: { where: string; layer: Record<string, any> }[] = [];
  const visit = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => visit(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') {
      const o = v as Record<string, any>;
      if (o.type === 'shader') out.push({ where: `${path}${o.id ? ` ("${o.id}")` : ''}`, layer: o });
      for (const [k, x] of Object.entries(o)) if (x && typeof x === 'object') visit(x, path ? `${path}.${k}` : k);
    }
  };
  visit(spec, '');
  return out;
}

/** Reads a shader file next to the spec; links that lead outside the spec's folder are refused. */
async function readInside(specPath: string, src: string): Promise<string> {
  const base = await realpath(dirname(resolve(specPath)));
  const real = await realpath(resolve(base, src)).catch(() => null);
  if (!real) throw new Error(`shader file "${src}" not found`);
  const rel = relative(base, real);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`shader file "${src}" must be inside the spec's folder`);
  return readFile(real, 'utf8');
}

/**
 * Compiles every shader layer of a spec in a headless browser (the same WebGL the renderer uses).
 * Returns one message per broken shader, with line numbers in the author's code; [] when all compile.
 * Specs without shader layers return at once, without starting a browser.
 */
export async function checkShaders(specPath: string, spec: unknown): Promise<string[]> {
  const found: Found[] = [];
  for (const { where, layer } of findShaders(spec)) {
    try {
      const code = typeof layer.frag === 'string' ? layer.frag : await readInside(specPath, String(layer.src ?? ''));
      found.push({ where, code, frag: buildFragment(code, (layer.uniforms ?? {}) as Record<string, UniformValue>) });
    } catch (e) {
      found.push({ where, code: '', error: (e as Error).message });
    }
  }
  const toCompile = found.filter((f) => f.frag);
  if (toCompile.length) {
    const browser = await puppeteer.launch({ headless: true, args: BROWSER_ARGS });
    try {
      const page = await browser.newPage();
      const logs = (await page.evaluate((frags: string[]) => {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return frags.map(() => null);
        return frags.map((src) => {
          const sh = gl.createShader(gl.FRAGMENT_SHADER)!;
          gl.shaderSource(sh, `#version 300 es\n${src}`);
          gl.compileShader(sh);
          const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS);
          const log = gl.getShaderInfoLog(sh) ?? '';
          gl.deleteShader(sh);
          return ok ? '' : log || 'compile failed';
        });
      }, toCompile.map((f) => f.frag!))) as (string | null)[];
      toCompile.forEach((f, i) => {
        const log = logs[i];
        if (log === null) throw new Error('WebGL2 is not available in the headless browser, so shaders could not be compiled');
        if (log) f.error = `did not compile:\n${formatShaderLog(log, f.code) || `  ${log.trim()}`}`;
      });
    } finally {
      await browser.close();
    }
  }
  return found.filter((f) => f.error).map((f) => `${f.where}: shader ${f.error}`);
}
