import type { EditOp } from '../spec/ops';
import type { Json } from './editor';
import type { PreviewAudio } from './audio';

/**
 * The Sound panel: the spec's music and voice tracks (role, volume, start, remove), the sound effects
 * kit, and adding audio by dropping a file anywhere on the preview or picking one.
 */
export interface SoundHost {
  spec(): Json | null;
  edit(ops: EditOp[]): Promise<boolean>;
  audio: PreviewAudio;
  toast(kind: 'ok' | 'err' | 'busy', text: string): void;
  /** Adds a layer to the scene under the playhead (dropped video clips). */
  addLayer(value: Json): Promise<void>;
}

const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv)$/i;
const ROLES: [string, string][] = [['music', 'Music'], ['voice', 'Voice'], ['sfx', 'Effects']];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const fileName = (src: string) => src.split('/').pop() ?? src;

export class SoundPanel {
  private list = document.getElementById('audio-list') as HTMLOListElement;
  private kit = document.getElementById('sfx-kit') as HTMLSelectElement;
  private picker = document.getElementById('audio-file') as HTMLInputElement;
  private drop = document.getElementById('drop-audio') as HTMLElement;

  constructor(private host: SoundHost) {
    (document.getElementById('audio-add') as HTMLButtonElement).onclick = () => this.picker.click();
    this.picker.onchange = () => {
      void this.addFiles([...(this.picker.files ?? [])]);
      this.picker.value = '';
    };
    this.kit.onchange = () => this.setKit(this.kit.value);
    this.bindDrop();
  }

  private tracks(): Json[] {
    return ((this.host.spec()?.audio ?? []) as Json[]).map((t) => ({ ...t }));
  }

  private save(tracks: Json[]): Promise<boolean> {
    return this.host.edit(tracks.length ? [{ op: 'set', path: ['audio'], value: tracks }] : [{ op: 'delete', path: ['audio'] }]);
  }

  private setKit(v: string): void {
    const spec = this.host.spec();
    const cur = spec?.sfx;
    if (v === 'off') void this.host.edit([{ op: 'set', path: ['sfx'], value: false }]);
    else void this.host.edit([{ op: 'set', path: ['sfx'], value: { ...(typeof cur === 'object' && cur ? cur : {}), kit: v } }]);
  }

  /** Redraws from the current spec. */
  render(): void {
    const spec = this.host.spec();
    const sfx = spec?.sfx;
    this.kit.value = sfx === false ? 'off' : (typeof sfx === 'object' && sfx?.kit) || 'soft';
    this.list.replaceChildren();
    const tracks = this.tracks();
    if (!tracks.length) {
      this.list.append(el('li', 'audio-empty', 'No music or voiceover yet.'));
      return;
    }
    tracks.forEach((t, i) => {
      const li = el('li', 'audio-row');
      const top = el('div', 'audio-top');
      const name = el('span', 'audio-name', fileName(String(t.src)));
      name.title = String(t.src);
      const len = this.host.audio.lengthOf(String(t.src));
      const meta = el('span', 'audio-len', len === null ? '' : `${len.toFixed(1)}s`);
      const del = el('button', 'mini-btn icon danger');
      del.title = 'Remove track';
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>';
      del.onclick = () => void this.save(tracks.filter((_, k) => k !== i));
      top.append(name, meta, del);

      const role = el('select', 'audio-role');
      for (const [v, label] of ROLES) role.append(new Option(label, v));
      role.value = t.role ?? 'music';
      role.onchange = () => {
        tracks[i] = { ...t, role: role.value };
        void this.save(tracks);
      };

      const vol = el('input', 'audio-vol');
      vol.type = 'range';
      vol.min = '0';
      vol.max = '1.5';
      vol.step = '0.05';
      vol.value = String(t.volume ?? ((t.role ?? 'music') === 'music' ? 0.8 : 1));
      vol.title = 'Volume';
      vol.onchange = () => {
        tracks[i] = { ...t, volume: Number(vol.value) };
        void this.save(tracks);
      };

      const at = el('input', 'audio-at');
      at.type = 'text';
      at.inputMode = 'decimal';
      at.value = String(t.at ?? 0);
      at.title = 'Start time (s)';
      at.onchange = () => {
        const v = Number(at.value);
        if (!Number.isFinite(v) || v < 0) {
          at.value = String(t.at ?? 0);
          return;
        }
        tracks[i] = { ...t, at: v };
        void this.save(tracks);
      };
      const atWrap = el('label', 'audio-at-wrap');
      atWrap.append(el('span', '', 'at'), at, el('span', 'unit', 's'));

      const controls = el('div', 'audio-controls');
      controls.append(role, vol, atWrap);
      li.append(top, controls);
      if ((t.role ?? 'music') === 'music') {
        // One music track can set the cut: scene changes and line entrances move onto its beats.
        const sync = el('label', 'field toggle audio-sync');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = !!t.sync;
        box.onchange = () => void this.save(tracks.map((x, k) => ({ ...x, sync: k === i && box.checked ? true : undefined })));
        sync.append(el('span', '', 'Cut to the beat'), box, el('i'));
        li.append(sync);
      }
      this.list.append(li);
    });
  }

  private bindDrop(): void {
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      depth++;
      this.drop.classList.remove('hidden');
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) this.drop.classList.add('hidden');
    });
    window.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      this.drop.classList.add('hidden');
      void this.addFiles([...(e.dataTransfer?.files ?? [])]);
    });
  }

  /** Uploads one file next to the spec; returns its path relative to the spec, or null. */
  private async upload(f: File): Promise<string | null> {
    this.host.toast('busy', `Adding ${f.name}`);
    const res = await fetch(`/__bemotion/upload?name=${encodeURIComponent(f.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Bemotion': '1' },
      body: f,
    });
    const body = await res.json().catch(() => ({ ok: false, error: `Upload failed (${res.status})` }));
    if (!body.ok) {
      this.host.toast('err', body.error ?? 'Upload failed');
      return null;
    }
    return body.src as string;
  }

  /**
   * Uploads dropped files next to the spec. Audio becomes tracks (names with voice/vo/narration become
   * voice); video clips become video layers in the scene under the playhead.
   */
  async addFiles(files: File[]): Promise<void> {
    for (const f of files.filter((f) => VIDEO_EXT.test(f.name))) {
      const src = await this.upload(f);
      if (!src) return;
      await this.host.addLayer({ type: 'video', src, width: 1280, radius: 24 });
      this.host.toast('ok', `Added ${f.name}`);
    }
    const audio = files.filter((f) => AUDIO_EXT.test(f.name));
    if (!audio.length) {
      if (!files.some((f) => VIDEO_EXT.test(f.name))) this.host.toast('err', 'Drop an audio file (mp3, wav, m4a...) or a video clip (mp4, mov, webm)');
      return;
    }
    const tracks = this.tracks();
    for (const f of audio) {
      const src = await this.upload(f);
      if (!src) return;
      const voice = /(^|[^a-z])(voice|vo|narration|narrator|voiceover)([^a-z]|$)/i.test(f.name);
      tracks.push(voice ? { src, role: 'voice', at: 0.5 } : { src, role: 'music' });
    }
    if (await this.save(tracks)) this.host.toast('ok', audio.length > 1 ? `Added ${audio.length} tracks` : `Added ${audio[0].name}`);
  }
}
