import type { Video } from '../spec/schema';
import type { BundleFile } from './bundle';
import type { ChunkSettings } from './chunks';
import { log } from './log';
import { RemoteWorker, parseRemotes, type FrameInfo } from './remote';
import { buildInfo } from './version';

/**
 * Chunks handed out to whoever is free: local render pages and render workers on other machines.
 * A chunk that fails on a remote worker goes back in the queue for the local pages, which keep waiting
 * while remote chunks are in flight so nothing is left behind.
 */
export class ChunkQueue {
  private next = 0;
  private retry: number[] = [];
  private remoteInFlight = 0;
  private waiters: (() => void)[] = [];

  constructor(private count: number) {}

  /** The next chunk for a local page, or null when every chunk is done. */
  async takeLocal(): Promise<number | null> {
    for (;;) {
      if (this.retry.length) return this.retry.shift()!;
      if (this.next < this.count) return this.next++;
      if (this.remoteInFlight === 0) return null;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  /** The next fresh chunk for a remote worker (re-queued ones stay local), or null. */
  takeRemote(): number | null {
    if (this.next >= this.count) return null;
    this.remoteInFlight++;
    return this.next++;
  }

  remoteDone(k: number, ok: boolean): void {
    this.remoteInFlight--;
    if (!ok) this.retry.push(k);
    for (const w of this.waiters.splice(0)) w();
  }
}

export interface HostStats {
  label: string;
  workers: number;
  frames: number;
  chunks: number;
  failed: number;
}

/** Connects to the workers that answer, comparing their version with this one (`strict` refuses a mismatch). */
export async function connectRemotes(list: string[], token: string | undefined, strict: boolean): Promise<RemoteWorker[]> {
  if (!token) throw new Error('--remote needs the workers\' token: pass --token or set BEMOTION_WORKER_TOKEN');
  const mine = await buildInfo();
  const hosts = list.flatMap((s) => parseRemotes(s));
  const out: RemoteWorker[] = [];
  await Promise.all(
    hosts.map(async (h) => {
      const r = new RemoteWorker(h.label, h.url, token);
      let info;
      try {
        info = await r.connect();
      } catch (e) {
        log.warn(`Remote ${h.label} is not available (${(e as Error).message}); rendering without it`);
        return;
      }
      if (info.version !== mine.version || info.commit !== mine.commit || info.commit === 'unknown') {
        const msg = `Remote ${h.label} runs Bemotion ${info.version} (${info.commit}), this machine ${mine.version} (${mine.commit})`;
        if (strict) throw new Error(`${msg}. Refusing with --strict: install the same version on every machine.`);
        log.warn(`${msg}. Frames may differ; use --strict to refuse.`);
      }
      log.info(`Remote ${h.label}: ${info.workers} workers${info.encoder ? `, ${info.encoder}` : ''}`);
      out.push(r);
    }),
  );
  return out;
}

export interface RemoteRun {
  /** Resolves when the worker has nothing more to do (or has failed). */
  done: Promise<void>;
  stats: HostStats;
}

/**
 * Starts the job on a worker (files first, only those it lacks), then keeps as many chunks in flight
 * there as it has workers. Any failure retires the worker for this render and re-queues its chunks.
 */
export function runRemote(
  r: RemoteWorker,
  o: {
    bundle: Promise<BundleFile[]>;
    video: Video;
    settings: ChunkSettings;
    format?: string;
    height?: number;
    gpu: boolean;
    info: FrameInfo;
    queue: ChunkQueue;
    ranges: [number, number][];
    chunkFile: (k: number) => string;
    chunkTimeout: (frames: number) => number;
    onFrames: (n: number) => void;
    finished: () => boolean;
  },
): RemoteRun {
  const stats: HostStats = { label: r.label, workers: r.info.workers, frames: 0, chunks: 0, failed: 0 };
  const done = (async () => {
    try {
      const files = await o.bundle;
      const t = Date.now();
      const started = await r.start(o.video, files, o.settings, { format: o.format, height: o.height, gpu: o.gpu });
      const ri = started.info;
      if (ri.width !== o.info.width || ri.height !== o.info.height || ri.fps !== o.info.fps || ri.frameCount !== o.info.frameCount) {
        throw new Error(`it loaded the video as ${ri.width}x${ri.height} @ ${ri.fps}fps, ${ri.frameCount} frames (here: ${o.info.width}x${o.info.height} @ ${o.info.fps}fps, ${o.info.frameCount} frames)`);
      }
      log.info(`Remote ${r.label} ready in ${((Date.now() - t) / 1000).toFixed(1)}s (sent ${started.sent} of ${files.length} files, ${(started.bytes / 1e6).toFixed(1)} MB)`);
    } catch (e) {
      if (!o.finished()) log.warn(`Remote ${r.label} could not start the job (${(e as Error).message}); rendering without it`);
      r.kill();
      return;
    }
    await Promise.all(
      Array.from({ length: r.info.workers }, async () => {
        while (!r.dead) {
          const k = o.queue.takeRemote();
          if (k === null) return;
          const [a, b] = o.ranges[k];
          try {
            await r.renderChunk(a, b, o.chunkFile(k), o.chunkTimeout(b - a));
            stats.frames += b - a;
            stats.chunks++;
            o.onFrames(b - a);
            o.queue.remoteDone(k, true);
          } catch (e) {
            stats.failed++;
            if (!r.dead) log.warn(`Remote ${r.label} failed on frames ${a}-${b - 1} (${(e as Error).message}); its chunks are rendered here instead`);
            r.kill();
            o.queue.remoteDone(k, false);
            return;
          }
        }
      }),
    );
  })();
  return { done, stats };
}

/** One line per machine: frames, chunks and frames per second over the render. */
export function printThroughput(all: HostStats[], seconds: number): void {
  log.step('Throughput');
  const w = Math.max(...all.map((s) => s.label.length));
  for (const s of all) {
    const fps = s.frames / Math.max(0.001, seconds);
    const failed = s.failed ? `, ${s.failed} failed (re-rendered locally)` : '';
    log.info(`${s.label.padEnd(w)}  ${String(s.workers).padStart(2)} workers  ${String(s.frames).padStart(5)} frames in ${s.chunks} chunks  ${fps.toFixed(1).padStart(6)} fps${failed}`);
  }
}
