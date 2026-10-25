import * as THREE from 'three';
import type { BackgroundLayer as BgSpec, GridLayer as GridSpec, GroupLayer as GroupSpec } from '../../spec/schema';
import { Layer, type SceneRuntime } from './base';
import { SdfMesh } from './sdf';

const STYLES = ['solid', 'linear', 'radial', 'aurora', 'mesh', 'spotlight', 'rays', 'noise', 'dots'];

const bgVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.99999, 1.0);
}
`;

const bgFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3 uColors[6];
uniform float uAlphas[6];
uniform int uCount;
uniform int uStyle;
uniform float uTime;
uniform float uAngle;
uniform float uIntensity;
uniform vec2 uCenter;
uniform vec2 uRes;
uniform float uOpacity;
uniform float uSeed;

vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float s = 0.0; float a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.02; a *= 0.5; } return s; }

vec3 col(int i) {
  if (i <= 0) return uColors[0];
  if (i == 1) return uColors[1];
  if (i == 2) return uColors[2];
  if (i == 3) return uColors[3];
  if (i == 4) return uColors[4];
  return uColors[5];
}

vec3 ramp(float t) {
  if (uCount <= 1) return col(0);
  float x = clamp(t, 0.0, 1.0) * float(uCount - 1);
  int i = int(floor(x));
  if (i >= uCount - 1) return col(uCount - 1);
  return mix(col(i), col(i + 1), fract(x));
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
  vec2 c = (uCenter / uRes) * vec2(1.0, 1.0);
  c.x *= aspect;
  float t = uTime;
  vec3 color = col(0);
  if (uStyle == 1) {
    float a = radians(uAngle);
    vec2 dir = vec2(sin(a), cos(a));
    float half_ = abs(aspect * 0.5 * dir.x) + abs(0.5 * dir.y);
    color = ramp(dot(p, dir) / half_ * 0.5 + 0.5);
  } else if (uStyle == 2) {
    color = ramp(length(p - c) / (0.75 * uIntensity));
  } else if (uStyle == 3) {
    vec2 q = p * 1.4;
    vec2 w = vec2(fbm(q + vec2(t * 0.05, uSeed)), fbm(q + vec2(5.2, 1.3 + t * 0.04)));
    q += (w - 0.5) * 1.6;
    color = col(0);
    for (int i = 1; i < 6; i++) {
      if (i >= uCount) break;
      float fi = float(i);
      vec2 center = vec2(sin(t * 0.11 * (1.0 + fi * 0.3) + fi * 1.7 + uSeed) * 0.55 * aspect, cos(t * 0.09 * (1.0 + fi * 0.2) + fi * 2.9) * 0.35);
      float d = length(q - center * 1.4);
      float blob = exp(-d * d * 2.2) * uIntensity;
      color = mix(color, col(i), clamp(blob, 0.0, 1.0));
    }
  } else if (uStyle == 4) {
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < 6; i++) {
      if (i >= uCount) break;
      float fi = float(i);
      vec2 pt = vec2(sin(t * 0.2 + fi * 2.4 + uSeed) * 0.45 * aspect, cos(t * 0.17 + fi * 1.9 + uSeed) * 0.45);
      float d = length(p - pt);
      float w = 1.0 / pow(d + 0.08, 2.6);
      acc += col(i) * w;
      wsum += w;
    }
    color = acc / wsum;
  } else if (uStyle == 5) {
    vec2 src = vec2(c.x, 0.62);
    vec2 d = p - src;
    float cone = smoothstep(0.75, 0.0, abs(d.x) / max(-d.y + 0.25, 0.05));
    float fall = exp(-length(d) * 1.4);
    color = mix(col(0), col(1), clamp(cone * fall * uIntensity * 1.6, 0.0, 1.0));
  } else if (uStyle == 6) {
    vec2 d = p - c;
    float ang = atan(d.y, d.x);
    float r = length(d);
    float rays = pow(0.5 + 0.5 * sin(ang * 14.0 + t * 0.4), 6.0) * 0.6 + pow(0.5 + 0.5 * sin(ang * 7.0 - t * 0.25 + 1.3), 8.0) * 0.4;
    float fall = exp(-r * 1.2);
    float core = exp(-r * r * 18.0);
    color = col(0) + col(uCount > 1 ? 1 : 0) * (rays * fall * uIntensity + core * 0.8 * uIntensity);
  } else if (uStyle == 7) {
    color = col(0) + (hash(vUv * uRes + fract(t) * 91.7) - 0.5) * 0.05 * uIntensity;
  } else if (uStyle == 8) {
    vec2 g = vUv * uRes / 34.0;
    vec2 f = fract(g) - 0.5;
    float dotm = smoothstep(0.09, 0.05, length(f));
    float fade = smoothstep(0.85, 0.1, length(p - c));
    color = mix(col(0), col(uCount > 1 ? 1 : 0), dotm * fade * uIntensity);
  }
  vec3 lin = toLinear(max(color, 0.0));
  float a = uOpacity;
  gl_FragColor = vec4(lin * a, a);
}
`;

