import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import type { SvgLayer as SvgSpec } from '../../spec/schema';
import { Layer } from './base';
import { Ribbon } from './ribbon';
import { srgbToLinear } from '../util/color';

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** Splits path data into its numbers and the text around them, so two compatible paths can be blended. */
function template(d: string): { parts: string[]; nums: number[] } {
  const parts: string[] = [];
  const nums: number[] = [];
  let last = 0;
  for (const m of d.matchAll(NUMBER)) {
    parts.push(d.slice(last, m.index));
    nums.push(parseFloat(m[0]));
    last = m.index! + m[0].length;
  }
  parts.push(d.slice(last));
  return { parts, nums };
}

/** Filled (and optionally stroked) vector shape from SVG path data, optionally morphing into a second outline. */
export class SvgLayer extends Layer<SvgSpec> {
  private fillMesh?: THREE.Mesh<THREE.ShapeGeometry, THREE.MeshBasicMaterial>;
  private strokes: Ribbon[] = [];
  private w = 0;
  private h = 0;
  private matrix = new THREE.Matrix4();
  private from?: { parts: string[]; nums: number[] };
  private to?: number[];
  private shownMorph = 0;

  size() {
    return { w: this.w, h: this.h };
  }

  async load(): Promise<void> {
    const s = this.spec;
    const first = this.parse(s.d);
    const geo = new THREE.ShapeGeometry(first.shapes, 16);
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    const vb = s.viewBox ?? [bb.min.x, bb.min.y, bb.max.x - bb.min.x, bb.max.y - bb.min.y];
    const scale = (s.width ?? vb[2]) / vb[2];
    const cx = vb[0] + vb[2] / 2;
    const cy = vb[1] + vb[3] / 2;
    this.w = vb[2] * scale;
    this.h = vb[3] * scale;
    // SVG is y-down; flip and center.
    this.matrix = new THREE.Matrix4().makeScale(scale, -scale, 1).multiply(new THREE.Matrix4().makeTranslation(-cx, -cy, 0));
    if (s.morphTo) {
      this.from = template(s.d);
      const to = template(s.morphTo);
      if (to.nums.length !== this.from.nums.length || to.parts.join('|').replace(/\s+/g, '') !== this.from.parts.join('|').replace(/\s+/g, '')) {
        throw new Error('morphTo must use the same path commands as d (the same glyph or shape in another weight or pose)');
      }
      this.to = to.nums;
    }
    geo.dispose();
    this.build(first);
  }

  private parse(d: string) {
    const data = new SVGLoader().parse(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}"/></svg>`);
    const shapes: THREE.Shape[] = [];
    for (const p of data.paths) shapes.push(...SVGLoader.createShapes(p));
    return { data, shapes };
  }

  /** (Re)builds the fill and stroke meshes for one outline. */
  private build({ data, shapes }: ReturnType<SvgLayer['parse']>): void {
    const s = this.spec;
    if (s.fill !== 'none') {
      const geo = new THREE.ShapeGeometry(shapes, 16);
      geo.applyMatrix4(this.matrix);
      if (this.fillMesh) {
        this.fillMesh.geometry.dispose();
        this.fillMesh.geometry = geo;
      } else {
        const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, side: THREE.DoubleSide });
        this.fillMesh = new THREE.Mesh(geo, mat);
        this.setupMaterial(this.fillMesh, mat);
        this.pivot.add(this.fillMesh);
      }
    }
    if (s.stroke) {
      let k = 0;
      for (const p of data.paths) {
        for (const sub of p.subPaths) {
          const pts = (sub.getPoints(24) as THREE.Vector2[]).map((v) => {
            const q = new THREE.Vector3(v.x, v.y, 0).applyMatrix4(this.matrix);
            return new THREE.Vector2(q.x, q.y);
          });
          if (pts.length < 2) continue;
          const existing = this.strokes[k];
          if (existing) existing.build(pts, s.strokeWidth ?? 2, sub.autoClose);
          else {
            const r = new Ribbon(pts, s.strokeWidth ?? 2, sub.autoClose);
            this.setupMaterial(r, r.material);
            r.renderOrder = this.order + 0.5;
            if (s.dash) r.setDash(s.dash[0], s.dash[1]);
            this.strokes.push(r);
            this.pivot.add(r);
          }
          k++;
        }
      }
    }
  }

  protected updateContent(t: number, opacity: number, blur = 0): void {
    const s = this.spec;
    if (this.from && this.to) {
      const m = Math.min(1, Math.max(0, this.num('morph', t, s.morph ?? 0)));
      if (Math.abs(m - this.shownMorph) > 1e-4) {
        this.shownMorph = m;
        const f = this.from;
        let d = '';
        for (let i = 0; i < f.nums.length; i++) d += f.parts[i] + (f.nums[i] + (this.to[i] - f.nums[i]) * m).toFixed(3);
        d += f.parts[f.parts.length - 1];
        this.build(this.parse(d));
      }
    }
    // Vector fills have no cheap blur; fade them as they defocus.
    opacity /= 1 + blur * 0.06;
    if (this.fillMesh) {
      const c = this.colorAt('fill', t, s.fill, '$text');
      this.fillMesh.material.color.setRGB(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
      this.fillMesh.material.opacity = c.a * opacity;
    }
    if (this.strokes.length) {
      const c = this.colorAt('stroke', t, s.stroke, '$text');
      for (const r of this.strokes) r.set(c, opacity, this.num('progress', t, s.progress ?? 1));
    }
  }
}
