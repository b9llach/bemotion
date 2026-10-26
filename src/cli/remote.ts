import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { callJson, callToFile } from './http';
import type { BundleFile } from './bundle';
import type { ChunkSettings } from './chunks';
import { ffmpegPath } from './ffmpeg';
import type { BuildInfo } from './version';

/** The coordinator's side of a render worker on another machine (see worker.ts). */

export const DEFAULT_WORKER_PORT = 7420;

export interface WorkerInfo extends BuildInfo {
  name: string;
  workers: number;
  encoder: string | null;
}

export interface FrameInfo {
  width: number;
  height: number;
  fps: number;
  duration: number;
  frameCount: number;
}

/** "host:port,host:port" (port 7420 when left out; IPv6 as [addr]:port) to base URLs. */
export function parseRemotes(list: string): { label: string; url: string }[] {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(s);
      if (!m) throw new Error(`Invalid remote "${s}": expected host:port`);
      const port = m[2] ? parseInt(m[2], 10) : DEFAULT_WORKER_PORT;
      if (port < 1 || port > 65535) throw new Error(`Invalid port in "${s}"`);
      return { label: `${m[1]}:${port}`, url: `http://${m[1]}:${port}` };
    });
}

/** Frames in an H.264 file, counted from its packets (no decoding). */
export function countFrames(file: string): Promise<number> {
  return new Promise((res, rej) => {
    // One line per packet; with no B-frame reordering to worry about, packets are frames.
    const p = spawn(ffmpegPath(), ['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', '-']);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.resume();
    p.on('error', rej);
    p.on('close', (code) => {
      if (code === 0) res(out.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length);
      else rej(new Error(`could not read the chunk (ffmpeg exited with ${code})`));
    });
  });
}

export class RemoteWorker {
  info!: WorkerInfo;
  job: string | null = null;
  dead = false;
  private abort = new AbortController();

  constructor(public label: string, private url: string, private token: string) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  private json<T>(method: string, path: string, body: unknown, timeout: number): Promise<T> {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return callJson<T>(`${this.url}${path}`, {
      method,
      headers: this.headers(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}),
      body: data,
      timeout,
      signal: this.abort.signal,
    });
  }

  async connect(timeout = 10000): Promise<WorkerInfo> {
    const info = await this.json<WorkerInfo>('GET', '/v1/info', undefined, timeout);
    if (info?.name !== 'bemotion-worker' || !(Number(info.workers) >= 1)) throw new Error('not a Bemotion worker');
    this.info = { ...info, workers: Math.min(64, Math.floor(Number(info.workers))) };
    return this.info;
  }

  /** Sends the files the worker does not have yet, then starts the job. Returns what the worker loaded. */
  async start(
    spec: unknown, files: BundleFile[], settings: ChunkSettings,
    opts: { format?: string; height?: number; gpu: boolean },
  ): Promise<{ info: FrameInfo; sent: number; bytes: number }> {
    const { missing } = await this.json<{ missing: string[] }>('POST', '/v1/blobs/missing', { hashes: [...new Set(files.map((f) => f.sha256))] }, 30000);
    const need = new Set(missing);
    let sent = 0;
    let bytes = 0;
    for (const f of files) {
      if (!need.has(f.sha256)) continue;
      need.delete(f.sha256);
      await callJson(`${this.url}/v1/blobs/${f.sha256}`, {
        method: 'PUT',
        headers: this.headers({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(f.size) }),
        body: () => createReadStream(f.file),
        // A minute plus the time for the file at 1 MB/s.
        timeout: 60000 + f.size / 1000,
        signal: this.abort.signal,
      });
      sent++;
      bytes += f.size;
    }
    const r = await this.json<{ id: string; info: FrameInfo }>('POST', '/v1/jobs', {
      spec,
      files: Object.fromEntries(files.map((f) => [f.path, f.sha256])),
      settings,
      format: opts.format ?? null,
      height: opts.height ?? null,
      gpu: opts.gpu,
    }, 600000);
    this.job = r.id;
    return { info: r.info, sent, bytes };
  }

  /** Renders frames a..b-1 on the worker into `out`, and checks the frame count. */
  async renderChunk(a: number, b: number, out: string, timeout: number): Promise<void> {
    if (!this.job) throw new Error('no job');
    const body = Buffer.from(JSON.stringify({ from: a, to: b }));
    await callToFile(`${this.url}/v1/jobs/${this.job}/chunk`, out, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json', 'Content-Length': String(body.length) }),
      body,
      timeout,
      signal: this.abort.signal,
      maxBytes: 2_000_000_000,
    });
    const n = await countFrames(out);
    if (n !== b - a) throw new Error(`chunk ${a}-${b - 1} came back with ${n} frames instead of ${b - a}`);
  }

  /** Stops everything in flight with this worker (its chunks then go back to the queue). */
  kill(): void {
    this.dead = true;
    this.abort.abort();
  }

  /** Ends the job on the worker so it deletes its files. */
  async close(): Promise<void> {
    const job = this.job;
    this.job = null;
    this.abort.abort();
    if (!job) return;
    await callJson(`${this.url}/v1/jobs/${job}`, { method: 'DELETE', headers: this.headers(), timeout: 5000 }).catch(() => {});
  }
}
