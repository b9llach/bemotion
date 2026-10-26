import * as THREE from 'three';
import type { Camera as CameraSpec } from '../spec/schema';
import type { EngineContext } from './context';
import { TrackSet } from './anim/keyframes';
import { clamp01, resolveEase, type EaseFn } from './anim/easing';
import { fbm1, noise1 } from './util/random';
import type { DofState } from './layers/base';

const DEG = Math.PI / 180;

interface Move {
  name: string;
  at: number;
  duration: number;
  ease: EaseFn;
  p: Record<string, any>;
}

interface CamState {
  x: number;
  y: number;
  z: number;
  tx: number;
  ty: number;
  tz: number;
  fov: number;
  roll: number;
  orbit: number;
  tilt: number;
}

const DEFAULT_DURATION: Record<string, number> = {
  pushIn: 2,
  pullOut: 2,
  panLeft: 1.5,
  panRight: 1.5,
  craneUp: 1.5,
  craneDown: 1.5,
  orbit: 3,
  tilt: 2,
  roll: 1,
  zoom: 1,
  dollyZoom: 2,
  punch: 0.45,
  shake: 0.5,
  drift: Infinity,
  whip: 0.45,
  moveTo: 1.2,
};

export const CAMERA_MOVES = Object.keys(DEFAULT_DURATION);

/** World-space point a camera tracking layer `id` looks at, at scene time `t` (see Layer.focusPoint). */
export type FocusResolver = (id: string, t: number, settle: number | false) => THREE.Vector3 | null;

