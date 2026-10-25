import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';

/**
 * Morphing between any two outlines: both are split into closed contours (each part's outline and its
 * holes), resampled to the same number of points, paired up by position and size, and aligned so each
 * point travels the shortest way. Parts without a partner shrink to (or grow from) their own center.
 */

type Pts = THREE.Vector2[];

interface Part {
  outer: Pts;
  holes: Pts[];
}

/** The paired outlines, ready to blend. */
export interface MorphPlan {
  parts: { outer: [Pts, Pts]; holes: [Pts, Pts][] }[];
}

const SAMPLES = 160;
const HOLE_SAMPLES = 96;

export function partsOf(d: string): Part[] {
  const data = new SVGLoader().parse(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${d.replace(/"/g, '')}"/></svg>`);
  const out: Part[] = [];
  for (const p of data.paths) {
    for (const shape of SVGLoader.createShapes(p)) {
      const ex = shape.extractPoints(24);
      out.push({ outer: dedupe(ex.shape), holes: ex.holes.map(dedupe).filter((h) => h.length >= 3) });
    }
  }
  return out.filter((p) => p.outer.length >= 3);
}

function dedupe(pts: Pts): Pts {
  const out: Pts = [];
  for (const p of pts) if (!out.length || out[out.length - 1].distanceToSquared(p) > 1e-10) out.push(p.clone());
  if (out.length > 1 && out[0].distanceToSquared(out[out.length - 1]) < 1e-10) out.pop();
  return out;
}

function area(pts: Pts): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function centroid(pts: Pts): THREE.Vector2 {
  const c = new THREE.Vector2();
  for (const p of pts) c.add(p);
  return c.divideScalar(Math.max(1, pts.length));
}

/** `n` points evenly spaced along a closed polyline. */
function resample(pts: Pts, n: number): Pts {
  const len: number[] = [0];
  for (let i = 1; i <= pts.length; i++) len.push(len[i - 1] + pts[i - 1].distanceTo(pts[i % pts.length]));
  const total = len[len.length - 1] || 1;
  const out: Pts = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = (k / n) * total;
    while (j < pts.length - 1 && len[j + 1] < s) j++;
    const a = pts[j];
    const b = pts[(j + 1) % pts.length];
    const seg = len[j + 1] - len[j] || 1;
    out.push(a.clone().lerp(b, (s - len[j]) / seg));
  }
  return out;
}

/** Rotates (and if needed reverses) `b` so its points line up with `a`'s with the least travel. */
function align(a: Pts, b: Pts): Pts {
  let src = b;
  if (Math.sign(area(a)) !== Math.sign(area(b))) src = [...b].reverse();
  const n = a.length;
  let best = Infinity;
  let off = 0;
  // Compare relative to each centroid so a part that also moves does not skew the alignment.
  const ca = centroid(a);
  const cb = centroid(src);
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let i = 0; i < n; i += 4) {
      const p = a[i];
      const q = src[(i + k) % n];
      s += (p.x - ca.x - (q.x - cb.x)) ** 2 + (p.y - ca.y - (q.y - cb.y)) ** 2;
      if (s >= best) break;
    }
    if (s < best) {
      best = s;
      off = k;
    }
  }
  return a.map((_, i) => src[(i + off) % n]);
}

/** A contour shrunk to a point (its center), for a part with no partner. */
function collapsed(like: Pts): Pts {
  const c = centroid(like);
  return like.map(() => c.clone());
}

/** Pairs items of two lists by distance between centers plus size difference, greedily; -1 when left over. */
function pairUp(a: Pts[], b: Pts[]): number[] {
  const ca = a.map(centroid);
  const cb = b.map(centroid);
  const sa = a.map((p) => Math.sqrt(Math.abs(area(p))));
  const sb = b.map((p) => Math.sqrt(Math.abs(area(p))));
  const cand: [number, number, number][] = [];
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) cand.push([ca[i].distanceTo(cb[j]) + Math.abs(sa[i] - sb[j]), i, j]);
  cand.sort((x, y) => x[0] - y[0]);
  const res = new Array(a.length).fill(-1);
  const used = new Set<number>();
  for (const [, i, j] of cand) {
    if (res[i] >= 0 || used.has(j)) continue;
    res[i] = j;
    used.add(j);
  }
  return res;
}

export function planMorph(fromD: string, toD: string): MorphPlan {
  const A = partsOf(fromD);
  const B = partsOf(toD);
  if (!A.length || !B.length) throw new Error('morphTo: both outlines need at least one closed shape');
  const plan: MorphPlan = { parts: [] };
  const match = pairUp(A.map((p) => p.outer), B.map((p) => p.outer));
  const usedB = new Set(match.filter((j) => j >= 0));
  const pairPart = (pa: Part | null, pb: Part | null) => {
    const oa = pa ? resample(pa.outer, SAMPLES) : null;
    const ob = pb ? resample(pb.outer, SAMPLES) : null;
    const outer: [Pts, Pts] = oa && ob ? [oa, align(oa, ob)] : oa ? [oa, collapsed(oa)] : [collapsed(ob!), ob!];
    const ha = (pa?.holes ?? []).map((h) => resample(h, HOLE_SAMPLES));
    const hb = (pb?.holes ?? []).map((h) => resample(h, HOLE_SAMPLES));
    const hm = pairUp(ha, hb);
    const holes: [Pts, Pts][] = [];
    const usedH = new Set<number>();
    ha.forEach((h, i) => {
      const j = hm[i];
      if (j >= 0) {
        holes.push([h, align(h, hb[j])]);
        usedH.add(j);
      } else holes.push([h, collapsed(h)]);
    });
    hb.forEach((h, j) => {
      if (!usedH.has(j)) holes.push([collapsed(h), h]);
    });
    plan.parts.push({ outer, holes });
  };
  A.forEach((pa, i) => pairPart(pa, match[i] >= 0 ? B[match[i]] : null));
  B.forEach((pb, j) => {
    if (!usedB.has(j)) pairPart(null, pb);
  });
  return plan;
}

const lerpPts = (a: Pts, b: Pts, t: number): Pts => a.map((p, i) => new THREE.Vector2(p.x + (b[i].x - p.x) * t, p.y + (b[i].y - p.y) * t));

/** The outline at `t` (0 = from, 1 = to), as shapes for a fill and closed contours for strokes. */
export function morphAt(plan: MorphPlan, t: number): { shapes: THREE.Shape[]; contours: Pts[] } {
  const shapes: THREE.Shape[] = [];
  const contours: Pts[] = [];
  for (const part of plan.parts) {
    const outer = lerpPts(part.outer[0], part.outer[1], t);
    if (Math.abs(area(outer)) < 1e-6) continue;
    const shape = new THREE.Shape(outer);
    contours.push(outer);
    for (const [ha, hb] of part.holes) {
      const h = lerpPts(ha, hb, t);
      if (Math.abs(area(h)) < 1e-6) continue;
      shape.holes.push(new THREE.Path(h));
      contours.push(h);
    }
    shapes.push(shape);
  }
  return { shapes, contours };
}
