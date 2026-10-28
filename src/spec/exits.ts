import type { Video } from './schema';
import { toSeconds } from './time';

type Scene = Video['scenes'][number];

/**
 * When a scene's exit begins, scene-local: where the next transition starts, or earlier when the
 * scene ends on a camera dive (a `moveTo` that zooms in, starts in the second half and runs to the
 * exit). A frame taken during the dive shows its copy cropped on its way out, not as it settles.
 */
export function exitAt(scene: Scene, duration: number, transitionOut: number, ctx: { fps: number; bpm?: number }): number {
  const exit = duration - transitionOut;
  let at = exit;
  for (const m of scene.camera?.moves ?? []) {
    if (m.preset !== 'moveTo' || !(Number(m.zoom ?? 1) > 1.15)) continue;
    const start = toSeconds(m.at, ctx, 0);
    const end = start + toSeconds(m.duration, ctx, 1.2);
    if (start >= duration * 0.4 && end >= exit - 0.25) at = Math.min(at, start);
  }
  return at;
}

/** Every `share` name in a scene's layers, nested ones included. */
export function shareNames(scene: Scene): Set<string> {
  const out = new Set<string>();
  const walk = (list: unknown[] | undefined) => {
    for (const l of (list ?? []) as Record<string, unknown>[]) {
      if (!l || typeof l !== 'object') continue;
      if (typeof l.share === 'string') out.add(l.share);
      if (Array.isArray(l.children)) walk(l.children);
    }
  };
  walk(scene.layers as unknown[]);
  return out;
}

/**
 * How each scene change hands off, in order (scene 1 onward): a shared element flight, a camera
 * dive out of the scene before its transition, or the transition type alone ("cut" when none).
 */
export function handoffs(video: Video, ctx: { fps: number; bpm?: number }): { scene: string; kind: string; type: string }[] {
  const out: { scene: string; kind: string; type: string }[] = [];
  for (let i = 1; i < video.scenes.length; i++) {
    const prev = video.scenes[i - 1];
    const s = video.scenes[i];
    const type = s.transition?.type ?? 'cut';
    const tOut = type === 'cut' ? 0 : toSeconds(s.transition?.duration, ctx, 0.5);
    const prevDur = toSeconds(prev.duration, ctx);
    const a = shareNames(prev);
    const shared = [...shareNames(s)].some((n) => a.has(n));
    const dive = exitAt(prev, prevDur, tOut, ctx) < prevDur - tOut - 0.05;
    const kind = shared ? 'shared element' : dive ? `dive + ${type}` : type === 'mask' ? 'mask' : type;
    out.push({ scene: s.id ?? `scene ${i}`, kind, type });
  }
  return out;
}
