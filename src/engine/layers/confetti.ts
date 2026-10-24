import * as THREE from 'three';
import type { ConfettiLayer as ConfettiSpec } from '../../spec/schema';
import { Layer } from './base';
import { rng } from '../util/random';
import { toThreeColor } from '../util/color';

interface Piece {
  vx: number;
  vy: number;
  vz: number;
  axis: THREE.Vector3;
  spin: number;
  w: number;
  h: number;
  flutter: number;
  phase: number;
}

const DEG = Math.PI / 180;

/** 3D paper confetti: pieces launch with drag and gravity, tumble, flutter and fade. Fully deterministic. */
export class ConfettiLayer extends Layer<ConfettiSpec> {
  private mesh!: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private pieces: Piece[] = [];
  private at = 0;
  private life = 2.6;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private sc = new THREE.Vector3();

  async load(): Promise<void> {
    const s = this.spec;
    const n = s.count ?? 140;
    const r = rng(s.seed ?? this.seed);
    this.at = this.ctx.time(s.at, this.start);
    this.ctx.event('pop', this.at, 1);
    this.ctx.event('sparkle', this.at + 0.05, 0.9);
    this.life = this.ctx.time(s.duration, 2.6);
    const palette = (s.colors ?? ['$primary', '$secondary', '#F472B6', '#FBBF24', '#FFFFFF']).map((c) => toThreeColor(this.ctx.color(c)));
    const power = s.power ?? 1100;
    const dir = (s.direction ?? 90) * DEG;
    const spread = (s.spread ?? 360) * DEG;
    const [smin, smax] = s.size ?? [16, 30];
    const coins = s.pieces === 'coin';
    const mat = coins
      ? new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 1, transparent: true, envMapIntensity: 0.9 })
      : new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide, transparent: true, envMapIntensity: 0.6 });
    // Coins: a thin cylinder turned to face the camera, scaled per piece like the paper quads.
    const geo = coins ? new THREE.CylinderGeometry(0.5, 0.5, 0.09, 40).rotateX(Math.PI / 2) : new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.InstancedMesh(geo as THREE.PlaneGeometry, mat, n);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.renderOrder = this.order;
    for (let i = 0; i < n; i++) {
      const a = dir + (r() - 0.5) * spread;
      const speed = power * (0.35 + r() * 0.65);
      const size = smin + (smax - smin) * r();
      this.pieces.push({
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        vz: (r() - 0.5) * speed * 0.8,
        axis: new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(),
        spin: (4 + r() * 10) * (r() < 0.5 ? -1 : 1),
        w: size,
        h: coins ? size : size * (0.45 + r() * 0.3),
        flutter: 20 + r() * 50,
        phase: r() * Math.PI * 2,
      });
      this.mesh.setColorAt(i, palette[Math.floor(r() * palette.length)]);
    }
    this.pivot.add(this.mesh);
  }

  protected updateContent(t: number, opacity: number): void {
    const s = this.spec;
    const k = s.drag ?? 2.2;
    const g = s.gravity ?? 900;
    const lt = t - this.at;
    const mat = this.mesh.material;
    if (lt < 0 || lt > this.life) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    mat.opacity = opacity * Math.min(1, (this.life - lt) / 0.6);
    const e = Math.exp(-k * lt);
    const drift = (1 - e) / k;
    // Linear drag with gravity: falling pieces approach terminal velocity g / k.
    const fall = (g / k) * (lt - drift);
    this.pieces.forEach((pc, i) => {
      this.p.set(pc.vx * drift + Math.sin(lt * 3 + pc.phase) * pc.flutter * Math.min(1, lt), pc.vy * drift - fall, pc.vz * drift);
      this.q.setFromAxisAngle(pc.axis, pc.spin * lt + pc.phase);
      this.sc.set(pc.w, pc.h, this.spec.pieces === 'coin' ? pc.w : 1);
      this.m.compose(this.p, this.q, this.sc);
      this.mesh.setMatrixAt(i, this.m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
