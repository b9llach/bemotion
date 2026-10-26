import { readFile } from 'node:fs/promises';
import { log } from './log';
import type { BackendChoice, GenerateOptions } from './generate';

/**
 * Auto director: comments left in the preview become edits without running `review --comments` by
 * hand. Each new comment restarts a quiet period; when it passes, the open comments go to the review
 * (one round). Runs never overlap: comments left during a run wait for the next one. The spec as it
 * was before a run goes into the editor's undo history, so one undo in the preview reverts it.
 */

export type DirectorState = 'idle' | 'waiting' | 'working' | 'done' | 'failed';

export interface DirectorStatus {
  enabled: boolean;
  state: DirectorState;
  /** What is happening, the summary of a finished run, or the error of a failed one. */
  message?: string;
  /** While waiting: when the run starts (epoch ms). */
  until?: number;
  /** Comments arrived during a run and wait for the next one. */
  queued?: boolean;
  /** Quiet period in seconds. */
  quiet: number;
}

export interface DirectorRun {
  /** One line for the preview. */
  summary: string;
}

export interface DirectorOptions {
  enabled?: boolean;
  /** Quiet period after the last comment before a run, ms (default 20000). */
  quietMs?: number;
  backend?: BackendChoice;
  model?: string;
  effort?: GenerateOptions['effort'];
  /** The revision itself (default: the review with comments, one round). */
  run?: (specPath: string) => Promise<DirectorRun>;
  /** Puts the spec text from before a run into the undo history. */
  record?: (before: string) => Promise<void>;
  /** Called on every status change. */
  onStatus?: (s: DirectorStatus) => void;
}

async function openComments(specPath: string): Promise<number> {
  const { readComments } = await import('./comments');
  return (await readComments(specPath)).filter((c) => !c.resolved).length;
}

export class Director {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private queued = false;
  private st: DirectorStatus;
  private quiet: number;

  constructor(private specPath: string, private o: DirectorOptions = {}) {
    this.quiet = Math.max(0, o.quietMs ?? 20000);
    this.st = { enabled: !!o.enabled, state: 'idle', quiet: this.quiet / 1000 };
  }

  status(): DirectorStatus {
    return { ...this.st };
  }

  /** Whether a run is in progress (for tests and shutdown). */
  get busy(): boolean {
    return this.running;
  }

  /** Turns the director on or off. Turning it on picks up comments that are already open. */
  async setEnabled(on: boolean): Promise<void> {
    if (on === this.st.enabled) return;
    this.st.enabled = on;
    if (!on) {
      this.clearTimer();
      this.queued = false;
      if (this.st.state === 'waiting') this.set({ state: 'idle', message: undefined });
      else this.emit();
      return;
    }
    this.emit();
    if (!this.running && (await openComments(this.specPath)) > 0) this.schedule();
  }

  /** A comment was saved: (re)start the quiet period, or queue it behind the current run. */
  notify(): void {
    if (!this.st.enabled) return;
    if (this.running) {
      this.queued = true;
      this.set({ queued: true });
      return;
    }
    this.schedule();
  }

  close(): void {
    this.clearTimer();
  }

  private schedule(): void {
    this.clearTimer();
    const until = Date.now() + this.quiet;
    this.set({ state: 'waiting', until, message: `Revising in ${Math.round(this.quiet / 1000)}s unless more comments arrive` });
    this.timer = setTimeout(() => void this.start(), this.quiet);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async start(): Promise<void> {
    this.timer = null;
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = true;
    try {
      const open = await openComments(this.specPath);
      if (!open) {
        this.set({ state: 'idle', message: 'No open comments', until: undefined });
        return;
      }
      this.queued = false;
      this.set({ state: 'working', until: undefined, queued: false, message: `Addressing ${open} comment${open === 1 ? '' : 's'}` });
      log.step(`Director: addressing ${open} comment${open === 1 ? '' : 's'}`);
      const before = await readFile(this.specPath, 'utf8');
      try {
        const r = await (this.o.run ?? ((p) => this.review(p)))(this.specPath);
        const after = await readFile(this.specPath, 'utf8');
        if (after !== before && this.o.record) await this.o.record(before);
        this.set({ state: 'done', message: r.summary });
        log.success(`Director: ${r.summary}`);
      } catch (e) {
        const msg = String((e as Error).message ?? e).split('\n')[0].slice(0, 300);
        this.set({ state: 'failed', message: msg });
        log.error(`Director: ${msg}`);
      }
    } finally {
      this.running = false;
    }
    if (this.queued && this.st.enabled) {
      this.queued = false;
      this.schedule();
    }
  }

  private async review(specPath: string): Promise<DirectorRun> {
    const { review } = await import('./generate');
    const r = await review(specPath, { comments: true, rounds: 1, backend: this.o.backend ?? 'claude-code', model: this.o.model, effort: this.o.effort });
    if (!r.revised) return { summary: r.notes && !/^APPROVED$/i.test(r.notes) ? `No changes: ${r.notes}` : 'Reviewed; no changes needed' };
    const left = r.findings.length ? `, ${r.findings.length} measured problem${r.findings.length === 1 ? '' : 's'} left` : '';
    return { summary: `Revised for ${r.resolved} comment${r.resolved === 1 ? '' : 's'}${left}${r.notes ? `. ${r.notes}` : ''}` };
  }

  private set(p: Partial<DirectorStatus>): void {
    Object.assign(this.st, p);
    for (const k of Object.keys(p) as (keyof DirectorStatus)[]) if (p[k] === undefined) delete this.st[k];
    this.emit();
  }

  private emit(): void {
    this.o.onStatus?.(this.status());
  }
}
