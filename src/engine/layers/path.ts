import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import type { IconLayer as IconSpec, PathLayer as PathSpec } from '../../spec/schema';
import { Layer } from './base';
import { Ribbon, smoothPoints } from './ribbon';
import { ICONS } from '../icons';
import { lucideSvg } from '../lucide';

const areaVert = /* glsl */ `
varying vec2 vPos;
void main() {
  vPos = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const areaFrag = /* glsl */ `
precision highp float;
varying vec2 vPos;
uniform vec4 uColor;
uniform float uTop;
uniform float uBase;
uniform float uClipX;
uniform float uOpacity;
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
void main() {
  if (vPos.x > uClipX) discard;
  float t = clamp((vPos.y - uBase) / max(uTop - uBase, 1.0), 0.0, 1.0);
  float a = uColor.a * t * t * uOpacity;
  gl_FragColor = vec4(toLinear(uColor.rgb) * a, a);
}
`;

export class PathLayer extends Layer<PathSpec> {
  private line!: Ribbon;
  private glow?: Ribbon;
  private area?: THREE.Mesh<THREE.ShapeGeometry, THREE.ShaderMaterial>;
  private pts: THREE.Vector2[] = [];
  private cum: number[] = [];
  private bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

  size() {
    return { w: this.bounds.maxX - this.bounds.minX, h: this.bounds.maxY - this.bounds.minY };
  }

  async load(): Promise<void> {
    const s = this.spec;
    const raw = s.points.map(([x, y]) => new THREE.Vector2(x, y));
    this.pts = s.smooth ? smoothPoints(raw) : raw;
    this.cum = [0];
    for (let i = 1; i < this.pts.length; i++) this.cum.push(this.cum[i - 1] + this.pts[i].distanceTo(this.pts[i - 1]));
    this.bounds = {
      minX: Math.min(...this.pts.map((p) => p.x)),
      maxX: Math.max(...this.pts.map((p) => p.x)),
      minY: Math.min(...this.pts.map((p) => p.y)),
      maxY: Math.max(...this.pts.map((p) => p.y)),
    };
    const width = s.width ?? 6;
    if (s.area) {
      const base = s.areaBase ?? this.bounds.minY;
      const shape = new THREE.Shape();
      shape.moveTo(this.pts[0].x, base);
      for (const p of this.pts) shape.lineTo(p.x, p.y);
      shape.lineTo(this.pts[this.pts.length - 1].x, base);
      shape.closePath();
      const c = this.ctx.color(s.area);
      const mat = new THREE.ShaderMaterial({
        vertexShader: areaVert,
        fragmentShader: areaFrag,
        transparent: true,
        depthWrite: false,
        premultipliedAlpha: true,
        side: THREE.DoubleSide,
        uniforms: {
          uColor: { value: new THREE.Vector4(c.r, c.g, c.b, c.a) },
          uTop: { value: this.bounds.maxY },
          uBase: { value: base },
          uClipX: { value: 1e9 },
          uOpacity: { value: 1 },
        },
      });
      this.area = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat);
      this.setupMaterial(this.area, mat);
      this.pivot.add(this.area);
    }
    if (s.glow) {
      this.glow = new Ribbon(this.pts, width * (s.glow.size ?? 6), s.closed, 1);
      this.setupMaterial(this.glow, this.glow.material);
      this.pivot.add(this.glow);
    }
    this.line = new Ribbon(this.pts, width, s.closed);
    if (s.dash) this.line.setDash(s.dash[0], s.dash[1]);
    this.setupMaterial(this.line, this.line.material);
    this.pivot.add(this.line);
  }

  /** x coordinate at the given fraction of path length. */
  private xAt(progress: number): number {
    const target = progress * this.cum[this.cum.length - 1];
    for (let i = 1; i < this.cum.length; i++) {
      if (this.cum[i] >= target) {
        const seg = this.cum[i] - this.cum[i - 1];
        const f = seg > 0 ? (target - this.cum[i - 1]) / seg : 1;
        return this.pts[i - 1].x + (this.pts[i].x - this.pts[i - 1].x) * f;
      }
    }
    return this.pts[this.pts.length - 1].x;
  }

  protected updateContent(t: number, opacity: number, blur = 0): void {
    const s = this.spec;
    const progress = this.num('progress', t, s.progress ?? 1) * this.draw;
    const color = this.colorAt('color', t, s.color, '$primary');
    this.line.setBlur(blur / Math.max(1, (s.width ?? 6) / 2));
    const intensity = this.num('intensity', t, s.intensity ?? 1);
    this.line.set(color, opacity, progress, intensity);
    if (this.glow) {
      const g = s.glow?.color ? this.ctx.color(s.glow.color) : color;
      this.glow.set({ ...g, a: g.a * (s.glow?.intensity ?? 0.35) }, opacity, progress, intensity);
    }
    if (this.area) {
      this.area.material.uniforms.uClipX.value = progress >= 1 ? 1e9 : this.xAt(progress);
      this.area.material.uniforms.uOpacity.value = opacity;
    }
  }
}

export class IconLayer extends Layer<IconSpec> {
  private ribbons: Ribbon[] = [];
  private px = 48;

  size() {
    return { w: this.px, h: this.px };
  }

  async load(): Promise<void> {
    const s = this.spec;
    const d = s.d ?? (s.name ? ICONS[s.name] : undefined);
    if (!d && !s.name) throw new Error('An icon needs a `name` or `d`');
    this.px = s.size ?? 48;
    const scale = this.px / 24;
    const stroke = (s.strokeWidth ?? 2) * scale;
    // Built-in names and `d` are drawn from path data; any other name is a Lucide icon (24x24 SVG
    // with paths, circles, rects and lines) served from the lucide-static package.
    const svg = d
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${d.split('|').map((p) => `<path d="${p}"/>`).join('')}</svg>`
      : await lucideSvg(s.name!);
    const data = new SVGLoader().parse(svg);
    for (const path of data.paths) {
      for (const sub of path.subPaths) {
        const raw = sub.getPoints(24) as THREE.Vector2[];
        if (raw.length < 2) continue;
        const pts = raw.map((p) => new THREE.Vector2((p.x - 12) * scale, (12 - p.y) * scale));
        const closed = sub.autoClose || (pts.length > 2 && pts[0].distanceTo(pts[pts.length - 1]) < 0.01);
        const r = new Ribbon(pts, stroke, closed && pts[0].distanceTo(pts[pts.length - 1]) > 0.01);
        if (s.dash) r.setDash(s.dash[0], s.dash[1]);
        this.setupMaterial(r, r.material);
        this.ribbons.push(r);
        this.pivot.add(r);
        // Round caps and joins: a small dot at every vertex keeps strokes looking like lucide icons.
        const dotGeo = new THREE.CircleGeometry(stroke / 2, 16);
        const ends = [pts[0], pts[pts.length - 1]];
        for (const e of ends) {
          const dot = new THREE.Mesh(dotGeo, r.material);
          dot.position.set(e.x, e.y, 0);
          dot.renderOrder = this.order;
          dot.userData.dist = e === pts[0] ? 0 : r.total;
          r.add(dot);
        }
      }
    }
  }

  protected updateContent(t: number, opacity: number, blur = 0): void {
    const s = this.spec;
    const color = this.colorAt('color', t, s.color, '$text');
    const halfStroke = ((s.strokeWidth ?? 2) * this.px) / 48;
    for (const r of this.ribbons) r.setBlur(blur / Math.max(1, halfStroke));
    const progress = this.num('progress', t, s.progress ?? 1) * this.draw;
    const intensity = this.num('intensity', t, s.intensity ?? 1);
    for (const r of this.ribbons) {
      r.set(color, opacity, progress, intensity);
      for (const c of r.children) c.visible = progress >= 0.999 || (c.userData.dist as number) <= progress * r.total;
    }
  }
}
