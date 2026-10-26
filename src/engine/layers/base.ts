import * as THREE from 'three';
import type { AnimRef, Keyframe } from '../../spec/schema';
import type { EngineContext, SfxKind } from '../context';
import { TrackSet } from '../anim/keyframes';
import { applyAnims, identityDelta, resolveAnims, type Delta, type ResolvedAnim } from '../anim/presets';
import { hashString } from '../util/random';
import type { RGBA } from '../util/color';
import { clamp01, resolveEase, type EaseFn } from '../anim/easing';
import { Ribbon } from './ribbon';
import { toSeconds } from '../../spec/time';
import { SpringTable, springParams, type SpringSpec } from '../anim/spring';
import { REACT_TRANSFORM, applyReact, reactList, type ReactSpec } from '../anim/react';

const DEG = Math.PI / 180;

/** Transform channels a spring can follow (see Layer.targetAt). */
const X = 0, Y = 1, Z = 2, RX = 3, RY = 4, RZ = 5, S = 6, SX = 7, SY = 8, OP = 9, CHANNELS = 10;
/** Spring `props` names to channels. */
const SPRING_PROPS: Record<string, number[]> = { x: [X], y: [Y], z: [Z], rotate: [RZ], rotateX: [RX], rotateY: [RY], scale: [S, SX, SY], opacity: [OP] };
const SPRING_DEFAULT = ['x', 'y', 'z', 'rotate', 'rotateX', 'rotateY', 'scale'];

/** Offset a spring group gives a child for follow-through (in the group's local frame). */
export interface FollowDelta {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  s: number;
}

/** Fields every layer accepts. */
export interface CommonSpec {
  type: string;
  id?: string;
  share?: string;
  x?: number;
  y?: number;
  z?: number;
  rotate?: number;
  rotateX?: number;
  rotateY?: number;
  rotateZ?: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  opacity?: number;
  origin?: string | [number, number];
  anchor?: string | [number, number];
  sound?: false | SfxKind | { sound: SfxKind; at?: number | string; gain?: number };
  start?: number | string;
  end?: number | string;
  in?: AnimRef | AnimRef[];
  out?: AnimRef | AnimRef[];
  loop?: AnimRef | AnimRef[];
  keyframes?: Record<string, Keyframe[]>;
  blend?: 'normal' | 'add';
  blur?: number;
  dof?: boolean;
  motionPath?: MotionPathSpec;
  spring?: SpringSpec;
  react?: ReactSpec | ReactSpec[];
}

export interface MotionPathSpec {
  points: number[][];
  at?: number | string;
  duration?: number | string;
  ease?: string | [number, number, number, number];
  smooth?: boolean;
  orient?: boolean;
  trail?: { color?: string; width?: number; length?: number; intensity?: number };
}

/** Depth of field: blur grows with distance from the focal plane. */
export interface DofState {
  z: number;
  strength: number;
  max: number;
}

/** Shared per-scene state that layers can register work with. */
export interface SceneRuntime {
  ctx: EngineContext;
  /** Monotonic counter for painter's-order sorting of flat layers. */
  nextOrder(): number;
  /** Register async work (text layout, texture uploads) that must finish before a frame is captured. */
  waitFor(p: Promise<unknown>): void;
  camera: THREE.PerspectiveCamera;
  /** Current depth-of-field settings, or null when off. */
  dof: DofState | null;
  /** Spec object to JSON path, for mapping layers back to the source file. */
  sourcePaths?: WeakMap<object, (string | number)[]>;
  /**
   * Scene-local time at the middle of the frame being rendered. Motion blur samples times around it;
   * whether a layer is on screen is decided by the frame's own time, so a layer that starts or ends on a
   * cut is not smeared into the neighbouring frame.
   */
  frameTime?: number;
}

/** Sound cue played when a layer enters or leaves with a given preset. */
const SFX_FOR_PRESET: Record<string, SfxKind> = {
  popIn: 'pop', pop: 'pop', scaleIn: 'pop', scale: 'pop', zoomIn: 'pop', zoom: 'pop', spinIn: 'pop', grow: 'pop',
  slideUp: 'swoosh', slideDown: 'swoosh', slideLeft: 'swoosh', slideRight: 'swoosh', slide: 'swoosh', whip: 'whoosh',
  flyIn: 'whoosh', pushIn: 'swoosh', swingIn: 'swoosh', tiltIn: 'soft', riseIn: 'swoosh', dropIn: 'swoosh',
  slam: 'impact', focusIn: 'soft', blurIn: 'soft', zoomOut: 'soft',
};

