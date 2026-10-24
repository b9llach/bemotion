import { z } from 'zod';

/**
 * Bemotion scene spec.
 *
 * Coordinates are in pixels with the origin at the center of the frame, +x right, +y up,
 * +z toward the camera. Times are scene-local. A time can be a number of seconds or a string
 * with a unit: "1.5s", "250ms", "12f" (frames) or "4b" (beats, requires `bpm`).
 */

export const Time = z.union([
  z.number(),
  z.string().regex(/^-?\d+(\.\d+)?(s|ms|f|b)?$/, 'time must look like 1.5, "1.5s", "250ms", "12f" or "4b"'),
]);
export type Time = z.infer<typeof Time>;

export const Ease = z.union([z.string(), z.tuple([z.number(), z.number(), z.number(), z.number()])]);
export type Ease = z.infer<typeof Ease>;

export const Color = z.string();
const Vec2 = z.tuple([z.number(), z.number()]);
const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const Keyframe = z.object({
  t: Time,
  v: z.union([z.number(), z.string(), z.array(z.number())]),
  ease: Ease.optional(),
}).strict();
export type Keyframe = z.infer<typeof Keyframe>;

export const Keyframes = z.record(z.string(), z.array(Keyframe));

const AnimObject = z.object({
  preset: z.string(),
  at: Time.optional(),
  duration: Time.optional(),
  ease: Ease.optional(),
}).catchall(z.any());
export const AnimRef = z.union([z.string(), AnimObject]);
export type AnimRef = z.infer<typeof AnimRef>;
const AnimList = z.union([AnimRef, z.array(AnimRef)]);

export const TextAnim = z.object({
  preset: z.string(),
  by: z.enum(['char', 'word', 'line']).optional(),
  at: Time.optional(),
  duration: Time.optional(),
  stagger: Time.optional(),
  ease: Ease.optional(),
  from: z.enum(['start', 'end', 'center', 'edges', 'random']).optional(),
}).catchall(z.any());
export type TextAnim = z.infer<typeof TextAnim>;

export const Finish = z.union([
  z.enum(['polished', 'brushed', 'satin', 'sandblasted', 'hammered']),
  z.object({
    type: z.enum(['polished', 'brushed', 'satin', 'sandblasted', 'hammered']),
    scratches: z.number().min(0).max(1).optional(),
    smudges: z.number().min(0).max(1).optional(),
    scale: z.number().optional(),
    angle: z.number().optional(),
    strength: z.number().optional(),
    seed: z.number().optional(),
  }).strict(),
]);
export type Finish = z.infer<typeof Finish>;

/** A color gradient painted across text: `colors` (2-4 stops, evenly spaced), CSS-style `angle` (90 = left to right). */
export const TextGradient = z.object({
  colors: z.array(Color).min(2).max(4),
  angle: z.number().optional(),
}).strict();
export type TextGradient = z.infer<typeof TextGradient>;

export const Fill = z.union([
  Color,
  z.object({
    type: z.enum(['linear', 'radial']),
    from: Color,
    to: Color,
    angle: z.number().optional(),
    center: Vec2.optional(),
  }).strict(),
]);
export type Fill = z.infer<typeof Fill>;

export const Shadow = z.object({
  color: Color.optional(),
  blur: z.number().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  opacity: z.number().optional(),
  spread: z.number().optional(),
}).strict();
export type Shadow = z.infer<typeof Shadow>;

export const Glow = z.object({
  color: Color.optional(),
  size: z.number().optional(),
  intensity: z.number().optional(),
}).strict();
export type Glow = z.infer<typeof Glow>;

const Origin = z.union([
  z.enum(['center', 'left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right']),
  Vec2,
]);

/** Per-format overrides (see src/spec/formats.ts): fields that replace this node's in "9:16", "1:1", "4:5"; false leaves it out. */
const FormatOverrides = z.record(z.string(), z.union([z.literal(false), z.record(z.string(), z.unknown())]));

