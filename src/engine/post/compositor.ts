import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { Post } from '../../spec/schema';
import { blurFrag, copyFrag, finalFrag, flightFrag, quadVert, transitionFrag, TRANSITIONS } from './shaders';
import { BACKDROP, type GlassTag } from './backdrop';
import { SOLO, type ScreenBox } from '../share';
import type { MaskInfo } from './mask';
import type { RGBA } from '../util/color';

export interface TransitionState {
  type: string;
  progress: number;
  direction: [number, number];
  color: RGBA;
  seed: number;
  /** For `mask` transitions: the shape the next scene shows through. */
  mask?: MaskInfo;
  /** For `mask` transitions with `from`: where that layer's letters are on screen right now. */
  maskFrom?: ScreenBox;
}

/** One shared element between two scenes: where it was, where it lands, and how far along it is (0-1). */
export interface FlightState {
  from: ScreenBox;
  to: ScreenBox;
  progress: number;
}

export interface ResolvedPost {
  bloom: { strength: number; radius: number; threshold: number } | null;
  chromatic: number;
  grain: number;
  vignette: number;
  exposure: number;
  contrast: number;
  saturation: number;
  tonemap: 'none' | 'aces' | 'agx' | 'soft';
}

export function resolvePost(...layers: (Post | undefined)[]): ResolvedPost {
  const m: Post = Object.assign({}, ...layers.filter(Boolean));
  const bloomDefaults = { strength: 0.7, radius: 0.6, threshold: 0.98 };
  return {
    bloom: m.bloom === false ? null : m.bloom === true || m.bloom === undefined ? bloomDefaults : { ...bloomDefaults, ...m.bloom },
    chromatic: m.chromatic ?? 0,
    grain: m.grain ?? 0.035,
    vignette: m.vignette ?? 0.25,
    exposure: m.exposure ?? 1,
    contrast: m.contrast ?? 1,
    saturation: m.saturation ?? 1,
    tonemap: m.tonemap ?? 'soft',
  };
}

function makeRT(w: number, h: number, samples = 0): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    samples,
    depthBuffer: true,
    // Masked groups draw their mask into the stencil.
    stencilBuffer: true,
    colorSpace: THREE.LinearSRGBColorSpace,
  });
}

/**
 * Owns all offscreen buffers. Per frame:
 *   scene(s) -> [transition mix] -> [motion-blur accumulation] -> bloom -> final grade -> canvas
 */
export class Compositor {
  rtA: THREE.WebGLRenderTarget;
  rtB: THREE.WebGLRenderTarget;
  rtMix: THREE.WebGLRenderTarget;
  rtAccum: THREE.WebGLRenderTarget;
  private copyQuad: FullScreenQuad;
  private copyMat: THREE.ShaderMaterial;
  private transQuad: FullScreenQuad;
  private transMat: THREE.ShaderMaterial;
  private finalQuad: FullScreenQuad;
  private finalMat: THREE.ShaderMaterial;
  private bloom: UnrealBloomPass;
  private flyA: THREE.WebGLRenderTarget | null = null;
  private flyB: THREE.WebGLRenderTarget | null = null;
  private flightQuad: FullScreenQuad;
  private flightMat: THREE.ShaderMaterial;
  private backA: THREE.WebGLRenderTarget | null = null;
  private backB: THREE.WebGLRenderTarget | null = null;
  private blurMat: THREE.ShaderMaterial;
  private blurQuad: FullScreenQuad;

