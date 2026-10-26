/**
 * Review comments in the preview: type a note at the playhead ("this feels slow"), see every comment
 * on the timeline and in a list, jump to one, resolve or delete it. Saved next to the spec by the
 * server (/__bemotion/comments); `bemotion comments` and `review --comments` read them.
 */
interface Comment {
  id: string;
  t: number;
  scene: string;
  sceneTime: number;
  layer?: (string | number)[];
  layerName?: string;
  text: string;
  resolved?: boolean;
}

interface DirectorStatus {
  enabled: boolean;
  state: 'idle' | 'waiting' | 'working' | 'done' | 'failed';
  message?: string;
  until?: number;
  queued?: boolean;
  quiet: number;
}

export interface CommentsHost {
  time(): number;
  duration(): number | null;
  seek(t: number): void;
  /** The scene at a time and the time inside it. */
  where(t: number): { scene: string; sceneTime: number } | null;
  /** The selected layer, if any. */
  selection(): { path: (string | number)[]; name: string } | null;
  toast(kind: 'ok' | 'err', text: string): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

export class CommentsPanel {
  private list: Comment[] = [];
  private input = $<HTMLInputElement>('comment-text');
  private ol = $<HTMLOListElement>('comment-list');
  private marks = $<HTMLElement>('comment-marks');
  private count = $<HTMLElement>('comment-count');

  constructor(private host: CommentsHost) {
    $<HTMLFormElement>('comment-form').onsubmit = (ev) => {
      ev.preventDefault();
      void this.add(this.input.value);
    };
    this.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') this.input.blur();
    });
    void this.load();
    this.bindDirector();
  }

  // --- Auto director: the server turns new comments into a revision after a quiet period. ---

  private directorBox = $<HTMLInputElement>('director-on');
  private directorLine = $<HTMLElement>('director-status');
  private directorState: DirectorStatus | null = null;
  private directorTick: number | null = null;

  private bindDirector(): void {
    this.directorBox.onchange = () => void this.toggleDirector(this.directorBox.checked);
    void fetch('/__bemotion/director', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => s && this.showDirector(s as DirectorStatus))
      .catch(() => {});
    if (import.meta.hot) import.meta.hot.on('bemotion:director', (s: DirectorStatus) => this.showDirector(s));
  }

  private async toggleDirector(on: boolean): Promise<void> {
    try {
      const res = await fetch('/__bemotion/director', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: on }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Could not switch the director (${res.status})`);
      this.showDirector(data as DirectorStatus);
    } catch (e) {
      this.directorBox.checked = !on;
      this.host.toast('err', (e as Error).message);
    }
  }

  /** Shows the director's state; the waiting countdown ticks once a second. */
  private showDirector(s: DirectorStatus): void {
    const prev = this.directorState;
    this.directorState = s;
    this.directorBox.checked = s.enabled;
    if (this.directorTick !== null) {
      clearInterval(this.directorTick);
      this.directorTick = null;
    }
    const draw = () => {
      const line = this.directorLine;
      line.dataset.state = s.state;
      if (!s.enabled && (s.state === 'idle' || s.state === 'waiting')) return void (line.textContent = '');
      let text = '';
      if (s.state === 'waiting') text = `Waiting: revising in ${Math.max(0, Math.ceil(((s.until ?? Date.now()) - Date.now()) / 1000))}s unless more comments arrive`;
      else if (s.state === 'working') text = `Working: ${s.message ?? 'revising'}${s.queued ? '. New comments wait for the next round' : ''}`;
      else if (s.state === 'done') text = `Done: ${(s.message ?? 'revised').replace(/\.+$/, '')}. Undo (Ctrl+Z) reverts it`;
      else if (s.state === 'failed') text = `Failed: ${s.message ?? 'unknown error'}`;
      else text = 'Idle: new comments are addressed automatically';
      line.textContent = text;
    };
    draw();
    if (s.state === 'waiting') this.directorTick = window.setInterval(draw, 1000);
    // A finished run resolved comments on the server.
    if (s.state === 'done' && prev?.state !== 'done') void this.load();
  }

  /** Starts typing a comment at the playhead. */
  focus(): void {
    this.input.focus();
  }

  private async send(body: unknown): Promise<void> {
    const res = await fetch('/__bemotion/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error ?? `Saving the comment failed (${res.status})`);
    this.list = data as Comment[];
    this.render();
  }

  async load(): Promise<void> {
    try {
      const res = await fetch('/__bemotion/comments', { cache: 'no-store' });
      if (res.ok) this.list = (await res.json()) as Comment[];
    } catch {
      // No comments yet.
    }
    this.render();
  }

  private async add(text: string): Promise<void> {
    const t = this.host.time();
    const where = this.host.where(t);
    const sel = this.host.selection();
    if (!text.trim()) return;
    try {
      await this.send({ op: 'add', t, scene: where?.scene ?? '', sceneTime: where?.sceneTime ?? t, ...(sel ? { layer: sel.path, layerName: sel.name } : {}), text });
      this.input.value = '';
      this.host.toast('ok', `Comment saved at ${fmt(t)}`);
    } catch (e) {
      this.host.toast('err', (e as Error).message);
    }
  }

  /** Redraws the list and the timeline markers (call when the duration changes). */
  render(): void {
    const open = this.list.filter((c) => !c.resolved).length;
    this.count.textContent = this.list.length ? `${open} open` : '';
    this.ol.replaceChildren(
      ...this.list.map((c) => {
        const li = document.createElement('li');
        li.className = `comment-row${c.resolved ? ' resolved' : ''}`;
        const done = document.createElement('input');
        done.type = 'checkbox';
        done.checked = !!c.resolved;
        done.title = c.resolved ? 'Reopen' : 'Resolve';
        done.onclick = (ev) => {
          ev.stopPropagation();
          void this.send({ op: 'resolve', id: c.id, resolved: done.checked }).catch((e) => this.host.toast('err', String(e.message)));
        };
        const time = document.createElement('span');
        time.className = 'comment-time';
        time.textContent = fmt(c.t);
        const body = document.createElement('span');
        body.className = 'comment-text';
        body.textContent = c.text;
        body.title = `${c.scene} at ${c.sceneTime.toFixed(2)}s${c.layerName ? `, on ${c.layerName}` : ''}`;
        const del = document.createElement('button');
        del.className = 'mini-btn icon danger';
        del.title = 'Delete comment';
        del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>';
        del.onclick = (ev) => {
          ev.stopPropagation();
          void this.send({ op: 'delete', id: c.id }).catch((e) => this.host.toast('err', String(e.message)));
        };
        li.append(done, time, body, del);
        li.onclick = () => this.host.seek(c.t);
        return li;
      }),
    );
    const d = this.host.duration();
    this.marks.replaceChildren(
      ...(d
        ? this.list
            .filter((c) => !c.resolved)
            .map((c) => {
              const m = document.createElement('button');
              m.className = 'comment-mark';
              m.style.left = `${Math.min(100, (c.t / d) * 100)}%`;
              m.title = `${fmt(c.t)}  ${c.text}`;
              m.onclick = (ev) => {
                ev.stopPropagation();
                this.host.seek(c.t);
              };
              return m;
            })
        : []),
    );
  }
}
