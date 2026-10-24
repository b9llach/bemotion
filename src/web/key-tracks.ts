import { isAnimatable, labelOf } from '../spec/fields';
import type { EaseValue, EditOp } from '../spec/ops';
import { rgbaToHex, type RGBA } from '../engine/util/color';
import { EaseEditor } from './ease-editor';
import { fmtNum, h, type Editor } from './editor';

interface Drag {
  el: HTMLElement;
  prop: string | null;
  t: number;
  to: number;
  x0: number;
  moved: boolean;
}

/**
 * Keyframe tracks on the timeline for the selected layer (one summary row plus one row per animated
 * property) and the Keyframe panel. Drag a diamond to retime it, click to select it, double-click
 * an empty spot in a row to add a key there, Delete removes the selected key.
 */
export class KeyTracks {
  private wrap = document.getElementById('keys')!;
  private panel = document.getElementById('key-panel')!;
  private title = document.getElementById('key-title')!;
  private timeIn = document.getElementById('key-time') as HTMLInputElement;
  private valueIn = document.getElementById('key-value') as HTMLInputElement;
  private valueRow = document.getElementById('key-value-row')!;
  private easeRow = document.getElementById('key-ease')!;
  private note = document.getElementById('key-note')!;
  private ease = new EaseEditor();
  private sig = '';
  private sigSpec: unknown = null;
  private drag: Drag | null = null;

  constructor(private ed: Editor) {
    this.easeRow.append(this.ease.root);
    this.ease.onPreview = (e) => {
      const op = this.easeOp(e);
      if (op) this.ed.host.preview([op]);
    };
    this.ease.onCommit = (e) => {
      const op = this.easeOp(e);
      if (op) void this.ed.host.edit([op]);
    };
    this.timeIn.addEventListener('change', () => {
      const sel = this.ed.selectedKey;
      const v = parseFloat(this.timeIn.value);
      if (sel && Number.isFinite(v)) void this.retime(sel.prop, sel.t, this.snap(v));
    });
    this.valueIn.addEventListener('change', () => void this.writeValue());
    document.getElementById('key-delete')?.addEventListener('click', () => void this.deleteSelected());
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', () => this.onUp());
  }

  private easeOp(e: EaseValue | null): EditOp | null {
    const sel = this.ed.selectedKey;
    const path = this.ed.selectedPath;
    if (!sel?.prop || !path) return null;
    return { op: 'ease', layer: path, prop: sel.prop, t: sel.t, ease: e };
  }

  private snap(t: number): number {
    const fps = this.ed.timeCtx().fps;
    const span = this.ed.sceneSpan();
    return Math.round(Math.min(Math.max(0, Math.round(t * fps) / fps), span.duration) * 1000) / 1000;
  }

  private tol(): number {
    return 0.5 / this.ed.timeCtx().fps;
  }

  /** Animated properties of the selected layer, in a stable order. */
  private props(): string[] {
    const kf = this.ed.raw()?.keyframes;
    if (!kf || typeof kf !== 'object') return [];
    return Object.keys(kf).filter((k) => Array.isArray(kf[k]) && kf[k].length);
  }

  refresh(): void {
    const engine = this.ed.host.engine();
    const path = this.ed.selectedPath;
    const on = this.ed.enabled && !!path && !!engine && !!this.ed.raw();
    if (!on) {
      if (this.sig !== '') {
        this.sig = '';
        this.wrap.replaceChildren();
      }
      this.panel.classList.add('hidden');
      return;
    }
    const spec = this.ed.host.spec();
    const sel = this.ed.selectedKey;
    const sig = `${path!.join('.')}|${engine!.duration}|${sel ? `${sel.prop}@${sel.t}` : ''}`;
    if (!this.drag && (sig !== this.sig || spec !== this.sigSpec)) {
      this.sig = sig;
      this.sigSpec = spec;
      this.rebuild();
      this.refreshPanel();
    }
  }