const ORIGINS: Record<string, [number, number]> = {
  center: [0, 0],
  left: [-0.5, 0],
  right: [0.5, 0],
  top: [0, 0.5],
  bottom: [0, -0.5],
  'top-left': [-0.5, 0.5],
  'top-right': [0.5, 0.5],
  'bottom-left': [-0.5, -0.5],
  'bottom-right': [0.5, -0.5],
};

export abstract class Layer<S extends CommonSpec = CommonSpec> {
  /** Positioned at the layer's x/y/z plus the origin offset. */
  readonly root = new THREE.Group();
  /** Offsets content so rotation and scale happen around the origin. */
  readonly pivot = new THREE.Group();
  readonly children: Layer[] = [];
  readonly ctx: EngineContext;
  readonly tracks: TrackSet;
  start = 0;
  end = Infinity;
  order = 0;
  protected anims: ResolvedAnim[] = [];
  protected seed: number;
  protected opacity = 1;
  /** Groups pass blur to children instead of applying depth of field themselves. */
  protected container = false;
  /** Where this layer's spec lives in the video JSON (null for layers generated by components). */
  sourcePath: (string | number)[] | null = null;
  /** The type written in the spec (`browser`, `card`...), before components expand into groups. */
  sourceType = '';
  /** A group's mask layer (drawn into the stencil only), set by the factory. */
  maskLayer?: Layer;
  /** Parent layer, set by the factory. */
  parent: Layer | null = null;
  /** Live offset applied on top of the animated transform while the editor drags a gizmo. */
  editDelta: { x: number; y: number; z: number; rx: number; ry: number; rz: number; s: number } | null = null;
  /** Set by the factory: true when this layer or an ancestor opted out of depth of field. */
  noDof = false;
  /** Comet trail drawn behind a motion path; attached to the parent by the factory. */
  trail?: Ribbon;
  /** Follow-through from a parent group with `spring.lag`, set by the parent every frame. */
  follow: FollowDelta | null = null;
  private readonly reacts: ReactSpec[];
  private springTable: SpringTable | null = null;
  private springKey = '';
  private readonly vals = new Array<number>(CHANNELS).fill(0);
  private readonly lagVals = new Array<number>(CHANNELS).fill(0);
  private path?: { curve: THREE.Curve<THREE.Vector3>; at: number; duration: number; ease: EaseFn; orient: boolean };
  private worldPos = new THREE.Vector3();

  constructor(
    readonly spec: S,
    protected rt: SceneRuntime,
  ) {
    // A layer with its own `sound` (or `sound: false`) makes no automatic sounds of its own.
    this.ctx = spec.sound !== undefined ? { ...rt.ctx, event: () => {} } : rt.ctx;
    this.root.add(this.pivot);
    this.root.userData.layer = this;
    this.tracks = new TrackSet(spec.keyframes, rt.ctx);
    this.start = this.ctx.time(spec.start, 0);
    this.end = this.ctx.time(spec.end, this.ctx.sceneDuration);
    this.seed = hashString(spec.id ?? `${spec.type}:${JSON.stringify(spec).length}:${spec.x ?? 0}:${spec.y ?? 0}`);
    this.order = rt.nextOrder();
    const win = { start: this.start, end: this.end };
    this.anims = [
      ...resolveAnims(spec.in, 'in', this.ctx, win, this.seed),
      ...resolveAnims(spec.out, 'out', this.ctx, win, this.seed),
      ...resolveAnims(spec.loop, 'loop', this.ctx, win, this.seed),
    ];
    if (spec.motionPath) this.setupPath(spec.motionPath);
    this.reacts = reactList(spec.react);
    for (const a of this.anims) {
      const kind = SFX_FOR_PRESET[a.name];
      if (kind && a.kind !== 'loop') this.ctx.event(kind, a.kind === 'in' ? a.at : a.at + a.duration * 0.3, a.kind === 'in' ? 1 : 0.6);
    }
    if (spec.motionPath?.trail) this.ctx.event('whoosh', this.path!.at, 0.8);
    if (spec.sound) {
      // Plays at the entrance (the first entrance preset, else when the layer appears), so it moves
      // with the layer when scenes change length.
      const s = typeof spec.sound === 'string' ? { sound: spec.sound } : spec.sound;
      const ins = this.anims.filter((a) => a.kind === 'in').map((a) => a.at);
      const entry = ins.length ? Math.min(...ins) : this.start;
      rt.ctx.event(s.sound, entry + toSeconds(s.at, { fps: this.ctx.fps, bpm: this.ctx.bpm }, 0), s.gain ?? 1);
    }
  }

