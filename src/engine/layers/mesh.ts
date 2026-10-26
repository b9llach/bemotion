import * as THREE from 'three';
import opentype from 'opentype.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import type { MeshLayer as MeshSpec } from '../../spec/schema';
import { Layer } from './base';
import { toThreeColor } from '../util/color';
import { applyFinish, boxUVs, planarUVs } from '../textures';

const DEG = Math.PI / 180;

const NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
`;

/** Outline with optional per-corner radius ([x, y, r]) as a THREE path. */
function roundedPath<T extends THREE.Path>(path: T, pts: number[][]): T {
  const n = pts.length;
  const at = (i: number) => new THREE.Vector2(pts[(i + n) % n][0], pts[(i + n) % n][1]);
  for (let i = 0; i < n; i++) {
    const p = at(i);
    const r = pts[i][2] ?? 0;
    if (r <= 0) {
      if (i === 0) path.moveTo(p.x, p.y);
      else path.lineTo(p.x, p.y);
      continue;
    }
    const prev = at(i - 1);
    const next = at(i + 1);
    const lin = p.distanceTo(prev);
    const lout = p.distanceTo(next);
    // Never round more than half of either neighbouring edge.
    const rr = Math.min(r, lin / 2, lout / 2);
    const a = p.clone().add(prev.clone().sub(p).normalize().multiplyScalar(rr));
    const b = p.clone().add(next.clone().sub(p).normalize().multiplyScalar(rr));
    if (i === 0) path.moveTo(a.x, a.y);
    else path.lineTo(a.x, a.y);
    path.quadraticCurveTo(p.x, p.y, b.x, b.y);
  }
  path.closePath?.();
  return path;
}

/** A 2D profile extruded along z with beveled front and back edges, centered on z = 0. */
function extrudeGeometry(s: MeshSpec): THREE.BufferGeometry {
  if (!s.profile) throw new Error('geometry "extrude" needs a profile: [[x, y], [x, y, radius], ...]');
  const depth = s.depth ?? 100;
  const bevel = Math.min(s.bevel ?? 6, depth / 2 - 0.05);
  const shape = roundedPath(new THREE.Shape(), s.profile);
  for (const h of s.holes ?? []) shape.holes.push(roundedPath(new THREE.Path(), h));
  const core = Math.max(0.1, depth - bevel * 2);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: core,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    // Keep the silhouette on the profile: the bevel grows inward instead of outward.
    bevelOffset: -bevel,
    bevelSegments: bevel > 0 ? 6 : 0,
    curveSegments: 18,
  });
  g.translate(0, 0, -core / 2);
  return g;
}

/** SVG path data (a logo) extruded along z with a bevel, centered, y up, `width` px wide. */
function svgGeometry(s: MeshSpec): THREE.BufferGeometry {
  if (!s.d) throw new Error('geometry "svg" needs `d` (SVG path data)');
  const data = new SVGLoader().parse(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${s.d.replace(/"/g, '')}" fill-rule="${s.fillRule ?? 'nonzero'}"/></svg>`);
  const shapes: THREE.Shape[] = [];
  for (const p of data.paths) shapes.push(...SVGLoader.createShapes(p));
  if (!shapes.length) throw new Error('geometry "svg": the path data has no closed shapes');
  let vb = s.viewBox;
  if (!vb) {
    const g = new THREE.ShapeGeometry(shapes);
    g.computeBoundingBox();
    const b = g.boundingBox!;
    vb = [b.min.x, b.min.y, b.max.x - b.min.x, b.max.y - b.min.y];
    g.dispose();
  }
  const width = s.width ?? (typeof s.size === 'number' ? s.size : vb[2]);
  const k = width / vb[2];
  const depth = s.depth ?? Math.max(8, width * 0.12);
  // Bevel in px; kept small next to thin strokes so the silhouette holds.
  const bevel = Math.min(s.bevel ?? Math.min(6, depth * 0.2), depth / 2 - 0.05);
  const core = Math.max(0.1, depth - bevel * 2);
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth: core / k,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel / k,
    bevelSize: bevel / k,
    bevelOffset: -bevel / k,
    bevelSegments: bevel > 0 ? 5 : 0,
    curveSegments: 24,
  });
  // SVG is y-down: flip, center on the viewBox, scale to width, center in depth.
  geo.translate(-(vb[0] + vb[2] / 2), -(vb[1] + vb[3] / 2), -core / k / 2);
  geo.scale(k, -k, k);
  // The flip turned the faces inside out: restore the winding.
  const idx = geo.index;
  if (idx) {
    const a = idx.array as Uint16Array | Uint32Array;
    for (let i = 0; i < a.length; i += 3) [a[i + 1], a[i + 2]] = [a[i + 2], a[i + 1]];
  } else {
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
    for (let i = 0; i < pos.count; i += 3) {
      for (const attr of [pos, uv]) {
        if (!attr) continue;
        for (let c = 0; c < attr.itemSize; c++) {
          const t = attr.getComponent(i + 1, c);
          attr.setComponent(i + 1, c, attr.getComponent(i + 2, c));
          attr.setComponent(i + 2, c, t);
        }
      }
    }
  }
  geo.computeVertexNormals();
  return geo;
}

