import type { Path } from '../spec/ops';
import { toSeconds } from '../spec/time';
import { h, samePath, type Editor, type Json } from './editor';

interface Template {
  label: string;
  hint: string;
  /** Asset-backed layers ask for a file first. */
  asset?: 'image' | 'model' | 'video';
  make(src?: string): Json;
}

const TEMPLATES: Template[] = [
  { label: 'Text', hint: 'Headline', make: () => ({ type: 'text', text: 'New headline', size: 96, weight: 700, color: '$text' }) },
  { label: 'Rectangle', hint: 'Rounded shape', make: () => ({ type: 'shape', shape: 'rect', width: 480, height: 280, radius: 28, fill: '$primary' }) },
  { label: 'Circle', hint: 'Shape', make: () => ({ type: 'shape', shape: 'circle', width: 240, fill: '$primary' }) },
  { label: 'Pill', hint: 'Shape', make: () => ({ type: 'shape', shape: 'pill', width: 360, height: 96, fill: '$surface2' }) },
  { label: 'Icon', hint: 'Line icon', make: () => ({ type: 'icon', name: 'check', size: 96, color: '$text' }) },
  { label: 'Button', hint: 'Component', make: () => ({ type: 'button', label: 'Get started' }) },
  { label: 'Glow', hint: 'Ambient light', make: () => ({ type: 'glow', color: '$primary', size: 900, intensity: 0.6, z: -400 }) },
  { label: '3D box', hint: 'Mesh', make: () => ({ type: 'mesh', geometry: 'roundedBox', size: 260, material: 'glossy', color: '$primary', rotateX: 20, rotateY: 30 }) },
  { label: '3D sphere', hint: 'Mesh', make: () => ({ type: 'mesh', geometry: 'sphere', size: 220, material: 'chrome' }) },
  { label: 'Image', hint: 'From a file', asset: 'image', make: (src) => ({ type: 'image', src, width: 640 }) },
  { label: 'Video', hint: 'Clip from a file', asset: 'video', make: (src) => ({ type: 'video', src, width: 1280, radius: 24 }) },
  { label: '3D model', hint: 'glTF / GLB file', asset: 'model', make: (src) => ({ type: 'model', src, size: 600 }) },
  { label: 'Group', hint: 'Container', make: () => ({ type: 'group', children: [] }) },
];

/** Short display name for a layer row. */
function nameOf(l: Json): string {
  if (typeof l.id === 'string') return l.id;
  for (const k of ['text', 'label', 'title', 'name', 'src']) {
    if (typeof l[k] === 'string' && l[k]) {
      const s = l[k].replace(/\s+/g, ' ');
      return k === 'text' || k === 'label' ? `"${s.length > 28 ? s.slice(0, 27) + '...' : s}"` : s;
    }
  }
  return l.type;
}

/**
 * Layers list for the scene under the playhead: click to select (including layers that are hard
 * to click in the viewport), dimmed when inactive at the playhead. The Add menu inserts new layers.
 */
export class LayersPanel {
  private list = document.getElementById('layer-tree')!;
  private menu = document.getElementById('add-menu')!;
  private sigSpec: unknown = null;
  private sig = '';
  private rows: { el: HTMLElement; path: Path; start: number; end: number }[] = [];

