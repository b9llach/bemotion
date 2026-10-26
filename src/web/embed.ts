import { Engine, type PreparedData } from '../engine/engine';

/**
 * <bemotion-player>: plays an exported video live in a page (see `bemotion export web`).
 *
 *   <script type="module" src="bemotion-player.js"></script>
 *   <bemotion-player src="spec.json" mode="loop" poster="poster.png"></bemotion-player>
 *
 * Attributes:
 *   src            the exported spec.json (assets resolve next to it)
 *   mode           loop (default), play (once, then holds the last frame) or scroll (the playhead
 *                  follows scrolling, smoothed)
 *   poster         image shown until the first frame is drawn, and instead of motion for visitors who
 *                  prefer reduced motion
 *   sound          soundtrack file; adds a mute toggle (starts muted). Not used in scroll mode.
 *   scroll-target  scroll mode: "page" (default), "parent" (the parent section scrolling through the
 *                  window, e.g. around a sticky player) or a CSS selector (a scrolling container, or a
 *                  section like "parent")
 *   format         another aspect ratio: 9:16, 1:1, 4:5
 *   transparent    render with a transparent background (implied by a "transparent" spec background)
 *
 * Rendering follows the element's size at up to 2 device pixels per CSS pixel, without motion blur,
 * and pauses while the element is off screen or the tab is hidden.
 */

type Mode = 'loop' | 'play' | 'scroll';

const STYLE = `
:host { display: block; position: relative; width: 100%; }
:host([hidden]) { display: none; }
.frame { position: relative; width: 100%; aspect-ratio: var(--bm-aspect, 16 / 9); overflow: hidden; }
canvas, img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
img { object-fit: cover; }
img[hidden] { display: none; }
canvas { opacity: 0; transition: opacity 0.25s ease; }
canvas.on { opacity: 1; }
button { position: absolute; right: 12px; bottom: 12px; width: 36px; height: 36px; padding: 0; border: 0; border-radius: 18px;
  background: rgba(0, 0, 0, 0.55); color: #fff; display: grid; place-items: center; cursor: pointer; }
button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
button svg { width: 18px; height: 18px; }
`;

const ICON_MUTED = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m23 9-6 6"/><path d="m17 9 6 6"/></svg>';
const ICON_SOUND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>';