/**
 * Perspective camera calibrated so that 1 world unit = 1 pixel on the z = 0 plane.
 * Moves stack: persistent moves (pushIn, orbit...) keep their end state, transient ones (punch, shake) return to rest.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private tracks: TrackSet;
  private moves: Move[];
  private baseFov: number;
  /** Set by the scene: finds where a tracked layer is at a given time. */
  focus?: FocusResolver;

  constructor(
    private spec: CameraSpec | undefined,
    private ctx: EngineContext,
    private seed: number,
  ) {
    this.baseFov = spec?.fov ?? 30;
    this.camera = new THREE.PerspectiveCamera(this.baseFov, ctx.width / ctx.height, 1, 60000);
    this.tracks = new TrackSet(spec?.keyframes, ctx);
    this.moves = (spec?.moves ?? []).map((m) => {
      const { preset, at, duration, ease, ...p } = m;
      if (!(preset in DEFAULT_DURATION)) throw new Error(`Unknown camera move "${preset}". Available: ${CAMERA_MOVES.join(', ')}`);
      const start = ctx.time(at, 0);
      const dur = ctx.time(duration, Math.min(DEFAULT_DURATION[preset], ctx.sceneDuration - start));
      if (preset === 'punch') ctx.event('impact', start, 0.45);
      if (preset === 'whip' || preset === 'moveTo') ctx.event('whoosh', start, preset === 'whip' ? 1 : 0.7);
      return { name: preset, at: start, duration: Math.max(dur, 0.0001), ease: resolveEase(ease, preset === 'whip' ? 'swift' : 'inOutCubic'), p };
    });
  }

  /** Depth of field at scene time t, or null when the scene has none. */
  dofAt(t: number): DofState | null {
    const d = this.spec?.dof;
    if (!d) return null;
    return {
      z: this.tracks.num('dofZ', t, d.z ?? 0),
      strength: this.tracks.num('dofStrength', t, d.strength ?? 0.03),
      max: d.max ?? 30,
    };
  }

  /** Distance from the z = 0 plane at which `fov` shows exactly `height` pixels. */
  distanceFor(fov: number): number {
    return this.ctx.height / 2 / Math.tan((fov * DEG) / 2);
  }

  /** True when the camera tracks a layer and must be updated after layers. */
  get follows(): string | undefined {
    return this.spec?.follow?.target;
  }

  /** Ids of the layers `moveTo` moves track. */
  get targets(): string[] {
    return this.moves.filter((m) => m.name === 'moveTo' && typeof m.p.target === 'string').map((m) => m.p.target);
  }

  /**
   * Where a tracked layer is at time t, in design pixels, averaged over a short window around t so the
   * camera glides through word-by-word reveals instead of stepping. Pure function of t (deterministic).
   */
  private trackPoint(id: string, t: number, p: Record<string, any>): { x: number; y: number } | null {
    if (!this.focus) return null;
    const win = Math.max(0, p.smooth ?? 0.5);
    // Half the visible width at the move's zoom, in world pixels (the scene zoom scales layers).
    const zs = this.ctx.sceneZoom ?? 1;
    const settle = p.settle === false ? false : (this.ctx.width / 2 / Math.max(0.05, p.zoom ?? 1)) * zs;
    const n = win > 0 ? 9 : 1;
    let x = 0;
    let y = 0;
    let wsum = 0;
    for (let i = 0; i < n; i++) {
      const u = n === 1 ? 0 : i / (n - 1) - 0.5;
      const w = 1 - Math.abs(u) * 1.6;
      const v = this.focus(id, t + u * win, settle);
      if (!v) return null;
      x += v.x * w;
      y += v.y * w;
      wsum += w;
    }
    // Layers sit inside the scene's zoom group; camera positions are in unzoomed design pixels.
    const off = (p.offset as number[] | undefined) ?? [0, 0];
    return { x: x / wsum / zs + (off[0] ?? 0), y: y / wsum / zs + (off[1] ?? 0) };
  }

  update(t: number, followPos?: THREE.Vector3): void {
    const s = this.spec ?? {};
    const tr = this.tracks;
    const x = tr.num('x', t, s.x ?? 0);
    const y = tr.num('y', t, s.y ?? 0);
    const st: CamState = {
      x,
      y,
      z: tr.num('z', t, s.z ?? 0),
      tx: tr.num('targetX', t, s.targetX ?? NaN),
      ty: tr.num('targetY', t, s.targetY ?? NaN),
      tz: tr.num('targetZ', t, s.targetZ ?? 0),
      fov: tr.num('fov', t, this.baseFov),
      roll: tr.num('roll', t, s.roll ?? 0),
      orbit: tr.num('orbit', t, 0),
      tilt: tr.num('tilt', t, 0),
    };
    let shakeX = 0;
    let shakeY = 0;
    let shakeRoll = 0;
    let dollyZ = 0;
    for (const m of this.moves) {
      if (t < m.at) continue;
      const raw = clamp01((t - m.at) / m.duration);
      const q = m.ease(raw);
      const amt = m.p.amount;
      switch (m.name) {
        case 'pushIn':
          st.z -= q * (amt ?? 450);
          break;
        case 'pullOut':
          st.z += q * (amt ?? 450);
          break;
        case 'panLeft':
          st.x -= q * (amt ?? 300);
          break;
        case 'panRight':
          st.x += q * (amt ?? 300);
          break;
        case 'craneUp':
          st.y += q * (amt ?? 250);
          break;
        case 'craneDown':
          st.y -= q * (amt ?? 250);
          break;
        case 'whip': {
          const dir = m.p.direction ?? 'right';
          const d = amt ?? this.ctx.width;
          if (dir === 'left') st.x -= q * d;
          else if (dir === 'up') st.y += q * d;
          else if (dir === 'down') st.y -= q * d;
          else st.x += q * d;
          break;
        }
        case 'orbit':
          st.orbit += q * (m.p.angle ?? 30);
          break;
        case 'tilt':
          st.tilt += q * (m.p.angle ?? 15);
          break;
        case 'roll':
          st.roll += q * (m.p.angle ?? 8);
          break;
        case 'zoom':
          st.fov -= q * (amt ?? 8);
          break;
        case 'moveTo': {
          // Glide so (x, y) is centered and the z = 0 plane appears `zoom` times larger.
          const dist = this.distanceFor(this.baseFov);
          const k = Math.max(0.05, m.p.zoom ?? 1);
          // With a target, glide onto that layer and keep tracking it (a text's reading position)
          // until a later move takes over.
          const tp = typeof m.p.target === 'string' ? this.trackPoint(m.p.target, t, m.p) : null;
          const gx = tp ? tp.x : m.p.x;
          const gy = tp ? tp.y : m.p.y;
          if (gx !== undefined) st.x += (gx - st.x) * q;
          if (gy !== undefined) st.y += (gy - st.y) * q;
          const targetZ = m.p.z !== undefined ? m.p.z : dist / k - dist;
          // Glide magnification at an even visual rate: interpolate it in log space. Moving the
          // camera distance evenly instead barely changes the view for most of a deep dive and then
          // rushes at the end (magnification goes as 1 / distance).
          const k0 = dist / (dist + st.z);
          const k1 = dist / (dist + targetZ);
          if (dist + st.z > 1 && dist + targetZ > 1 && Math.abs(Math.log(k1 / k0)) > 1e-6) {
            st.z = dist / (k0 * Math.pow(k1 / k0, q)) - dist;
          } else {
            st.z += (targetZ - st.z) * q;
          }
          break;
        }
        case 'dollyZoom': {
          const from = st.fov;
          const to = from + q * (amt ?? 25);
          dollyZ += this.distanceFor(to) - this.distanceFor(from);
          st.fov = to;
          break;
        }
        case 'punch': {
          if (raw >= 1) break;
          const env = raw < 0.18 ? Math.sin((raw / 0.18) * Math.PI * 0.5) : Math.pow(1 - (raw - 0.18) / 0.82, 2.2);
          st.fov -= env * (amt ?? 4);
          break;
        }
        case 'shake': {
          if (raw >= 1) break;
          const decay = Math.pow(1 - raw, 2);
          const a = (amt ?? 18) * decay;
          const f = m.p.frequency ?? 30;
          shakeX += noise1((t - m.at) * f, this.seed) * a;
          shakeY += noise1((t - m.at) * f, this.seed + 17) * a;
          shakeRoll += noise1((t - m.at) * f, this.seed + 29) * (m.p.roll ?? 0.8) * decay;
          break;
        }
        case 'drift': {
          const a = amt ?? 14;
          const sp = m.p.speed ?? 0.35;
          shakeX += fbm1(t * sp, this.seed + 3) * a;
          shakeY += fbm1(t * sp, this.seed + 9) * a;
          shakeRoll += fbm1(t * sp, this.seed + 5) * (m.p.roll ?? 0.4);
          break;
        }
      }
    }

    // A zoomed scene (narrower formats) scales its layers about the center; camera positions follow
    // so moves still land on the same layers. Distance is left alone: magnification stays the same.
    const zs = this.ctx.sceneZoom ?? 1;
    if (zs !== 1) {
      st.x *= zs;
      st.y *= zs;
      st.tx *= zs;
      st.ty *= zs;
      st.tz *= zs;
    }
    const dist = this.distanceFor(this.baseFov);
    const tx = (Number.isNaN(st.tx) ? st.x : st.tx) + shakeX * 0.3;
    const ty = (Number.isNaN(st.ty) ? st.y : st.ty) + shakeY * 0.3;
    const target = new THREE.Vector3(tx, ty, st.tz);
    const pos = new THREE.Vector3(st.x + shakeX, st.y + shakeY, dist + st.z + dollyZ);
    const f = this.spec?.follow;
    if (f && followPos) {
      // Blend from the free camera to a chase camera locked on the target layer.
      const w = Math.min(1, Math.max(0, this.tracks.num('follow', t, 1)));
      const off = f.offset ?? [0, 0, 900];
      const fp = new THREE.Vector3(
        followPos.x + this.tracks.num('followX', t, off[0]) + shakeX,
        followPos.y + this.tracks.num('followY', t, off[1]) + shakeY,
        followPos.z + this.tracks.num('followZ', t, off[2]),
      );
      pos.lerp(fp, w);
      target.lerp(followPos, w);
    }
    if (st.orbit || st.tilt) {
      const off = pos.clone().sub(target);
      off.applyEuler(new THREE.Euler(-st.tilt * DEG, st.orbit * DEG, 0, 'YXZ'));
      pos.copy(target).add(off);
    }
    const cam = this.camera;
    cam.position.copy(pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(target);
    cam.rotateZ((st.roll + shakeRoll) * DEG);
    if (cam.fov !== st.fov) {
      cam.fov = st.fov;
    }
    cam.aspect = this.ctx.width / this.ctx.height;
    cam.updateProjectionMatrix();
  }
}
