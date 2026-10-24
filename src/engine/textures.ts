import * as THREE from 'three';
import { rng } from './util/random';

/**
 * Procedural surface finishes. Each finish is a height field (for a normal map, so light catches the
 * grain) plus a roughness map (so scratches and smudges change the shine). Deterministic per seed.
 */
export type FinishType = 'polished' | 'brushed' | 'satin' | 'sandblasted' | 'hammered';

export interface FinishSpec {
  type: FinishType;
  /** 0..1: density of fine scratches. */
  scratches?: number;
  /** 0..1: fingerprint-like roughness variation. */
  smudges?: number;
  /** Tiles across the object (default 1). */
  scale?: number;
  /** Grain direction in degrees (brushed). */
  angle?: number;
  /** Normal strength multiplier (default 1). */
  strength?: number;
  seed?: number;
}

export interface FinishMaps {
  normal: THREE.Texture;
  roughness: THREE.Texture;
}

const N = 1024;
const cache = new Map<string, FinishMaps>();

function valueNoise1(seed: number) {
  const r = rng(seed);
  const table = Float32Array.from({ length: 512 }, () => r() * 2 - 1);
  return (x: number) => {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    const a = table[i & 511];
    const b = table[(i + 1) & 511];
    return a + (b - a) * u;
  };
}

function valueNoise2(seed: number) {
  const r = rng(seed);
  const table = Float32Array.from({ length: 256 * 256 }, () => r());
  const at = (x: number, y: number) => table[(x & 255) * 256 + (y & 255)];
  return (x: number, y: number) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = at(ix, iy);
    const b = at(ix + 1, iy);
    const c = at(ix, iy + 1);
    const d = at(ix + 1, iy + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
}

function fbm2(noise: (x: number, y: number) => number, x: number, y: number, oct = 4) {
  let s = 0;
  let a = 0.5;
  let f = 1;
  for (let i = 0; i < oct; i++) {
    s += noise(x * f, y * f) * a;
    a *= 0.5;
    f *= 2.03;
  }
  return s;
}

/** Wraps an index into the tile so the texture repeats seamlessly. */
const wrap = (i: number) => ((i % N) + N) % N;

function scratchInto(height: Float32Array, rough: Float32Array, amount: number, seed: number): void {
  const r = rng(seed);
  const count = Math.round(amount * 420);
  for (let s = 0; s < count; s++) {
    let x = r() * N;
    let y = r() * N;
    let ang = r() * Math.PI * 2;
    const len = 20 + Math.pow(r(), 2) * 380;
    const bend = (r() - 0.5) * 0.004;
    const depth = 0.35 + r() * 0.65;
    const steps = Math.ceil(len);
    for (let i = 0; i < steps; i++) {
      x += Math.cos(ang);
      y += Math.sin(ang);
      ang += bend;
      // Fade the ends so scratches taper like real ones.
      const taper = Math.sin((i / steps) * Math.PI);
      const k = wrap(Math.round(y)) * N + wrap(Math.round(x));
      height[k] -= depth * taper * 0.9;
      rough[k] += 0.22 * taper * depth;
      const side = wrap(Math.round(y + Math.cos(ang))) * N + wrap(Math.round(x - Math.sin(ang)));
      height[side] -= depth * taper * 0.3;
      rough[side] += 0.08 * taper;
    }
  }
}

function toTexture(data: Uint8Array, colorSpace: THREE.ColorSpace): THREE.Texture {
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = colorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

export function makeFinish(spec: FinishSpec, baseRoughness: number): FinishMaps {
  const key = JSON.stringify([spec.type, spec.scratches ?? 0, spec.smudges ?? 0, spec.strength ?? 1, spec.seed ?? 1, baseRoughness.toFixed(3)]);
  const hit = cache.get(key);
  if (hit) return cloneMaps(hit, spec);
  const seed = spec.seed ?? 1;
  const height = new Float32Array(N * N);
  const rough = new Float32Array(N * N).fill(baseRoughness);
  const n2 = valueNoise2(seed + 11);

  if (spec.type === 'brushed') {
    // Long hairline grain along x: each row has its own depth, varying slowly along its length.
    const r = rng(seed + 3);
    const rowBase = Float32Array.from({ length: N }, () => r() * 2 - 1);
    const along = valueNoise1(seed + 5);
    for (let y = 0; y < N; y++) {
      const fine = rowBase[y];
      const coarse = (rowBase[wrap(y - 1)] + rowBase[y] + rowBase[wrap(y + 1)]) / 3;
      for (let x = 0; x < N; x++) {
        const v = 0.55 * fine + 0.3 * coarse + 0.35 * along(x / 90 + y * 7.31);
        height[y * N + x] = v * 0.16;
        rough[y * N + x] += v * 0.035;
      }
    }
  } else if (spec.type === 'satin' || spec.type === 'sandblasted') {
    const grain = spec.type === 'sandblasted' ? 1 : 0.45;
    const r = rng(seed + 9);
    for (let i = 0; i < N * N; i++) {
      const v = (r() * 2 - 1) * grain;
      height[i] = v * 0.35;
      rough[i] += v * 0.04 + (spec.type === 'sandblasted' ? 0.12 : 0.04);
    }
  } else if (spec.type === 'hammered') {
    // Soft dents from a jittered grid of cells.
    const r = rng(seed + 21);
    const cells = 18;
    const pts: [number, number][] = [];
    for (let gy = 0; gy < cells; gy++) for (let gx = 0; gx < cells; gx++) pts.push([(gx + 0.15 + r() * 0.7) * (N / cells), (gy + 0.15 + r() * 0.7) * (N / cells)]);
    const cell = N / cells;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const gx = Math.floor(x / cell);
        const gy = Math.floor(y / cell);
        let best = 1e9;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const [px, py] = pts[((gy + oy + cells) % cells) * cells + ((gx + ox + cells) % cells)];
            // Toroidal distance keeps the tile seamless.
            let ddx = Math.abs(px - x);
            let ddy = Math.abs(py - y);
            ddx = Math.min(ddx, N - ddx);
            ddy = Math.min(ddy, N - ddy);
            const d = ddx * ddx + ddy * ddy;
            if (d < best) best = d;
          }
        }
        const t = Math.sqrt(best) / cell;
        height[y * N + x] = -Math.cos(Math.min(1, t) * Math.PI * 0.5) * 2.2;
      }
    }
  }

  if (spec.smudges) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const s = fbm2(n2, x / 140, y / 140);
        const swirl = Math.max(0, fbm2(n2, x / 55 + 40, y / 55 + 7) - 0.55) * 2;
        rough[y * N + x] += (s - 0.45) * 0.18 * spec.smudges + swirl * 0.1 * spec.smudges;
      }
    }
  }
  if (spec.scratches) scratchInto(height, rough, spec.scratches, seed + 31);

  const strength = 2.2 * (spec.strength ?? 1);
  const nData = new Uint8Array(N * N * 4);
  const rData = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const dx = (height[y * N + wrap(x + 1)] - height[y * N + wrap(x - 1)]) * strength;
      const dy = (height[wrap(y + 1) * N + x] - height[wrap(y - 1) * N + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      nData[i * 4] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      nData[i * 4 + 1] = Math.round((dy * inv * 0.5 + 0.5) * 255);
      nData[i * 4 + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      nData[i * 4 + 3] = 255;
      const rv = Math.round(Math.min(1, Math.max(0.02, rough[i])) * 255);
      // three.js reads roughness from the green channel.
      rData[i * 4] = rv;
      rData[i * 4 + 1] = rv;
      rData[i * 4 + 2] = rv;
      rData[i * 4 + 3] = 255;
    }
  }
  const maps = { normal: toTexture(nData, THREE.NoColorSpace), roughness: toTexture(rData, THREE.NoColorSpace) };
  cache.set(key, maps);
  return cloneMaps(maps, spec);
}

