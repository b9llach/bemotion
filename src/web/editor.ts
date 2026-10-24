import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Engine } from '../engine/engine';
import type { Layer } from '../engine/layers/base';
import type { SceneInstance } from '../engine/scene';
import type { EditOp, Path } from '../spec/ops';
import { toSeconds } from '../spec/time';
import { FieldsPanel } from './fields-panel';
import { KeyTracks } from './key-tracks';
import { LayersPanel } from './layers-panel';

const DEG = Math.PI / 180;

type Mode = 'translate' | 'rotate' | 'scale';
export type Json = Record<string, any>;

/** Transform properties the inspector and gizmo edit. */
export const PROPS = [
  { key: 'x', label: 'X', digits: 1 },
  { key: 'y', label: 'Y', digits: 1 },
  { key: 'z', label: 'Z', digits: 1 },
  { key: 'rotateX', label: 'Rot X', digits: 2 },
  { key: 'rotateY', label: 'Rot Y', digits: 2 },
  { key: 'rotateZ', label: 'Rot Z', digits: 2 },
  { key: 'scale', label: 'Scale', digits: 4 },
  { key: 'opacity', label: 'Opacity', digits: 3 },
] as const;

type PropKey = (typeof PROPS)[number]['key'];

export interface EditorHost {
  engine(): Engine | null;
  canvas(): HTMLCanvasElement | null;
  /** The current (saved or optimistic) spec. A new object after every change. */
  spec(): Json | null;
  time(): number;
  seek(t: number): void;
  requestRender(): void;
  setStatus(kind: 'ok' | 'err' | 'busy', text: string): void;
  /** Applies ops to the preview immediately and saves them to the file. False when rejected. */
  edit(ops: EditOp[]): Promise<boolean>;
  /** Shows ops in the preview without saving (live scrubbing). `null` returns to the saved spec. */
  preview(ops: EditOp[] | null): void;
  undo(): void;
  redo(): void;
}

/** A selected keyframe: one property's key, or every key of the layer at that time (prop null). */
export interface KeySel {
  prop: string | null;
  t: number;
}

/** Small DOM helper. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function samePath(a: Path | null, b: Path | null): boolean {
  return !!a && !!b && a.length === b.length && a.every((k, i) => k === b[i]);
}

/** Follows a JSON path inside the spec. */
export function at(spec: Json | null, path: Path | null): any {
  let node: any = spec;
  for (const k of path ?? []) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[k];
  }
  return node;
}

/** Number formatting for inputs: fixed digits without trailing zeros. */
export function fmtNum(v: number, digits: number): string {
  const s = v.toFixed(digits);
  return (s.includes('.') ? s.replace(/\.?0+$/, '') : s) || '0';
}

/**
 * Visual editor. Pick layers in the viewport or the layers list, move/rotate/scale them with a
 * gizmo, edit any property, add, duplicate, reorder and delete layers, and edit keyframes and
 * their easing on the timeline. Every change goes through `host.edit`, which updates the preview
 * in place and writes the spec file.
 */
export class Editor {
  enabled = false;
  autoKey = false;
  mode: Mode = 'translate';
  selected: Layer | null = null;
  selectedPath: Path | null = null;
  selectedKey: KeySel | null = null;
  readonly fields: FieldsPanel;
  readonly keys: KeyTracks;
  readonly layers: LayersPanel;
  private controls: TransformControls | null = null;
  private helper: THREE.Object3D | null = null;
  private box: THREE.BoxHelper | null = null;
  private proxy = new THREE.Object3D();
  private start = { pos: new THREE.Vector3(), rot: new THREE.Euler(), scl: new THREE.Vector3(1, 1, 1) };
  private dragging = false;
  private down: { x: number; y: number } | null = null;
  private inputs = new Map<string, HTMLInputElement>();
  private keyButtons = new Map<string, HTMLButtonElement>();

  constructor(readonly host: EditorHost) {
    this.buildTransform();
    this.fields = new FieldsPanel(this);
    this.keys = new KeyTracks(this);
    this.layers = new LayersPanel(this);
    this.bindActions();
  }

