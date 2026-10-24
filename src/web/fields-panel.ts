import { layerFields, labelOf, type FieldInfo } from '../spec/fields';
import { ICONS } from '../engine/icons';
import { parseColor, rgbaToHex, type RGBA } from '../engine/util/color';
import type { EditOp } from '../spec/ops';
import { at, bindScrub, fmtNum, h, type Editor, type Json } from './editor';

interface Row {
  info: FieldInfo;
  /** Refreshes the control from the value at the playhead (animated fields change over time). */
  update(): void;
}

/** Fields that are shown in other sections or would be confusing to edit as raw values. */
const HIDDEN = new Set(['motionPath']);

/**
 * The Properties section: one row per property of the selected layer, generated from the schema.
 * Numbers scrub and type, colors get a picker, text gets a text area, enums a select, and
 * everything else is edited as JSON. A raw JSON editor for the whole layer sits underneath.
 */
export class FieldsPanel {
  private grid = document.getElementById('layer-fields')!;
  private addSel = document.getElementById('add-field') as HTMLSelectElement;
  private json = document.getElementById('layer-json') as HTMLTextAreaElement;
  private jsonError = document.getElementById('layer-json-error')!;
  private rows: Row[] = [];
  private pending = new Set<string>();
  private sigSpec: unknown = null;
  private sigPath = '';