  private setupPath(mp: MotionPathSpec): void {
    const pts = mp.points.map((p) => new THREE.Vector3(p[0], p[1], p[2] ?? 0));
    if (pts.length < 2) throw new Error('motionPath needs at least two points');
    let curve: THREE.Curve<THREE.Vector3>;
    if (mp.smooth === false) {
      const cp = new THREE.CurvePath<THREE.Vector3>();
      for (let i = 1; i < pts.length; i++) cp.add(new THREE.LineCurve3(pts[i - 1], pts[i]));
      curve = cp;
    } else {
      curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    }
    const at = this.ctx.time(mp.at, this.start);
    const duration = this.ctx.time(mp.duration, 1.2);
    this.path = { curve, at, duration, ease: resolveEase(mp.ease, 'inOutCubic'), orient: !!mp.orient };
    if (mp.trail) {
      const length = curve.getLength();
      const flat = curve.getSpacedPoints(Math.max(32, Math.round(length / 6))).map((v) => new THREE.Vector2(v.x, v.y));
      this.trail = new Ribbon(flat, mp.trail.width ?? 6, false, 0);
      this.trail.renderOrder = this.order - 0.5;
    }
  }

  /** Builds geometry, loads assets. Children are loaded by the factory. */
  abstract load(): Promise<void>;

  /** True for layers that read `anchor` themselves (text). */
  protected readonly ownAnchor: boolean = false;

  /** Content size in pixels, used for origins and some presets. */
  size(): { w: number; h: number } {
    return { w: 0, h: 0 };
  }

