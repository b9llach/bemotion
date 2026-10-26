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
