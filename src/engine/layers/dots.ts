import * as THREE from 'three';
import type { DotsLayer as DotsSpec } from '../../spec/schema';
import { Layer } from './base';
import { srgbToLinear } from '../util/color';

/** One dot's path: keys are [frame, x, y, diameter] in the data's frame rate, design px (y up). */
interface Track {
  color?: string;
  keys: number[][];
}

const vert = /* glsl */ `
attribute vec4 aColor;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vUv = uv;
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const frag = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec4 vColor;
uniform float uOpacity;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float aa = max(fwidth(d), 1e-4);
  float a = (1.0 - smoothstep(1.0 - aa, 1.0 + aa * 0.5, d)) * vColor.a * uOpacity;
  if (a <= 0.0) discard;
  gl_FragColor = vec4(vColor.rgb * a, a);
}
`;

/** A field of dots that move along recorded paths (one data file, one draw call). */
export class DotsLayer extends Layer<DotsSpec> {
  private paths: Track[] = [];
  private colors: THREE.Vector3[] = [];
  private mesh!: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private colorAttr!: THREE.InstancedBufferAttribute;
  private m = new THREE.Matrix4();
  private p = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();

  async load(): Promise<void> {
    const sp = this.spec;
    if (sp.tracks) this.paths = sp.tracks as Track[];
    else if (sp.src) {
      const res = await fetch(this.ctx.asset(sp.src));
      if (!res.ok) throw new Error(`dots: could not load ${sp.src} (${res.status})`);
      const data = await res.json();
      this.paths = (Array.isArray(data) ? data : data.tracks) as Track[];
    } else throw new Error('dots needs `src` (a JSON file of tracks) or inline `tracks`');
    this.paths = this.paths.filter((t) => t.keys?.length).map((t) => ({ ...t, keys: [...t.keys].sort((a, b) => a[0] - b[0]) }));
    const fallback = sp.color ?? '$primary';
    this.colors = this.paths.map((t) => {
      const c = this.ctx.color(t.color && !sp.color ? t.color : fallback);
      return new THREE.Vector3(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
    });
    const n = Math.max(1, this.paths.length);
    const mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: { uOpacity: { value: 1 } }, premultipliedAlpha: true, side: THREE.DoubleSide });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, n);
    this.colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.mesh.geometry.setAttribute('aColor', this.colorAttr);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.setupMaterial(this.mesh, mat);
    this.pivot.add(this.mesh);
  }

  protected updateContent(t: number, opacity: number): void {
    const sp = this.spec;
    const fps = sp.fps ?? this.ctx.fps;
    const at = this.ctx.time(sp.at, this.start);
    const fade = sp.fade ?? 1;
    const grow = sp.grow ?? 0;
    const sizeK = sp.size ?? 1;
    const fr = (t - at) * fps;
    let n = 0;
    const col = this.colorAttr.array as Float32Array;
    for (let i = 0; i < this.paths.length; i++) {
      const k = this.paths[i].keys;
      const f0 = k[0][0];
      const f1 = k[k.length - 1][0];
      if (fr < f0 - fade || fr > f1 + fade) continue;
      // Position between the two keys around this frame (clamped at the ends).
      let x: number, y: number, d: number;
      if (fr <= f0) [, x, y, d] = k[0];
      else if (fr >= f1) [, x, y, d] = k[k.length - 1];
      else {
        let lo = 0;
        let hi = k.length - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (k[mid][0] <= fr) lo = mid;
          else hi = mid;
        }
        const a = k[lo];
        const b = k[hi];
        const u = (fr - a[0]) / Math.max(1e-6, b[0] - a[0]);
        x = a[1] + (b[1] - a[1]) * u;
        y = a[2] + (b[2] - a[2]) * u;
        d = a[3] + (b[3] - a[3]) * u;
      }
      let alpha = 1;
      if (fade > 0) {
        if (fr < f0) alpha = 1 - (f0 - fr) / fade;
        else if (fr > f1) alpha = 1 - (fr - f1) / fade;
      }
      let g = 1;
      if (grow > 0 && fr >= f0 - fade) g = Math.min(1, 0.3 + (0.7 * Math.max(0, fr - (f0 - fade))) / grow);
      this.p.set(x, y, 0);
      this.s.set(d * g * sizeK, d * g * sizeK, 1);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(n, this.m);
      const c = this.colors[i];
      col[n * 4] = c.x;
      col[n * 4 + 1] = c.y;
      col[n * 4 + 2] = c.z;
      col[n * 4 + 3] = Math.max(0, alpha);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.mesh.material.uniforms.uOpacity.value = opacity;
  }
}