/** Glyph outlines of a text in a font file, as SVG path data (y down), lines centered. */
async function textPath(s: MeshSpec, fontUrl: string): Promise<string> {
  const res = await fetch(fontUrl);
  if (!res.ok) throw new Error(`geometry "text": could not load the font (${res.status})`);
  const font = opentype.parse(await res.arrayBuffer());
  const size = typeof s.size === 'number' ? s.size : 200;
  const lines = (s.text ?? '').split('\n');
  const lh = size * (s.lineHeight ?? 1.1);
  const opts = { kerning: true, letterSpacing: s.letterSpacing ?? -0.02 };
  const widths = lines.map((l) => font.getAdvanceWidth(l, size, opts) + Math.max(0, l.length - 1) * (opts.letterSpacing * size));
  const maxW = Math.max(...widths);
  return lines
    .map((l, i) => font.getPath(l, (maxW - widths[i]) / 2, i * lh, size, opts).toPathData(2))
    .filter(Boolean)
    .join(' ');
}

function buildGeometry(s: MeshSpec): THREE.BufferGeometry {
  const size = s.size ?? 300;
  const [w, h, d] = Array.isArray(size) ? size : [size, size, size];
  const r = s.radius ?? (Array.isArray(size) ? Math.min(w, h) / 2 : size / 2);
  const tube = s.tube ?? r * 0.3;
  switch (s.geometry) {
    case 'box':
      return new THREE.BoxGeometry(w, h, d);
    case 'roundedBox':
      return new RoundedBoxGeometry(w, h, d, 6, s.radius ?? Math.min(w, h, d) * 0.12);
    case 'sphere':
      return new THREE.SphereGeometry(r, 96, 64);
    case 'torus':
      return new THREE.TorusGeometry(r, tube, 64, 200);
    case 'torusKnot':
      return new THREE.TorusKnotGeometry(r * 0.7, tube * 0.7, 400, 48);
    case 'icosahedron':
      return new THREE.IcosahedronGeometry(r, s.detail ?? 0);
    case 'octahedron':
      return new THREE.OctahedronGeometry(r, s.detail ?? 0);
    case 'dodecahedron':
      return new THREE.DodecahedronGeometry(r, s.detail ?? 0);
    case 'cylinder':
      return new THREE.CylinderGeometry(r, r, h, 96);
    case 'cone':
      return new THREE.ConeGeometry(r, h, 96);
    case 'capsule':
      return new THREE.CapsuleGeometry(r * 0.5, h - r, 16, 48);
    case 'plane':
      return new THREE.PlaneGeometry(w, h);
    case 'ring':
      return new THREE.RingGeometry(r - tube, r, 128);
    case 'blob':
      return new THREE.IcosahedronGeometry(r, s.detail ?? 48);
    case 'extrude':
      return extrudeGeometry(s);
    case 'svg':
    case 'text':
      return svgGeometry(s);
    case 'slab': {
      // Rounded-rectangle slab with beveled edges: phones, laptops, 3D cards.
      const cr = Math.min(s.radius ?? Math.min(w, h) * 0.1, Math.min(w, h) / 2 - 1);
      const bevel = Math.min(d * 0.35, 8);
      const shape = new THREE.Shape();
      const x0 = -w / 2 + bevel;
      const y0 = -h / 2 + bevel;
      const iw = w - bevel * 2;
      const ih = h - bevel * 2;
      const r2 = Math.max(0, cr - bevel);
      shape.moveTo(x0 + r2, y0);
      shape.lineTo(x0 + iw - r2, y0);
      shape.quadraticCurveTo(x0 + iw, y0, x0 + iw, y0 + r2);
      shape.lineTo(x0 + iw, y0 + ih - r2);
      shape.quadraticCurveTo(x0 + iw, y0 + ih, x0 + iw - r2, y0 + ih);
      shape.lineTo(x0 + r2, y0 + ih);
      shape.quadraticCurveTo(x0, y0 + ih, x0, y0 + ih - r2);
      shape.lineTo(x0, y0 + r2);
      shape.quadraticCurveTo(x0, y0, x0 + r2, y0);
      const g = new THREE.ExtrudeGeometry(shape, {
        depth: Math.max(0.1, d - bevel * 2),
        bevelEnabled: true,
        bevelThickness: bevel,
        bevelSize: bevel,
        bevelSegments: 5,
        curveSegments: 24,
      });
      g.translate(0, 0, -(d - bevel * 2) / 2);
      return g;
    }
  }
}