const base = {
  id: z.string().optional(),
  formats: FormatOverrides.optional(),
  /** Same name on a layer in the next scene: the element flies across the transition between them. */
  share: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().optional(),
  rotate: z.number().optional(),
  rotateX: z.number().optional(),
  rotateY: z.number().optional(),
  rotateZ: z.number().optional(),
  scale: z.number().optional(),
  scaleX: z.number().optional(),
  scaleY: z.number().optional(),
  opacity: z.number().optional(),
  origin: Origin.optional(),
  start: Time.optional(),
  end: Time.optional(),
  in: AnimList.optional(),
  out: AnimList.optional(),
  loop: AnimList.optional(),
  keyframes: Keyframes.optional(),
  blend: z.enum(['normal', 'add']).optional(),
  blur: z.number().optional(),
  dof: z.boolean().optional(),
  motionPath: z.object({
    points: z.array(z.array(z.number()).min(2).max(3)).min(2),
    at: Time.optional(),
    duration: Time.optional(),
    ease: Ease.optional(),
    smooth: z.boolean().optional(),
    orient: z.boolean().optional(),
    trail: z.object({
      color: Color.optional(),
      width: z.number().optional(),
      length: z.number().optional(),
      intensity: z.number().optional(),
    }).strict().optional(),
  }).strict().optional(),
};

const textStyle = {
  font: z.string().optional(),
  weight: z.number().optional(),
  italic: z.boolean().optional(),
  size: z.number().optional(),
  color: Color.optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  anchor: z.enum(['left', 'center', 'right']).optional(),
  maxWidth: z.number().optional(),
  lineHeight: z.number().optional(),
  letterSpacing: z.number().optional(),
  uppercase: z.boolean().optional(),
  glow: Glow.optional(),
  stroke: z.object({ color: Color.optional(), width: z.number().optional() }).strict().optional(),
  intensity: z.number().optional(),
};

export type Layer =
  | TextLayer | CounterLayer | ShapeLayer | ImageLayer | VideoLayer | PathLayer | IconLayer | SvgLayer | MeshLayer
  | ParticlesLayer | BackgroundLayer | GridLayer | GroupLayer
  | BrowserLayer | PhoneLayer | LaptopLayer | CardLayer | ButtonLayer | CursorLayer | ChartLayer | ToastLayer
  | ProgressLayer | BadgeLayer | AvatarLayer | FlashLayer | GlowLayer | CodeLayer | Marquee | RepeatLayer | ConfettiLayer | ModelLayer;

const TextLayerS = z.object({
  type: z.literal('text'),
  ...base,
  ...textStyle,
  text: z.string(),
  gradient: TextGradient.optional(),
  /** Highlighted substrings: every occurrence, or only the `nth` (0-based) when given. */
  highlight: z.array(z.object({ text: z.string(), color: Color.optional(), gradient: TextGradient.optional(), italic: z.boolean().optional(), nth: z.number().int().min(0).optional() }).strict()).optional(),
  /** Spread the letters of each line so it fills the block width (`maxWidth`, or the widest line). `"all"` includes the last line. */
  justify: z.union([z.boolean(), z.literal('all')]).optional(),
  /** Turn into other texts in sequence: shared letters glide to their new places, the rest fade out and in. */
  morph: z.array(z.object({
    text: z.string(),
    at: Time,
    duration: Time.optional(),
    ease: Ease.optional(),
    size: z.number().optional(),
    color: Color.optional(),
    gradient: TextGradient.optional(),
  }).strict()).optional(),
  animate: TextAnim.optional(),
  animateOut: TextAnim.optional(),
}).strict();
export type TextLayer = z.infer<typeof TextLayerS>;