  /** Called whenever a new engine (and canvas) is loaded. Reselects the previous layer by path. */
  attach(engine: Engine, canvas: HTMLCanvasElement): void {
    this.controls?.dispose();
    this.removeHelpers();
    const controls = new TransformControls(engine.sceneAt(this.host.time()).camera, canvas);
    controls.setMode(this.mode);
    controls.setSpace('local');
    controls.addEventListener('dragging-changed', (e) => {
      this.dragging = !!(e as unknown as { value: boolean }).value;
      if (this.dragging) this.beginDrag();
      else void this.commitDrag();
    });
    controls.addEventListener('objectChange', () => this.onDrag());
    this.controls = controls;
    this.helper = controls.getHelper();
    canvas.addEventListener('pointerdown', (e) => (this.down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointerup', (e) => this.onClick(e));
    engine.onAfterUpdate = (scene) => this.sync(scene);
    this.onSpecChanged();
  }

  /** The preview applied a new spec (an edit, undo, or a change on disk): rebind to the rebuilt layers. */
  onSpecChanged(): void {
    if (this.dragging) return;
    const engine = this.host.engine();
    if (this.selectedPath && !this.raw()) {
      this.selectPath(null);
      return;
    }
    this.bind(engine && this.selectedPath ? engine.layerAt(this.selectedPath) : null);
    this.refreshInspector();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    document.querySelector('.app')?.classList.toggle('editing', on);
    if (!on) this.selectPath(null);
    this.refreshInspector();
    this.host.requestRender();
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.controls?.setMode(mode);
    document.querySelectorAll<HTMLButtonElement>('#edit-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    this.host.requestRender();
  }

  setAutoKey(on: boolean): void {
    this.autoKey = on;
    document.getElementById('autokey')?.classList.toggle('on', on);
  }

  // --- Spec access -----------------------------------------------------------------------------

  /** The selected layer's JSON in the current spec. */
  raw(path: Path | null = this.selectedPath): Json | undefined {
    const v = at(this.host.spec(), path);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  }

  timeCtx(): { fps: number; bpm?: number } {
    const s = this.host.spec();
    return { fps: s?.fps ?? 30, bpm: s?.bpm };
  }

  /** Start (global seconds) and duration of the scene a path belongs to. */
  sceneSpan(path: Path | null = this.selectedPath): { start: number; duration: number } {
    const e = this.host.engine();
    const tm = e && path && typeof path[1] === 'number' ? e.timings[path[1]] : undefined;
    return { start: tm?.start ?? 0, duration: tm?.duration ?? e?.duration ?? 0 };
  }

  /** Playhead in the selected layer's scene time. */
  localTime(path: Path | null = this.selectedPath): number {
    const s = this.sceneSpan(path);
    return Math.min(Math.max(0, this.host.time() - s.start), s.duration);
  }

  /** Keyframes of a property in the source JSON, with times in seconds. */
  keysOf(prop: string, path: Path | null = this.selectedPath): { t: number; v: unknown; ease?: unknown }[] {
    const ks = this.raw(path)?.keyframes?.[prop];
    if (!Array.isArray(ks)) return [];
    const tc = this.timeCtx();
    return ks.map((k: Json) => ({ t: toSeconds(k.t, tc), v: k.v, ease: k.ease })).sort((a, b) => a.t - b.t);
  }

  isAnimated(prop: string, path: Path | null = this.selectedPath): boolean {
    return this.keysOf(prop, path).length > 0;
  }

  hasKeyAt(prop: string, t: number, path: Path | null = this.selectedPath): boolean {
    const tol = 0.5 / this.timeCtx().fps;
    return this.keysOf(prop, path).some((k) => Math.abs(k.t - t) < tol);
  }

  /**
   * The op that changes `prop` to `value` at the playhead: a keyframe when the property is
   * animated (or auto-key is on and the engine can animate it), otherwise the base value.
   */
  opFor(prop: string, value: unknown, animatable: boolean, path: Path | null = this.selectedPath): EditOp | null {
    if (!path) return null;
    const keyable = typeof value === 'number' || typeof value === 'string' || (Array.isArray(value) && value.every((n) => typeof n === 'number'));
    if (keyable && (this.isAnimated(prop, path) || (this.autoKey && animatable))) {
      return { op: 'key', layer: path, prop, t: Math.round(this.localTime(path) * 1000) / 1000, v: value as number | string | number[] };
    }
    if (value === undefined) return { op: 'delete', path: [...path, prop] };
    return { op: 'set', path: [...path, prop], value };
  }

  // --- Selection -------------------------------------------------------------------------------

  private onClick(e: PointerEvent): void {
    if (!this.enabled || this.dragging || !this.down) return;
    const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
    this.down = null;
    if (moved > 4 || this.controls?.axis) return;
    const engine = this.host.engine();
    const canvas = this.host.canvas();
    if (!engine || !canvas) return;
    const r = canvas.getBoundingClientRect();
    const ndc = { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -(((e.clientY - r.top) / r.height) * 2 - 1) };
    let layer = engine.pick(ndc, this.host.time());
    // Alt-click selects the parent of the current selection.
    if (layer && e.altKey && this.selected) {
      let p = this.selected.parent;
      while (p && !p.sourcePath) p = p.parent;
      if (p) layer = p;
    }
    this.selectPath(layer?.sourcePath ?? null);
  }

  /** Selects the layer at a JSON path (or nothing). */
  selectPath(path: Path | null): void {
    if (!samePath(path, this.selectedPath)) {
      this.selectedKey = null;
      this.fields.reset();
    }
    this.selectedPath = path ? [...path] : null;
    const engine = this.host.engine();
    this.bind(engine && path ? engine.layerAt(path) : null);
    this.refreshInspector();
    this.host.requestRender();
  }

  /** Attaches the gizmo and outline to a built layer. */
  private bind(layer: Layer | null): void {
    this.selected = layer;
    this.removeHelpers();
    if (!layer || !this.controls || !this.helper) return;
    const parent = layer.root.parent;
    if (!parent) return;
    parent.add(this.proxy);
    this.copyRoot();
    this.controls.attach(this.proxy);
    const scene = this.sceneOf(layer);
    scene?.three.add(this.helper);
    this.box = new THREE.BoxHelper(layer.root, 0x7c5cff);
    (this.box.material as THREE.LineBasicMaterial).depthTest = false;
    this.box.renderOrder = 1e6;
    scene?.three.add(this.box);
  }

  private removeHelpers(): void {
    this.controls?.detach();
    this.helper?.removeFromParent();
    this.proxy.removeFromParent();
    if (this.box) {
      this.box.removeFromParent();
      this.box.geometry.dispose();
      this.box = null;
    }
  }

  private sceneOf(layer: Layer): SceneInstance | null {
    return this.host.engine()?.scenes.find((s) => s.allLayers.includes(layer)) ?? null;
  }

  /** Runs after each scene update, before render: keep the gizmo on the animated layer. */
  sync(scene: SceneInstance): void {
    if (!this.controls) return;
    if (!this.enabled || !this.selected || !scene.allLayers.includes(this.selected)) {
      if (this.helper && this.helper.parent === scene.three) this.helper.visible = false;
      if (this.box && this.box.parent === scene.three) this.box.visible = false;
      return;
    }
    if (this.helper) this.helper.visible = true;
    this.controls.camera = scene.camera;
    if (!this.dragging) this.copyRoot();
    if (this.box) {
      this.box.visible = this.selected.root.visible;
      this.box.setFromObject(this.selected.root);
    }
  }

  private copyRoot(): void {
    const r = this.selected?.root;
    if (!r) return;
    this.proxy.position.copy(r.position);
    this.proxy.rotation.copy(r.rotation);
    this.proxy.scale.copy(r.scale);
    this.proxy.updateMatrixWorld(true);
  }

  // --- Gizmo dragging --------------------------------------------------------------------------

  private beginDrag(): void {
    this.start.pos.copy(this.proxy.position);
    this.start.rot.copy(this.proxy.rotation);
    this.start.scl.copy(this.proxy.scale);
  }

  private dragDelta() {
    const p = this.proxy;
    const sAvg = (p.scale.x / this.start.scl.x + p.scale.y / this.start.scl.y) / 2;
    return {
      x: p.position.x - this.start.pos.x,
      y: p.position.y - this.start.pos.y,
      z: p.position.z - this.start.pos.z,
      rx: (p.rotation.x - this.start.rot.x) / DEG,
      ry: (p.rotation.y - this.start.rot.y) / DEG,
      rz: (p.rotation.z - this.start.rot.z) / DEG,
      s: Number.isFinite(sAvg) && sAvg > 0 ? sAvg : 1,
    };
  }

  private onDrag(): void {
    if (!this.selected || !this.dragging) return;
    this.selected.editDelta = this.dragDelta();
    this.host.requestRender();
    this.refreshTransform();
  }

  private async commitDrag(): Promise<void> {
    const layer = this.selected;
    if (!layer) return;
    const d = this.dragDelta();
    const changes: [PropKey, number][] = [];
    const cur = (k: PropKey) => this.valueOf(k);
    if (this.mode === 'translate') {
      if (Math.abs(d.x) > 0.01) changes.push(['x', cur('x') + d.x]);
      if (Math.abs(d.y) > 0.01) changes.push(['y', cur('y') + d.y]);
      if (Math.abs(d.z) > 0.01) changes.push(['z', cur('z') + d.z]);
    } else if (this.mode === 'rotate') {
      if (Math.abs(d.rx) > 0.01) changes.push(['rotateX', cur('rotateX') + d.rx]);
      if (Math.abs(d.ry) > 0.01) changes.push(['rotateY', cur('rotateY') + d.ry]);
      if (Math.abs(d.rz) > 0.01) changes.push(['rotateZ', cur('rotateZ') + d.rz]);
    } else if (Math.abs(d.s - 1) > 1e-4) {
      changes.push(['scale', cur('scale') * d.s]);
    }
    // The drag offset stays on the old layer until the rebuilt one replaces it, so nothing jumps.
    if (!changes.length || !(await this.writeTransform(changes))) {
      layer.editDelta = null;
      this.host.requestRender();
    }
  }

  // --- Transform values ------------------------------------------------------------------------

  /** The JSON property that holds rotation around Z (the spec allows `rotate` as an alias). */
  private propName(key: PropKey): string {
    const r = this.raw();
    if (key === 'rotateZ' && r && r.rotateZ === undefined && (r.rotate !== undefined || r.keyframes?.rotate)) return 'rotate';
    return key;
  }

  private valueOf(key: PropKey): number {
    const r = this.raw() ?? {};
    const name = this.propName(key);
    const base = typeof r[name] === 'number' ? r[name] : key === 'scale' || key === 'opacity' ? 1 : 0;
    return this.selected ? this.selected.tracks.num(name, this.localTime(), base) : base;
  }

  private async writeTransform(changes: [PropKey, number][], forceKey = false): Promise<boolean> {
    const path = this.selectedPath;
    if (!path) return false;
    const t = Math.round(this.localTime() * 1000) / 1000;
    const ops = changes.map(([key, raw]): EditOp => {
      const digits = PROPS.find((p) => p.key === key)!.digits;
      const value = Math.round(raw * 10 ** digits) / 10 ** digits;
      const name = this.propName(key);
      if (forceKey) return { op: 'key', layer: path, prop: name, t, v: value };
      return this.opFor(name, value, true)!;
    });
    if (this.raw()?.motionPath && changes.some(([k]) => k === 'x' || k === 'y' || k === 'z')) {
      this.host.setStatus('err', 'Position follows a motion path');
    }
    return this.host.edit(ops);
  }

  private buildTransform(): void {
    const grid = document.getElementById('layer-props');
    if (!grid) return;
    for (const p of PROPS) {
      const row = h('div', 'prop');
      const label = h('span', 'prop-label', p.label);
      const input = h('input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.spellcheck = false;
      input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        if (!this.selectedPath || !Number.isFinite(v)) return;
        void this.writeTransform([[p.key, v]]);
      });
      bindScrub(label, () => this.valueOf(p.key), p.key === 'scale' || p.key === 'opacity' ? 0.005 : p.key.startsWith('rotate') ? 0.5 : 1, {
        preview: (v) => {
          const op = this.selectedPath ? this.opFor(this.propName(p.key), Math.round(v * 1e4) / 1e4, true) : null;
          if (op) this.host.preview([op]);
        },
        commit: (v) => void this.writeTransform([[p.key, v]]),
        cancel: () => this.host.preview(null),
      });
      const key = h('button', 'key');
      key.title = 'Toggle keyframe at playhead';
      key.addEventListener('click', () => this.toggleKey(p.key));
      row.append(label, input, key);
      grid.appendChild(row);
      this.inputs.set(p.key, input);
      this.keyButtons.set(p.key, key);
    }
  }

  private toggleKey(key: PropKey): void {
    const path = this.selectedPath;
    if (!path) return;
    const t = this.localTime();
    const name = this.propName(key);
    if (this.hasKeyAt(name, t)) {
      void this.host.edit([{ op: 'unkey', layer: path, prop: name, t }]);
    } else {
      void this.writeTransform([[key, this.valueOf(key)]], true);
    }
  }

  private refreshTransform(): void {
    if (!this.selectedPath) return;
    const t = this.localTime();
    const d = this.dragging ? this.dragDelta() : null;
    for (const p of PROPS) {
      const input = this.inputs.get(p.key)!;
      let v = this.valueOf(p.key);
      if (d) {
        if (p.key === 'x') v += d.x;
        if (p.key === 'y') v += d.y;
        if (p.key === 'z') v += d.z;
        if (p.key === 'rotateX') v += d.rx;
        if (p.key === 'rotateY') v += d.ry;
        if (p.key === 'rotateZ') v += d.rz;
        if (p.key === 'scale') v *= d.s;
      }
      if (document.activeElement !== input) input.value = fmtNum(v, p.digits);
      const name = this.propName(p.key);
      const btn = this.keyButtons.get(p.key)!;
      btn.classList.toggle('animated', this.isAnimated(name));
      btn.classList.toggle('on', this.hasKeyAt(name, t));
    }
  }

  // --- Layer actions ---------------------------------------------------------------------------

  private bindActions(): void {
    const on = (id: string, fn: () => void) => document.getElementById(id)?.addEventListener('click', fn);
    on('act-duplicate', () => void this.duplicate());
    on('act-forward', () => void this.reorder(1));
    on('act-backward', () => void this.reorder(-1));
    on('act-delete', () => void this.deleteSelected());
  }

  async duplicate(): Promise<void> {
    const path = this.selectedPath;
    const raw = this.raw();
    if (!path || !raw) return;
    const list = path.slice(0, -1);
    const index = path[path.length - 1] as number;
    const copy = structuredClone(raw) as Json;
    // Ids must stay unique: suffix every id in the copy.
    const taken = new Set<string>();
    const collect = (n: any) => {
      if (n && typeof n === 'object') {
        if (typeof n.id === 'string') taken.add(n.id);
        Object.values(n).forEach(collect);
      }
    };
    collect(this.host.spec());
    const rename = (n: any) => {
      if (!n || typeof n !== 'object') return;
      if (typeof n.id === 'string') {
        let i = 2;
        while (taken.has(`${n.id}-${i}`)) i++;
        n.id = `${n.id}-${i}`;
        taken.add(n.id);
      }
      (n.children ?? []).forEach(rename);
    };
    rename(copy);
    // Offset the copy so it is visible next to the original (unless keyframes drive position).
    if (!copy.keyframes?.x && !copy.motionPath) copy.x = (typeof copy.x === 'number' ? copy.x : 0) + 40;
    if (!copy.keyframes?.y && !copy.motionPath) copy.y = (typeof copy.y === 'number' ? copy.y : 0) - 40;
    const target = [...list, index + 1];
    if (await this.host.edit([{ op: 'insert', path: list, index: index + 1, value: copy }])) this.selectPath(target);
  }

  async reorder(dir: 1 | -1): Promise<void> {
    const path = this.selectedPath;
    if (!path) return;
    const list = at(this.host.spec(), path.slice(0, -1));
    const index = path[path.length - 1] as number;
    const to = index + dir;
    if (!Array.isArray(list) || to < 0 || to >= list.length) return;
    const target = [...path.slice(0, -1), to];
    if (await this.host.edit([{ op: 'move', path, to }])) this.selectPath(target);
  }

  async deleteSelected(): Promise<void> {
    const path = this.selectedPath;
    if (!path) return;
    this.selectPath(null);
    await this.host.edit([{ op: 'remove', path }]);
  }

  /** Inserts a new layer at the top of the scene under the playhead and selects it. */
  async addLayer(value: Json): Promise<void> {
    const engine = this.host.engine();
    const spec = this.host.spec();
    if (!engine || !spec) return;
    const idx = engine.sceneIndexAt(this.host.time());
    const list = spec.scenes?.[idx]?.layers ?? [];
    const path: Path = ['scenes', idx, 'layers', list.length];
    if (await this.host.edit([{ op: 'insert', path: ['scenes', idx, 'layers'], value }])) {
      if (!this.enabled) this.setEnabled(true);
      this.selectPath(path);
    }
  }

  // --- Inspector -------------------------------------------------------------------------------

  /** Cheap per-frame refresh; panels rebuild their DOM only when the spec or selection changed. */
  refreshInspector(): void {
    const has = this.enabled && !!this.selectedPath && !!this.raw();
    document.getElementById('layer-panel')?.classList.toggle('hidden', !has);
    document.querySelectorAll('.edit-panel').forEach((p) => p.classList.toggle('hidden', !this.enabled));
    if (has) {
      const raw = this.raw()!;
      const title = document.getElementById('layer-title');
      const name = `${raw.id ? raw.id + '  ' : ''}${raw.type}`;
      if (title && title.textContent !== name) title.textContent = name;
      const pathEl = document.getElementById('layer-path');
      const ps = (this.selectedPath ?? []).join('.');
      if (pathEl && pathEl.textContent !== ps) pathEl.textContent = ps;
      this.refreshTransform();
    }
    this.fields.refresh();
    this.keys.refresh();
    this.layers.refresh();
  }

  /** Keyboard shortcuts. Returns true when the key was handled. */
  handleKey(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      if (e.shiftKey) this.host.redo();
      else this.host.undo();
      return true;
    }
    if (mod && k === 'y') {
      this.host.redo();
      return true;
    }
    if (mod && k === 'd' && this.enabled && this.selectedPath) {
      void this.duplicate();
      return true;
    }
    if (mod && (k === ']' || k === '[') && this.enabled && this.selectedPath) {
      void this.reorder(k === ']' ? 1 : -1);
      return true;
    }
    if (mod) return false;
    switch (k) {
      case 'e':
        this.setEnabled(!this.enabled);
        return true;
      case 'w':
        if (!this.enabled) return false;
        this.setMode('translate');
        return true;
      case 'r':
        if (!this.enabled) return false;
        this.setMode('rotate');
        return true;
      case 's':
        if (!this.enabled) return false;
        this.setMode('scale');
        return true;
      case 'k':
        if (!this.enabled) return false;
        this.setAutoKey(!this.autoKey);
        return true;
      case 'delete':
      case 'backspace':
        if (!this.enabled) return false;
        if (this.selectedKey) void this.keys.deleteSelected();
        else if (this.selectedPath) void this.deleteSelected();
        return true;
      case 'escape':
        if (this.selectedKey) {
          this.selectedKey = null;
          this.refreshInspector();
        } else this.selectPath(null);
        return true;
    }
    return false;
  }
}

/**
 * Drag horizontally on a label to scrub a number (Shift for 10x, Alt for 0.1x). Previews while
 * dragging and commits on release; Escape cancels.
 */
export function bindScrub(
  label: HTMLElement,
  get: () => number,
  step: number,
  cb: { preview(v: number): void; commit(v: number): void; cancel(): void },
): void {
  label.classList.add('scrub');
  let start: { x: number; v: number } | null = null;
  let moved = false;
  let value = 0;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && start) {
      start = null;
      cb.cancel();
    }
  };
  label.addEventListener('pointerdown', (e) => {
    start = { x: e.clientX, v: get() };
    moved = false;
    label.setPointerCapture(e.pointerId);
    window.addEventListener('keydown', onKey);
    e.preventDefault();
  });
  label.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    if (!moved && Math.abs(dx) < 3) return;
    moved = true;
    const k = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    value = start.v + dx * step * k;
    cb.preview(value);
  });
  label.addEventListener('pointerup', () => {
    window.removeEventListener('keydown', onKey);
    if (start && moved) cb.commit(value);
    start = null;
  });
}