  constructor(
    private renderer: THREE.WebGLRenderer,
    public width: number,
    public height: number,
  ) {
    const msaa = Math.min(4, renderer.capabilities.maxSamples);
    this.rtA = makeRT(width, height, msaa);
    this.rtB = makeRT(width, height, msaa);
    this.rtMix = makeRT(width, height);
    this.rtAccum = makeRT(width, height);
    this.copyMat = new THREE.ShaderMaterial({
      vertexShader: quadVert,
      fragmentShader: copyFrag,
      uniforms: { tSrc: { value: null }, uWeight: { value: 1 } },
      depthTest: false,
      depthWrite: false,
      // Premultiplied so additive blending is ONE, ONE: each sample contributes exactly its weight.
      premultipliedAlpha: true,
    });
    this.copyQuad = new FullScreenQuad(this.copyMat);
    this.transMat = new THREE.ShaderMaterial({
      vertexShader: quadVert,
      fragmentShader: transitionFrag,
      uniforms: {
        tA: { value: null },
        tB: { value: null },
        uP: { value: 0 },
        uType: { value: 0 },
        uDir: { value: new THREE.Vector2(1, 0) },
        uColor: { value: new THREE.Vector3(0, 0, 0) },
        uRes: { value: new THREE.Vector2(width, height) },
        uSeed: { value: 0 },
        tMask: { value: null },
        uMaskRect: { value: new THREE.Vector4() },
        uMaskP0: { value: new THREE.Vector2() },
        uMaskO: { value: new THREE.Vector2() },
        uMaskS: { value: 1 },
        uMaskA: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.transQuad = new FullScreenQuad(this.transMat);
    this.finalMat = new THREE.ShaderMaterial({
      vertexShader: quadVert,
      fragmentShader: finalFrag,
      uniforms: {
        tSrc: { value: null },
        uRes: { value: new THREE.Vector2(width, height) },
        uChromatic: { value: 0 },
        uVignette: { value: 0 },
        uGrain: { value: 0 },
        uExposure: { value: 1 },
        uContrast: { value: 1 },
        uSaturation: { value: 1 },
        uTonemap: { value: 0 },
        uFrame: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.finalQuad = new FullScreenQuad(this.finalMat);
    this.flightMat = new THREE.ShaderMaterial({
      vertexShader: quadVert,
      fragmentShader: flightFrag,
      uniforms: {
        tA: { value: null },
        tB: { value: null },
        uRes: { value: new THREE.Vector2(width, height) },
        uC: { value: new THREE.Vector2() },
        uCA: { value: new THREE.Vector2() },
        uCB: { value: new THREE.Vector2() },
        uKA: { value: 1 },
        uKB: { value: 1 },
        uWA: { value: 1 },
        uWB: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      // The copies are premultiplied: draw them over with ONE, ONE_MINUS_SRC_ALPHA.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.flightQuad = new FullScreenQuad(this.flightMat);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.5, 0.5, 0.8);
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: quadVert,
      fragmentShader: blurFrag,
      uniforms: { tSrc: { value: null }, uStep: { value: new THREE.Vector2() }, uSigma: { value: 1 } },
      depthTest: false,
      depthWrite: false,
    });
    this.blurQuad = new FullScreenQuad(this.blurMat);
  }

  setSize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    for (const rt of [this.rtA, this.rtB, this.rtMix, this.rtAccum, this.flyA, this.flyB]) rt?.setSize(w, h);
    this.backA?.setSize(Math.ceil(w / 2), Math.ceil(h / 2));
    this.backB?.setSize(Math.ceil(w / 2), Math.ceil(h / 2));
    this.bloom.setSize(w, h);
    this.flightMat.uniforms.uRes.value.set(w, h);
    this.transMat.uniforms.uRes.value.set(w, h);
    this.finalMat.uniforms.uRes.value.set(w, h);
  }

  renderScene(scene: THREE.Scene, camera: THREE.Camera, clear: THREE.Color, target: THREE.WebGLRenderTarget): void {
    const r = this.renderer;
    r.setRenderTarget(target);
    r.setClearColor(clear, 1);
    r.clear(true, true, true);
    // Glass: draw what lies below it, blur that into the backdrop, then draw the glass and what lies above.
    let cut = Infinity;
    let blur = 0;
    const drawn: THREE.Object3D[] = [];
    scene.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (!(m.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine)) return;
      drawn.push(o);
      const g = o.userData.glass as GlassTag | undefined;
      if (g) {
        cut = Math.min(cut, o.renderOrder);
        blur = Math.max(blur, g.blur);
      }
    });
    if (cut === Infinity) {
      r.render(scene, camera);
      return;
    }
    const above = drawn.filter((o) => o.renderOrder >= cut);
    for (const o of above) o.visible = false;
    r.render(scene, camera);
    for (const o of above) o.visible = true;
    this.blurBackdrop(target, blur);
    const below = drawn.filter((o) => o.renderOrder < cut);
    for (const o of below) o.visible = false;
    r.setRenderTarget(target);
    r.render(scene, camera);
    for (const o of below) o.visible = true;
  }

  /** Half-resolution blurred copy of `src` for glass to refract. `blur` is in full-resolution px. */
  private blurBackdrop(src: THREE.WebGLRenderTarget, blur: number): void {
    const w = Math.ceil(this.width / 2);
    const h = Math.ceil(this.height / 2);
    this.backA ??= makeRT(w, h);
    this.backB ??= makeRT(w, h);
    const u = this.blurMat.uniforms;
    const sigma = Math.max(0.5, blur / 2);
    u.uSigma.value = sigma;
    u.tSrc.value = src.texture;
    u.uStep.value.set(1 / this.width, 0);
    // First pass also downsamples: step in source texels, sigma in half-res texels doubled.
    u.uSigma.value = sigma * 2;
    this.renderer.setRenderTarget(this.backA);
    this.blurQuad.render(this.renderer);
    u.tSrc.value = this.backA.texture;
    u.uStep.value.set(0, 1 / h);
    u.uSigma.value = sigma;
    this.renderer.setRenderTarget(this.backB);
    this.blurQuad.render(this.renderer);
    BACKDROP.tBackdrop.value = this.backB.texture;
    BACKDROP.uViewRes.value.set(this.width, this.height);
  }

  /** Renders only the objects on the SOLO channel, over transparent black (premultiplied result). */
  renderSolo(scene: THREE.Scene, camera: THREE.Camera, which: 'a' | 'b'): void {
    const msaa = Math.min(4, this.renderer.capabilities.maxSamples);
    if (which === 'a') this.flyA ??= makeRT(this.width, this.height, msaa);
    else this.flyB ??= makeRT(this.width, this.height, msaa);
    const target = which === 'a' ? this.flyA! : this.flyB!;
    const r = this.renderer;
    const saved = camera.layers.mask;
    camera.layers.set(SOLO);
    r.setRenderTarget(target);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, true);
    r.render(scene, camera);
    camera.layers.mask = saved;
  }

  /**
   * Draws a shared element in flight over `target`, from the copies last rendered with renderSolo.
   * The center travels in a straight line, the size changes geometrically, and the outgoing copy
   * hands over to the incoming one through the middle of the flight.
   */
  flight(target: THREE.WebGLRenderTarget, f: FlightState): void {
    const u = this.flightMat.uniforms;
    const q = Math.min(1, Math.max(0, f.progress));
    const { from: A, to: B } = f;
    const w = A.w * Math.pow(B.w / A.w, q);
    const h = A.h * Math.pow(B.h / A.h, q);
    u.tA.value = this.flyA!.texture;
    u.tB.value = this.flyB!.texture;
    u.uC.value.set(A.cx + (B.cx - A.cx) * q, A.cy + (B.cy - A.cy) * q);
    u.uCA.value.set(A.cx, A.cy);
    u.uCB.value.set(B.cx, B.cy);
    u.uKA.value = Math.sqrt((w / A.w) * (h / A.h));
    u.uKB.value = Math.sqrt((w / B.w) * (h / B.h));
    const t = Math.min(1, Math.max(0, (q - 0.2) / 0.6));
    const wb = t * t * (3 - 2 * t);
    u.uWA.value = 1 - wb;
    u.uWB.value = wb;
    this.renderer.setRenderTarget(target);
    this.flightQuad.render(this.renderer);
  }

  mix(t: TransitionState): THREE.WebGLRenderTarget {
    const u = this.transMat.uniforms;
    u.tA.value = this.rtA.texture;
    u.tB.value = this.rtB.texture;
    u.uP.value = t.progress;
    u.uType.value = Math.max(0, TRANSITIONS.indexOf(t.type));
    u.uDir.value.set(t.direction[0], t.direction[1]);
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    u.uColor.value.set(lin(t.color.r), lin(t.color.g), lin(t.color.b));
    u.uSeed.value = t.seed;
    if (t.mask) this.placeMask(t.mask, t.progress, t.maskFrom);
    this.renderer.setRenderTarget(this.rtMix);
    this.transQuad.render(this.renderer);
    return this.rtMix;
  }

  /**
   * Mask transition choreography: the shape pops in at the center holding the next scene (first
   * fifth), then the view dives into its deepest point, which drifts to the center as the zoom grows
   * exponentially, ending when the solid area around it is larger than the frame.
   */
  private placeMask(m: MaskInfo, p: number, from?: ScreenBox): void {
    const u = this.transMat.uniforms;
    const W = this.width;
    const H = this.height;
    const ss = (a: number, b: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    let w = Math.min(W * 0.72, H * 0.62 * m.aspect);
    let h = w / m.aspect;
    let x0 = (W - w) / 2;
    let y0 = (H - h) / 2;
    if (from) {
      // Start exactly over the layer's letters: its ink box is the mask's ink box. No pop-in.
      const [u0, v0, u1, v1] = m.ink;
      w = from.w / (u1 - u0);
      h = from.h / (v1 - v0);
      x0 = from.cx - w * ((u0 + u1) / 2);
      y0 = from.cy - h * ((v0 + v1) / 2);
    }
    const p0x = x0 + m.point[0] * w;
    const p0y = y0 + m.point[1] * h;
    const end = Math.max(1, (Math.hypot(W, H) / 2) * 1.08 / (m.depth * w));
    const lead = from ? 0.04 : 0.18;
    const dive = ss(lead, 1, p);
    const move = ss(lead, 0.85, p);
    u.tMask.value = m.texture;
    u.uMaskRect.value.set(x0, y0, w, h);
    u.uMaskP0.value.set(p0x, p0y);
    u.uMaskO.value.set(p0x + (W / 2 - p0x) * move, p0y + (H / 2 - p0y) * move);
    // The shape pops in quickly (85% to 100%), then the dive takes over. Over a layer it is already there.
    u.uMaskS.value = (from ? 1 : 0.85 + 0.15 * ss(0, 0.18, p)) * Math.pow(end, dive * dive);
    u.uMaskA.value = from ? 1 : ss(0, 0.07, p);
  }

  /** Small copies of two motion blur samples, to tell whether anything moves within a frame. */
  private snaps: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private snapPx: [Uint8Array, Uint8Array] | null = null;

  /** Copies `src` into small snapshot `slot` (480 wide), for `snapshotsDiffer`. */
  snapshot(src: THREE.WebGLRenderTarget, slot: 0 | 1): void {
    if (!this.snaps) {
      const w = 480;
      const h = Math.max(1, Math.round((480 * this.height) / this.width));
      const mk = () => new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, colorSpace: THREE.LinearSRGBColorSpace });
      this.snaps = [mk(), mk()];
      this.snapPx = [new Uint8Array(w * h * 4), new Uint8Array(w * h * 4)];
    }
    this.copyMat.uniforms.tSrc.value = src.texture;
    this.copyMat.uniforms.uWeight.value = 1;
    this.copyMat.blending = THREE.NoBlending;
    this.copyMat.transparent = false;
    this.renderer.setRenderTarget(this.snaps[slot]);
    this.copyQuad.render(this.renderer);
  }

  /** True when the two snapshots differ visibly anywhere (more than 3 of 255 in a channel). */
  snapshotsDiffer(): boolean {
    if (!this.snaps || !this.snapPx) return true;
    const [a, b] = this.snaps;
    this.renderer.readRenderTargetPixels(a, 0, 0, a.width, a.height, this.snapPx[0]);
    this.renderer.readRenderTargetPixels(b, 0, 0, b.width, b.height, this.snapPx[1]);
    const [pa, pb] = this.snapPx;
    for (let i = 0; i < pa.length; i++) if (Math.abs(pa[i] - pb[i]) > 3) return true;
    return false;
  }

  /** Adds `src` into the accumulation buffer with the given weight. */
  accumulate(src: THREE.WebGLRenderTarget, weight: number, first: boolean): void {
    this.copyMat.uniforms.tSrc.value = src.texture;
    this.copyMat.uniforms.uWeight.value = weight;
    this.copyMat.blending = first ? THREE.NoBlending : THREE.AdditiveBlending;
    this.copyMat.transparent = !first;
    this.renderer.setRenderTarget(this.rtAccum);
    if (first) this.renderer.clear(true, false, false);
    this.copyQuad.render(this.renderer);
  }

  /** Copies src into rtMix so bloom can write into it without touching scene buffers. */
  private toWorking(src: THREE.WebGLRenderTarget): THREE.WebGLRenderTarget {
    if (src === this.rtMix || src === this.rtAccum) return src;
    this.copyMat.uniforms.tSrc.value = src.texture;
    this.copyMat.uniforms.uWeight.value = 1;
    this.copyMat.blending = THREE.NoBlending;
    this.copyMat.transparent = false;
    this.renderer.setRenderTarget(this.rtMix);
    this.copyQuad.render(this.renderer);
    return this.rtMix;
  }

  present(src: THREE.WebGLRenderTarget, post: ResolvedPost, frame: number): void {
    const r = this.renderer;
    let input = src;
    if (post.bloom && post.bloom.strength > 0) {
      input = this.toWorking(src);
      this.bloom.strength = post.bloom.strength;
      this.bloom.radius = post.bloom.radius;
      this.bloom.threshold = post.bloom.threshold;
      this.bloom.render(r, input, input, 0, false);
    }
    const u = this.finalMat.uniforms;
    u.tSrc.value = input.texture;
    u.uChromatic.value = post.chromatic;
    u.uVignette.value = post.vignette;
    u.uGrain.value = post.grain;
    u.uExposure.value = post.exposure;
    u.uContrast.value = post.contrast;
    u.uSaturation.value = post.saturation;
    u.uTonemap.value = post.tonemap === 'aces' ? 1 : post.tonemap === 'agx' ? 2 : post.tonemap === 'soft' ? 3 : 0;
    u.uFrame.value = frame % 1000;
    r.setRenderTarget(null);
    this.finalQuad.render(r);
  }

  dispose(): void {
    for (const rt of [this.rtA, this.rtB, this.rtMix, this.rtAccum, this.flyA, this.flyB, this.backA, this.backB]) rt?.dispose();
    this.bloom.dispose();
    this.blurMat.dispose();
    this.flightMat.dispose();
    this.copyMat.dispose();
    this.snaps?.forEach((t) => t.dispose());
    this.transMat.dispose();
    this.finalMat.dispose();
  }
}
