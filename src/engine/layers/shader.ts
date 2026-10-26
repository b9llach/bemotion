import * as THREE from 'three';
import type { ShaderLayer as ShaderSpec } from '../../spec/schema';
import { Layer, type SceneRuntime } from './base';
import { SHADER_VERT, buildFragment, compileCheck, uniformType, type UniformValue } from './shader-src';

/**
 * A quad drawn by the spec's own GLSL: `frag` inline or `src`, a .glsl file next to the spec. Uniforms
 * from the spec are keyframeable by name; the built-ins come from the scene clock, never the wall clock.
 */
export class ShaderLayer extends Layer<ShaderSpec> {
  private mesh?: THREE.Mesh<THREE.PlaneGeometry, THREE.RawShaderMaterial>;
  private uniformSpec: Record<string, UniformValue> = {};

  constructor(spec: ShaderSpec, rt: SceneRuntime) {
    super(spec, rt);
  }

  private dims(t: number): { w: number; h: number } {
    const s = this.spec;
    return { w: this.num('width', t, s.width ?? this.ctx.width), h: this.num('height', t, s.height ?? this.ctx.height) };
  }

  size() {
    return this.dims(0);
  }

  async load(): Promise<void> {
    const s = this.spec;
    let code = s.frag;
    if (code === undefined) {
      if (!s.src) throw new Error('shader needs `frag` (GLSL source) or `src` (a .glsl file)');
      const res = await fetch(this.ctx.asset(s.src));
      if (!res.ok) throw new Error(`could not load shader "${s.src}" (${res.status})`);
      code = await res.text();
    }
    this.uniformSpec = s.uniforms ?? {};
    const frag = buildFragment(code, this.uniformSpec);
    // Compile once up front so a mistake is an error naming the layer, not a black frame.
    const gl = this.ctx.renderer.getContext() as WebGL2RenderingContext;
    const errors = compileCheck(gl, frag, code);
    if (errors) throw new Error(`shader${s.src ? ` "${s.src}"` : ''} did not compile:\n${errors}`);

    const uniforms: Record<string, THREE.IUniform> = {
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uProgress: { value: 0 },
      uOpacity: { value: 1 },
      uDiscard: { value: 0 },
    };
    for (const [name, v] of Object.entries(this.uniformSpec)) {
      const type = uniformType(v);
      uniforms[name] = { value: type === 'float' ? 0 : type === 'vec2' ? new THREE.Vector2() : type === 'vec3' ? new THREE.Vector3() : new THREE.Vector4() };
    }
    const mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SHADER_VERT,
      fragmentShader: frag,
      uniforms,
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.setupMaterial(this.mesh, mat);
    this.pivot.add(this.mesh);
  }

  protected updateContent(t: number, opacity: number): void {
    const mesh = this.mesh;
    if (!mesh) return;
    const { w, h } = this.dims(t);
    mesh.scale.set(Math.max(1e-3, w), Math.max(1e-3, h), 1);
    const u = mesh.material.uniforms;
    u.uTime.value = t;
    (u.uResolution.value as THREE.Vector2).set(w, h);
    const life = this.end - this.start;
    u.uProgress.value = Number.isFinite(life) && life > 0 ? Math.min(1, Math.max(0, (t - this.start) / life)) : 0;
    u.uOpacity.value = opacity;
    for (const [name, base] of Object.entries(this.uniformSpec)) {
      const type = uniformType(base);
      if (type === 'float') {
        u[name].value = this.num(name, t, base as number);
      } else if (typeof base === 'string') {
        const c = this.colorAt(name, t, base, base);
        (u[name].value as THREE.Vector3).set(c.r, c.g, c.b);
      } else {
        const arr = base as number[];
        const tr = this.tracks.get(name);
        const v = tr && tr.kind === 'array' ? (tr.eval(t) as number[]) : arr;
        (u[name].value as THREE.Vector2 | THREE.Vector3 | THREE.Vector4).fromArray(v.length >= arr.length ? v : arr);
      }
    }
  }
}
