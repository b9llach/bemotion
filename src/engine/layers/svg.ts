import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import type { SvgLayer as SvgSpec } from '../../spec/schema';
import { Layer } from './base';
import { Ribbon } from './ribbon';
import { srgbToLinear } from '../util/color';
import { morphAt, planMorph, type MorphPlan } from '../morph';
import { drawWindows, parseSvgDoc } from '../svgdoc';
import { clamp01 } from '../anim/easing';
import type { RGBA } from '../util/color';

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

/** One element of an SVG file as drawn: its fill, its stroke pieces, and when it traces. */
interface FileElement {
  fill?: THREE.Mesh<THREE.ShapeGeometry, THREE.MeshBasicMaterial>;
  fillPaint: string | null;
  fillOpacity: number;
  /** Stroke pieces; `from`/`to` are where each sits along the element's whole outline (0-1). */
  strokes: { r: Ribbon; from: number; to: number }[];
  strokePaint: string | null;
  strokeOpacity: number;
  /** The strokes trace the outline of a shape that has only a fill (shown while it draws). */
  outline: boolean;
  start: number;
  span: number;
}

const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Filled (and optionally stroked) vector shape from SVG path data, optionally morphing into a second outline. */
export class SvgLayer extends Layer<SvgSpec> {
  private fillMesh?: THREE.Mesh<THREE.ShapeGeometry, THREE.MeshBasicMaterial>;
  private strokes: Ribbon[] = [];
  private w = 0;
  private h = 0;
  private matrix = new THREE.Matrix4();
  private from?: { parts: string[]; nums: number[] };
  private to?: number[];
  /** Outlines with different commands morph point by point. */
  private plan?: MorphPlan;
  private shownMorph = 0;

  size() {
    return { w: this.w, h: this.h };
  }

