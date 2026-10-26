import * as THREE from 'three';
import type { VideoLayer as VideoSpec } from '../../spec/schema';
import { Layer, type SceneRuntime } from './base';
import { SdfMesh } from './sdf';
import { shadowParams } from './shape';

/**
 * A video clip, drawn like an image (fit, radius, shadow, stroke). Renders are exact: every frame
 * seeks the clip to the matching source frame and waits for it to decode. The preview plays the clip
 * normally while the timeline plays, and seeks exactly when scrubbing or paused.
 *
 * Clips next to the spec load through the server's seek-friendly copy (/__bemotion/video), which has
 * a keyframe every 10 frames at the video's frame rate, so seeks are fast and land on whole frames.
 */
export class VideoLayer extends Layer<VideoSpec> {
  readonly mesh = new SdfMesh();
  private video!: HTMLVideoElement;
  private tex!: THREE.CanvasTexture;
  /** Frames are copied here before upload: it captures exactly the frame that was seeked to. */
  private canvas!: HTMLCanvasElement;
  private g2d!: CanvasRenderingContext2D;
  private w = 640;
  private h = 360;
  private trim = 0;
  private speed = 1;
  private lastT = -1;
  private shown = -1;
  private seeking: Promise<void> | null = null;
  /** Focus path: keys of view center (0-1, from the top-left) and zoom, in scene time. */
  private focusKeys: { t: number; x: number; y: number; z: number }[] = [];
  /** The part of the clip on screen: center and zoom. */
  private win = { x: 0.5, y: 0.5, z: 1 };
  /** Where things happen in the clip, in scene time (for the drawn cursor). */
  private activity: { at: number; x: number; y: number }[] = [];
  private grabbedWin = '';

  constructor(spec: VideoSpec, rt: SceneRuntime) {
    super(spec, rt);
  }

  size() {
    return { w: this.w, h: this.h };
  }

  /** The clip's path relative to the spec when it is served by the local server, else null. */
  private localPath(): { origin: string; rel: string } | null {
    const direct = new URL(this.ctx.asset(this.spec.src), location.href);
    const local = '/__bemotion/assets/';
    if (direct.origin !== location.origin || !direct.pathname.startsWith(local)) return null;
    return { origin: direct.origin, rel: decodeURIComponent(direct.pathname.slice(local.length)) };
  }

  /** Where the clip loads from: the server's seek-friendly copy for local files. */
  private url(): string {
    const l = this.localPath();
    if (!l) return new URL(this.ctx.asset(this.spec.src), location.href).href;
    return `${l.origin}/__bemotion/video?src=${encodeURIComponent(l.rel)}&fps=${this.ctx.fps}`;
  }

