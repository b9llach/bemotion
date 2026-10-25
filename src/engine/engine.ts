import * as THREE from 'three';
import { buildEnvironment, loadHdriEnvironment } from './environments';
import { validateVideo, type Video } from '../spec/schema';
import { resolveAutoText } from '../spec/autotext';
import { resolveShared } from '../spec/share';
import { applyFormat, type Framing } from '../spec/formats';
import { buildTargetWarp, buildWarp, syncMoments, toDesign, toOutput, type Warp } from '../spec/beatsync';
import { captionLayers, generated, lineTargets, type Word } from './voice';
import { toSeconds } from '../spec/time';
import { FLYING, SOLO, inkBox, lightAllChannels, screenBox, setChannel, type ScreenBox } from './share';
import { VideoLayer } from './layers/video';
import { buildMask, type MaskInfo } from './post/mask';

export interface ClipSound {
  src: string;
  /** Global start time, seconds. */
  at: number;
  /** How long the clip is on screen, seconds of timeline. */
  length: number;
  trim: number;
  speed: number;
  volume: number;
  repeat: boolean;
}
import { layoutScenes, type SceneTiming } from '../spec/time';
import { createContext, type EngineContext } from './context';
import { SceneInstance } from './scene';
import type { Layer } from './layers/base';
import { Compositor, resolvePost } from './post/compositor';
import { resolveEase } from './anim/easing';
import { hashString } from './util/random';

export interface EngineOptions {
  /** URL that relative asset paths in the spec resolve against. */
  baseUrl: string;
  /** Preview mode: motion blur off unless asked, lower render scale allowed. */
  preview?: boolean;
  /** Render scale relative to the video size (preview only). */
  scale?: number;
  /** Another aspect ratio to render the spec at: "9:16", "1:1", "4:5" (see spec/formats.ts). */
  format?: string;
  onProgress?: (msg: string) => void;
}

export interface FrameOptions {
  motionBlur?: boolean;
}

const DIRS: Record<string, [number, number]> = {
  // Shader takes the negated movement direction.
  left: [1, 0],
  right: [-1, 0],
  up: [0, -1],
  down: [0, 1],
};

export interface InspectItem {
  /** Index of the layer in its scene (depth first). */
  uid: number;
  /** uids of its parent layers. */
  anc: number[];
  type: string;
  id?: string;
  /** id of the nearest named parent layer. */
  group?: string;
  /** Paint order: higher draws on top. */
  order: number;
  /** uid of the outermost component (browser, phone, card...) it is part of, if any. */
  component?: number;
  text?: string;
  /** Where it sits in the video JSON, e.g. scenes[2].layers[4].children[1]. */
  path?: string;
  opacity: number;
  box: { x0: number; y0: number; x1: number; y1: number };
}
export interface InspectInfo {
  scene: string;
  transition: boolean;
  items: InspectItem[];
}

/** Layers that cover the frame or decorate it on purpose; layout checks ignore them. */
const INSPECT_SKIP = new Set(['background', 'grid', 'particles', 'confetti', 'dots', 'flash', 'glow', 'cursor', 'path', 'marquee']);

function groupId(l: Layer): string | undefined {
  for (let p = l.parent; p; p = p.parent) if (p.spec.id) return p.spec.id;
  return undefined;
}

/** Containers that are plain groupings; every other layer with children is a component. */
const PLAIN_GROUPS = new Set(['group']);

function componentOf(l: Layer): number | undefined {
  let out: Layer | undefined;
  for (let p = l.parent; p; p = p.parent) if (!PLAIN_GROUPS.has(p.sourceType || p.spec.type)) out = p;
  if (!out) return undefined;
  // Unique within the scene: layers are numbered in depth-first order, same as `uid`.
  return out.order;
}

