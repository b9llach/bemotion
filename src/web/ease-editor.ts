import { EASINGS, resolveEase } from '../engine/anim/easing';
import type { EaseValue } from '../spec/ops';

type Bezier = [number, number, number, number];

/** Cubic-bezier equivalents of the named easings, so their handles can be dragged into a custom curve. */
const BEZIER: Record<string, Bezier> = {
  linear: [0, 0, 1, 1],
  inSine: [0.12, 0, 0.39, 0],
  outSine: [0.61, 1, 0.88, 1],
  inOutSine: [0.37, 0, 0.63, 1],
  inQuad: [0.11, 0, 0.5, 0],
  outQuad: [0.5, 1, 0.89, 1],
  inOutQuad: [0.45, 0, 0.55, 1],
  inCubic: [0.32, 0, 0.67, 0],
  outCubic: [0.33, 1, 0.68, 1],
  inOutCubic: [0.65, 0, 0.35, 1],
  inQuart: [0.5, 0, 0.75, 0],
  outQuart: [0.25, 1, 0.5, 1],
  inOutQuart: [0.76, 0, 0.24, 1],
  inQuint: [0.64, 0, 0.78, 0],
  outQuint: [0.22, 1, 0.36, 1],
  inOutQuint: [0.83, 0, 0.17, 1],
  inExpo: [0.7, 0, 0.84, 0],
  outExpo: [0.16, 1, 0.3, 1],
  inOutExpo: [0.87, 0, 0.13, 1],
  inCirc: [0.55, 0, 1, 0.45],
  outCirc: [0, 0.55, 0.45, 1],
  inOutCirc: [0.85, 0, 0.15, 1],
  inBack: [0.36, 0, 0.66, -0.56],
  outBack: [0.34, 1.56, 0.64, 1],
  inOutBack: [0.68, -0.6, 0.32, 1.6],
  snap: [0.85, 0, 0.15, 1],
  swift: [0.55, 0, 0.1, 1],
  smooth: [0.45, 0, 0.2, 1],
  anticipate: [0.6, -0.28, 0.4, 1],
  overshoot: [0.34, 1.56, 0.64, 1],
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 240;
const H = 196;
const PAD = 14;
// Vertical range shown, so overshooting curves stay visible.
const Y_MIN = -0.5;
const Y_MAX = 1.65;

const sx = (x: number) => PAD + x * (W - PAD * 2);
const sy = (y: number) => H - PAD - ((y - Y_MIN) / (Y_MAX - Y_MIN)) * (H - PAD * 2);
const ix = (px: number) => (px - PAD) / (W - PAD * 2);
const iy = (py: number) => Y_MIN + ((H - PAD - py) / (H - PAD * 2)) * (Y_MAX - Y_MIN);

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Curve editor for a keyframe's ease: a named-ease picker plus a graph with two bezier handles.
 * Dragging a handle turns the ease into a custom cubic-bezier.
 */
export class EaseEditor {
  readonly root: HTMLElement;
  /** Called while dragging (preview) and on release (commit). `null` means the default ease. */
  onPreview: (ease: EaseValue | null) => void = () => {};
  onCommit: (ease: EaseValue | null) => void = () => {};
  private select: HTMLSelectElement;
  private curve: SVGPathElement;
  private lines: [SVGLineElement, SVGLineElement];
  private handles: [SVGCircleElement, SVGCircleElement];
  private readout: HTMLElement;
  private value: EaseValue | null = null;
  private fallback = 'inOutCubic';

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'ease-editor';
    this.select = document.createElement('select');
    this.select.className = 'ease-select';
    this.select.addEventListener('change', () => {
      const v = this.select.value;
      const next = v === '' ? null : v === 'custom' ? this.bezier() : v;
      this.set(next, this.fallback);
      this.onCommit(next);
    });
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ease-graph' });
    // Reference lines at 0 and 1.
    svg.append(
      el('rect', { x: sx(0), y: sy(1), width: sx(1) - sx(0), height: sy(0) - sy(1), class: 'ease-box' }),
      el('line', { x1: sx(0), y1: sy(0), x2: sx(1), y2: sy(1), class: 'ease-diag' }),
    );
    this.curve = el('path', { class: 'ease-curve', d: '' });
    this.lines = [el('line', { class: 'ease-arm' }), el('line', { class: 'ease-arm' })];
    this.handles = [el('circle', { r: 6, class: 'ease-handle' }), el('circle', { r: 6, class: 'ease-handle' })];
    svg.append(this.curve, ...this.lines, ...this.handles);
    this.handles.forEach((h, i) => this.bindHandle(svg, h, i));
    this.readout = document.createElement('div');
    this.readout.className = 'ease-readout';
    this.root.append(this.select, svg, this.readout);
  }

  /** Shows `ease`; `fallback` is what an unset ease resolves to. */
  set(ease: EaseValue | null, fallback = 'inOutCubic'): void {
    this.value = ease;
    this.fallback = fallback;
    const opts: [string, string][] = [['', `Default (${fallback})`], ...Object.keys(EASINGS).map((k): [string, string] => [k, k])];
    if (Array.isArray(ease)) opts.push(['custom', 'Custom curve']);
    const sig = opts.map((o) => o[0]).join(',');
    if (this.select.dataset.sig !== sig) {
      this.select.dataset.sig = sig;
      this.select.replaceChildren(
        ...opts.map(([v, label]) => {
          const o = document.createElement('option');
          o.value = v;
          o.textContent = label;
          return o;
        }),
      );
    }
    this.select.value = ease === null ? '' : Array.isArray(ease) ? 'custom' : ease;
    this.draw();
  }

  /** The bezier the handles show for the current value. */
  private bezier(): Bezier {
    const v = this.value ?? this.fallback;
    if (Array.isArray(v)) return [...v] as Bezier;
    return [...(BEZIER[v] ?? [0.25, 0.1, 0.25, 1])] as Bezier;
  }

  private draw(): void {
    const fn = resolveEase(this.value ?? undefined, this.fallback);
    let d = '';
    for (let i = 0; i <= 96; i++) {
      const x = i / 96;
      d += `${i ? 'L' : 'M'}${sx(x).toFixed(2)},${sy(fn(x)).toFixed(2)}`;
    }
    this.curve.setAttribute('d', d);
    const b = this.bezier();
    const exact = Array.isArray(this.value) || BEZIER[(this.value ?? this.fallback) as string] !== undefined;
    const pts: [number, number][] = [
      [b[0], b[1]],
      [b[2], b[3]],
    ];
    const anchors: [number, number][] = [
      [0, 0],
      [1, 1],
    ];
    pts.forEach(([x, y], i) => {
      const h = this.handles[i];
      h.setAttribute('cx', String(sx(x)));
      h.setAttribute('cy', String(sy(y)));
      h.classList.toggle('approx', !exact);
      const l = this.lines[i];
      l.setAttribute('x1', String(sx(anchors[i][0])));
      l.setAttribute('y1', String(sy(anchors[i][1])));
      l.setAttribute('x2', String(sx(x)));
      l.setAttribute('y2', String(sy(y)));
    });
    this.readout.textContent = Array.isArray(this.value)
      ? `cubic-bezier(${this.value.map(r3).join(', ')})`
      : exact
        ? `${this.value ?? this.fallback}  (${b.map(r3).join(', ')})`
        : `${this.value ?? this.fallback}  (drag a handle for a custom curve)`;
  }

  private bindHandle(svg: SVGSVGElement, h: SVGCircleElement, i: number): void {
    let dragging = false;
    const at = (e: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const py = ((e.clientY - r.top) / r.height) * H;
      return [Math.min(1, Math.max(0, ix(px))), Math.min(Y_MAX, Math.max(Y_MIN, iy(py)))];
    };
    h.addEventListener('pointerdown', (e) => {
      dragging = true;
      h.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    h.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const [x, y] = at(e);
      const b = this.bezier();
      b[i * 2] = r3(x);
      b[i * 2 + 1] = r3(y);
      this.set(b, this.fallback);
      this.onPreview(b);
    });
    h.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      this.onCommit(this.value);
    });
  }
}