  /** Focus moves in scene time: the spec's own, or found in the clip by the server for "auto". */
  private async loadFocus(): Promise<void> {
    const f = this.spec.focus;
    if (!f) return;
    type Move = { at: number; until?: number; x: number; y: number; zoom: number; duration: number };
    let moves: Move[];
    if (f === 'auto') {
      const l = this.localPath();
      if (!l) return;
      const res = await fetch(`${l.origin}/__bemotion/video-focus?src=${encodeURIComponent(l.rel)}`);
      if (!res.ok) throw new Error(`Could not analyze video "${this.spec.src}" for focus: ${await res.text()}`);
      const found = (await res.json()) as { at: number; until: number; x: number; y: number; zoom: number }[];
      // Clip seconds to scene time.
      const toScene = (ct: number) => this.start + (ct - this.trim) / this.speed;
      moves = found
        .map((m) => ({ at: toScene(m.at), until: toScene(m.until), x: m.x, y: m.y, zoom: m.zoom, duration: 0.8 }))
        .filter((m) => m.until > this.start);
      this.activity = moves.map((m) => ({ at: m.at, x: m.x, y: m.y }));
    } else {
      this.activity = f.map((m) => ({ at: this.ctx.time(m.at), x: m.x, y: m.y }));
      moves = f.map((m) => ({
        at: this.ctx.time(m.at),
        until: m.until === undefined ? undefined : this.ctx.time(m.until),
        x: m.x,
        y: m.y,
        zoom: m.zoom ?? 2,
        duration: this.ctx.time(m.duration, 0.8),
      }));
    }
    moves.sort((a, b) => a.at - b.at);
    const base = { x: 0.5, y: 0.5, z: 1 };
    const keys: { t: number; x: number; y: number; z: number }[] = [{ t: -1e9, ...base }];
    let cur = base;
    moves.forEach((m, i) => {
      const next = moves[i + 1];
      const d = Math.max(0.1, m.duration);
      const at = Math.max(m.at, keys[keys.length - 1].t);
      let end = Math.max(at + d, m.until ?? at + d + 2);
      if (next) end = Math.max(at + d, Math.min(end, next.at));
      const state = { x: m.x, y: m.y, z: Math.max(1, m.zoom) };
      keys.push({ t: at, ...cur }, { t: at + d, ...state }, { t: end, ...state });
      cur = state;
      // Pull back out unless the next move starts soon, in which case the view pans straight there.
      if (!next || next.at > end + d * 0.6) {
        keys.push({ t: end + d, ...base });
        cur = base;
      }
    });
    this.focusKeys = keys;
  }

  /** Where things happen, for a cursor without focus moves: the same analysis as focus "auto". */
  private async findActivity(): Promise<void> {
    const l = this.localPath();
    if (!l) return;
    const res = await fetch(`${l.origin}/__bemotion/video-focus?src=${encodeURIComponent(l.rel)}`);
    if (!res.ok) throw new Error(`Could not analyze video "${this.spec.src}" for the cursor: ${await res.text()}`);
    const found = (await res.json()) as { at: number; x: number; y: number }[];
    this.activity = found.map((m) => ({ at: this.start + (m.at - this.trim) / this.speed, x: m.x, y: m.y })).filter((m) => m.at >= this.start);
  }

  /**
   * A cursor drawn over the clip: it glides to each place where something happens, arriving just before
   * and clicking as it starts, then rests. Its path is sampled every frame through the focus view, so it
   * stays on the same pixel of the recording while the view zooms and pans.
   */
  private async addCursor(): Promise<void> {
    const s = this.spec;
    if (!this.activity.length && s.focus !== 'auto' && !Array.isArray(s.focus)) await this.findActivity();
    // One stop per action: activity close to the last stop soon after it (typing into the same field,
    // a panel filling in) keeps the cursor still, as a person's mouse rests while they type.
    const acts: { at: number; x: number; y: number }[] = [];
    for (const a of this.activity.filter((a) => a.at > this.start + 0.3 && a.at < this.end - 0.2)) {
      const last = acts[acts.length - 1];
      if (last && Math.hypot(a.x - last.x, (a.y - last.y) * 0.6) < 0.16 && a.at - last.at < 4) continue;
      acts.push(a);
    }
    if (!acts.length) return;
    const glide = 0.7;
    // The cursor's own path in clip coordinates (0-1): rest, glide, click, rest.
    const keys: { t: number; x: number; y: number }[] = [{ t: this.start, x: 0.62, y: 0.7 }];
    for (const a of acts) {
      const arrive = a.at - 0.15;
      const prev = keys[keys.length - 1];
      const leave = Math.max(prev.t, arrive - glide);
      keys.push({ t: leave, x: prev.x, y: prev.y }, { t: arrive, x: a.x, y: a.y });
    }
    const at = (t: number) => {
      let i = keys.length - 1;
      while (i > 0 && keys[i].t > t) i--;
      const a = keys[i];
      const b = keys[i + 1];
      if (!b || b.t <= a.t) return a;
      const u = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
    };
    // Through the view: the focus window is clamped inside the frame the same way grab() clamps it.
    const toLocal = (t: number) => {
      const p = at(t);
      const w = this.focusAt(t);
      const half = 0.5 / w.z;
      const x0 = Math.min(1 - 2 * half, Math.max(0, w.x - half));
      const y0 = Math.min(1 - 2 * half, Math.max(0, w.y - half));
      const u = Math.min(1, Math.max(0, (p.x - x0) * w.z));
      const v = Math.min(1, Math.max(0, (p.y - y0) * w.z));
      return { x: (u - 0.5) * this.w, y: (0.5 - v) * this.h };
    };
    const fps = this.ctx.fps;
    const path: { t: number; x: number; y: number; ease: string }[] = [];
    for (let f = Math.ceil(this.start * fps); f <= Math.floor(this.end * fps); f++) {
      const t = f / fps;
      path.push({ t, ...toLocal(t), ease: 'linear' });
    }
    const c = typeof s.cursor === 'object' ? s.cursor : {};
    const spec = {
      type: 'cursor', style: c.style ?? 'hand', ...(c.size ? { size: c.size } : {}), ...(c.color ? { color: c.color } : {}),
      z: 2, start: this.start, end: this.end, path, clicks: acts.map((a) => a.at - 0.05),
      in: { preset: 'fade', duration: 0.3 },
    };
    const { buildLayers } = await import('./index');
    const [cursor] = await buildLayers([spec as never], this.rt);
    this.addChild(cursor);
  }

