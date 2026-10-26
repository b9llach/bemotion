import type { Video } from './schema';

/** What the layers of a spec react to (`react[].to`): 'beat', 'level', 'bass'. */
export function reactKinds(video: Video): Set<string> {
  const out = new Set<string>();
  const walk = (list: unknown[] | undefined) => {
    for (const n of list ?? []) {
      if (!n || typeof n !== 'object') continue;
      const r = (n as { react?: unknown }).react;
      for (const e of Array.isArray(r) ? r : r ? [r] : []) if (e && typeof (e as { to?: unknown }).to === 'string') out.add((e as { to: string }).to);
      walk((n as { children?: unknown[] }).children);
    }
  };
  for (const s of video.scenes) walk(s.layers);
  return out;
}

/** The music `react` follows: the synced music track, else the first music track, else the score. */
export function reactSource(video: Video): { track: NonNullable<Video['audio']>[number] } | { score: true } | null {
  const music = (video.audio ?? []).filter((a) => (a.role ?? 'music') === 'music');
  const track = music.find((a) => a.sync) ?? music[0];
  if (track) return { track };
  if (video.score) return { score: true };
  return null;
}

/** Warnings for `validate`: layers that react to music the video does not have. */
export function reactWarnings(video: Video): string[] {
  if (!reactKinds(video).size || reactSource(video)) return [];
  return ['Layers have "react" but the video has no music track or score: they will not move with the music.'];
}