export class BemotionPlayer extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['src', 'mode', 'poster', 'sound', 'format', 'transparent'];
  }

  private frameEl: HTMLDivElement;
  private canvas: HTMLCanvasElement | null = null;
  private img: HTMLImageElement;
  private button: HTMLButtonElement | null = null;
  private audio: HTMLAudioElement | null = null;
  private engine: Engine | null = null;
  /** Bumped on every (re)load, so a stale load never takes over. */
  private generation = 0;
  private clock = 0;
  private smooth = 0;
  private lastTick = 0;
  private visible = false;
  private rendering = false;
  private shownFrame = -1;
  private shownTime = 0;
  private dirty = true;
  private raf = 0;
  private wantScale = 0;
  private io: IntersectionObserver | null = null;
  private ro: ResizeObserver | null = null;
  private resolveReady!: () => void;
  /** Resolves when the first frame is on screen. */
  ready: Promise<void>;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    this.frameEl = document.createElement('div');
    this.frameEl.className = 'frame';
    this.frameEl.setAttribute('part', 'frame');
    this.img = document.createElement('img');
    this.img.alt = '';
    this.img.hidden = true;
    this.frameEl.append(this.img);
    root.append(style, this.frameEl);
    this.ready = new Promise((r) => (this.resolveReady = r));
  }

  /** Output seconds of the frame on screen. */
  get currentTime(): number {
    return this.shownTime;
  }

  get duration(): number {
    return this.engine?.duration ?? 0;
  }

  get mode(): Mode {
    const m = this.getAttribute('mode');
    return m === 'play' || m === 'scroll' ? m : 'loop';
  }

  connectedCallback(): void {
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) this.visible = e.isIntersecting;
    });
    this.io.observe(this);
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(this.frameEl);
    void this.load();
  }

  disconnectedCallback(): void {
    this.generation++;
    cancelAnimationFrame(this.raf);
    this.io?.disconnect();
    this.ro?.disconnect();
    this.audio?.pause();
    this.engine?.dispose();
    this.engine = null;
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    if (old === value || !this.isConnected) return;
    if (name === 'mode') {
      this.clock = 0;
      this.dirty = true;
    } else if (name === 'poster') this.showPoster();
    else void this.load();
  }

  private reducedMotion(): boolean {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  private showPoster(): void {
    const poster = this.getAttribute('poster');
    if (poster) this.img.src = new URL(poster, document.baseURI).href;
    this.img.hidden = !poster || !!this.canvas?.classList.contains('on');
  }

  private async load(): Promise<void> {
    const gen = ++this.generation;
    cancelAnimationFrame(this.raf);
    this.engine?.dispose();
    this.engine = null;
    this.canvas?.remove();
    this.canvas = null;
    this.shownFrame = -1;
    this.clock = 0;
    this.showPoster();
    const src = this.getAttribute('src');
    if (!src) return;
    // Visitors who prefer reduced motion see the poster; without one, the last frame.
    const reduced = this.reducedMotion();
    if (reduced && this.getAttribute('poster')) {
      this.resolveReady();
      return;
    }
    try {
      const specUrl = new URL(src, document.baseURI);
      const res = await fetch(specUrl.href);
      if (!res.ok) throw new Error(`could not load ${specUrl.href} (${res.status})`);
      const spec = (await res.json()) as Record<string, unknown>;
      const prepared = spec.$prepared as PreparedData | undefined;
      delete spec.$prepared;
      if (gen !== this.generation) return;
      const bg = typeof spec.background === 'string' ? spec.background.trim().toLowerCase() : '';
      const alpha = this.hasAttribute('transparent') || bg === 'transparent' || bg === 'none';
      const canvas = document.createElement('canvas');
      canvas.setAttribute('part', 'canvas');
      this.frameEl.append(canvas);
      const engine = await Engine.create(canvas, spec, {
        baseUrl: new URL('.', specUrl).href,
        preview: true,
        format: this.getAttribute('format') || undefined,
        alpha,
        prepared,
      });
      if (gen !== this.generation) {
        engine.dispose();
        canvas.remove();
        return;
      }
      this.engine = engine;
      this.canvas = canvas;
      this.style.setProperty('--bm-aspect', `${engine.pixelWidth} / ${engine.pixelHeight}`);
      this.setupSound();
      this.fit();
      if (reduced) {
        this.applyScale();
        await this.draw(this.endTime());
        return;
      }
      this.lastTick = performance.now();
      const tick = (now: number) => {
        if (gen !== this.generation) return;
        this.raf = requestAnimationFrame(tick);
        this.tick(now);
      };
      this.raf = requestAnimationFrame(tick);
    } catch (e) {
      console.error(`bemotion-player: ${(e as Error).message}`);
      this.dispatchEvent(new CustomEvent('error', { detail: e }));
    }
  }

  /** The last frame's time. */
  private endTime(): number {
    const e = this.engine!;
    return Math.max(0, (e.frameCount - 1) / e.fps);
  }

  /** Render size: the element's width at up to 2 device pixels per CSS pixel, never above the video's own. */
  private fit(): void {
    const e = this.engine;
    if (!e) return;
    const css = this.frameEl.clientWidth || e.pixelWidth;
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const px = Math.max(64, Math.min(e.pixelWidth, Math.round(css * dpr)));
    const scale = px / e.pixelWidth;
    if (Math.abs(scale - this.wantScale) > 0.01) {
      this.wantScale = scale;
      this.dirty = true;
    }
  }

  private appliedScale = 0;
  private applyScale(): void {
    if (this.engine && this.wantScale && this.wantScale !== this.appliedScale) {
      this.engine.setScale(this.wantScale);
      this.appliedScale = this.wantScale;
    }
  }

  private setupSound(): void {
    this.button?.remove();
    this.button = null;
    this.audio?.pause();
    this.audio = null;
    const sound = this.getAttribute('sound');
    if (!sound || this.mode === 'scroll') return;
    const audio = new Audio(new URL(sound, document.baseURI).href);
    audio.preload = 'auto';
    audio.muted = true;
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('part', 'sound');
    const label = () => {
      button.innerHTML = audio.muted ? ICON_MUTED : ICON_SOUND;
      button.setAttribute('aria-label', audio.muted ? 'Turn sound on' : 'Turn sound off');
    };
    button.addEventListener('click', () => {
      audio.muted = !audio.muted;
      label();
      if (!audio.muted) {
        audio.currentTime = this.shownTime;
        void audio.play().catch(() => {});
      } else audio.pause();
    });
    label();
    this.frameEl.append(button);
    this.button = button;
    this.audio = audio;
  }

  /** Where the playhead should be in scroll mode, 0-1. */
  private scrollProgress(): number {
    const target = this.getAttribute('scroll-target') ?? 'page';
    const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
    const section = (el: Element) => {
      // Progress of a section scrolling through the window: 0 when its top reaches the top of the
      // window, 1 when its bottom reaches the bottom (a sticky player inside it stays in view).
      const r = el.getBoundingClientRect();
      const range = r.height - window.innerHeight;
      return range > 0 ? clamp(-r.top / range) : clamp((window.innerHeight - r.top) / (window.innerHeight + r.height));
    };
    if (target === 'page') {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      return max > 0 ? clamp(window.scrollY / max) : 0;
    }
    const el = target === 'parent' ? this.parentElement : document.querySelector(target);
    if (!el) return 0;
    if (target !== 'parent' && el.scrollHeight > el.clientHeight + 1) return clamp(el.scrollTop / (el.scrollHeight - el.clientHeight));
    return section(el);
  }

  private tick(now: number): void {
    const e = this.engine;
    const dt = Math.min(0.1, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;
    if (!e) return;
    if (!this.visible || document.hidden) {
      if (this.audio && !this.audio.paused) this.audio.pause();
      return;
    }
    const end = this.endTime();
    let t: number;
    const mode = this.mode;
    if (mode === 'scroll') {
      const target = this.scrollProgress() * end;
      // Ease toward the scroll position (about 120 ms to close most of the gap).
      this.smooth += (target - this.smooth) * (1 - Math.exp(-dt * 12));
      if (Math.abs(target - this.smooth) < 0.25 / e.fps) this.smooth = target;
      t = this.smooth;
    } else if (mode === 'play') {
      this.clock = Math.min(end, this.clock + dt);
      t = this.clock;
    } else {
      this.clock = (this.clock + dt) % Math.max(1 / e.fps, e.duration);
      t = this.clock;
    }
    this.syncAudio(t, mode === 'play' && t >= end);
    void this.draw(t);
  }

  private syncAudio(t: number, ended: boolean): void {
    const a = this.audio;
    if (!a || a.muted) return;
    if (ended) {
      if (!a.paused) a.pause();
      return;
    }
    if (a.paused) void a.play().catch(() => {});
    if (Math.abs(a.currentTime - t) > 0.2) a.currentTime = t;
  }

  /** Draws the frame at `t` unless it is already on screen; skips while a frame is being drawn. */
  private async draw(t: number): Promise<void> {
    const e = this.engine;
    if (!e || this.rendering) return;
    const frame = Math.min(e.frameCount - 1, Math.max(0, Math.round(t * e.fps)));
    if (frame === this.shownFrame && !this.dirty) return;
    this.rendering = true;
    try {
      this.applyScale();
      this.dirty = false;
      await e.renderFrame(frame / e.fps, { motionBlur: false });
      this.shownFrame = frame;
      this.shownTime = frame / e.fps;
      if (this.canvas && !this.canvas.classList.contains('on')) {
        this.canvas.classList.add('on');
        this.img.hidden = true;
        this.resolveReady();
        this.dispatchEvent(new Event('ready'));
      }
    } catch (err) {
      console.error(`bemotion-player: ${(err as Error).message}`);
    } finally {
      this.rendering = false;
    }
  }
}

if (!customElements.get('bemotion-player')) customElements.define('bemotion-player', BemotionPlayer);