  /** View center and zoom at scene time t (eased between keys; zoom eases geometrically). */
  private focusAt(t: number): { x: number; y: number; z: number } {
    const k = this.focusKeys;
    if (k.length < 2) return { x: 0.5, y: 0.5, z: 1 };
    let i = k.length - 1;
    while (i > 0 && k[i].t > t) i--;
    const a = k[i];
    const b = k[i + 1];
    if (!b) return { x: a.x, y: a.y, z: a.z };
    const u = Math.min(1, Math.max(0, (t - a.t) / Math.max(1e-6, b.t - a.t)));
    const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
    return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, z: a.z * Math.pow(b.z / a.z, e) };
  }

  async load(): Promise<void> {
    const s = this.spec;
    this.trim = this.ctx.time(s.trim, 0);
    this.speed = s.speed ?? 1;
    const v = document.createElement('video');
    v.muted = true; // the render mixes the clip's sound from the original file
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    v.src = this.url();
    await new Promise<void>((resolve, reject) => {
      v.addEventListener('loadeddata', () => resolve(), { once: true });
      v.addEventListener('error', () => reject(new Error(`Could not load video "${s.src}"`)), { once: true });
    });
    this.video = v;
    const aspect = v.videoWidth / v.videoHeight || 16 / 9;
    this.w = s.width ?? (s.height ? s.height * aspect : v.videoWidth);
    this.h = s.height ?? this.w / aspect;
    const k = Math.min(1, 1920 / Math.max(1, v.videoWidth));
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.max(1, Math.round(v.videoWidth * k));
    this.canvas.height = Math.max(1, Math.round(v.videoHeight * k));
    this.g2d = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = false;
    this.setupMaterial(this.mesh, this.mesh.material);
    this.mesh.setParams({ width: this.w, height: this.h, fillA: { r: 1, g: 1, b: 1, a: 1 } });
    this.mesh.setMap(this.tex, s.fit ?? 'cover');
    this.pivot.add(this.mesh);
    await this.loadFocus();
    if (s.cursor) await this.addCursor();
    this.win = this.focusAt(this.start);
    await this.seek(this.clipTime(this.start));
  }

  /** The clip time for scene time `t`, snapped to the middle of a source frame. */
  private clipTime(t: number): number {
    const fps = this.ctx.fps;
    const dur = this.video.duration || 0;
    let ct = this.trim + Math.max(0, t - this.start) * this.speed;
    if (this.spec.repeat && dur > this.trim) ct = this.trim + ((ct - this.trim) % (dur - this.trim));
    const frame = Math.floor(ct * fps + 1e-6);
    const last = Math.max(0, Math.floor(dur * fps) - 1);
    return (Math.min(frame, last) + 0.5) / fps;
  }

  private seek(time: number): Promise<void> {
    const v = this.video;
    if (Math.abs(this.shown - time) < 1e-6 && !v.seeking) return Promise.resolve();
    this.shown = time;
    this.seeking = new Promise<void>((resolve) => {
      const done = () => {
        this.grab();
        resolve();
      };
      v.addEventListener('seeked', done, { once: true });
      v.currentTime = time;
    });
    return this.seeking;
  }

  /** Copies the part of the video's current frame in view (all of it unless focused) into the texture. */
  private grab(): void {
    const v = this.video;
    if (v.readyState < 2) return;
    const { x, y, z } = this.win;
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const sw = vw / z;
    const sh = vh / z;
    // Keep the window inside the frame.
    const sx = Math.min(vw - sw, Math.max(0, x * vw - sw / 2));
    const sy = Math.min(vh - sh, Math.max(0, y * vh - sh / 2));
    this.g2d.drawImage(v, sx, sy, sw, sh, 0, 0, this.canvas.width, this.canvas.height);
    this.grabbedWin = `${x}|${y}|${z}`;
    this.tex.needsUpdate = true;
  }

  update(t: number, parentOpacity: number, parentBlur = 0): void {
    super.update(t, parentOpacity, parentBlur);
    // Off screen in the preview: stop playing so it does not run ahead.
    if (!this.root.visible && this.video && !this.video.paused) this.video.pause();
  }

  protected updateContent(t: number, opacity: number, blur = 0): void {
    const s = this.spec;
    // Footage carries its own motion blur: every motion blur sample of a frame shows the clip's frame at the
    // frame's own time. (Sampling around it would seek back and forth between two source frames.)
    const target = this.clipTime(this.rt.frameTime ?? t);
    this.win = this.focusAt(t);
    const dt = t - this.lastT;
    this.lastT = t;
    const v = this.video;
    if (this.ctx.preview && dt > 0 && dt < 0.2) {
      // Timeline playing: let the clip play and only correct real drift.
      v.playbackRate = this.speed;
      if (v.paused) void v.play().catch(() => {});
      if (Math.abs(v.currentTime - target) > 0.25) v.currentTime = target;
      this.grab();
      this.shown = -1;
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(this.shown - target) > 1e-6) this.rt.waitFor(this.seek(target));
      // Same frame, new view (zooming during a held frame, or motion blur samples): copy it again.
      else if (!v.seeking && this.grabbedWin !== `${this.win.x}|${this.win.y}|${this.win.z}`) this.grab();
    }
    this.mesh.setParams({
      blur: blur * 0.35,
      width: this.w,
      height: this.h,
      radius: this.num('radius', t, s.radius ?? 0),
      fillA: { r: 1, g: 1, b: 1, a: 1 },
      stroke: s.stroke ? this.ctx.color(s.stroke) : undefined,
      strokeWidth: s.strokeWidth ?? (s.stroke ? 1.5 : 0),
      shadow: shadowParams(s.shadow, this.ctx),
    });
    this.mesh.setMapBlur(blur);
    this.mesh.setOpacity(opacity);
  }

  /** Where this clip sits in its scene, for mixing its sound into the render. */
  soundInfo(): { src: string; start: number; end: number; trim: number; speed: number; volume: number; repeat: boolean } {
    return { src: this.spec.src, start: this.start, end: this.end, trim: this.trim, speed: this.speed, volume: this.spec.volume ?? 0, repeat: !!this.spec.repeat };
  }

  dispose(): void {
    super.dispose();
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    }
    this.tex?.dispose();
  }
}