function formatPath(p: (string | number)[]): string {
  return p.map((k, i) => (typeof k === 'number' ? `[${k}]` : i ? `.${k}` : k)).join('');
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  video: Video;
  readonly ctx: EngineContext;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** Length of the output in seconds (after music sync, if any). */
  duration: number;
  /** Scene timing in design time: what the spec says. The engine renders scenes by design time. */
  readonly designTimings: SceneTiming[];
  private designDuration: number;
  /** Music sync: maps output time to design time and back (null when the video is not synced). */
  warp: Warp | null = null;
  private beats: number[] | null = null;
  /** The voiceover's words in output time (audio track with a `script`). */
  words: Word[] | null = null;
  /** Caption layers per scene for the current warp. */
  private captions: Record<string, unknown>[][] | null = null;
  private outTimings: SceneTiming[] | null = null;
  scenes: SceneInstance[] = [];
  private compositor: Compositor;
  private scale: number;
  private mbSamples: number;
  private mbShutter: number;
  /** The frame being rendered, so scene swaps never happen mid-frame. */
  private inflight: Promise<void> = Promise.resolve();

  /** Output size and design-to-output zoom for the chosen format. */
  readonly framing: Framing;

  private constructor(
    readonly canvas: HTMLCanvasElement,
    video: Video,
    private opts: EngineOptions,
    framing?: Framing,
  ) {
    this.framing = framing ?? { width: video.width ?? 1920, height: video.height ?? 1080, zoom: 1 };
    this.video = video;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.autoClear = false;
    this.renderer.setPixelRatio(1);
    this.renderer.toneMapping = THREE.NoToneMapping;
    const wantsShadows = !!video.lighting?.shadows || video.scenes.some((s) => s.lighting?.shadows);
    if (wantsShadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.VSMShadowMap;
    }
    const named = typeof video.environment === 'string' && ['room', 'studio', 'softbox'].includes(video.environment);
    // HDRIs load asynchronously in create(); start from the neutral room.
    const env = buildEnvironment(this.renderer, named ? (video.environment as 'room' | 'studio' | 'softbox') : 'room');
    this.ctx = createContext(video, { renderer: this.renderer, baseUrl: opts.baseUrl, preview: !!opts.preview, envMap: env, wrap: this.framing.wrap });
    this.width = this.ctx.width;
    this.height = this.ctx.height;
    this.fps = this.ctx.fps;
    const layout = layoutScenes(video.scenes, { fps: this.fps, bpm: video.bpm });
    this.designTimings = layout.scenes;
    this.duration = layout.duration;
    this.designDuration = layout.duration;
    this.scale = (opts.scale ?? 1) * this.framing.zoom;
    this.ctx.view.scale = this.scale;
    const w = Math.round(this.width * this.scale);
    const h = Math.round(this.height * this.scale);
    this.renderer.setSize(w, h, false);
    this.compositor = new Compositor(this.renderer, w, h);
    const mb = video.motionBlur;
    this.mbSamples = mb === false ? 1 : mb === true || mb === undefined ? 8 : mb.samples ?? 8;
    this.mbShutter = mb === false ? 0 : typeof mb === 'object' ? mb.shutter ?? 0.5 : 0.5;
  }

  /** Validates the spec, builds every scene and waits for fonts and textures. */
  static async create(canvas: HTMLCanvasElement, input: unknown, opts: EngineOptions): Promise<Engine> {
    const { spec, framing } = applyFormat(input, opts.format);
    const v = validateVideo(spec);
    if (!v.ok || !v.video) throw new Error(`Invalid video spec${opts.format ? ` (format ${opts.format})` : ''}:\n${v.errors.map((e) => `  - ${e}`).join('\n')}`);
    const engine = new Engine(canvas, resolveShared(resolveAutoText(v.video)), opts, framing);
    await engine.loadEnvironment();
    await engine.prepareTiming();
    await engine.build();
    return engine;
  }

  private async loadEnvironment(): Promise<void> {
    const e = this.video.environment;
    if (!e || (typeof e === 'string' && ['room', 'studio', 'softbox'].includes(e))) return;
    const src = typeof e === 'string' ? e : e.src;
    const res = typeof e === 'object' ? e.res ?? '1k' : '1k';
    const url = src.startsWith('hdri:') ? `/__bemotion/hdri/${src.slice(5)}_${res}.hdr` : this.ctx.asset(src);
    try {
      this.ctx.envMap = await loadHdriEnvironment(this.renderer, url);
    } catch (err) {
      throw new Error(`Could not load environment "${src}": ${(err as Error).message}`);
    }
    this.opts.onProgress?.(`Loaded environment ${src}`);
  }

  /** Shapes for `mask` transitions, keyed by their settings. */
  private masks = new Map<string, MaskInfo>();

  /** A mask transition's text settings: its own, else those of its `from` layer in the previous scene. */
  private maskStyle(video: Video, i: number): { font: string; weight: number; letterSpacing: number } {
    const tr = video.scenes[i].transition!;
    let src: Record<string, unknown> | undefined;
    if (tr.from && i > 0) {
      const find = (list: unknown[]): Record<string, unknown> | undefined => {
        for (const n of list as Record<string, unknown>[]) {
          if (n && n.id === tr.from) return n;
          const kids = n && Array.isArray(n.children) ? find(n.children) : undefined;
          if (kids) return kids;
        }
        return undefined;
      };
      src = find(video.scenes[i - 1].layers);
    }
    return {
      font: tr.font ?? (typeof src?.font === 'string' ? src.font : 'display'),
      weight: tr.weight ?? (typeof src?.weight === 'number' ? src.weight : src ? 600 : 800),
      letterSpacing: tr.letterSpacing ?? (typeof src?.letterSpacing === 'number' ? src.letterSpacing : src ? -0.02 : 0),
    };
  }

  private maskKey(video: Video, i: number): string {
    const tr = video.scenes[i].transition;
    return JSON.stringify([tr?.text, tr?.svg, this.maskStyle(video, i)]);
  }

  /** Draws the mask of every `mask` transition that is not cached yet. */
  private async prepareMasks(video: Video = this.video): Promise<void> {
    for (let i = 0; i < video.scenes.length; i++) {
      const tr = video.scenes[i].transition;
      if (tr?.type !== 'mask') continue;
      const key = this.maskKey(video, i);
      if (this.masks.has(key)) continue;
      const st = this.maskStyle(video, i);
      this.masks.set(key, await buildMask({ text: tr.text, svg: tr.svg, weight: st.weight, letterSpacing: st.letterSpacing, fontUrl: tr.svg ? undefined : this.ctx.fontUrl(st.font, st.weight) }));
    }
  }

  private async build(): Promise<void> {
    await this.prepareMasks();
    const bg = this.video.background ?? '$bg';
    this.scenes = this.video.scenes.map((s, i) => new SceneInstance(this.sceneSpec(s, i), this.designTimings[i], this.ctx, bg));
    let done = 0;
    await Promise.all(
      this.scenes.map(async (s, i) => {
        try {
          await s.build();
        } catch (e) {
          throw new Error(`scenes[${i}]${s.spec.id ? ` ("${s.spec.id}")` : ''}: ${(e as Error).message}`);
        }
        this.opts.onProgress?.(`Built scene ${++done}/${this.scenes.length}`);
      }),
    );
    // Warm up: compile shaders for every scene so the first frames are not slow.
    for (const s of this.scenes) {
      await s.update(0);
      this.renderer.compile(s.three, s.camera);
    }
  }

  /** A local audio file's path relative to the spec, for the server's analysis routes. */
  private audioPath(src: string, what: string): { origin: string; rel: string } {
    const asset = new URL(this.ctx.asset(src), location.href);
    const local = '/__bemotion/assets/';
    if (asset.origin !== location.origin || !asset.pathname.startsWith(local)) throw new Error(`audio "${src}": ${what} needs the file next to the spec`);
    return { origin: asset.origin, rel: decodeURIComponent(asset.pathname.slice(local.length)) };
  }

  /**
   * Timing from the soundtrack, before scenes are built. A music track with `sync` is analyzed for
   * beats; a voice track with a `script` is aligned word by word. The video then plays through a time
   * warp: following the voice when the voice track has `align` (lines arrive as they are said),
   * otherwise landing moments on beats (see spec/beatsync.ts). Captions use the voice's words.
   */
  private async prepareTiming(): Promise<void> {
    const tctx = { fps: this.fps, bpm: this.video.bpm };
    const music = this.video.audio?.find((a) => a.sync);
    if (music) {
      const { origin, rel } = this.audioPath(music.src, 'sync');
      const res = await fetch(`${origin}/__bemotion/beats?src=${encodeURIComponent(rel)}`);
      if (!res.ok) throw new Error(`Could not find the beats in "${music.src}": ${await res.text()}`);
      const info = (await res.json()) as { beats: number[] };
      const at = toSeconds(music.at, tctx, 0);
      const trim = toSeconds(music.trim, tctx, 0);
      this.beats = info.beats.filter((b) => b >= trim).map((b) => at + b - trim);
      this.opts.onProgress?.(`Found ${this.beats.length} beats in ${music.src}`);
    }
    const voice = this.video.audio?.find((a) => a.role === 'voice' && a.script);
    if (voice) {
      const { origin, rel } = this.audioPath(voice.src, 'script');
      const res = await fetch(`${origin}/__bemotion/voice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ src: rel, script: voice.script }) });
      if (!res.ok) throw new Error(`Could not align the voiceover "${voice.src}": ${await res.text()}`);
      const found = (await res.json()) as Word[];
      const at = toSeconds(voice.at, tctx, 0);
      const trim = toSeconds(voice.trim, tctx, 0);
      this.words = found.filter((w) => w.start >= trim).map((w) => ({ text: w.text, start: at + w.start - trim, end: at + w.end - trim }));
      this.opts.onProgress?.(`Aligned ${this.words.length} spoken words in ${voice.src}`);
    }
    this.applyWarp(this.computeWarp(this.video));
  }

  /** The warp for a spec: following the voice (align), or onto the beats (sync), or none. */
  private computeWarp(video: Video): Warp | null {
    const tctx = { fps: this.fps, bpm: video.bpm };
    const voice = video.audio?.find((a) => a.role === 'voice' && a.script && a.align);
    if (voice && this.words) {
      return buildTargetWarp(lineTargets(video, this.designTimings, this.words, (v) => toSeconds(v as never, tctx, 0)), this.designDuration);
    }
    if (this.beats && video.audio?.some((a) => a.sync)) return buildWarp(syncMoments(video, this.designTimings), this.beats, this.designDuration);
    return null;
  }

  private applyWarp(w: Warp | null): void {
    this.warp = w;
    this.duration = w ? toOutput(w, this.designDuration) : this.designDuration;
    this.outTimings = null;
    this.captions = null;
  }

  /** A scene's spec as built: with caption layers added when the video has `captions`. */
  private sceneSpec(s: Video['scenes'][number], i: number, video: Video = this.video): Video['scenes'][number] {
    const style = video.captions;
    if (!style || !this.words) return s;
    this.captions ??= captionLayers(this.words, (t) => this.design(t), this.designTimings, this.height, typeof style === 'object' ? style : {});
    let extra = this.captions[i];
    if (!extra?.length) return s;
    if (typeof style !== 'object' || !style.color) {
      // Readable on the scene: white on dark backgrounds, near black on light ones.
      const bg = this.ctx.color(s.background ?? video.background ?? '$bg');
      const light = 0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b > 0.5;
      extra = extra.map((l) => {
        const c = { ...l, color: light ? '#1D1D1F' : '#FFFFFF' };
        generated.add(c);
        return c;
      });
    }
    return { ...s, layers: [...s.layers, ...(extra as Video['scenes'][number]['layers'])] };
  }

  /** Output time to design time. */
  design(t: number): number {
    return this.warp ? toDesign(this.warp, t) : t;
  }

  /** Design time to output time. */
  output(t: number): number {
    return this.warp ? toOutput(this.warp, t) : t;
  }

  /** Scene timing on the output timeline: where the cuts land in the finished video. */
  get timings(): SceneTiming[] {
    const w = this.warp;
    if (!w) return this.designTimings;
    return (this.outTimings ??= this.designTimings.map((tm) => {
      const start = toOutput(w, tm.start);
      const end = toOutput(w, tm.end);
      return { ...tm, start, end, duration: end - start, transitionIn: toOutput(w, tm.start + tm.transitionIn) - start };
    }));
  }

  get frameCount(): number {
    return Math.max(1, Math.round(this.duration * this.fps));
  }

  /** Output size in pixels at full scale (the design size times the format's zoom). */
  get pixelWidth(): number {
    return this.framing.width;
  }

  get pixelHeight(): number {
    return this.framing.height;
  }

  setScale(scale: number): void {
    scale *= this.framing.zoom;
    this.scale = scale;
    this.ctx.view.scale = scale;
    const w = Math.round(this.width * scale);
    const h = Math.round(this.height * scale);
    this.renderer.setSize(w, h, false);
    this.compositor.setSize(w, h);
  }

  /** Scenes visible at global (output) time t. During a transition there are two. */
  activeAt(t: number): { a: SceneInstance; b?: SceneInstance; progress: number } {
    return this.activeAtDesign(this.design(t));
  }

  private activeAtDesign(t: number): { a: SceneInstance; b?: SceneInstance; progress: number } {
    const ts = Math.min(Math.max(t, 0), this.designDuration);
    let idx = this.designTimings.findIndex((s, i) => ts >= s.start && (ts < s.end || i === this.designTimings.length - 1));
    if (idx < 0) idx = this.designTimings.length - 1;
    // Is the next scene already transitioning in?
    const next = this.designTimings[idx + 1];
    if (next && next.transitionIn > 0 && ts >= next.start) {
      return { a: this.scenes[idx], b: this.scenes[idx + 1], progress: (ts - next.start) / next.transitionIn };
    }
    return { a: this.scenes[idx], progress: 0 };
  }

  sceneIndexAt(t: number): number {
    const { a, b, progress } = this.activeAt(t);
    return b && progress > 0.5 ? b.timing.index : a.timing.index;
  }

  /** Called after a scene's layers are updated and before it renders (the editor syncs its gizmo here). */
  onAfterUpdate?: (scene: SceneInstance) => void;

  /** The scene that owns global time t (the incoming one once a transition is past halfway). */
  sceneAt(t: number): SceneInstance {
    return this.scenes[this.sceneIndexAt(t)];
  }

  /** Finds the editable layer under a point. `ndc` is in -1..1 with +y up. */
  pick(ndc: { x: number; y: number }, t: number): Layer | null {
    const scene = this.sceneAt(t);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), scene.camera);
    const hits = ray.intersectObjects(scene.three.children, true);
    for (const h of hits) {
      if (!h.object.visible) continue;
      // Skip invisible-but-present helpers and full-screen backgrounds.
      let o: THREE.Object3D | null = h.object;
      let layer: Layer | null = null;
      while (o) {
        const l = o.userData.layer as Layer | undefined;
        if (l) {
          layer = l;
          break;
        }
        o = o.parent;
      }
      if (!layer || layer.spec.type === 'background' || layer.spec.type === 'particles') continue;
      let visible = true;
      for (let p: THREE.Object3D | null = layer.root; p; p = p.parent) if (!p.visible) visible = false;
      if (!visible) continue;
      // Walk up to the nearest layer that exists in the source JSON.
      let target: Layer | null = layer;
      while (target && !target.sourcePath) target = target.parent;
      if (target) return target;
    }
    return null;
  }

  /** Looks a layer up by its JSON path. */
  layerAt(path: (string | number)[]): Layer | null {
    const key = path.join('/');
    for (const s of this.scenes) for (const l of s.allLayers) if (l.sourcePath && l.sourcePath.join('/') === key) return l;
    return null;
  }

  /** Shared elements entering scene i from scene i - 1 (layers with the same `share` name). */
  private pairs = new Map<number, { a: Layer; b: Layer }[]>();
  /** Layers currently hidden from their scene because they are drawn in flight. */
  private flying = new Set<Layer>();
  private lit = new WeakSet<SceneInstance>();

  private sharePairs(i: number): { a: Layer; b: Layer }[] {
    let list = this.pairs.get(i);
    if (list) return list;
    list = [];
    const tr = this.video.scenes[i]?.transition;
    if (i > 0 && tr && tr.type !== 'cut' && this.designTimings[i].transitionIn > 0) {
      const first = (s: SceneInstance, name: string) => s.allLayers.find((l) => l.spec.share === name);
      for (const lb of this.scenes[i].allLayers) {
        const name = lb.spec.share;
        if (!name || first(this.scenes[i], name) !== lb) continue;
        const la = first(this.scenes[i - 1], name);
        if (la) list.push({ a: la, b: lb });
      }
    }
    this.pairs.set(i, list);
    return list;
  }

  /** Moves exactly `layers` onto the flying channel (hidden from normal renders) and restores the rest. */
  private setFlying(layers: Layer[]): void {
    const next = new Set(layers);
    for (const l of this.flying) if (!next.has(l)) setChannel(l.root, 0);
    for (const l of next) setChannel(l.root, FLYING);
    this.flying = next;
  }

  /** Where a mask transition's `from` layer's letters are on screen, in the outgoing scene. */
  private maskFromBox(a: SceneInstance, id: string): ScreenBox | undefined {
    const layer = a.allLayers.find((l) => l.spec.id === id);
    if (!layer) return undefined;
    a.camera.updateMatrixWorld();
    return inkBox(layer.root, a.camera, this.compositor.width, this.compositor.height) ?? undefined;
  }

  /** Renders design time t (scene changes, transitions and shared element flights). */
  private async composite(t: number) {
    const { a, b, progress } = this.activeAtDesign(t);
    const c = this.compositor;
    await a.update(Math.min(t - a.timing.start, a.timing.duration));
    this.onAfterUpdate?.(a);
    if (!b) {
      if (this.flying.size) this.setFlying([]);
      c.renderScene(a.three, a.camera, a.clearColor, c.rtA);
      return { target: c.rtA, scene: a };
    }
    await b.update(Math.max(0, t - b.timing.start));
    this.onAfterUpdate?.(b);
    // Shared elements fly from where they are in the outgoing scene to where they sit in the incoming one.
    const flights: { a: Layer; b: Layer; from: ScreenBox; to: ScreenBox }[] = [];
    const pairs = this.sharePairs(b.timing.index);
    if (pairs.length) {
      a.camera.updateMatrixWorld();
      b.camera.updateMatrixWorld();
      for (const p of pairs) {
        const from = screenBox(p.a.root, a.camera, c.width, c.height);
        const to = screenBox(p.b.root, b.camera, c.width, c.height);
        if (from && to) flights.push({ ...p, from, to });
      }
    }
    this.setFlying(flights.flatMap((f) => [f.a, f.b]));
    const tr0 = b.spec.transition!;
    // A mask that starts over a layer replaces it: measure where its letters are, then hide it for this frame.
    let maskFrom: ScreenBox | undefined;
    if (tr0.type === 'mask' && tr0.from) {
      maskFrom = this.maskFromBox(a, tr0.from);
      const layer = a.allLayers.find((l) => l.spec.id === tr0.from);
      if (layer && maskFrom) layer.root.visible = false;
    }
    c.renderScene(a.three, a.camera, a.clearColor, c.rtA);
    c.renderScene(b.three, b.camera, b.clearColor, c.rtB);
    const tr = b.spec.transition!;
    // The mask transition times its own phases (pop in, then dive), so it runs on a linear clock.
    const ease = resolveEase(tr.ease, tr.type === 'mask' ? 'linear' : tr.type === 'whip' || tr.type === 'push' || tr.type === 'slide' ? 'inOutQuart' : 'inOutCubic');
    const target = c.mix({
      type: tr.type,
      progress: ease(Math.min(Math.max(progress, 0), 1)),
      direction: DIRS[tr.direction ?? 'left'],
      color: this.ctx.color(tr.color ?? (tr.type === 'flash' ? '#FFFFFF' : '#000000')),
      seed: hashString(b.spec.id ?? String(b.timing.index)) % 1000,
      mask: tr.type === 'mask' ? this.masks.get(this.maskKey(this.video, b.timing.index)) : undefined,
      maskFrom,
    });
    if (flights.length) {
      for (const s of [a, b]) {
        if (this.lit.has(s)) continue;
        lightAllChannels(s.three);
        this.lit.add(s);
      }
      const q = resolveEase(tr.type === 'mask' ? undefined : tr.ease, 'inOutCubic')(Math.min(Math.max(progress, 0), 1));
      for (const f of flights) {
        setChannel(f.a.root, SOLO);
        c.renderSolo(a.three, a.camera, 'a');
        setChannel(f.a.root, FLYING);
        setChannel(f.b.root, SOLO);
        c.renderSolo(b.three, b.camera, 'b');
        setChannel(f.b.root, FLYING);
        c.flight(target, { from: f.from, to: f.to, progress: q });
      }
    }
    return { target, scene: progress > 0.5 ? b : a };
  }

  /**
   * Applies a changed spec in place. Only scenes whose JSON changed are rebuilt; the renderer,
   * environment and untouched scenes are kept. Returns 'reload' when the change needs a new engine
   * (size, fps, environment, theme, timing or scene count changed).
   */
  async patch(input: unknown): Promise<'patched' | 'unchanged' | 'reload'> {
    const v = validateVideo(applyFormat(input, this.opts.format).spec);
    if (!v.ok || !v.video) throw new Error(`Invalid video spec:\n${v.errors.map((e) => `  - ${e}`).join('\n')}`);
    const next = resolveShared(resolveAutoText(v.video));
    const { scenes: a, ...restA } = this.video;
    const { scenes: b, ...restB } = next;
    if (JSON.stringify(restA) !== JSON.stringify(restB) || a.length !== b.length) return 'reload';
    const layout = layoutScenes(b, { fps: this.fps, bpm: next.bpm });
    const same = layout.scenes.every((t, i) => {
      const o = this.designTimings[i];
      return Math.abs(t.start - o.start) < 1e-6 && Math.abs(t.duration - o.duration) < 1e-6 && Math.abs(t.transitionIn - o.transitionIn) < 1e-6;
    });
    if (!same) return 'reload';
    // A change that moves the soundtrack timing (or captions) touches every scene: start over.
    if (JSON.stringify(this.computeWarp(next)) !== JSON.stringify(this.warp)) return 'reload';
    const changed = b.map((s, i) => JSON.stringify(s) !== JSON.stringify(a[i]));
    if (!changed.some(Boolean)) {
      this.video = next;
      return 'unchanged';
    }
    await this.prepareMasks(next);
    const bg = next.background ?? '$bg';
    const built = new Map<number, SceneInstance>();
    try {
      await Promise.all(
        changed.map(async (c, i) => {
          if (!c) return;
          const s = new SceneInstance(this.sceneSpec(b[i], i, next), this.designTimings[i], this.ctx, bg);
          built.set(i, s);
          try {
            await s.build();
          } catch (e) {
            throw new Error(`scenes[${i}]${s.spec.id ? ` ("${s.spec.id}")` : ''}: ${(e as Error).message}`);
          }
          await s.update(0);
          this.renderer.compile(s.three, s.camera);
        }),
      );
    } catch (e) {
      for (const s of built.values()) s.dispose();
      throw e;
    }
    // Swap between frames.
    await this.inflight.catch(() => {});
    const old: SceneInstance[] = [];
    for (const [i, s] of built) {
      old.push(this.scenes[i]);
      this.scenes[i] = s;
    }
    this.video = next;
    this.pairs.clear();
    this.setFlying([]);
    for (const s of old) s.dispose();
    return 'patched';
  }

  /** Renders the frame at global time `t` (seconds) into the canvas. */
  renderFrame(t: number, opts: FrameOptions = {}): Promise<void> {
    const p = this.inflight.catch(() => {}).then(() => this.renderFrameNow(t, opts));
    this.inflight = p;
    return p;
  }

  private async renderFrameNow(t: number, opts: FrameOptions): Promise<void> {
    const useMb = (opts.motionBlur ?? !this.opts.preview) && this.mbSamples > 1 && this.mbShutter > 0;
    const samples = useMb ? this.mbSamples : 1;
    let last = this.compositor.rtA;
    let scene: SceneInstance = this.scenes[0];
    const frameDt = 1 / this.fps;
    // The frame's own (design) time: decides which scenes and layers are on screen, so a hard cut is
    // never blurred together with the shot before or after it.
    const center = Math.min(this.design(Math.min(Math.max(t, 0), this.duration - 1e-4)), this.designDuration - 1e-4);
    const home = this.activeAtDesign(center);
    for (let i = 0; i < samples; i++) {
      const offset = samples > 1 ? ((i + 0.5) / samples - 0.5) * this.mbShutter * frameDt : 0;
      const ts = Math.min(Math.max(t + offset, 0), this.duration - 1e-4);
      let ds = Math.min(this.design(ts), this.designDuration - 1e-4);
      if (!home.b) {
        // A cut between scenes: keep every sample inside this frame's scene.
        const tm = home.a.timing;
        const next = this.designTimings[tm.index + 1];
        const until = next && next.transitionIn > 0 ? Infinity : tm.end - 1e-4;
        ds = Math.min(Math.max(ds, tm.start), until);
      }
      for (const sc of this.scenes) sc.frameTime = center - sc.timing.start;
      const r = await this.composite(ds);
      last = r.target;
      scene = r.scene;
      if (samples > 1) this.compositor.accumulate(r.target, 1 / samples, i === 0);
    }
    for (const sc of this.scenes) sc.frameTime = undefined;
    const src = samples > 1 ? this.compositor.rtAccum : last;
    const post = resolvePost(this.video.post, scene.spec.post);
    this.compositor.present(src, post, Math.round(t * this.fps));
  }

  /** Sound-design cues on the global timeline: layer cues plus one per scene transition. */
  /** Video layers with sound (`volume` above 0), on the global timeline, for the render's audio mix. */
  clipSounds(): ClipSound[] {
    const out: ClipSound[] = [];
    for (const s of this.scenes) {
      for (const l of s.allLayers) {
        if (!(l instanceof VideoLayer)) continue;
        const i = l.soundInfo();
        if (i.volume <= 0) continue;
        const end = Math.min(i.end, s.timing.duration);
        if (end <= i.start) continue;
        const at = this.output(s.timing.start + i.start);
        out.push({ src: i.src, at, length: this.output(s.timing.start + end) - at, trim: i.trim, speed: i.speed, volume: i.volume, repeat: i.repeat });
      }
    }
    return out;
  }

  events(): { kind: string; t: number; gain: number }[] {
    const out: { kind: string; t: number; gain: number }[] = [];
    const TRANSITION_SFX: Record<string, string> = {
      whip: 'whoosh', zoom: 'whoosh', zoomOut: 'whoosh', push: 'swoosh', slide: 'swoosh', split: 'swoosh',
      glitch: 'glitch', flash: 'impact', fade: 'soft', blur: 'soft', black: 'soft', wipe: 'swoosh', circle: 'soft', pixelate: 'glitch', mask: 'whoosh',
    };
    this.scenes.forEach((s, i) => {
      for (const e of s.events) out.push({ kind: e.kind, t: this.output(s.timing.start + e.t), gain: e.gain });
      const tr = s.spec.transition;
      if (i > 0 && tr && TRANSITION_SFX[tr.type]) out.push({ kind: TRANSITION_SFX[tr.type], t: Math.max(0, this.output(s.timing.start) - 0.08), gain: 0.9 });
    });
    return out.sort((a, b) => a.t - b.t);
  }

  /**
   * What is on screen at output time t, for layout checks: the visible leaf layers of the scene (none
   * during a transition) with their boxes in output pixels (y down). Text reports its drawn letters,
   * other layers their own rectangle (shadows and glows excluded). Call after rendering frame t.
   */
  inspect(t: number): InspectInfo {
    const { a, b } = this.activeAt(t);
    if (b) return { scene: a.spec.id ?? `scene ${a.timing.index}`, transition: true, items: [] };
    const scene = a;
    const W = this.compositor.width;
    const H = this.compositor.height;
    scene.camera.updateMatrixWorld();
    const uid = new Map<Layer, number>();
    scene.allLayers.forEach((l, i) => uid.set(l, i));
    const items: InspectItem[] = [];
    const corner = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const toCam = new THREE.Vector3();
    for (const l of scene.allLayers) {
      if (l.children.length || INSPECT_SKIP.has(l.spec.type)) continue;
      let shown = true;
      for (let o: THREE.Object3D | null = l.root; o; o = o.parent) if (!o.visible) shown = false;
      if (!shown) continue;
      // The back of a turned card or phone is hidden (or mirrored); leave it out.
      l.root.updateWorldMatrix(true, false);
      normal.set(0, 0, 1).transformDirection(l.root.matrixWorld);
      toCam.setFromMatrixPosition(l.root.matrixWorld).subVectors(scene.camera.position, toCam);
      // Turned well away from the camera (a tilted card), its box no longer matches what is drawn.
      if (normal.dot(toCam) < 0.94 * toCam.length()) continue;
      // Rotated in the frame: an upright box around it would claim corners it does not cover.
      normal.set(1, 0, 0).transformDirection(l.root.matrixWorld);
      if (Math.abs(Math.atan2(normal.y, normal.x)) > 0.07) continue;
      let box: ScreenBox | null = null;
      const type = l.spec.type;
      if (type === 'text' || type === 'counter') box = inkBox(l.root, scene.camera, W, H);
      else {
        const sz = l.size();
        if (sz.w > 0 && sz.h > 0 && Number.isFinite(sz.w) && Number.isFinite(sz.h)) {
          l.pivot.updateWorldMatrix(true, false);
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (let i = 0; i < 4; i++) {
            corner.set(i & 1 ? sz.w / 2 : -sz.w / 2, i & 2 ? sz.h / 2 : -sz.h / 2, 0).applyMatrix4(l.pivot.matrixWorld).project(scene.camera);
            const px = (corner.x * 0.5 + 0.5) * W;
            const py = (corner.y * 0.5 + 0.5) * H;
            x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
          }
          box = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
        } else box = screenBox(l.root, scene.camera, W, H);
      }
      if (!box || box.w < 1 || box.h < 1) continue;
      const anc: number[] = [];
      for (let p = l.parent; p; p = p.parent) anc.push(uid.get(p) ?? -1);
      const sp = l.spec as { id?: string; text?: string };
      // Topmost ancestor that exists in the JSON, for naming layers made by components.
      let named: Layer | null = l;
      while (named && !named.sourcePath) named = named.parent;
      const src = named ? scene.sourcePaths.get(named.spec as object) ?? named.sourcePath : null;
      items.push({
        uid: uid.get(l)!,
        anc,
        type,
        id: sp.id ?? named?.spec.id,
        group: groupId(l),
        order: l.order,
        component: componentOf(l),
        text: typeof sp.text === 'string' ? sp.text : undefined,
        path: src ? formatPath(src) : undefined,
        opacity: l.effectiveOpacity,
        // Output pixels, y down.
        box: {
          x0: ((box.cx - box.w / 2) / W) * this.pixelWidth,
          x1: ((box.cx + box.w / 2) / W) * this.pixelWidth,
          y0: ((H - box.cy - box.h / 2) / H) * this.pixelHeight,
          y1: ((H - box.cy + box.h / 2) / H) * this.pixelHeight,
        },
      });
    }
    return { scene: scene.spec.id ?? `scene ${scene.timing.index}`, transition: false, items };
  }

  async renderFrameIndex(frame: number, opts: FrameOptions = {}): Promise<void> {
    await this.renderFrame(frame / this.fps, opts);
  }

  dispose(): void {
    for (const s of this.scenes) s.dispose();
    this.compositor.dispose();
    this.renderer.dispose();
  }
}