/** Shares the pixel data but gives each use its own repeat and rotation. */
function cloneMaps(maps: FinishMaps, spec: FinishSpec): FinishMaps {
  const place = (t: THREE.Texture) => {
    const c = t.clone();
    const s = spec.scale ?? 1;
    c.repeat.set(s, s);
    c.center.set(0.5, 0.5);
    c.rotation = ((spec.angle ?? 0) * Math.PI) / 180;
    c.needsUpdate = true;
    return c;
  };
  return { normal: place(maps.normal), roughness: place(maps.roughness) };
}

/** Planar UVs over the geometry's bounding box (front-on projection). Gives slabs a clean 0..1 mapping. */
export function planarUVs(geo: THREE.BufferGeometry): void {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  const w = Math.max(1e-6, bb.max.x - bb.min.x);
  const h = Math.max(1e-6, bb.max.y - bb.min.y);
  // Keep texel density equal on both axes so grain is not stretched.
  const span = Math.max(w, h);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) - bb.min.x) / span;
    uv[i * 2 + 1] = (pos.getY(i) - bb.min.y) / span;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/**
 * Box-projected UVs: each vertex takes the two axes its normal is not facing, at one shared texel
 * density, so finishes look the same on the front, the sides and the top of extruded shapes.
 */
export function boxUVs(geo: THREE.BufferGeometry): void {
  geo.computeBoundingBox();
  geo.computeVertexNormals();
  const bb = geo.boundingBox!;
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const span = Math.max(1e-6, bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z);
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nrm.getX(i));
    const ay = Math.abs(nrm.getY(i));
    const az = Math.abs(nrm.getZ(i));
    const x = (pos.getX(i) - bb.min.x) / span;
    const y = (pos.getY(i) - bb.min.y) / span;
    const z = (pos.getZ(i) - bb.min.z) / span;
    const [u, v] = az >= ax && az >= ay ? [x, y] : ax >= ay ? [z, y] : [x, z];
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Applies a finish to a standard or physical material. */
export function applyFinish(mat: THREE.Material, spec: FinishSpec | FinishType): void {
  const f: FinishSpec = typeof spec === 'string' ? { type: spec } : spec;
  const m = mat as THREE.MeshPhysicalMaterial;
  if (!('roughness' in m)) return;
  const maps = makeFinish(f, m.roughness);
  m.roughness = 1;
  m.roughnessMap = maps.roughness;
  m.normalMap = maps.normal;
  const ns = f.type === 'polished' ? 0.6 : f.type === 'brushed' ? 0.45 : 1;
  m.normalScale = new THREE.Vector2(ns, ns);
  if (f.type === 'brushed' && 'anisotropy' in m) {
    // Stretched highlights across the grain, the signature of brushed metal.
    m.anisotropy = Math.max(m.anisotropy ?? 0, 0.45);
    m.anisotropyRotation = ((f.angle ?? 0) * Math.PI) / 180;
  }
  m.needsUpdate = true;
}
