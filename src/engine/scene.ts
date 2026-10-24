import * as THREE from 'three';
import type { Scene as SceneSpec } from '../spec/schema';
import type { SceneTiming } from '../spec/time';
import type { EngineContext, SfxEvent } from './context';
import type { DofState, Layer, SceneRuntime } from './layers/base';
import { buildLayers } from './layers';
import { CameraRig } from './camera';
import { hashString } from './util/random';
import { generated } from './voice';

export class SceneInstance implements SceneRuntime {
  readonly three = new THREE.Scene();
  /** Holds every layer except backgrounds, scaled by the scene's `zoom`. */
  readonly content = new THREE.Group();
  readonly rig: CameraRig;
  readonly ctx: EngineContext;
  layers: Layer[] = [];
  clearColor: THREE.Color;
  dof: DofState | null = null;
  readonly events: SfxEvent[] = [];
  private orderCounter = 0;
  private pending: Promise<unknown>[] = [];

  constructor(
    readonly spec: SceneSpec,
    readonly timing: SceneTiming,
    baseCtx: EngineContext,
    defaultBackground: string,
  ) {
    const events = this.events;
    this.ctx = {
      ...baseCtx,
      sceneDuration: timing.duration,
      sceneZoom: spec.zoom ?? 1,
      event: (kind, t, gain = 1) => {
        if (Number.isFinite(t) && t >= 0 && t <= timing.duration) events.push({ kind, t, gain });
      },
    };
    this.rig = new CameraRig(spec.camera, this.ctx, hashString(spec.id ?? `scene${timing.index}`));
    this.clearColor = this.ctx.threeColor(spec.background ?? defaultBackground);
    this.three.environment = this.ctx.envMap;
    const envSpec = typeof baseCtx.envSettings === 'object' ? baseCtx.envSettings : null;
    this.three.environmentIntensity = envSpec?.intensity ?? 1;
    this.three.environmentRotation.set(0, ((envSpec?.rotation ?? 0) * Math.PI) / 180, 0);
    const env = baseCtx.environment;
    const studio = env === 'studio';
    const light = env === 'softbox' || env === 'hdri';
    const L = { ...baseCtx.lighting, ...(spec.lighting ?? {}) };
    const hemi = new THREE.HemisphereLight(0xffffff, light ? 0xd8d8de : 0x202030, studio ? 0.15 : light ? 0.9 : 0.6);
    const key = new THREE.DirectionalLight(0xffffff, (L.intensity ?? 1) * (studio ? 1.2 : light ? 1.6 : 2.2));
    const kd = new THREE.Vector3(...(L.key ?? [0.35, 1, 0.45])).normalize();
    const ground = L.ground ?? -420;
    key.position.copy(kd.clone().multiplyScalar(4000)).add(new THREE.Vector3(0, ground, 0));
    key.target.position.set(0, ground, 0);
    const rim = new THREE.DirectionalLight(studio ? 0xffe6c4 : light ? 0xffffff : 0xb9a8ff, studio ? 1.0 : light ? 0.6 : 1.6);
    rim.position.set(-1400, 400, -800);
    this.three.add(hemi, key, key.target, rim);
    this.content.scale.setScalar(spec.zoom ?? 1);
    this.three.add(this.content);
    if (L.shadows) {
      // Soft shadows onto an invisible ground plane: what makes objects sit in a white studio.
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      const cam = key.shadow.camera;
      cam.left = -2600;
      cam.right = 2600;
      cam.top = 2600;
      cam.bottom = -2600;
      cam.near = 100;
      cam.far = 9000;
      key.shadow.radius = L.softness ?? 14;
      key.shadow.blurSamples = 24;
      key.shadow.bias = -0.0002;
      const catcher = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), new THREE.ShadowMaterial({ opacity: L.shadowOpacity ?? 0.16, depthWrite: false }));
      catcher.rotation.x = -Math.PI / 2;
      catcher.position.y = ground;
      catcher.receiveShadow = true;
      catcher.renderOrder = -1000;
      this.three.add(catcher);
    }
  }

  get camera(): THREE.PerspectiveCamera {
    return this.rig.camera;
  }

  nextOrder(): number {
    return ++this.orderCounter;
  }

  waitFor(p: Promise<unknown>): void {
    this.pending.push(p);
  }

  readonly sourcePaths = new WeakMap<object, (string | number)[]>();
  private byId = new Map<string, Layer>();
  /** Every layer in the scene, depth first. */
  allLayers: Layer[] = [];
  private followPos = new THREE.Vector3();

  async build(): Promise<void> {
    // Remember where each spec object sits in the video JSON so the editor can write changes back.
    const index = this.timing.index;
    const mapPaths = (list: unknown[], path: (string | number)[]) =>
      list.forEach((node, i) => {
        // Layers the engine added (captions) are not in the JSON file.
        if (!node || typeof node !== 'object' || generated.has(node)) return;
        const p = [...path, i];
        this.sourcePaths.set(node as object, p);
        const kids = (node as { children?: unknown[] }).children;
        if (Array.isArray(kids)) mapPaths(kids, [...p, 'children']);
      });
    mapPaths(this.spec.layers, ['scenes', index, 'layers']);
    this.layers = await buildLayers(this.spec.layers, this);
    const walk = (l: Layer) => {
      if (l.spec.id) this.byId.set(l.spec.id, l);
      this.allLayers.push(l);
      l.children.forEach(walk);
    };
    this.layers.forEach(walk);
    const f = this.rig.follows;
    if (f && !this.byId.has(f)) throw new Error(`camera.follow.target "${f}" does not match any layer id`);
    for (const id of this.rig.targets) {
      if (!this.byId.has(id)) throw new Error(`camera moveTo target "${id}" does not match any layer id`);
    }
    if (this.rig.targets.length) {
      const probe = new THREE.Vector3();
      this.rig.focus = (id, t, settle) => this.byId.get(id)?.focusPoint(t, probe, settle) ?? null;
    }
    for (const l of this.layers) {
      // Backgrounds fill the frame whatever the zoom.
      (l.spec.type === 'background' ? this.three : this.content).add(l.root);
      if (l.trail) this.content.add(l.trail);
    }
  }

  /** Updates every layer and the camera for scene-local time `t`, then waits for async work (text relayout). */
  async update(t: number): Promise<void> {
    this.dof = this.rig.dofAt(t);
    const follow = this.rig.follows ? this.byId.get(this.rig.follows) : undefined;
    if (follow) {
      // Chase camera: move layers first, then aim at the target's world position.
      for (const l of this.layers) l.update(t, 1);
      follow.root.updateWorldMatrix(true, false);
      this.followPos.setFromMatrixPosition(follow.root.matrixWorld);
      this.rig.update(t, this.followPos);
    } else if (this.rig.focus) {
      // Tracking moves read where layers are this frame.
      for (const l of this.layers) l.update(t, 1);
      this.rig.update(t);
    } else {
      this.rig.update(t);
      for (const l of this.layers) l.update(t, 1);
    }
    if (this.pending.length) {
      const p = this.pending;
      this.pending = [];
      await Promise.all(p);
    }
  }

  dispose(): void {
    for (const l of this.layers) l.dispose();
  }
}