const CounterLayerS = z.object({
  type: z.literal('counter'),
  ...base,
  ...textStyle,
  from: z.number().optional(),
  to: z.number(),
  decimals: z.number().optional(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  separator: z.boolean().optional(),
  at: Time.optional(),
  duration: Time.optional(),
  ease: Ease.optional(),
}).strict();
export type CounterLayer = z.infer<typeof CounterLayerS>;

const ShapeLayerS = z.object({
  type: z.literal('shape'),
  ...base,
  shape: z.enum(['rect', 'circle', 'pill', 'ring', 'sparkle']).optional(),
  morphTo: z.enum(['rect', 'circle', 'ring', 'sparkle']).optional(),
  morph: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  radius: z.number().optional(),
  fill: Fill.optional(),
  stroke: Color.optional(),
  strokeWidth: z.number().optional(),
  shadow: Shadow.optional(),
  glow: Glow.optional(),
  progress: z.number().optional(),
  intensity: z.number().optional(),
}).strict();
export type ShapeLayer = z.infer<typeof ShapeLayerS>;

const ImageLayerS = z.object({
  type: z.literal('image'),
  ...base,
  src: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  fit: z.enum(['cover', 'contain', 'fill']).optional(),
  radius: z.number().optional(),
  shadow: Shadow.optional(),
  stroke: Color.optional(),
  strokeWidth: z.number().optional(),
}).strict();
export type ImageLayer = z.infer<typeof ImageLayerS>;

const VideoLayerS = z.object({
  type: z.literal('video'),
  ...base,
  src: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  fit: z.enum(['cover', 'contain', 'fill']).optional(),
  radius: z.number().optional(),
  shadow: Shadow.optional(),
  stroke: Color.optional(),
  strokeWidth: z.number().optional(),
  /** Seconds into the clip where playback starts. */
  trim: Time.optional(),
  /** Playback rate (2 = twice as fast). */
  speed: z.number().positive().max(16).optional(),
  /** Play the clip again from `trim` when it ends; otherwise it holds its last frame. */
  repeat: z.boolean().optional(),
  /** Include the clip's own sound in the render (0 = silent, the default). */
  volume: z.number().min(0).max(4).optional(),
  /**
   * Zoom into parts of the clip like an edited product demo. "auto" finds where things happen (typing,
   * menus, panels); or a list of moves: scene-local `at`, the point (`x`, `y` in 0-1 from the clip's
   * top-left), `zoom` (2), `duration` of the move in (0.8), `until` when it pulls back out.
   */
  focus: z.union([z.literal('auto'), z.array(z.object({
    at: Time,
    x: z.number(),
    y: z.number(),
    zoom: z.number().min(1).max(8).optional(),
    duration: Time.optional(),
    until: Time.optional(),
  }).strict())]).optional(),
}).strict();
export type VideoLayer = z.infer<typeof VideoLayerS>;

const PathLayerS = z.object({
  type: z.literal('path'),
  ...base,
  points: z.array(Vec2),
  width: z.number().optional(),
  color: Color.optional(),
  progress: z.number().optional(),
  smooth: z.boolean().optional(),
  closed: z.boolean().optional(),
  area: Color.optional(),
  areaBase: z.number().optional(),
  glow: Glow.optional(),
  intensity: z.number().optional(),
  /** Dashed line: [drawn, gap] in px. */
  dash: z.tuple([z.number(), z.number()]).optional(),
}).strict();
export type PathLayer = z.infer<typeof PathLayerS>;

const IconLayerS = z.object({
  type: z.literal('icon'),
  ...base,
  name: z.string().optional(),
  d: z.string().optional(),
  size: z.number().optional(),
  color: Color.optional(),
  strokeWidth: z.number().optional(),
  progress: z.number().optional(),
  intensity: z.number().optional(),
  dash: z.tuple([z.number(), z.number()]).optional(),
}).strict();
export type IconLayer = z.infer<typeof IconLayerS>;

const SvgLayerS = z.object({
  type: z.literal('svg'),
  ...base,
  d: z.string(),
  viewBox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  width: z.number().optional(),
  fill: Color.optional(),
  stroke: Color.optional(),
  strokeWidth: z.number().optional(),
  /** Draw-on of the stroke, 0-1 (keyframeable). */
  progress: z.number().optional(),
  /** Dashed stroke: [drawn, gap] in px. */
  dash: z.tuple([z.number(), z.number()]).optional(),
  /**
   * A second outline with the same commands as `d` (the same glyph in another weight, a logo variant).
   * Keyframe `morph` from 0 to 1 to blend the shape into it.
   */
  morphTo: z.string().optional(),
  morph: z.number().optional(),
}).strict();
export type SvgLayer = z.infer<typeof SvgLayerS>;

const MeshLayerS = z.object({
  type: z.literal('mesh'),
  ...base,
  geometry: z.enum([
    'box', 'roundedBox', 'sphere', 'torus', 'torusKnot', 'icosahedron', 'octahedron', 'dodecahedron',
    'cylinder', 'cone', 'capsule', 'plane', 'ring', 'blob', 'slab', 'extrude',
  ]),
  /** extrude: outline in pixels; a third number rounds that corner with the given radius. */
  profile: z.array(z.union([Vec2, Vec3])).min(3).optional(),
  /** extrude: cut-outs inside the profile (slots, screen openings). */
  holes: z.array(z.array(z.union([Vec2, Vec3])).min(3)).optional(),
  /** extrude: thickness along z (default 100). */
  depth: z.number().positive().optional(),
  /** extrude: rounded bevel on the front and back edges (default 6, 0 for sharp). */
  bevel: z.number().min(0).optional(),
  /** Receive shadows from other objects (needs lighting.shadows). */
  shadow: z.boolean().optional(),
  size: z.union([z.number(), Vec3]).optional(),
  radius: z.number().optional(),
  tube: z.number().optional(),
  detail: z.number().optional(),
  material: z.enum(['glass', 'chrome', 'metal', 'gold', 'brushed', 'matte', 'glossy', 'ceramic', 'neon', 'iridescent', 'clay', 'wireframe']).optional(),
  color: Color.optional(),
  emissive: Color.optional(),
  emissiveIntensity: z.number().optional(),
  roughness: z.number().optional(),
  metalness: z.number().optional(),
  finish: Finish.optional(),
  spin: Vec3.optional(),
}).strict();
export type MeshLayer = z.infer<typeof MeshLayerS>;

const ParticlesLayerS = z.object({
  type: z.literal('particles'),
  ...base,
  count: z.number().optional(),
  area: Vec3.optional(),
  size: z.union([z.number(), Vec2]).optional(),
  color: Color.optional(),
  colors: z.array(Color).optional(),
  motion: z.enum(['drift', 'rise', 'fall', 'warp', 'burst', 'orbit', 'static']).optional(),
  speed: z.number().optional(),
  seed: z.number().optional(),
  at: Time.optional(),
  shape: z.enum(['dot', 'square', 'streak', 'spark']).optional(),
}).strict();
export type ParticlesLayer = z.infer<typeof ParticlesLayerS>;

const BackgroundLayerS = z.object({
  type: z.literal('background'),
  ...base,
  style: z.enum(['solid', 'linear', 'radial', 'aurora', 'mesh', 'spotlight', 'rays', 'noise', 'dots']).optional(),
  colors: z.array(Color).optional(),
  color: Color.optional(),
  angle: z.number().optional(),
  speed: z.number().optional(),
  intensity: z.number().optional(),
  center: Vec2.optional(),
  seed: z.number().optional(),
}).strict();
export type BackgroundLayer = z.infer<typeof BackgroundLayerS>;

const GridLayerS = z.object({
  type: z.literal('grid'),
  ...base,
  plane: z.enum(['floor', 'wall']).optional(),
  size: Vec2.optional(),
  cell: z.number().optional(),
  color: Color.optional(),
  lineWidth: z.number().optional(),
  fade: z.number().optional(),
  speed: z.number().optional(),
}).strict();
export type GridLayer = z.infer<typeof GridLayerS>;

export interface GroupLayer extends z.infer<typeof GroupBase> {
  children?: Layer[];
  /** Children show only inside this layer's shape (it is not drawn itself). */
  mask?: Layer;
  /** Children show only outside the mask instead. */
  maskInvert?: boolean;
}
const GroupBase = z.object({ type: z.literal('group'), ...base, width: z.number().optional(), height: z.number().optional() });

const BrowserBase = z.object({
  type: z.literal('browser'),
  ...base,
  width: z.number().optional(),
  height: z.number().optional(),
  url: z.string().optional(),
  theme: z.enum(['dark', 'light']).optional(),
  radius: z.number().optional(),
  fill: Color.optional(),
  shadow: z.union([Shadow, z.boolean()]).optional(),
});
export interface BrowserLayer extends z.infer<typeof BrowserBase> { children?: Layer[] }

const PhoneBase = z.object({
  type: z.literal('phone'),
  ...base,
  width: z.number().optional(),
  height: z.number().optional(),
  color: Color.optional(),
  screen: Color.optional(),
  depth: z.number().optional(),
});
export interface PhoneLayer extends z.infer<typeof PhoneBase> { children?: Layer[] }

const LaptopBase = z.object({
  type: z.literal('laptop'),
  ...base,
  width: z.number().optional(),
  color: Color.optional(),
  screen: Color.optional(),
  open: z.number().optional(),
});
export interface LaptopLayer extends z.infer<typeof LaptopBase> { children?: Layer[] }

const CardBase = z.object({
  type: z.literal('card'),
  ...base,
  width: z.number().optional(),
  height: z.number().optional(),
  radius: z.number().optional(),
  fill: Fill.optional(),
  stroke: Color.optional(),
  shadow: z.union([Shadow, z.boolean()]).optional(),
  glow: Glow.optional(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  icon: z.string().optional(),
  accent: Color.optional(),
  padding: z.number().optional(),
});
export interface CardLayer extends z.infer<typeof CardBase> { children?: Layer[] }

const ButtonLayerS = z.object({
  type: z.literal('button'),
  ...base,
  label: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  fill: Fill.optional(),
  color: Color.optional(),
  size: z.number().optional(),
  radius: z.number().optional(),
  icon: z.string().optional(),
  press: Time.optional(),
  glow: Glow.optional(),
}).strict();
export type ButtonLayer = z.infer<typeof ButtonLayerS>;

const CursorLayerS = z.object({
  type: z.literal('cursor'),
  ...base,
  path: z.array(z.object({ t: Time, x: z.number(), y: z.number(), ease: Ease.optional() }).strict()).optional(),
  clicks: z.array(Time).optional(),
  color: Color.optional(),
  size: z.number().optional(),
  style: z.enum(['arrow', 'hand']).optional(),
}).strict();
export type CursorLayer = z.infer<typeof CursorLayerS>;

const ChartLayerS = z.object({
  type: z.literal('chart'),
  ...base,
  kind: z.enum(['bar', 'line', 'area', 'donut']).optional(),
  data: z.array(z.number()),
  labels: z.array(z.string()).optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  color: Color.optional(),
  colors: z.array(Color).optional(),
  at: Time.optional(),
  duration: Time.optional(),
  stagger: Time.optional(),
  gridLines: z.boolean().optional(),
  radius: z.number().optional(),
}).strict();
export type ChartLayer = z.infer<typeof ChartLayerS>;

const ToastLayerS = z.object({
  type: z.literal('toast'),
  ...base,
  title: z.string(),
  body: z.string().optional(),
  icon: z.string().optional(),
  accent: Color.optional(),
  width: z.number().optional(),
  theme: z.enum(['dark', 'light']).optional(),
}).strict();
export type ToastLayer = z.infer<typeof ToastLayerS>;

const ProgressLayerS = z.object({
  type: z.literal('progress'),
  ...base,
  width: z.number().optional(),
  height: z.number().optional(),
  value: z.number().optional(),
  from: z.number().optional(),
  at: Time.optional(),
  duration: Time.optional(),
  ease: Ease.optional(),
  color: Fill.optional(),
  track: Color.optional(),
}).strict();
export type ProgressLayer = z.infer<typeof ProgressLayerS>;

const BadgeLayerS = z.object({
  type: z.literal('badge'),
  ...base,
  label: z.string(),
  icon: z.string().optional(),
  color: Color.optional(),
  fill: Fill.optional(),
  stroke: Color.optional(),
  size: z.number().optional(),
}).strict();
export type BadgeLayer = z.infer<typeof BadgeLayerS>;

const AvatarLayerS = z.object({
  type: z.literal('avatar'),
  ...base,
  initials: z.string().optional(),
  src: z.string().optional(),
  size: z.number().optional(),
  fill: Fill.optional(),
  color: Color.optional(),
  ring: Color.optional(),
}).strict();
export type AvatarLayer = z.infer<typeof AvatarLayerS>;

const FlashLayerS = z.object({
  type: z.literal('flash'),
  ...base,
  color: Color.optional(),
  at: Time.optional(),
  duration: Time.optional(),
  intensity: z.number().optional(),
}).strict();
export type FlashLayer = z.infer<typeof FlashLayerS>;

const GlowLayerS = z.object({
  type: z.literal('glow'),
  ...base,
  color: Color.optional(),
  size: z.number().optional(),
  intensity: z.number().optional(),
}).strict();
export type GlowLayer = z.infer<typeof GlowLayerS>;

const CodeLayerS = z.object({
  type: z.literal('code'),
  ...base,
  code: z.string(),
  language: z.string().optional(),
  size: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  typing: z.boolean().optional(),
  at: Time.optional(),
  speed: z.number().optional(),
  title: z.string().optional(),
  lineHeight: z.number().optional(),
}).strict();
export type CodeLayer = z.infer<typeof CodeLayerS>;

const ModelLayerS = z.object({
  type: z.literal('model'),
  ...base,
  src: z.string(),
  size: z.number().optional(),
  color: Color.optional(),
  material: z.enum(['glass', 'chrome', 'metal', 'gold', 'brushed', 'matte', 'glossy', 'ceramic', 'iridescent', 'clay']).optional(),
  roughness: z.number().optional(),
  metalness: z.number().optional(),
  animation: z.union([z.string(), z.number(), z.literal(false)]).optional(),
  finish: Finish.optional(),
  speed: z.number().optional(),
  spin: Vec3.optional(),
  shadow: z.boolean().optional(),
}).strict();
export type ModelLayer = z.infer<typeof ModelLayerS>;

const ConfettiLayerS = z.object({
  type: z.literal('confetti'),
  ...base,
  count: z.number().optional(),
  colors: z.array(Color).optional(),
  at: Time.optional(),
  duration: Time.optional(),
  power: z.number().optional(),
  direction: z.number().optional(),
  spread: z.number().optional(),
  gravity: z.number().optional(),
  drag: z.number().optional(),
  size: Vec2.optional(),
  seed: z.number().optional(),
  pieces: z.enum(['paper', 'coin']).optional(),
}).strict();
export type ConfettiLayer = z.infer<typeof ConfettiLayerS>;

const RepeatBase = z.object({
  type: z.literal('repeat'),
  ...base,
  count: z.number().int().min(1).max(200),
  layout: z.enum(['line', 'grid', 'ring', 'tunnel', 'scatter']).optional(),
  spacing: z.union([z.number(), Vec2, Vec3]).optional(),
  columns: z.number().int().optional(),
  radius: z.number().optional(),
  rows: z.number().int().optional(),
  area: Vec3.optional(),
  jitter: z.number().optional(),
  seed: z.number().optional(),
  stagger: Time.optional(),
});
export interface RepeatLayer extends z.infer<typeof RepeatBase> { children?: Layer[] }

const MarqueeBase = z.object({
  type: z.literal('marquee'),
  ...base,
  speed: z.number().optional(),
  gap: z.number().optional(),
  width: z.number().optional(),
  direction: z.enum(['left', 'right']).optional(),
});
export interface Marquee extends z.infer<typeof MarqueeBase> { children?: Layer[] }

const children = { get children(): z.ZodOptional<z.ZodArray<z.ZodType<Layer>>> { return z.array(LayerS).optional(); } };

export const LayerS: z.ZodType<Layer> = z.lazy(() =>
  z.discriminatedUnion('type', [
    TextLayerS, CounterLayerS, ShapeLayerS, ImageLayerS, VideoLayerS, PathLayerS, IconLayerS, SvgLayerS, MeshLayerS,
    ParticlesLayerS, BackgroundLayerS, GridLayerS,
    GroupBase.extend(children).extend({ get mask(): z.ZodOptional<z.ZodType<Layer>> { return LayerS.optional(); }, maskInvert: z.boolean().optional() }).strict(),
    BrowserBase.extend(children).strict(),
    PhoneBase.extend(children).strict(),
    LaptopBase.extend(children).strict(),
    CardBase.extend(children).strict(),
    ButtonLayerS, CursorLayerS, ChartLayerS, ToastLayerS, ProgressLayerS, BadgeLayerS, AvatarLayerS,
    FlashLayerS, GlowLayerS, CodeLayerS, ConfettiLayerS, ModelLayerS,
    MarqueeBase.extend(children).strict(),
    RepeatBase.extend(children).strict(),
  ]),
) as z.ZodType<Layer>;

export const CameraMove = z.object({
  preset: z.string(),
  at: Time.optional(),
  duration: Time.optional(),
  ease: Ease.optional(),
}).catchall(z.any());
export type CameraMove = z.infer<typeof CameraMove>;

export const Camera = z.object({
  fov: z.number().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().optional(),
  targetX: z.number().optional(),
  targetY: z.number().optional(),
  targetZ: z.number().optional(),
  roll: z.number().optional(),
  keyframes: Keyframes.optional(),
  moves: z.array(CameraMove).optional(),
  dof: z.object({
    z: z.number().optional(),
    strength: z.number().optional(),
    max: z.number().optional(),
  }).strict().optional(),
  follow: z.object({
    target: z.string(),
    offset: Vec3.optional(),
  }).strict().optional(),
}).strict();
export type Camera = z.infer<typeof Camera>;

export const Post = z.object({
  bloom: z.union([z.boolean(), z.object({
    strength: z.number().optional(),
    radius: z.number().optional(),
    threshold: z.number().optional(),
  }).strict()]).optional(),
  chromatic: z.number().optional(),
  grain: z.number().optional(),
  vignette: z.number().optional(),
  exposure: z.number().optional(),
  contrast: z.number().optional(),
  saturation: z.number().optional(),
  tonemap: z.enum(['soft', 'none', 'aces', 'agx']).optional(),
}).strict();
export type Post = z.infer<typeof Post>;

export const Transition = z.object({
  type: z.enum(['cut', 'fade', 'black', 'flash', 'slide', 'push', 'whip', 'zoom', 'zoomOut', 'glitch', 'wipe', 'circle', 'pixelate', 'blur', 'split', 'mask']),
  duration: Time.optional(),
  direction: z.enum(['left', 'right', 'up', 'down']).optional(),
  ease: Ease.optional(),
  color: Color.optional(),
  /** mask: the next scene shows through these letters, then the view dives into one of them. */
  text: z.string().optional(),
  font: z.string().optional(),
  weight: z.number().optional(),
  /** mask: letter spacing of the text, in em (like text layers). */
  letterSpacing: z.number().optional(),
  /**
   * mask: id of a text or counter layer in the outgoing scene showing the same text. The mask starts
   * exactly over its letters (and takes its font, weight and spacing) instead of popping in at the center.
   */
  from: z.string().optional(),
  /** mask: a filled vector shape (a logo) instead of text: SVG path data and its viewBox. */
  svg: z.object({ d: z.string(), viewBox: z.tuple([z.number(), z.number(), z.number(), z.number()]) }).strict().optional(),
}).strict();
export type Transition = z.infer<typeof Transition>;

export const Lighting = z.object({
  shadows: z.boolean().optional(),
  ground: z.number().optional(),
  shadowOpacity: z.number().optional(),
  softness: z.number().optional(),
  key: Vec3.optional(),
  intensity: z.number().optional(),
}).strict();
export type Lighting = z.infer<typeof Lighting>;

export const Scene = z.object({
  id: z.string().optional(),
  duration: Time,
  background: Color.optional(),
  camera: Camera.optional(),
  transition: Transition.optional(),
  post: Post.optional(),
  lighting: Lighting.optional(),
  /** Scales the scene's layers about the frame center (backgrounds excluded). Narrower formats set it to fit wide UI. */
  zoom: z.number().positive().optional(),
  formats: FormatOverrides.optional(),
  layers: z.array(LayerS),
}).strict();
export type Scene = z.infer<typeof Scene>;

export const Theme = z.object({
  colors: z.record(z.string(), Color).optional(),
  fonts: z.record(z.string(), z.string()).optional(),
}).strict();
export type Theme = z.infer<typeof Theme>;

export const Audio = z.object({
  src: z.string(),
  /** music (default): looped bed, ducks under voice. voice: narration. sfx: effects, mixed as is. */
  role: z.enum(['music', 'voice', 'sfx']).optional(),
  at: Time.optional(),
  volume: z.number().optional(),
  trim: Time.optional(),
  fadeIn: Time.optional(),
  fadeOut: Time.optional(),
  /** Repeat the file to fill the video. */
  loop: z.boolean().optional(),
  /** Music only: lower it automatically while a voice track is speaking (default true). */
  duck: z.boolean().optional(),
  /** Cut the video to this track's beats: scene changes and line entrances move onto them. */
  sync: z.boolean().optional(),
  /** Voice: what is said, word for word. Lets the engine find when each word is spoken. */
  script: z.string().optional(),
  /** Voice with a script: time the video to it, each line of type arriving as its words are said. */
  align: z.boolean().optional(),
}).strict();
export type Audio = z.infer<typeof Audio>;

export const Video = z.object({
  $schema: z.string().optional(),
  title: z.string().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  fps: z.number().positive().optional(),
  /** Per-format settings: `zoom` (output pixels per design pixel) and any top-level field. */
  formats: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  bpm: z.number().positive().optional(),
  background: Color.optional(),
  environment: z.union([
    z.enum(['room', 'studio', 'softbox']),
    z.string().regex(/^hdri:[a-z0-9_]+$|\.(hdr|exr)$/i, 'environment must be room, studio, softbox, "hdri:<polyhaven id>" or a .hdr/.exr file'),
    z.object({
      src: z.string(),
      intensity: z.number().optional(),
      rotation: z.number().optional(),
      res: z.enum(['1k', '2k', '4k']).optional(),
    }).strict(),
  ]).optional(),
  lighting: Lighting.optional(),
  theme: Theme.optional(),
  fonts: z.record(z.string(), z.string()).optional(),
  post: Post.optional(),
  motionBlur: z.union([z.boolean(), z.object({
    samples: z.number().int().min(1).max(64).optional(),
    shutter: z.number().min(0).max(2).optional(),
  }).strict()]).optional(),
  audio: z.array(Audio).optional(),
  sfx: z.union([z.boolean(), z.object({
    volume: z.number().optional(),
    mute: z.array(z.string()).optional(),
    kit: z.enum(['soft', 'classic', 'tactile']).optional(),
    seed: z.number().optional(),
    reverb: z.number().min(0).max(1).optional(),
  }).strict()]).optional(),
  /** Captions from the voiceover's script, timed to the speech: true, or a style. */
  captions: z.union([z.boolean(), z.object({
    size: z.number().optional(),
    color: Color.optional(),
    y: z.number().optional(),
    weight: z.number().optional(),
    font: z.string().optional(),
    maxWords: z.number().int().min(1).max(12).optional(),
  }).strict()]).optional(),
  sounds: z.array(z.object({
    sound: z.enum(['whoosh', 'swoosh', 'soft', 'pop', 'tick', 'key', 'click', 'impact', 'sparkle', 'chime', 'glitch']),
    at: Time,
    gain: z.number().optional(),
  }).strict()).optional(),
  scenes: z.array(Scene).min(1),
}).strict();
export type Video = z.infer<typeof Video>;

export interface ValidationResult {
  ok: boolean;
  video?: Video;
  errors: string[];
}

export function validateVideo(input: unknown): ValidationResult {
  const r = Video.safeParse(input);
  if (r.success) return { ok: true, video: r.data, errors: [] };
  const errors = r.error.issues.map((i) => {
    const path = i.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('').replace(/^\./, '');
    return `${path || '(root)'}: ${i.message}`;
  });
  return { ok: false, errors };
}
