import * as THREE from 'three';
// The light build has no expression support: animation files cannot run code in the page.
import lottie, { type AnimationItem } from 'lottie-web/build/player/lottie_light_canvas';
import type { LottieLayer as LottieSpec } from '../../spec/schema';
import { Layer } from './base';
import { SdfMesh } from './sdf';

/**
 * A Lottie animation (Bodymovin JSON exported from After Effects, or from LottieFiles), drawn with
 * lottie-web's light canvas build (expressions, which are JavaScript, are not run; their properties
 * keep their keyframed values),
 * into a texture. Every frame is drawn at the exact frame for the
 * timeline (`goToAndStop`), never by its own clock, so renders are deterministic.
 */
export class LottieLayer extends Layer<LottieSpec> {
  readonly mesh = new SdfMesh();
  private anim!: AnimationItem;
  private canvas!: HTMLCanvasElement;
  private tex!: THREE.CanvasTexture;
  private w = 400;
  private h = 400;
  private fr = 30;
  private ip = 0;
  private op = 60;
  private last = NaN;

  size() {
    return { w: this.w, h: this.h };
  }

  async load(): Promise<void> {
    const s = this.spec;
    const url = this.ctx.asset(s.src);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`lottie: could not load "${s.src}" (${res.status})`);
    const data = (await res.json()) as { w: number; h: number; fr: number; ip: number; op: number };
    this.fr = data.fr || 30;
    this.ip = data.ip ?? 0;
    this.op = data.op ?? this.ip + this.fr * 2;
    const aspect = data.w / data.h;
    this.w = s.width ?? (s.height ? s.height * aspect : data.w);
    this.h = s.height ?? this.w / aspect;
    // Draw at the size it appears (times the resolution), within a texture size every GPU takes.
    const k = Math.min(4096 / Math.max(this.w, this.h), (s.resolution ?? 1) * Math.max(1, this.ctx.view?.scale ?? 1));
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.max(1, Math.round(this.w * k));
    this.canvas.height = Math.max(1, Math.round(this.h * k));
    const g = this.canvas.getContext('2d')!;
    // Images inside the animation are found next to its JSON.
    const base = url.slice(0, url.lastIndexOf('/') + 1);
    this.anim = lottie.loadAnimation({
      renderer: 'canvas',
      loop: false,
      autoplay: false,
      animationData: data,
      assetsPath: base,
      rendererSettings: { context: g, clearCanvas: true, preserveAspectRatio: 'xMidYMid meet' },
    } as Parameters<typeof lottie.loadAnimation>[0]);
    await new Promise<void>((done) => {
      if (this.anim.isLoaded) return done();
      this.anim.addEventListener('DOMLoaded', () => done());
      setTimeout(done, 5000);
    });
    this.anim.resize();
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = false;
    this.setupMaterial(this.mesh, this.mesh.material);
    this.mesh.setParams({ width: this.w, height: this.h, fillA: { r: 1, g: 1, b: 1, a: 1 } });
    this.mesh.setMap(this.tex, 'fill');
    this.pivot.add(this.mesh);
  }

  /** The animation frame for scene time t: from the layer's start, at `speed`, looping or holding. */
  private frameAt(t: number): number {
    const s = this.spec;
    const local = Math.max(0, t - this.start) * (s.speed ?? 1) + (s.trim ?? 0);
    const len = Math.max(1, this.op - this.ip);
    let f = local * this.fr;
    if (s.repeat ?? true) f = ((f % len) + len) % len;
    else f = Math.min(f, len - 1);
    return this.ip + f;
  }

  protected updateContent(t: number, opacity: number, blur = 0): void {
    const s = this.spec;
    const f = this.frameAt(t);
    if (f !== this.last) {
      this.anim.goToAndStop(f, true);
      this.tex.needsUpdate = true;
      this.last = f;
    }
    this.mesh.setParams({ blur: blur * 0.35, width: this.w, height: this.h, radius: this.num('radius', t, s.radius ?? 0), fillA: { r: 1, g: 1, b: 1, a: 1 } });
    this.mesh.setMapBlur(blur);
    this.mesh.setOpacity(opacity);
  }

  dispose(): void {
    super.dispose();
    this.anim?.destroy();
    this.tex?.dispose();
  }
}