export class BackgroundLayer extends Layer<BgSpec> {
  private mesh!: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;

  size() {
    return { w: this.ctx.width, h: this.ctx.height };
  }

  async load(): Promise<void> {
    const s = this.spec;
    const list = s.colors ?? [s.color ?? '$bg'];
    const cols = list.slice(0, 6).map((c) => this.ctx.color(c));
    const uColors = Array.from({ length: 6 }, (_, i) => {
      const c = cols[Math.min(i, cols.length - 1)];
      return new THREE.Vector3(c.r, c.g, c.b);
    });
    const mat = new THREE.ShaderMaterial({
      vertexShader: bgVert,
      fragmentShader: bgFrag,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      premultipliedAlpha: true,
      uniforms: {
        uColors: { value: uColors },
        uAlphas: { value: Array.from({ length: 6 }, (_, i) => cols[Math.min(i, cols.length - 1)].a) },
        uCount: { value: cols.length },
        uStyle: { value: Math.max(0, STYLES.indexOf(s.style ?? (cols.length > 1 ? 'linear' : 'solid'))) },
        uTime: { value: 0 },
        uAngle: { value: s.angle ?? 180 },
        uIntensity: { value: s.intensity ?? 1 },
        uCenter: { value: new THREE.Vector2(...(s.center ?? [0, 0])) },
        uRes: { value: new THREE.Vector2(this.ctx.width, this.ctx.height) },
        uOpacity: { value: 1 },
        uSeed: { value: s.seed ?? 0 },
      },
    });
    if (s.blend === 'add') mat.blending = THREE.AdditiveBlending;
    // Fully opaque backgrounds render in the opaque pass so glass (transmission) can refract them.
    const fades = s.blend === 'add' || (s.opacity ?? 1) < 1 || this.tracks.has('opacity') || !!s.in || !!s.out || !!s.loop || s.start !== undefined;
    mat.transparent = fades;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1e6 + this.order;
    this.pivot.add(this.mesh);
  }

  protected updateContent(t: number, opacity: number): void {
    const u = this.mesh.material.uniforms;
    u.uTime.value = t * (this.spec.speed ?? 1);
    u.uOpacity.value = opacity;
    u.uIntensity.value = this.num('intensity', t, this.spec.intensity ?? 1);
    u.uAngle.value = this.num('angle', t, this.spec.angle ?? 180);
  }
}

const gridVert = /* glsl */ `
varying vec2 vPos;
void main() {
  vPos = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const gridFrag = /* glsl */ `
