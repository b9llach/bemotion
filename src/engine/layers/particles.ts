import * as THREE from 'three';
import type { ParticlesLayer as ParticlesSpec } from '../../spec/schema';
import { Layer } from './base';
import { rng } from '../util/random';
import { srgbToLinear } from '../util/color';

const MOTIONS = ['static', 'drift', 'rise', 'fall', 'warp', 'burst', 'orbit'];

const vert = /* glsl */ `
attribute vec4 aSeed;
attribute vec3 aColor;
attribute float aSize;
uniform float uTime;
uniform float uSpeed;
uniform int uMotion;
uniform vec3 uArea;
uniform float uBurstAt;
uniform float uViewH;
varying vec3 vColor;
varying float vFade;
const float TAU = 6.28318530718;

void main() {
  vec3 base = (aSeed.xyz - 0.5) * uArea;
  vec3 p = base;
  float fade = 1.0;
  float t = uTime * uSpeed;
  if (uMotion == 1) {
    p += vec3(sin(t * 0.6 + aSeed.w * TAU), cos(t * 0.5 + aSeed.x * TAU), sin(t * 0.4 + aSeed.y * TAU)) * uArea * 0.035;
  } else if (uMotion == 2 || uMotion == 3) {
    float dir = uMotion == 2 ? 1.0 : -1.0;
    float y = mod(aSeed.y * uArea.y + dir * t * (60.0 + aSeed.w * 90.0), uArea.y);
    p.y = y - uArea.y * 0.5;
    p.x += sin(t * 0.8 + aSeed.w * TAU) * 18.0;
    fade = smoothstep(0.0, 0.15, y / uArea.y) * smoothstep(1.0, 0.85, y / uArea.y);
  } else if (uMotion == 4) {
    float z = mod(aSeed.z * uArea.z + t * (900.0 + aSeed.w * 900.0), uArea.z);
    p.z = z - uArea.z * 0.8;
    float r = length(base.xy);
    p.xy = base.xy / max(r, 1.0) * (80.0 + r);
    fade = smoothstep(0.0, 0.2, z / uArea.z);
  } else if (uMotion == 5) {
    float bt = max(uTime - uBurstAt, 0.0);
    vec3 dir = normalize(aSeed.xyz - 0.5 + 1e-4);
    float dist = (1.0 - exp(-bt * (3.0 + aSeed.w * 3.0))) * length(uArea) * 0.5 * (0.3 + aSeed.w * 0.7);
    p = dir * dist;
    p.y -= bt * bt * 120.0;
    fade = uTime < uBurstAt ? 0.0 : exp(-bt * 1.4);
  } else if (uMotion == 6) {
    float r = length(base.xz);
    float a = atan(base.z, base.x) + t * (0.4 + 300.0 / max(r, 50.0) * 0.3);
    p = vec3(cos(a) * r, base.y * 0.25, sin(a) * r);
  }
  vColor = aColor;
  vFade = fade;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * projectionMatrix[1][1] * uViewH * 0.5 / max(-mv.z, 1.0);
}
`;

const frag = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vFade;
uniform float uOpacity;
uniform int uShape;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a;
  if (uShape == 1) {
    a = step(max(abs(c.x), abs(c.y)), 0.42);
  } else if (uShape == 2) {
    a = smoothstep(0.5, 0.0, d) ;
    a = a * a;
  } else if (uShape == 3) {
    float cross_ = max(smoothstep(0.06, 0.0, abs(c.x)) * smoothstep(0.5, 0.0, abs(c.y)), smoothstep(0.06, 0.0, abs(c.y)) * smoothstep(0.5, 0.0, abs(c.x)));
    a = max(cross_, smoothstep(0.18, 0.0, d));
  } else {
    a = smoothstep(0.5, 0.32, d);
  }
  a *= vFade * uOpacity;
  if (a <= 0.002) discard;
  gl_FragColor = vec4(vColor * a, a);
}
`;

export class ParticlesLayer extends Layer<ParticlesSpec> {
  private points!: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;

  size() {
    const a = this.spec.area ?? [this.ctx.width, this.ctx.height, 800];
    return { w: a[0], h: a[1] };
  }

  async load(): Promise<void> {
    const s = this.spec;
    const n = s.count ?? 300;
    const r = rng(s.seed ?? this.seed);
    const seeds = new Float32Array(n * 4);
    const colors = new Float32Array(n * 3);
    const sizes = new Float32Array(n);
    const palette = (s.colors ?? [s.color ?? '#ffffff']).map((c) => this.ctx.color(c));
    const [smin, smax] = Array.isArray(s.size) ? s.size : [(s.size ?? 4) * 0.5, s.size ?? 4];
    for (let i = 0; i < n; i++) {
      seeds.set([r(), r(), r(), r()], i * 4);
      const c = palette[Math.floor(r() * palette.length)];
      colors.set([srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)], i * 3);
      sizes[i] = smin + (smax - smin) * Math.pow(r(), 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 4));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
    const area = s.area ?? [this.ctx.width * 1.4, this.ctx.height * 1.4, 1200];
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      blending: s.blend === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending,
      premultipliedAlpha: true,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: s.speed ?? 1 },
        uMotion: { value: Math.max(0, MOTIONS.indexOf(s.motion ?? 'drift')) },
        uArea: { value: new THREE.Vector3(...area) },
        uBurstAt: { value: this.ctx.time(s.at, this.start) },
        uViewH: { value: this.ctx.height },
        uOpacity: { value: 1 },
        uShape: { value: ['dot', 'square', 'streak', 'spark'].indexOf(s.shape ?? 'dot') },
      },
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = this.order;
    this.pivot.add(this.points);
  }

  protected updateContent(t: number, opacity: number): void {
    const u = this.points.material.uniforms;
    u.uTime.value = t;
    u.uViewH.value = this.ctx.height * this.ctx.view.scale;
    u.uOpacity.value = opacity;
    u.uSpeed.value = this.num('speed', t, this.spec.speed ?? 1);
  }
}