export function buildMaterial(s: Pick<MeshSpec, 'material' | 'roughness' | 'metalness' | 'emissiveIntensity'>, color: THREE.Color, envMap: THREE.Texture | null): THREE.Material {
  const kind = s.material ?? 'glossy';
  void envMap;
  const common = { color, envMapIntensity: 1 } as const;
  let m: THREE.Material;
  switch (kind) {
    case 'glass':
      m = new THREE.MeshPhysicalMaterial({
        ...common,
        transmission: 1,
        roughness: s.roughness ?? 0.04,
        metalness: 0,
        thickness: 180,
        ior: 1.45,
        clearcoat: 1,
        clearcoatRoughness: 0.05,
        iridescence: 0.25,
        attenuationColor: color,
        attenuationDistance: 900,
        specularIntensity: 1,
      });
      break;
    case 'chrome':
      m = new THREE.MeshPhysicalMaterial({ ...common, metalness: 1, roughness: s.roughness ?? 0.06, clearcoat: 1, envMapIntensity: 1.4 });
      break;
    case 'gold':
      m = new THREE.MeshPhysicalMaterial({
        ...common,
        metalness: 1,
        roughness: s.roughness ?? 0.3,
        // No lacquer: an untinted clearcoat reflection washes the gold out to gray under bright light.
        envMapIntensity: 1.2,
      });
      break;
    case 'brushed':
      m = new THREE.MeshPhysicalMaterial({
        ...common,
        metalness: 1,
        roughness: s.roughness ?? 0.38,
        anisotropy: 0.85,
        clearcoat: 0.3,
        envMapIntensity: 1.25,
      });
      break;
    case 'metal':
      m = new THREE.MeshStandardMaterial({ ...common, metalness: s.metalness ?? 1, roughness: s.roughness ?? 0.32 });
      break;
    case 'ceramic':
      // Glazed plastic or ceramic: white product bodies, readers, earbuds.
      m = new THREE.MeshPhysicalMaterial({ ...common, metalness: 0, roughness: s.roughness ?? 0.32, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 0.9 });
      break;
    case 'matte':
      m = new THREE.MeshStandardMaterial({ ...common, metalness: 0, roughness: s.roughness ?? 0.85, envMapIntensity: 0.6 });
      break;
    case 'clay':
      m = new THREE.MeshPhysicalMaterial({ ...common, metalness: 0, roughness: 1, sheen: 1, sheenRoughness: 0.6, sheenColor: new THREE.Color(1, 1, 1), envMapIntensity: 0.7 });
      break;
    case 'iridescent':
      m = new THREE.MeshPhysicalMaterial({
        ...common,
        metalness: s.metalness ?? 0.6,
        roughness: s.roughness ?? 0.12,
        iridescence: 1,
        iridescenceIOR: 1.6,
        iridescenceThicknessRange: [200, 900],
        clearcoat: 1,
        envMapIntensity: 1.3,
      });
      break;
    case 'neon':
      m = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(s.emissiveIntensity ?? 3) });
      break;
    case 'wireframe':
      m = new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true });
      break;
    default:
      m = new THREE.MeshPhysicalMaterial({ ...common, metalness: s.metalness ?? 0.1, roughness: s.roughness ?? 0.25, clearcoat: 1, clearcoatRoughness: 0.1 });
  }
  return m;
}

export class MeshLayer extends Layer<MeshSpec> {
  private mesh!: THREE.Mesh;
  private material!: THREE.Material;
  private sideMat?: THREE.Material;
  private blobUniforms?: { uTime: { value: number }; uAmp: { value: number } };
  private dims = { w: 300, h: 300 };

  size() {
    return this.dims;
  }

