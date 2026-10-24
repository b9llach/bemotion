import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import type { SvgLayer as SvgSpec } from '../../spec/schema';
import { Layer } from './base';
import { Ribbon } from './ribbon';
import { srgbToLinear } from '../util/color';

/** Filled (and optionally stroked) vector shape from SVG path data. */
export class SvgLayer extends Layer<SvgSpec> {
  private fillMesh?: THREE.Mesh<THREE.ShapeGeometry, THREE.MeshBasicMaterial>;
  private strokes: Ribbon[] = [];
  private w = 0;
  private h = 0;

  size() {
    return { w: this.w, h: this.h };
  }

  async load(): Promise<void> {
    const s = this.spec;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="${s.d}"/></svg>`;
    const data = new SVGLoader().parse(svg);
    const shapes: THREE.Shape[] = [];
    for (const p of data.paths) shapes.push(...SVGLoader.createShapes(p));
    const geo = new THREE.ShapeGeometry(shapes, 16);
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    const vb = s.viewBox ?? [bb.min.x, bb.min.y, bb.max.x - bb.min.x, bb.max.y - bb.min.y];
    const scale = (s.width ?? vb[2]) / vb[2];
    const cx = vb[0] + vb[2] / 2;
    const cy = vb[1] + vb[3] / 2;
    this.w = vb[2] * scale;
    this.h = vb[3] * scale;
    // SVG is y-down; flip and center.
    const m = new THREE.Matrix4().makeScale(scale, -scale, 1).multiply(new THREE.Matrix4().makeTranslation(-cx, -cy, 0));
    if (s.fill !== 'none') {
      geo.applyMatrix4(m);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      this.fillMesh = new THREE.Mesh(geo, mat);
      this.setupMaterial(this.fillMesh, mat);
      this.pivot.add(this.fillMesh);
    }
    if (s.stroke) {
      for (const p of data.paths) {
        for (const sub of p.subPaths) {
          const pts = (sub.getPoints(24) as THREE.Vector2[]).map((v) => {
            const q = new THREE.Vector3(v.x, v.y, 0).applyMatrix4(m);
            return new THREE.Vector2(q.x, q.y);
          });
          if (pts.length < 2) continue;
          const r = new Ribbon(pts, s.strokeWidth ?? 2, sub.autoClose);
          this.setupMaterial(r, r.material);
          r.renderOrder = this.order + 0.5;
          this.strokes.push(r);
          this.pivot.add(r);
        }
      }
    }
  }

  protected updateContent(t: number, opacity: number, blur = 0): void {
    const s = this.spec;
    // Vector fills have no cheap blur; fade them as they defocus.
    opacity /= 1 + blur * 0.06;
    if (this.fillMesh) {
      const c = this.colorAt('fill', t, s.fill, '$text');
      this.fillMesh.material.color.setRGB(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
      this.fillMesh.material.opacity = c.a * opacity;
    }
    if (this.strokes.length) {
      const c = this.colorAt('stroke', t, s.stroke, '$text');
      for (const r of this.strokes) r.set(c, opacity, this.num('progress', t, 1));
    }
  }
}
