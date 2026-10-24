import type { Layer as LayerSpec } from '../../spec/schema';
import { Layer, type SceneRuntime } from './base';
import { TextLayer, CounterLayer } from './text';
import { ShapeLayer, ImageLayer } from './shape';
import { PathLayer, IconLayer } from './path';
import { SvgLayer } from './svg';
import { MeshLayer } from './mesh';
import { ParticlesLayer } from './particles';
import { BackgroundLayer, GridLayer, GroupLayer } from './background';
import { MarqueeLayer } from './marquee';
import { ConfettiLayer } from './confetti';
import { ModelLayer } from './model';
import { VideoLayer } from './video';
import { expand, isComponent } from '../components';

type AnySpec = LayerSpec & Record<string, any>;
type LayerCtor = new (spec: any, rt: SceneRuntime) => Layer;

const CLASSES: Record<string, LayerCtor> = {
  text: TextLayer,
  counter: CounterLayer,
  shape: ShapeLayer,
  image: ImageLayer,
  video: VideoLayer,
  path: PathLayer,
  icon: IconLayer,
  svg: SvgLayer,
  mesh: MeshLayer,
  particles: ParticlesLayer,
  background: BackgroundLayer,
  grid: GridLayer,
  group: GroupLayer,
  marquee: MarqueeLayer,
  confetti: ConfettiLayer,
  model: ModelLayer,
};

function markNoDof(l: Layer): void {
  l.noDof = true;
  for (const c of l.children) markNoDof(c);
}

/** Builds the layer tree synchronously so paint order follows the spec, then loads everything in parallel. */
export async function buildLayers(specs: LayerSpec[], rt: SceneRuntime): Promise<Layer[]> {
  const all: Layer[] = [];
  const make = (raw: AnySpec, path: string): Layer => {
    let spec = raw;
    let guard = 0;
    while (isComponent(spec.type)) {
      spec = expand(spec, rt.ctx) as AnySpec;
      if (++guard > 8) throw new Error(`${path}: component expansion did not terminate`);
    }
    const Ctor = CLASSES[spec.type];
    if (!Ctor) throw new Error(`${path}: unknown layer type "${spec.type}"`);
    let layer: Layer;
    try {
      layer = new Ctor(spec, rt);
    } catch (e) {
      throw new Error(`${path} (${raw.type}): ${(e as Error).message}`);
    }
    all.push(layer);
    layer.sourcePath = rt.sourcePaths?.get(raw) ?? null;
    if ((spec as any).dof === false) layer.noDof = true;
    let children: AnySpec[] = (spec as any).children ?? [];
    if (spec.type === 'marquee' && children.length) {
      // Repeat items until one period covers the visible band.
      const gap = (spec as any).gap ?? 280;
      const width = (spec as any).width ?? rt.ctx.width;
      const base = children;
      while (children.length * gap < width + gap * 2) children = [...children, ...base];
    }
    children.forEach((c, i) => {
      const child = make(c, `${path}.children[${i}]`);
      if (layer.noDof) markNoDof(child);
      layer.addChild(child);
      if (child.trail) layer.pivot.add(child.trail);
    });
    return layer;
  };
  const roots = specs.map((s, i) => make(s as AnySpec, `layers[${i}]`));
  await Promise.all(
    all.map((l) =>
      l.load().catch((e) => {
        throw new Error(`${l.spec.id ? `"${l.spec.id}"` : l.spec.type} layer: ${(e as Error).message}`);
      }),
    ),
  );
  return roots;
}