  async load(): Promise<void> {
    const s = this.spec;
    const color = this.ctx.threeColor(s.color ?? '$primary');
    // 3D text: the font's glyph outlines become path data for the same extrusion as an svg logo, at
    // their natural size unless `width` is given.
    const geo = s.geometry === 'text'
      ? buildGeometry({
          ...s,
          d: await textPath(s, this.ctx.fontUrl(s.font ?? 'display', s.weight ?? 700)),
          size: undefined,
          viewBox: undefined,
          fillRule: 'nonzero',
          // The bevel insets every outline: keep it thinner than hairline serifs.
          bevel: s.bevel ?? (typeof s.size === 'number' ? s.size : 200) * 0.012,
          depth: s.depth ?? (typeof s.size === 'number' ? s.size : 200) * 0.25,
        })
      : buildGeometry(s);
    if (s.finish && (s.geometry === 'slab' || s.geometry === 'roundedBox' || s.geometry === 'box')) planarUVs(geo);
    else if (s.finish && (s.geometry === 'extrude' || s.geometry === 'svg' || s.geometry === 'text')) boxUVs(geo);
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    this.dims = { w: bb.max.x - bb.min.x, h: bb.max.y - bb.min.y };
    this.material = buildMaterial(s, color, this.ctx.envMap);
    if (s.finish) applyFinish(this.material, s.finish);
    if (s.emissive && 'emissive' in this.material) {
      const m = this.material as THREE.MeshStandardMaterial;
      m.emissive = this.ctx.threeColor(s.emissive);
      m.emissiveIntensity = s.emissiveIntensity ?? 1;
    }
    if (s.geometry === 'blob') {
      const uniforms = { uTime: { value: 0 }, uAmp: { value: 0.18 } };
      this.blobUniforms = uniforms;
      const radius = s.radius ?? (typeof s.size === 'number' ? s.size / 2 : 150);
      this.material.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = uniforms.uTime;
        shader.uniforms.uAmp = uniforms.uAmp;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\nuniform float uTime;\nuniform float uAmp;\n${NOISE_GLSL}\nfloat blobDisp(vec3 p){ return snoise(p / ${radius.toFixed(1)} * 1.4 + vec3(uTime * 0.35)) * uAmp; }`)
          .replace(
            '#include <beginnormal_vertex>',
            `#include <beginnormal_vertex>
            {
              vec3 p0 = position;
              vec3 nrm = normalize(objectNormal);
              vec3 tg = normalize(cross(nrm, abs(nrm.y) < 0.99 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0)));
              vec3 bt = normalize(cross(nrm, tg));
              float e = ${(radius * 0.01).toFixed(3)};
              vec3 d0 = p0 * (1.0 + blobDisp(p0));
              vec3 d1 = (p0 + tg * e) * (1.0 + blobDisp(p0 + tg * e));
              vec3 d2 = (p0 + bt * e) * (1.0 + blobDisp(p0 + bt * e));
              objectNormal = normalize(cross(d1 - d0, d2 - d0));
            }`,
          )
          .replace('#include <begin_vertex>', `#include <begin_vertex>\ntransformed = position * (1.0 + blobDisp(position));`);
      };
      this.material.customProgramCacheKey = () => `blob-${radius}`;
    }
    if ((s.sideColor || s.sideMaterial) && (s.geometry === 'extrude' || s.geometry === 'svg' || s.geometry === 'text')) {
      // Extruded geometry has two groups: 0 the faces, 1 the sides.
      this.sideMat = buildMaterial({ ...s, material: s.sideMaterial ?? s.material }, s.sideColor ? this.ctx.threeColor(s.sideColor) : color, this.ctx.envMap);
      if (s.finish) applyFinish(this.sideMat, s.finish);
    }
    this.mesh = new THREE.Mesh(geo, this.sideMat ? [this.material, this.sideMat] : this.material);
    this.mesh.castShadow = s.material !== 'neon' && s.material !== 'wireframe' && s.blend !== 'add';
    this.mesh.receiveShadow = !!s.shadow;
    this.mesh.renderOrder = this.order;
    if (s.blend === 'add') {
      this.material.blending = THREE.AdditiveBlending;
      this.material.transparent = true;
      this.material.depthWrite = false;
    }
    this.pivot.add(this.mesh);
  }

  protected updateContent(t: number, opacity: number): void {
    const s = this.spec;
    const m = this.material as THREE.MeshStandardMaterial;
    const transparent = opacity < 0.999 || s.material === 'wireframe' || s.blend === 'add';
    if (m.transparent !== transparent) {
      m.transparent = transparent;
      m.needsUpdate = true;
    }
    m.opacity = opacity;
    if (this.sideMat) {
      const sm = this.sideMat as THREE.MeshStandardMaterial;
      if (sm.transparent !== transparent) {
        sm.transparent = transparent;
        sm.needsUpdate = true;
      }
      sm.opacity = opacity;
    }
    const c = this.tracks.color('color', t);
    if (c && 'color' in m) m.color.copy(toThreeColor(c)).multiplyScalar(s.material === 'neon' ? s.emissiveIntensity ?? 3 : 1);
    if (s.spin) this.mesh.rotation.set(s.spin[0] * t * DEG, s.spin[1] * t * DEG, s.spin[2] * t * DEG);
    if (this.blobUniforms) {
      this.blobUniforms.uTime.value = t * (this.num('speed', t, 1));
      this.blobUniforms.uAmp.value = this.num('amount', t, 0.18);
    }
  }
}
