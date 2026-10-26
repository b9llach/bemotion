import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';

/** One drawable element of an SVG file (a path, rect, circle, ellipse, line, polyline or polygon). */
export interface SvgElement {
  /** Filled outline in the file's coordinates (y down), empty when the element has no fill. */
  shapes: THREE.Shape[];
  /** Outline pieces in the file's coordinates, in drawing order. */
  subpaths: { pts: THREE.Vector2[]; closed: boolean; length: number }[];
  /** Paint as written in the file (`currentColor` kept as is); null when there is none. */
  fill: string | null;
  stroke: string | null;
  fillOpacity: number;
  strokeOpacity: number;
  /** Stroke width in the file's units, after the element's transforms. */
  strokeWidth: number;
  roundCaps: boolean;
}

export interface SvgDoc {
  /** The root's viewBox, else its width and height, else null (use the bounds). */
  viewBox: [number, number, number, number] | null;
  elements: SvgElement[];
}

const paint = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s === 'none' || s === 'transparent') return null;
  return s;
};

const num = (v: unknown, fallback: number) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
};

function lengthOf(pts: THREE.Vector2[], closed: boolean): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += pts[i].distanceTo(pts[i - 1]);
  if (closed && pts.length > 2) l += pts[0].distanceTo(pts[pts.length - 1]);
  return l;
}

/**
 * Parses a whole SVG document: every element in document order with its own paint, groups'
 * transforms applied (three's SVGLoader), and the root's viewBox. Runs in the browser (DOMParser).
 */
export function parseSvgDoc(text: string): SvgDoc {
  const data = new SVGLoader().parse(text);
  const root = data.xml as unknown as Element | undefined;
  let viewBox: SvgDoc['viewBox'] = null;
  const vb = root?.getAttribute?.('viewBox');
  if (vb) {
    const n = vb.split(/[\s,]+/).filter(Boolean).map(Number);
    if (n.length === 4 && n.every(Number.isFinite) && n[2] > 0 && n[3] > 0) viewBox = [n[0], n[1], n[2], n[3]];
  }
  if (!viewBox && root?.getAttribute) {
    const w = parseFloat(root.getAttribute('width') ?? '');
    const h = parseFloat(root.getAttribute('height') ?? '');
    if (w > 0 && h > 0) viewBox = [0, 0, w, h];
  }
  const elements: SvgElement[] = [];
  for (const p of data.paths) {
    const st = (p.userData?.style ?? {}) as Record<string, unknown>;
    const opacity = num(st.opacity, 1);
    const visibility = st.visibility;
    if (visibility === 'hidden' || st.display === 'none') continue;
    // Gradients are drawn in their middle stop's color.
    const gradients = (p.userData?.gradients ?? {}) as Record<string, { stops?: { color: string }[] | null } | undefined>;
    const solid = (v: string | null) => {
      const m = v ? /^\s*url\(\s*["']?#([^)'"\s]+)["']?\s*\)\s*$/.exec(v) : null;
      if (!m) return v;
      const stops = gradients[m[1]]?.stops;
      return stops?.length ? stops[Math.floor(stops.length / 2)].color : null;
    };
    const fill = solid(paint(st.fill));
    const stroke = solid(paint(st.stroke));
    const strokeWidth = num(st.strokeWidth, 1);
    const subpaths = p.subPaths
      .map((sub) => {
        const pts = sub.getPoints(24) as THREE.Vector2[];
        // A closing segment back to the start (written as Z, or a circle) is drawn as a closed loop.
        let closed = sub.autoClose;
        if (pts.length > 2 && pts[0].distanceTo(pts[pts.length - 1]) < 1e-3) {
          pts.pop();
          closed = true;
        }
        return { pts, closed, length: lengthOf(pts, closed) };
      })
      .filter((sp) => sp.pts.length >= 2 && sp.length > 0);
    if (!subpaths.length) continue;
    elements.push({
      shapes: fill ? SVGLoader.createShapes(p) : [],
      subpaths,
      fill,
      stroke: stroke && strokeWidth > 0 ? stroke : null,
      fillOpacity: num(st.fillOpacity, 1) * opacity,
      strokeOpacity: num(st.strokeOpacity, 1) * opacity,
      strokeWidth,
      roundCaps: st.strokeLineCap === 'round',
    });
  }
  return { viewBox, elements };
}

/**
 * Draw-on timing for `count` elements in document order: element i traces over [start, start + span]
 * of the layer's progress. `stagger` is the delay between starts as a fraction of one element's
 * span: 0 draws all together, 1 one after another.
 */
export function drawWindows(count: number, stagger: number): { start: number; span: number }[] {
  const k = Math.max(0, stagger);
  const span = 1 / (1 + Math.max(0, count - 1) * k);
  return Array.from({ length: count }, (_, i) => ({ start: i * k * span, span }));
}