  constructor(private ed: Editor) {
    document.getElementById('add-layer')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.menu.classList.contains('hidden')) this.openMenu();
      else this.closeMenu();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.menu.contains(e.target as Node) && (e.target as HTMLElement).id !== 'add-layer') this.closeMenu();
    });
  }

  private closeMenu(): void {
    this.menu.classList.add('hidden');
  }

  private openMenu(): void {
    this.menu.classList.remove('hidden');
    this.menu.replaceChildren(
      ...TEMPLATES.map((t) => {
        const b = h('button', 'menu-item');
        b.append(h('span', 'mi-label', t.label), h('span', 'mi-hint', t.hint));
        b.addEventListener('click', () => (t.asset ? void this.pickAsset(t) : this.add(t.make())));
        return b;
      }),
    );
  }

  private add(value: Json): void {
    this.closeMenu();
    void this.ed.addLayer(value);
  }

  /** Lists matching files next to the spec, with a free path field as a fallback. */
  private async pickAsset(t: Template): Promise<void> {
    const back = h('button', 'menu-back', 'Back');
    back.addEventListener('click', () => this.openMenu());
    const head = h('div', 'menu-head', t.asset === 'image' ? 'Choose an image' : t.asset === 'video' ? 'Choose a video' : 'Choose a model');
    const listEl = h('div', 'menu-files', 'Loading files');
    const input = h('input', 'menu-input');
    input.placeholder = 'path/relative/to/spec.png';
    input.spellcheck = false;
    const go = h('button', 'mini-btn', 'Add');
    const submit = () => {
      const v = input.value.trim();
      if (v) this.add(t.make(v));
    };
    go.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') submit();
    });
    const form = h('div', 'menu-form');
    form.append(input, go);
    this.menu.replaceChildren(back, head, listEl, form);
    try {
      const r = await fetch(`/__bemotion/files?kind=${t.asset}`, { cache: 'no-store' });
      const files = r.ok ? ((await r.json()) as string[]) : [];
      listEl.replaceChildren(
        ...(files.length
          ? files.map((f) => {
              const b = h('button', 'menu-item file', f);
              b.addEventListener('click', () => this.add(t.make(f)));
              return b;
            })
          : [h('div', 'menu-empty', 'No matching files next to the spec. Type a path below.')]),
      );
    } catch {
      listEl.textContent = 'Could not list files. Type a path below.';
    }
  }

  refresh(): void {
    if (!this.ed.enabled) return;
    const engine = this.ed.host.engine();
    const spec = this.ed.host.spec();
    if (!engine || !spec) return;
    const idx = engine.sceneIndexAt(this.ed.host.time());
    const sel = this.ed.selectedPath;
    const sig = `${idx}|${sel ? sel.join('.') : ''}`;
    if (spec !== this.sigSpec || sig !== this.sig) {
      this.sigSpec = spec;
      this.sig = sig;
      this.rebuild(spec, idx);
    }
    // Dim layers that are not on screen at the playhead.
    const local = this.ed.host.time() - engine.timings[idx].start;
    for (const r of this.rows) r.el.classList.toggle('inactive', local < r.start || local > r.end);
  }

  private rebuild(spec: Json, idx: number): void {
    const scene = spec.scenes?.[idx];
    const head = document.getElementById('layers-scene');
    if (head) head.textContent = scene?.id ?? `Scene ${idx + 1}`;
    const tc = { fps: spec.fps ?? 30, bpm: spec.bpm };
    const engine = this.ed.host.engine()!;
    const dur = engine.timings[idx]?.duration ?? 0;
    const sel = this.ed.selectedPath;
    this.rows = [];
    const items: HTMLElement[] = [];
    // Painter's order: later layers draw on top, so list them first like a layer stack.
    const walk = (layers: Json[], base: Path, depth: number) => {
      for (let i = layers.length - 1; i >= 0; i--) {
        const l = layers[i];
        if (!l || typeof l !== 'object') continue;
        const path = [...base, i];
        const li = h('li', 'layer-row');
        li.style.paddingLeft = `${8 + depth * 14}px`;
        li.append(h('span', 'lt-type', String(l.type)), h('span', 'lt-name', nameOf(l)));
        if (samePath(path, sel)) li.classList.add('on');
        li.addEventListener('click', () => {
          if (!this.ed.enabled) this.ed.setEnabled(true);
          this.ed.selectPath(path);
        });
        items.push(li);
        let start = 0;
        let end = dur;
        try {
          start = l.start !== undefined ? toSeconds(l.start, tc) : 0;
          end = l.end !== undefined ? toSeconds(l.end, tc) : dur;
        } catch {
          /* invalid time strings are reported by validation */
        }
        this.rows.push({ el: li, path, start, end });
        if (Array.isArray(l.children) && l.children.length) walk(l.children, [...path, 'children'], depth + 1);
      }
    };
    walk(Array.isArray(scene?.layers) ? scene.layers : [], ['scenes', idx, 'layers'], 0);
    if (!items.length) items.push(h('li', 'layer-empty', 'No layers in this scene'));
    this.list.replaceChildren(...items);
    this.list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }
}
