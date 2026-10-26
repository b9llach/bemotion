import { request as httpRequest, type IncomingMessage } from 'node:http';
import { createWriteStream, type WriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';

/**
 * A small HTTP client for render workers: plain node:http (no global request or header timeouts, so a
 * long chunk can take as long as it needs), one deadline for the whole exchange, an abort signal, and
 * size limits on what comes back.
 */
export interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string | (() => Readable);
  /** Milliseconds for the whole request and response. */
  timeout: number;
  signal?: AbortSignal;
  /** Largest response body accepted, in bytes. */
  maxBytes?: number;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function send(url: string, o: CallOptions, onResponse: (res: IncomingMessage, done: (e?: Error) => void) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (e?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      if (e) {
        req.destroy();
        reject(e);
      } else resolve();
    };
    const onAbort = () => finish(new Error('aborted'));
    const timer = setTimeout(() => finish(new Error(`timed out after ${Math.round(o.timeout / 1000)}s`)), o.timeout);
    const req = httpRequest(url, { method: o.method ?? 'GET', headers: o.headers }, (res) => onResponse(res, finish));
    req.on('error', (e) => finish(e));
    if (o.signal?.aborted) return finish(new Error('aborted'));
    o.signal?.addEventListener('abort', onAbort);
    const body = o.body;
    if (typeof body === 'function') {
      const s = body();
      s.on('error', (e) => finish(e));
      s.pipe(req);
    } else req.end(body);
  });
}

async function errorOf(res: IncomingMessage): Promise<HttpError> {
  let text = '';
  for await (const c of res) {
    if (text.length < 2000) text += c;
  }
  let msg = text.slice(0, 500);
  try {
    msg = JSON.parse(text).error ?? msg;
  } catch {}
  return new HttpError(res.statusCode ?? 0, `HTTP ${res.statusCode}: ${msg}`);
}

/** A request whose answer is JSON. */
export async function callJson<T>(url: string, o: CallOptions): Promise<T> {
  let out: T | undefined;
  await send(url, o, (res, done) => {
    if ((res.statusCode ?? 0) >= 300) {
      errorOf(res).then(done, done);
      return;
    }
    const max = o.maxBytes ?? 10_000_000;
    let size = 0;
    const parts: Buffer[] = [];
    res.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) done(new Error('response too large'));
      else parts.push(c);
    });
    res.on('error', (e) => done(e));
    res.on('end', () => {
      try {
        out = JSON.parse(Buffer.concat(parts).toString('utf8')) as T;
        done();
      } catch (e) {
        done(new Error(`bad response: ${(e as Error).message}`));
      }
    });
  });
  return out as T;
}

/** A request whose answer is a file, written to `out` (through a temporary name, so a cut-off download never lands there). */
export async function callToFile(url: string, out: string, o: CallOptions): Promise<void> {
  const part = `${out}.part`;
  let file: WriteStream | null = null;
  try {
    await send(url, o, (res, done) => {
      if ((res.statusCode ?? 0) >= 300) {
        errorOf(res).then(done, done);
        return;
      }
      const max = o.maxBytes ?? 4_000_000_000;
      let size = 0;
      const f = createWriteStream(part);
      file = f;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > max) done(new Error('response too large'));
      });
      res.on('error', (e) => done(e));
      res.on('aborted', () => done(new Error('connection closed mid-transfer')));
      f.on('error', (e) => done(e));
      f.on('close', () => {
        if (!res.complete) done(new Error('connection closed mid-transfer'));
        else done();
      });
      res.pipe(f);
    });
    await rename(part, out);
  } catch (e) {
    const f = file as WriteStream | null;
    if (f && !f.closed) await new Promise<void>((r) => f.destroy().once('close', () => r()));
    await rm(part, { force: true }).catch(() => {});
    throw e;
  }
}