precision highp float;
varying vec2 vPos;
uniform vec4 uColor;
uniform float uCell;
uniform float uLine;
uniform float uScroll;
uniform float uFade;
uniform vec2 uSize;
uniform float uOpacity;
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
void main() {
  vec2 g = (vPos + vec2(0.0, uScroll)) / uCell;
  vec2 w = fwidth(g);
  vec2 f = abs(fract(g - 0.5) - 0.5) / max(w, 1e-4);
  float line = 1.0 - min(min(f.x, f.y) / max(uLine, 0.5), 1.0);
  float fade = 1.0 - smoothstep(0.0, 1.0, length(vPos / (uSize * 0.5)) / max(uFade, 0.01));
  float a = line * fade * uColor.a * uOpacity;
  gl_FragColor = vec4(toLinear(uColor.rgb) * a, a);
}
`;

export class GridLayer extends Layer<GridSpec> {
  private mesh!: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;

  async load(): Promise<void> {
    const s = this.spec;
    const [w, h] = s.size ?? [9000, 9000];
    const c = this.ctx.color(s.color ?? '$primary/45');
    const mat = new THREE.ShaderMaterial({
      vertexShader: gridVert,
      fragmentShader: gridFrag,
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
      blending: s.blend === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Vector4(c.r, c.g, c.b, c.a) },
        uCell: { value: s.cell ?? 120 },
        uLine: { value: s.lineWidth ?? 1.2 },
        uScroll: { value: 0 },
        uFade: { value: s.fade ?? 0.9 },
        uSize: { value: new THREE.Vector2(w, h) },
        uOpacity: { value: 1 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    this.mesh.renderOrder = this.order;
    if ((s.plane ?? 'floor') === 'floor') {
      this.mesh.rotation.x = -Math.PI / 2;
      if (s.y === undefined) this.root.position.y = -420;
    }
    this.pivot.add(this.mesh);
  }

  protected updateContent(t: number, opacity: number): void {
    const s = this.spec;
    if ((s.plane ?? 'floor') === 'floor' && s.y === undefined && !this.tracks.has('y')) this.root.position.y += -420;
    const u = this.mesh.material.uniforms;
    u.uScroll.value = t * (s.speed ?? 0);
    u.uOpacity.value = opacity;
  }
}

interface Raster {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  target: THREE.WebGLRenderTarget;
  mesh: SdfMesh;
  w: number;
  h: number;
  res: number;
}

export class GroupLayer extends Layer<GroupSpec> {
  protected container = true;
  /** With `raster`: children render into an offscreen image, which the group shows on a quad. */
  private raster?: Raster;

  constructor(spec: GroupSpec, rt: SceneRuntime) {
    super(spec, rt);
    const r = spec.raster;
    if (r) {
      const camera = new THREE.OrthographicCamera(-r.width / 2, r.width / 2, r.height / 2, -r.height / 2, -20000, 20000);
      camera.position.z = 10000;
      const target = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        samples: 4,
        depthBuffer: true,
        stencilBuffer: true,
        colorSpace: THREE.LinearSRGBColorSpace,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
      });
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.2));
      this.raster = { scene, camera, target, mesh: new SdfMesh(), w: r.width, h: r.height, res: r.resolution ?? 1 };
    }
  }

  size() {
    return { w: this.spec.width ?? this.spec.raster?.width ?? 0, h: this.spec.height ?? this.spec.raster?.height ?? 0 };
  }

  addChild(child: Layer): void {
    super.addChild(child);
    if (this.raster) this.raster.scene.add(child.root);
  }

  async load(): Promise<void> {
    const r = this.raster;
    if (!r) return;
    this.setupMaterial(r.mesh, r.mesh.material);
    r.mesh.setParams({ width: r.w, height: r.h, fillA: { r: 1, g: 1, b: 1, a: 1 } });
    r.mesh.setMap(r.target.texture, 'fill', true);
    this.pivot.add(r.mesh);
  }

  protected updateContent(t: number, opacity: number, blur: number): void {
    const r = this.raster;
    if (!r) return;
    const s = this.spec;
    r.mesh.setParams({ width: r.w, height: r.h, radius: this.num('radius', t, s.radius ?? 0), fillA: { r: 1, g: 1, b: 1, a: 1 }, blur: blur * 0.35 });
    r.mesh.setMapBlur(blur);
    const ht = s.halftone;
    r.mesh.setHalftone(ht ? {
      amount: this.num('halftone', t, ht.amount ?? 1),
      cell: ht.cell ?? r.w / (ht.columns ?? 40),
      color: this.ctx.color(ht.color ?? '$primary'),
      levels: ht.levels ?? [0, 1],
      invert: ht.invert ?? false,
      size: ht.size ?? 0.95,
    } : null);
    r.mesh.setOpacity(opacity);
  }

  protected updateChildren(t: number, opacity: number, blur = 0): void {
    const r = this.raster;
    if (!r) return super.updateChildren(t, opacity, blur);
    // Children draw at full strength into the image; the group's opacity and blur apply to the image.
    super.updateChildren(t, 1, 0);
    const px = Math.max(1, this.ctx.view.scale * r.res);
    const w = Math.max(1, Math.round(r.w * px));
    const h = Math.max(1, Math.round(r.h * px));
    if (r.target.width !== w || r.target.height !== h) r.target.setSize(w, h);
    const gl = this.ctx.renderer;
    const prev = gl.getRenderTarget();
    const clear = gl.getClearColor(new THREE.Color());
    const alpha = gl.getClearAlpha();
    gl.setRenderTarget(r.target);
    gl.setClearColor(0x000000, 0);
    gl.clear(true, true, true);
    gl.render(r.scene, r.camera);
    gl.setRenderTarget(prev);
    gl.setClearColor(clear, alpha);
  }

  dispose(): void {
    super.dispose();
    if (this.raster) {
      for (const c of this.children) c.dispose();
      this.raster.target.dispose();
    }
  }
}