  /**
   * Where a camera tracking this layer looks at time `t`, in world space: the layer's origin. Text
   * overrides it with the word being revealed. Call after the layer was updated for this frame.
   * `settle`: how far from the center the camera sees (world pixels) once a reveal is done, or false
   * to stay on the last word.
   */
  focusPoint(_t: number, out: THREE.Vector3, _settle: number | false = Infinity): THREE.Vector3 {
    this.root.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.root.matrixWorld);
  }

  /** Called every frame with scene-local time. `blur` is the total blur radius in px for this layer. */
  protected abstract updateContent(t: number, opacity: number, blur: number): void;

  num(name: string, t: number, fallback: number): number {
    const v = this.tracks.num(name, t, fallback);
    // Transform props react in update(), after the spring; the rest react where layers read them.
    return this.reacts.length && !REACT_TRANSFORM.has(name) ? applyReact(this.reacts, name, v, this.ctx.music, () => this.outputTime(t)) : v;
  }

  /** Output seconds (the music's timeline) of scene-local time t. */
  protected outputTime(t: number): number {
    const g = (this.ctx.sceneStart ?? 0) + t;
    return this.ctx.outTime ? this.ctx.outTime(g) : g;
  }

  /**
   * The animated transform at t (keyframes, presets, motion path) into `out`, before spring, react and
   * editor offsets. A pure function of t; returns the presets' added blur.
   */
  private targetAt(t: number, out: number[]): number {
    const s = this.spec;
    const d: Delta = applyAnims(identityDelta(), this.anims, t, this.size());
    let px = this.num('x', t, s.x ?? 0);
    let py = this.num('y', t, s.y ?? 0);
    let pz = this.num('z', t, s.z ?? 0);
    let pathAngle = 0;
    if (this.path) {
      const u = this.pathProgress(t);
      const p = this.path.curve.getPointAt(u);
      px = p.x;
      py = p.y;
      pz = p.z;
      if (this.path.orient) {
        const tan = this.path.curve.getTangentAt(Math.min(0.999, Math.max(0.001, u)));
        pathAngle = Math.atan2(tan.y, tan.x) / DEG;
      }
    }
    out[X] = px + d.x;
    out[Y] = py + d.y;
    out[Z] = pz + d.z;
    out[RX] = this.num('rotateX', t, s.rotateX ?? 0) + d.rx;
    out[RY] = this.num('rotateY', t, s.rotateY ?? 0) + d.ry;
    out[RZ] = this.num('rotateZ', t, this.num('rotate', t, s.rotateZ ?? s.rotate ?? 0)) + d.rz + pathAngle;
    out[S] = this.num('scale', t, s.scale ?? 1);
    out[SX] = this.num('scaleX', t, s.scaleX ?? 1) * d.sx;
    out[SY] = this.num('scaleY', t, s.scaleY ?? 1) * d.sy;
    out[OP] = this.num('opacity', t, s.opacity ?? 1) * d.opacity;
    return d.blur;
  }

  /** The transform at t with the spring applied (when the layer has one), into `out`. */
  private transformAt(t: number, out: number[]): number {
    const blur = this.targetAt(t, out);
    const sp = this.spec.spring;
    if (!sp) return blur;
    const size = this.size();
    const key = `${size.w}x${size.h}`;
    if (!this.springTable || this.springKey !== key) {
      // Rebuilt when the layout changes (a text layer measures itself once its font has loaded).
      const params = springParams(sp)!;
      const props = (typeof sp === 'object' && sp.props) || SPRING_DEFAULT;
      const mask = new Array<boolean>(CHANNELS).fill(false);
      for (const p of props) for (const c of SPRING_PROPS[p] ?? []) mask[c] = true;
      this.springTable = new SpringTable(params, CHANNELS, this.start, (tt, o) => void this.targetAt(tt, o), mask);
      this.springKey = key;
    }
    this.springTable.at(t, out);
    if (this.springTable.sprung[OP]) out[OP] = Math.min(1, Math.max(0, out[OP]));
    return blur;
  }

  colorAt(name: string, t: number, base: string | undefined, fallback: string): RGBA {
    return this.tracks.color(name, t) ?? this.ctx.color(base ?? fallback);
  }

  /** Opacity this frame, including parents (0 when hidden). */
  get effectiveOpacity(): number {
    return this.root.visible ? this.opacity : 0;
  }

  isActive(t: number): boolean {
    const c = this.rt.frameTime ?? t;
    return c >= this.start && c <= this.end;
  }

  update(t: number, parentOpacity: number, parentBlur = 0): void {
    if (!this.isActive(t)) {
      this.root.visible = false;
      if (this.trail) this.trail.visible = false;
      return;
    }
    const s = this.spec;
    const v = this.vals;
    const presetBlur = this.transformAt(t, v);
    const music = this.ctx.music;
    const rs = this.reacts;
    const tOut = () => this.outputTime(t);
    const opacity = (rs.length ? applyReact(rs, 'opacity', v[OP], music, tOut) : v[OP]) * parentOpacity;
    this.updateTrail(t, opacity);
    if (opacity <= 0.0005) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;

    const size = this.size();
    const o = typeof s.origin === 'string' ? ORIGINS[s.origin] ?? [0, 0] : s.origin ?? [0, 0];
    const ox = o[0] * size.w;
    const oy = o[1] * size.h;
    // anchor: x/y name an edge or corner instead of the center (text lays itself out by its own anchor).
    let ax = 0;
    let ay = 0;
    if (s.anchor !== undefined && !this.ownAnchor) {
      const a = typeof s.anchor === 'string' ? ORIGINS[s.anchor] ?? [0, 0] : s.anchor;
      ax = -a[0] * size.w;
      ay = -a[1] * size.h;
    }

    let px = v[X];
    let py = v[Y];
    let pz = v[Z];
    let rx = v[RX];
    let ry = v[RY];
    let rz = v[RZ];
    let sc = v[S];
    let scx = v[SX];
    let scy = v[SY];
    if (rs.length) {
      px = applyReact(rs, 'x', px, music, tOut);
      py = applyReact(rs, 'y', py, music, tOut);
      pz = applyReact(rs, 'z', pz, music, tOut);
      rx = applyReact(rs, 'rotateX', rx, music, tOut);
      ry = applyReact(rs, 'rotateY', ry, music, tOut);
      rz = applyReact(rs, 'rotateZ', applyReact(rs, 'rotate', rz, music, tOut), music, tOut);
      sc = applyReact(rs, 'scale', sc, music, tOut);
      scx = applyReact(rs, 'scaleX', scx, music, tOut);
      scy = applyReact(rs, 'scaleY', scy, music, tOut);
    }
    const e = this.editDelta;
    const f = this.follow;
    if (f) {
      px += f.x;
      py += f.y;
      pz += f.z;
      rx += f.rx;
      ry += f.ry;
      rz += f.rz;
      sc *= f.s;
    }
    this.root.position.set(px + ox + ax + (e?.x ?? 0), py + oy + ay + (e?.y ?? 0), pz + (e?.z ?? 0));
    this.pivot.position.set(-ox, -oy, 0);
    this.root.rotation.set(rx * DEG, ry * DEG, rz * DEG);
    if (e) {
      this.root.rotation.x += e.rx * DEG;
      this.root.rotation.y += e.ry * DEG;
      this.root.rotation.z += e.rz * DEG;
    }
    sc *= e?.s ?? 1;
    this.root.scale.set(Math.max(1e-4, sc * scx), Math.max(1e-4, sc * scy), Math.max(1e-4, sc));
    this.opacity = opacity;
    let ownBlur = this.num('blur', t, s.blur ?? 0) + presetBlur;
    if (rs.length) ownBlur = applyReact(rs, 'blur', ownBlur, music, tOut);
    ownBlur = Math.max(0, ownBlur + parentBlur);
    // World position is needed for depth of field; make sure it is current.
    const blur = this.container ? ownBlur : ownBlur + this.depthBlur();
    this.updateContent(t, opacity, blur);
    this.setFollowThrough(t);
    this.updateChildren(t, opacity, ownBlur);
  }

  /**
   * Follow-through for a group with `spring.lag`: child i moves as the group did i * lag seconds ago,
   * so the pieces trail each other into place. The offset is given in the group's own frame.
   */
  private setFollowThrough(t: number): void {
    const sp = this.spec.spring;
    const lag = typeof sp === 'object' ? sp.lag ?? 0 : 0;
    if (!lag || !this.children.length) return;
    const now = this.vals;
    const then = this.lagVals;
    const inv = this.root.quaternion.clone().invert();
    const sx = this.root.scale.x;
    const sy = this.root.scale.y;
    const sz = this.root.scale.z;
    const d = new THREE.Vector3();
    this.children.forEach((c, i) => {
      if (i === 0) {
        c.follow = null;
        return;
      }
      this.transformAt(t - i * lag, then);
      d.set(then[X] - now[X], then[Y] - now[Y], then[Z] - now[Z]).applyQuaternion(inv);
      const ratio = (then[S] * then[SX]) / Math.max(1e-4, now[S] * now[SX]);
      c.follow = { x: d.x / sx, y: d.y / sy, z: d.z / sz, rx: then[RX] - now[RX], ry: then[RY] - now[RY], rz: then[RZ] - now[RZ], s: Number.isFinite(ratio) && ratio > 0 ? ratio : 1 };
    });
  }

  private pathProgress(t: number): number {
    const p = this.path!;
    return p.ease(clamp01(p.duration <= 0 ? 1 : (t - p.at) / p.duration));
  }

  private updateTrail(t: number, opacity: number): void {
    if (!this.trail || !this.path) return;
    const mp = this.spec.motionPath!;
    const u = this.pathProgress(t);
    const visible = u > 0.001 && u < 0.999 && opacity > 0.001;
    this.trail.visible = visible;
    if (!visible) return;
    const c = this.ctx.color(mp.trail?.color ?? '$primary');
    this.trail.set(c, opacity, u, mp.trail?.intensity ?? 1, mp.trail?.length ?? 0.35);
  }

  /** Blur from the camera's depth of field, based on this layer's world z. */
  protected depthBlur(): number {
    const dof = this.rt.dof;
    if (!dof || dof.strength <= 0 || this.noDof) return 0;
    this.root.updateWorldMatrix(true, false);
    this.worldPos.setFromMatrixPosition(this.root.matrixWorld);
    return Math.min(dof.max, Math.abs(this.worldPos.z - dof.z) * dof.strength);
  }

  protected updateChildren(t: number, opacity: number, blur = 0): void {
    this.maskLayer?.update(t, 1, 0);
    for (const c of this.children) c.update(t, opacity, blur);
  }

  addChild(child: Layer): void {
    child.parent = this;
    this.children.push(child);
    this.pivot.add(child.root);
  }

  /** Applies blending and paint order to a material/mesh owned by this layer. */
  protected setupMaterial(mesh: THREE.Mesh | THREE.Points | THREE.Line, mat: THREE.Material, flat = true): void {
    mesh.renderOrder = this.order;
    if (this.spec.blend === 'add') {
      mat.blending = THREE.AdditiveBlending;
      mat.depthWrite = false;
    }
    if (flat) {
      mat.transparent = true;
      mat.depthWrite = false;
    }
  }

  dispose(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
  }
}
