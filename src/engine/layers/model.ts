import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { ModelLayer as ModelSpec } from '../../spec/schema';
import { Layer } from './base';
import { buildMaterial } from './mesh';
import { toThreeColor } from '../util/color';
import { applyFinish } from '../textures';

const DEG = Math.PI / 180;
const loader = new GLTFLoader();
const cache = new Map<string, Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>>();

/**
 * A 3D model from a glTF / GLB file (Blender, Spline, Sketchfab...). It is scaled so its largest
 * dimension equals `size` px and centered on its bounding box. Animation clips play in sync with the
 * timeline (seeked per frame, so renders stay deterministic).
 */
export class ModelLayer extends Layer<ModelSpec> {
  private model!: THREE.Object3D;
  private mixer?: THREE.AnimationMixer;
  private materials: THREE.Material[] = [];
  private dims = { w: 0, h: 0 };

  size() {
    return this.dims;
  }

  async load(): Promise<void> {
    const s = this.spec;
    const url = this.ctx.asset(s.src);
    let p = cache.get(url);
    if (!p) {
      p = loader.loadAsync(url).then((g) => ({ scene: g.scene, animations: g.animations }));
      cache.set(url, p);
    }
    const gltf = await p;
    // Clone so the same file can appear several times.
    const model = gltf.scene.clone(true);
    const box = new THREE.Box3().setFromObject(model);
    const dim = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const k = (s.size ?? 400) / Math.max(dim.x, dim.y, dim.z, 1e-6);
    const holder = new THREE.Group();
    model.position.sub(center);
    holder.add(model);
    holder.scale.setScalar(k);
    this.dims = { w: dim.x * k, h: dim.y * k };

    const override = s.material ? buildMaterial({ material: s.material, color: s.color, roughness: s.roughness, metalness: s.metalness } as never, this.ctx.threeColor(s.color ?? '#FFFFFF'), this.ctx.envMap) : null;
    // A shared override material must only get its finish once (it rewrites roughness).
    const finished = new Set<THREE.Material>();
    holder.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = s.shadow !== false;
      m.receiveShadow = s.shadow !== false;
      if (override) {
        m.material = override;
      } else {
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        m.material = mats.map((mat) => {
          const c = mat.clone() as THREE.MeshStandardMaterial;
          if (s.color && 'color' in c) c.color = toThreeColor(this.ctx.color(s.color));
          if (s.roughness !== undefined && 'roughness' in c) c.roughness = s.roughness;
          if (s.metalness !== undefined && 'metalness' in c) c.metalness = s.metalness;
          return c;
        }) as unknown as THREE.Material;
        if (mats.length === 1) m.material = (m.material as unknown as THREE.Material[])[0];
      }
      const list = Array.isArray(m.material) ? m.material : [m.material];
      if (s.finish) for (const mat of list) if (!finished.has(mat)) {
        finished.add(mat);
        applyFinish(mat, s.finish);
      }
      this.materials.push(...list);
    });

    if (gltf.animations.length && s.animation !== false) {
      this.mixer = new THREE.AnimationMixer(model);
      const clip =
        typeof s.animation === 'string'
          ? THREE.AnimationClip.findByName(gltf.animations, s.animation)
          : gltf.animations[typeof s.animation === 'number' ? s.animation : 0];
      if (!clip) throw new Error(`Model has no animation "${s.animation}". Clips: ${gltf.animations.map((a) => a.name).join(', ')}`);
      this.mixer.clipAction(clip).play();
    }
    this.model = holder;
    this.pivot.add(holder);
  }

  protected updateContent(t: number, opacity: number): void {
    const s = this.spec;
    const transparent = opacity < 0.999;
    for (const m of this.materials) {
      if (m.transparent !== transparent) {
        m.transparent = transparent;
        m.needsUpdate = true;
      }
      m.opacity = opacity;
    }
    if (s.spin) this.model.rotation.set(s.spin[0] * t * DEG, s.spin[1] * t * DEG, s.spin[2] * t * DEG);
    if (this.mixer) this.mixer.setTime(Math.max(0, t - this.start) * (s.speed ?? 1));
  }
}
