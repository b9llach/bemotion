import type { Video } from './schema';

/**
 * Shared elements: a layer with `share: "<name>"` in one scene and a layer with the same name in the
 * next scene are one element. During the transition between them the engine flies it from where it
 * was to where it lands, so the flight replaces the outgoing copy's exit and the incoming copy's
 * entrance. This pass removes those animations. It is a pure function of the spec.
 */

type Node = Record<string, unknown> & { share?: string; children?: unknown };

/** Layers with a `share` name in a scene, depth first; the first layer with a name wins. */
export function sharedLayers(layers: unknown[]): Map<string, Node> {
  const out = new Map<string, Node>();
  const walk = (list: unknown[]) => {
    for (const n of list) {
      if (!n || typeof n !== 'object') continue;
      const node = n as Node;
      if (typeof node.share === 'string' && node.share && !out.has(node.share)) out.set(node.share, node);
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(layers);
  return out;
}

/** Names shared between scene i - 1 and scene i, when scene i comes in on a transition that overlaps. */
export function sharedNames(video: Video, i: number): string[] {
  const tr = video.scenes[i]?.transition;
  if (i < 1 || !tr || tr.type === 'cut') return [];
  const a = sharedLayers(video.scenes[i - 1].layers);
  const b = sharedLayers(video.scenes[i].layers);
  return [...b.keys()].filter((k) => a.has(k));
}

export function resolveShared(video: Video): Video {
  const any = video.scenes.some((_, i) => sharedNames(video, i).length > 0);
  if (!any) return video;
  const out = JSON.parse(JSON.stringify(video)) as Video;
  out.scenes.forEach((_, i) => {
    const names = sharedNames(out, i);
    if (!names.length) return;
    const a = sharedLayers(out.scenes[i - 1].layers);
    const b = sharedLayers(out.scenes[i].layers);
    for (const k of names) {
      const from = a.get(k)!;
      const to = b.get(k)!;
      delete from.out;
      delete from.animateOut;
      delete to.in;
      delete to.animate;
    }
  });
  return out;
}