  constructor(private ed: Editor) {
    this.addSel?.addEventListener('change', () => {
      const name = this.addSel.value;
      this.addSel.value = '';
      if (!name) return;
      this.pending.add(name);
      this.rebuild();
      (this.grid.querySelector(`[data-field="${name}"] input, [data-field="${name}"] select, [data-field="${name}"] textarea`) as HTMLElement | null)?.focus();
    });
    document.getElementById('layer-json-apply')?.addEventListener('click', () => void this.applyJson());
    this.json?.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void this.applyJson();
      e.stopPropagation();
    });
  }

  /** Forget fields added but not yet written (selection changed). */
  reset(): void {
    this.pending.clear();
    this.sigSpec = null;
  }

  refresh(): void {
    const path = this.ed.selectedPath;
    if (!this.ed.enabled || !path || !this.ed.raw()) {
      this.sigSpec = null;
      return;
    }
    const spec = this.ed.host.spec();
    const ps = path.join('.');
    if (spec !== this.sigSpec || ps !== this.sigPath) {
      this.sigSpec = spec;
      this.sigPath = ps;
      // Do not rebuild under the user's cursor; the next refresh after blur picks it up.
      const focused = document.activeElement;
      if (focused && this.grid.contains(focused)) {
        this.sigSpec = null;
      } else {
        this.rebuild();
        this.refreshJson();
      }
    }
    for (const r of this.rows) r.update();
  }

  private refreshJson(): void {
    if (!this.json || document.activeElement === this.json) return;
    this.json.value = JSON.stringify(this.ed.raw() ?? {}, null, 2);
    this.jsonError.textContent = '';
  }

  private async applyJson(): Promise<void> {
    const path = this.ed.selectedPath;
    if (!path) return;
    let value: unknown;
    try {
      value = JSON.parse(this.json.value);
    } catch (e) {
      this.jsonError.textContent = `JSON error: ${(e as Error).message}`;
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as Json).type !== 'string') {
      this.jsonError.textContent = 'A layer is an object with a "type".';
      return;
    }
    const ok = await this.ed.host.edit([{ op: 'set', path, value }]);
    this.jsonError.textContent = ok ? '' : 'The change was rejected. See the status message.';
    if (ok) {
      this.json.blur();
      this.sigSpec = null;
    }
  }

  private rebuild(): void {
    const raw = this.ed.raw();
    if (!raw) return;
    const type = String(raw.type);
    const all = layerFields(type).filter((f) => !HIDDEN.has(f.name));
    const shown = all.filter((f) => raw[f.name] !== undefined || f.required || this.pending.has(f.name) || raw.keyframes?.[f.name]);
    this.rows = shown.map((f) => this.row(f, type));
    this.grid.replaceChildren(...this.rows.map((r) => (r as Row & { el: HTMLElement }).el));
    // Properties that can still be added.
    const free = all.filter((f) => !shown.includes(f));
    if (this.addSel) {
      const head = h('option', undefined, free.length ? 'Add property' : 'All properties set');
      head.value = '';
      this.addSel.replaceChildren(
        head,
        ...free.map((f) => {
          const o = h('option', undefined, labelOf(f.name));
          o.value = f.name;
          return o;
        }),
      );
      this.addSel.disabled = !free.length;
    }
  }

  /** Current value: the keyframed value at the playhead when animated, else the base value. */
  private valueAt(name: string): unknown {
    const raw = this.ed.raw() ?? {};
    const layer = this.ed.selected;
    if (this.ed.isAnimated(name) && layer) {
      const t = this.ed.localTime();
      const tr = layer.tracks.get(name);
      if (tr) {
        const v = tr.eval(t);
        if (tr.kind === 'color') return rgbaToHex(v as RGBA);
        return v;
      }
    }
    return raw[name];
  }

  private write(info: FieldInfo, value: unknown): void {
    const op = this.ed.opFor(info.name, value, info.animatable);
    if (op) void this.ed.host.edit([op]);
  }

  private previewValue(info: FieldInfo, value: unknown): void {
    const op = this.ed.opFor(info.name, value, info.animatable);
    if (op) this.ed.host.preview([op]);
  }

  private row(info: FieldInfo, type: string): Row & { el: HTMLElement } {
    const el = h('div', 'prop field');
    el.dataset.field = info.name;
    const label = h('span', 'prop-label', labelOf(info.name));
    label.title = info.name;
    const ctl = h('div', 'ctl');
    const side = h('div', 'side');
    el.append(label, ctl, side);
    let update: () => void = () => {};
    const kind = info.kind === 'color' && typeof this.valueAt(info.name) === 'object' ? 'json' : info.kind;
    const options = type === 'icon' && info.name === 'name' ? Object.keys(ICONS).sort() : info.options;

    if (kind === 'number') {
      const input = h('input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.spellcheck = false;
      input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        if (input.value.trim() === '' && !info.required) this.write(info, undefined);
        else if (Number.isFinite(v)) this.write(info, v);
      });
      const cur = () => {
        const v = this.valueAt(info.name);
        return typeof v === 'number' ? v : 0;
      };
      bindScrub(label, cur, Math.abs(cur()) <= 2 ? 0.01 : 1, {
        preview: (v) => this.previewValue(info, Math.round(v * 1e4) / 1e4),
        commit: (v) => this.write(info, Math.round(v * 1e4) / 1e4),
        cancel: () => this.ed.host.preview(null),
      });
      ctl.append(input);
      update = () => {
        const v = this.valueAt(info.name);
        if (document.activeElement !== input) input.value = typeof v === 'number' ? fmtNum(v, 4) : '';
      };
    } else if (kind === 'color') {
      const swatch = h('input', 'swatch');
      swatch.type = 'color';
      const input = h('input');
      input.type = 'text';
      input.spellcheck = false;
      input.placeholder = '#FFFFFF or $primary';
      swatch.addEventListener('input', () => this.previewValue(info, swatch.value.toUpperCase()));
      swatch.addEventListener('change', () => this.write(info, swatch.value.toUpperCase()));
      input.addEventListener('change', () => {
        const v = input.value.trim();
        if (!v && !info.required) return this.write(info, undefined);
        try {
          this.resolve(v);
        } catch {
          this.ed.host.setStatus('err', `Not a color: ${v}`);
          return;
        }
        this.write(info, v);
      });
      ctl.classList.add('color');
      ctl.append(swatch, input);
      update = () => {
        const v = this.valueAt(info.name);
        const s = typeof v === 'string' ? v : '';
        if (document.activeElement !== input) input.value = s;
        if (document.activeElement !== swatch) {
          try {
            swatch.value = s ? this.resolve(s) : '#000000';
          } catch {
            /* unresolvable token */
          }
        }
      };
    } else if (kind === 'boolean') {
      const tog = h('label', 'toggle mini');
      const box = h('input');
      box.type = 'checkbox';
      tog.append(box, h('i'));
      box.addEventListener('change', () => this.write(info, box.checked));
      ctl.append(tog);
      update = () => {
        box.checked = this.valueAt(info.name) === true;
      };
    } else if (kind === 'enum' && options) {
      const sel = h('select');
      const unset = h('option', undefined, 'Default');
      unset.value = '';
      sel.append(unset, ...options.map((o) => Object.assign(h('option', undefined, o), { value: o })));
      sel.addEventListener('change', () => this.write(info, sel.value === '' ? undefined : sel.value));
      ctl.append(sel);
      update = () => {
        const v = this.valueAt(info.name);
        if (document.activeElement !== sel) sel.value = typeof v === 'string' ? v : '';
      };
    } else if (kind === 'text') {
      const area = h('textarea');
      area.rows = 2;
      area.spellcheck = false;
      area.addEventListener('change', () => this.write(info, area.value));
      area.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') area.blur();
        e.stopPropagation();
      });
      ctl.append(area);
      el.classList.add('tall');
      update = () => {
        const v = this.valueAt(info.name);
        if (document.activeElement !== area) area.value = typeof v === 'string' ? v : '';
      };
    } else {
      // string or json
      const input = h('input');
      input.type = 'text';
      input.spellcheck = false;
      const isString = kind === 'string';
      input.addEventListener('change', () => {
        const text = input.value.trim();
        if (!text && !info.required) return this.write(info, undefined);
        if (isString) return this.write(info, input.value);
        let v: unknown;
        try {
          v = JSON.parse(text);
        } catch {
          if (!info.acceptsString) {
            this.ed.host.setStatus('err', `${info.name}: expected JSON`);
            return;
          }
          v = text;
        }
        this.write(info, v);
      });
      ctl.append(input);
      update = () => {
        const v = this.valueAt(info.name);
        if (document.activeElement === input) return;
        input.value = v === undefined ? '' : isString || typeof v === 'string' ? String(v) : JSON.stringify(v);
      };
    }

    if (info.animatable) {
      const key = h('button', 'key');
      key.title = 'Toggle keyframe at playhead';
      key.addEventListener('click', () => this.toggleKey(info));
      side.append(key);
      const base = update;
      update = () => {
        base();
        const t = this.ed.localTime();
        key.classList.toggle('animated', this.ed.isAnimated(info.name));
        key.classList.toggle('on', this.ed.hasKeyAt(info.name, t));
      };
    } else if (!info.required) {
      const rm = h('button', 'remove');
      rm.title = 'Remove property (use the default)';
      rm.textContent = '×';
      rm.addEventListener('click', () => {
        this.pending.delete(info.name);
        if (this.ed.raw()?.[info.name] === undefined) this.rebuild();
        else this.write(info, undefined);
      });
      side.append(rm);
    }
    update();
    return { info, update, el };
  }

  private toggleKey(info: FieldInfo): void {
    const path = this.ed.selectedPath;
    if (!path) return;
    const t = this.ed.localTime();
    let op: EditOp;
    if (this.ed.hasKeyAt(info.name, t)) {
      op = { op: 'unkey', layer: path, prop: info.name, t };
    } else {
      let v = this.valueAt(info.name);
      if (v === undefined) v = info.kind === 'color' ? '#FFFFFF' : 0;
      if (typeof v !== 'number' && typeof v !== 'string' && !Array.isArray(v)) {
        this.ed.host.setStatus('err', `${info.name} cannot be keyframed`);
        return;
      }
      op = { op: 'key', layer: path, prop: info.name, t: Math.round(t * 1000) / 1000, v: v as number | string | number[] };
    }
    void this.ed.host.edit([op]);
  }

  /** Theme tokens resolve through the spec's theme so swatches show the real color. */
  private resolve(v: string): string {
    if (v.startsWith('$')) {
      const engine = this.ed.host.engine();
      if (engine) return rgbaToHex(engine.ctx.color(v));
      const theme = at(this.ed.host.spec(), ['theme', 'colors', v.slice(1)]);
      if (typeof theme === 'string') return rgbaToHex(parseColor(theme));
    }
    return rgbaToHex(parseColor(v)).toUpperCase();
  }
}