  private rebuild(): void {
    const engine = this.ed.host.engine()!;
    const raw = this.ed.raw()!;
    const span = this.ed.sceneSpan();
    const dur = engine.duration;
    const pct = (local: number) => `${((span.start + local) / dur) * 100}%`;
    const sel = this.ed.selectedKey;
    const tol = this.tol();
    const props = this.props();
    const rows: HTMLElement[] = [];

    // Scene extent so it is clear where keys can go.
    const extent = h('div', 'key-extent');
    extent.style.left = pct(0);
    extent.style.width = `${(span.duration / dur) * 100}%`;

    const makeRow = (prop: string | null, times: number[]) => {
      const row = h('div', `key-row${prop === null ? ' sum' : ''}`);
      const label = h('span', 'key-label', prop === null ? (props.length ? 'All keys' : 'No keyframes') : labelOf(prop));
      if (prop && !isAnimatable(String(raw.type), prop)) {
        label.classList.add('inert');
        label.title = `${prop} is not animated by the engine on ${raw.type} layers`;
      }
      row.append(label);
      for (const t of times) {
        const d = h('button', 'kf');
        d.style.left = pct(t);
        d.title = `${prop ?? 'All'}  ${t.toFixed(3)}s`;
        if (sel && sel.prop === prop && Math.abs(sel.t - t) < tol) d.classList.add('sel');
        d.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          e.preventDefault();
          this.drag = { el: d, prop, t, to: t, x0: e.clientX, moved: false };
        });
        d.addEventListener('dblclick', (e) => e.stopPropagation());
        row.append(d);
      }
      if (prop !== null) {
        row.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          const r = this.wrap.getBoundingClientRect();
          const global = ((e.clientX - r.left) / r.width) * dur;
          void this.addKey(prop, this.snap(global - span.start));
        });
      }
      return row;
    };

    const all = new Map<number, number>();
    for (const p of props) for (const k of this.ed.keysOf(p)) all.set(Math.round(k.t * 1000) / 1000, 1);
    rows.push(makeRow(null, [...all.keys()].sort((a, b) => a - b)));
    for (const p of props) rows.push(makeRow(p, this.ed.keysOf(p).map((k) => k.t)));
    this.wrap.replaceChildren(extent, ...rows);
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const engine = this.ed.host.engine();
    if (!engine) return;
    const span = this.ed.sceneSpan();
    const w = this.wrap.getBoundingClientRect().width;
    d.to = this.snap(d.t + (dx / w) * engine.duration);
    d.el.style.left = `${((span.start + d.to) / engine.duration) * 100}%`;
    d.el.classList.add('dragging');
    d.el.dataset.tip = `${d.to.toFixed(2)}s`;
    this.ed.host.seek(span.start + d.to);
  }

  private onUp(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const span = this.ed.sceneSpan();
    if (d.moved && Math.abs(d.to - d.t) >= this.tol()) {
      void this.retime(d.prop, d.t, d.to);
    } else {
      this.ed.selectedKey = { prop: d.prop, t: d.t };
      this.ed.host.seek(span.start + d.t);
      this.sig = '';
      this.ed.refreshInspector();
    }
  }

  private async retime(prop: string | null, t: number, to: number): Promise<void> {
    const path = this.ed.selectedPath;
    if (!path) return;
    const op: EditOp = { op: 'retime', layer: path, ...(prop ? { prop } : {}), t, to };
    this.ed.selectedKey = { prop, t: to };
    this.sig = '';
    const ok = await this.ed.host.edit([op]);
    if (!ok) this.ed.selectedKey = { prop, t };
    this.ed.host.seek(this.ed.sceneSpan().start + (ok ? to : t));
    this.ed.refreshInspector();
  }

  /** Value of a property at scene time t, from the built layer's track. */
  private valueAt(prop: string, t: number): number | string | number[] | undefined {
    const tr = this.ed.selected?.tracks.get(prop);
    if (tr) {
      const v = tr.eval(t);
      return tr.kind === 'color' ? rgbaToHex(v as RGBA).toUpperCase() : (v as number | string | number[]);
    }
    const base = this.ed.raw()?.[prop];
    return typeof base === 'number' || typeof base === 'string' ? base : undefined;
  }

  private async addKey(prop: string, t: number): Promise<void> {
    const path = this.ed.selectedPath;
    const v = this.valueAt(prop, t);
    if (!path || v === undefined) return;
    this.ed.selectedKey = { prop, t };
    await this.ed.host.edit([{ op: 'key', layer: path, prop, t, v }]);
  }

  async deleteSelected(): Promise<void> {
    const sel = this.ed.selectedKey;
    const path = this.ed.selectedPath;
    if (!sel || !path) return;
    const props = sel.prop ? [sel.prop] : this.props().filter((p) => this.ed.hasKeyAt(p, sel.t));
    this.ed.selectedKey = null;
    if (props.length) await this.ed.host.edit(props.map((prop): EditOp => ({ op: 'unkey', layer: path, prop, t: sel.t })));
    this.ed.refreshInspector();
  }

  private async writeValue(): Promise<void> {
    const sel = this.ed.selectedKey;
    const path = this.ed.selectedPath;
    if (!sel?.prop || !path) return;
    const text = this.valueIn.value.trim();
    const key = this.ed.keysOf(sel.prop).find((k) => Math.abs(k.t - sel.t) < this.tol());
    let v: number | string | number[];
    if (typeof key?.v === 'number') {
      v = parseFloat(text);
      if (!Number.isFinite(v)) return;
    } else if (Array.isArray(key?.v)) {
      try {
        v = JSON.parse(text);
      } catch {
        this.ed.host.setStatus('err', 'Expected an array like [1, 2]');
        return;
      }
    } else v = text;
    await this.ed.host.edit([{ op: 'key', layer: path, prop: sel.prop, t: sel.t, v }]);
  }

  private refreshPanel(): void {
    const sel = this.ed.selectedKey;
    const tol = this.tol();
    if (!sel) {
      this.panel.classList.add('hidden');
      return;
    }
    if (sel.prop === null) {
      const props = this.props().filter((p) => this.ed.hasKeyAt(p, sel.t));
      if (!props.length) {
        this.panel.classList.add('hidden');
        return;
      }
      this.panel.classList.remove('hidden');
      this.title.textContent = `${props.length} ${props.length === 1 ? 'property' : 'properties'}: ${props.map(labelOf).join(', ')}`;
      this.valueRow.classList.add('hidden');
      this.easeRow.classList.add('hidden');
      this.note.textContent = 'Dragging this key on the "All keys" row moves every key at this time.';
    } else {
      const keys = this.ed.keysOf(sel.prop);
      const i = keys.findIndex((k) => Math.abs(k.t - sel.t) < tol);
      if (i < 0) {
        this.panel.classList.add('hidden');
        return;
      }
      const k = keys[i];
      this.panel.classList.remove('hidden');
      this.title.textContent = labelOf(sel.prop);
      this.valueRow.classList.remove('hidden');
      this.easeRow.classList.remove('hidden');
      if (document.activeElement !== this.valueIn) {
        this.valueIn.value = typeof k.v === 'number' ? fmtNum(k.v, 4) : Array.isArray(k.v) ? JSON.stringify(k.v) : String(k.v);
      }
      const ease = (k.ease ?? null) as EaseValue | null;
      this.ease.set(ease, 'inOutCubic');
      this.note.textContent =
        i === 0
          ? 'The ease shapes the motion arriving at a keyframe. This is the first key, so its ease has no effect.'
          : `Ease of the motion from ${keys[i - 1].t.toFixed(2)}s to ${k.t.toFixed(2)}s.`;
    }
    if (document.activeElement !== this.timeIn) this.timeIn.value = fmtNum(sel.t, 3);
  }
}