  async load(): Promise<void> {
    const s = this.spec;
    if (s.src) return this.loadFile(s.src);
    if (!s.d) throw new Error('An svg layer needs `d` (path data) or `src` (a .svg file)');
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
      if (to.nums.length === this.from.nums.length && to.parts.join('|').replace(/\s+/g, '') === this.from.parts.join('|').replace(/\s+/g, '')) {
        // Same commands (a glyph in another weight): blend the numbers, exact at every step.
        this.to = to.nums;
      } else {
        this.from = undefined;
        this.plan = planMorph(s.d, s.morphTo);
      }
    }
    geo.dispose();
    this.build(first);
  }

  private file?: FileElement[];
  private paints = new Map<string, RGBA>();

  /** A whole .svg file: every element with its own paint, drawn on one after another. */
  private async loadFile(src: string): Promise<void> {
    const s = this.spec;
    const res = await fetch(this.ctx.asset(src));
    if (!res.ok) throw new Error(`Could not load the SVG "${src}" (${res.status})`);
    const doc = parseSvgDoc(await res.text());
    if (!doc.elements.length) throw new Error(`"${src}" has no paths or shapes to draw`);
    let vb = s.viewBox ?? doc.viewBox;
    if (!vb) {
      const box = new THREE.Box2();
      for (const el of doc.elements) for (const sp of el.subpaths) for (const p of sp.pts) box.expandByPoint(p);
      vb = [box.min.x, box.min.y, Math.max(1e-6, box.max.x - box.min.x), Math.max(1e-6, box.max.y - box.min.y)];
    }
    const scale = (s.width ?? vb[2]) / vb[2];
    this.w = vb[2] * scale;
    this.h = vb[3] * scale;
    this.matrix = new THREE.Matrix4().makeScale(scale, -scale, 1).multiply(new THREE.Matrix4().makeTranslation(-(vb[0] + vb[2] / 2), -(vb[1] + vb[3] / 2), 0));
    const windows = drawWindows(doc.elements.length, s.stagger ?? 0.35);
    const n = doc.elements.length;
    this.file = doc.elements.map((el, i) => {
      // Painter's order within the layer follows the document.
      const order = this.order + (i / n) * 0.9;
      const out: FileElement = {
        fillPaint: s.fill === 'none' ? null : el.fill,
        fillOpacity: el.fillOpacity,
        strokes: [],
        strokePaint: el.stroke,
        strokeOpacity: el.strokeOpacity,
        outline: !el.stroke,
        ...windows[i],
      };
      if (out.fillPaint && el.shapes.length) {
        const geo = new THREE.ShapeGeometry(el.shapes, 16);
        geo.applyMatrix4(this.matrix);
        const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, side: THREE.DoubleSide });
        out.fill = new THREE.Mesh(geo, mat);
        this.setupMaterial(out.fill, mat);
        out.fill.renderOrder = order;
        this.pivot.add(out.fill);
      }
      // Shapes with only a fill trace their outline (in the fill's color) while they draw.
      if (!el.stroke && !out.fill) return out;
      const width = el.stroke ? el.strokeWidth * scale : s.strokeWidth ?? 2;
      const total = el.subpaths.reduce((a, sp) => a + sp.length, 0);
      let acc = 0;
      for (const sp of el.subpaths) {
        const pts = sp.pts.map((v) => {
          const q = new THREE.Vector3(v.x, v.y, 0).applyMatrix4(this.matrix);
          return new THREE.Vector2(q.x, q.y);
        });
        const r = new Ribbon(pts, width, sp.closed);
        this.setupMaterial(r, r.material);
        r.renderOrder = order + 0.4 / n;
        if (s.dash) r.setDash(s.dash[0], s.dash[1]);
        if (el.roundCaps || !el.stroke) {
          // Round ends, as the file asks (and always on traced outlines, which look drawn by a pen).
          const dotGeo = new THREE.CircleGeometry(width / 2, 16);
          for (const [e, dist] of sp.closed ? [] : ([[pts[0], 0], [pts[pts.length - 1], r.total]] as const)) {
            const dot = new THREE.Mesh(dotGeo, r.material);
            dot.position.set(e.x, e.y, 0);
            dot.renderOrder = r.renderOrder;
            dot.userData.dist = dist;
            r.add(dot);
          }
        }
        this.pivot.add(r);
        out.strokes.push({ r, from: acc / total, to: (acc + sp.length) / total });
        acc += sp.length;
      }
      return out;
    });
  }

  /** The color of a paint in the file, unless `color` (or `fill`/`stroke`) overrides it. */
  private paint(t: number, raw: string, which: 'fill' | 'stroke'): RGBA {
    const s = this.spec;
    if (s.color !== undefined || this.tracks.has('color')) return this.colorAt('color', t, s.color, '$text');
    const own = s[which];
    if ((own !== undefined && own !== 'none') || this.tracks.has(which)) return this.colorAt(which, t, own, '$text');
    let c = this.paints.get(raw);
    if (!c) {
      if (raw === 'currentColor') c = this.ctx.color('$text');
      else {
        try {
          c = this.ctx.color(raw);
        } catch {
          // Any CSS color the file uses that the spec's parser does not know.
          const tc = new THREE.Color().setStyle(raw, THREE.LinearSRGBColorSpace);
          c = { r: tc.r, g: tc.g, b: tc.b, a: 1 };
        }
      }
      this.paints.set(raw, c);
    }
    return c;
  }

  private updateFile(t: number, opacity: number): void {
    const s = this.spec;
    const p = clamp01(this.num('progress', t, s.progress ?? 1) * this.draw);
    for (const el of this.file!) {
      const local = p >= 1 ? 1 : clamp01((p - el.start) / el.span);
      // Fills fade in as their own trace completes (fillAfter), or all together at the end.
      const fillIn = p >= 1 ? 1 : s.fillAfter ? smooth(0.6, 1, local) : smooth(0.85, 1, p);
      if (el.fill) {
        const c = this.paint(t, el.fillPaint!, 'fill');
        el.fill.visible = fillIn > 0;
        el.fill.material.color.setRGB(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
        el.fill.material.opacity = c.a * el.fillOpacity * opacity * fillIn;
      }
      if (!el.strokes.length) continue;
      // A traced outline gives way to its fill as the fill arrives.
      const strokeOpacity = el.outline ? el.fillOpacity * (1 - fillIn) : el.strokeOpacity;
      const c = el.outline ? this.paint(t, el.fillPaint!, 'fill') : this.paint(t, el.strokePaint!, 'stroke');
      for (const { r, from, to } of el.strokes) {
        const q = clamp01((local - from) / Math.max(1e-6, to - from));
        r.visible = strokeOpacity > 0 && q > 0;
        if (!r.visible) continue;
        r.set(c, opacity * strokeOpacity, q);
        for (const d of r.children) d.visible = q >= 0.999 || (d.userData.dist as number) <= q * r.total;
      }
    }
  }

  private parse(d: string) {
    const data = new SVGLoader().parse(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}"/></svg>`);
    const shapes: THREE.Shape[] = [];
    for (const p of data.paths) shapes.push(...SVGLoader.createShapes(p));
    return { data, shapes };
  }

  /** (Re)builds the fill and stroke meshes for one outline. */
  private build({ data, shapes }: { data?: ReturnType<SvgLayer['parse']>['data']; shapes: THREE.Shape[] }, contours?: THREE.Vector2[][]): void {
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
      // Strokes follow the subpaths of parsed data, or the contours of a point morph (all closed).
      const subs: { pts: THREE.Vector2[]; closed: boolean }[] = contours
        ? contours.map((c) => ({ pts: c, closed: true }))
        : (data?.paths ?? []).flatMap((p) => p.subPaths.map((sub) => ({ pts: sub.getPoints(24) as THREE.Vector2[], closed: sub.autoClose })));
      for (const sub of subs) {
        {
          const pts = sub.pts.map((v) => {
            const q = new THREE.Vector3(v.x, v.y, 0).applyMatrix4(this.matrix);
            return new THREE.Vector2(q.x, q.y);
          });
          if (pts.length < 2) continue;
          const existing = this.strokes[k];
          if (existing) existing.build(pts, s.strokeWidth ?? 2, sub.closed);
          else {
            const r = new Ribbon(pts, s.strokeWidth ?? 2, sub.closed);
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
    if (this.file) return this.updateFile(t, opacity / (1 + blur * 0.06));
    if (this.plan) {
      const m = Math.min(1, Math.max(0, this.num('morph', t, s.morph ?? 0)));
      if (Math.abs(m - this.shownMorph) > 1e-4) {
        this.shownMorph = m;
        const { shapes, contours } = morphAt(this.plan, m);
        this.build({ shapes }, contours);
        // A part that disappeared leaves its stroke behind: hide strokes beyond the contours drawn.
        this.strokes.forEach((r, i) => (r.visible = i < contours.length));
      }
    } else if (this.from && this.to) {
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
      for (const r of this.strokes) r.set(c, opacity, this.num('progress', t, s.progress ?? 1) * this.draw);
    }
  }
}
