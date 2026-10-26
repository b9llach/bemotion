/**
 * Platform safe zones for vertical (9:16) video: the parts of a 1080x1920 frame that TikTok, Instagram
 * Reels and YouTube Shorts cover with their own interface (the top bar, the column of action buttons on
 * the right, the caption, username and audio line at the bottom). Text and logos under them are hard
 * or impossible to read in the feed.
 *
 * The numbers are approximate and rounded outward, from the platforms' published creative guidance and
 * the common safe-zone templates built from it (TikTok Ads creative specs, Meta's Reels ad guidance of
 * about 14% top and 35% bottom kept free of text, YouTube's Shorts safe-area template). The apps change
 * their layouts from version to version, so treat them as a margin, not a measurement.
 *
 * Pure data and math: shared by `bemotion check --platform` and the preview's `?safe=` overlay.
 */

export interface SafeZones {
  label: string;
  /** Pixels at 1080x1920 covered from the top (status and tab bar). */
  top: number;
  /** Covered from the bottom (caption, username, audio line, progress bar). */
  bottom: number;
  /** Width of the action button column on the right ... */
  right: number;
  /** ... which runs from this far down the frame to the bottom zone. */
  railTop: number;
  /** A thin margin on the left the caption text starts in. */
  left: number;
}

export const SAFE_ZONES: Record<string, SafeZones> = {
  // TikTok Ads creative specs and TikTok safe-zone templates: ~150 px top, ~480 px bottom, ~140 px rail.
  tiktok: { label: 'TikTok', top: 150, bottom: 480, right: 140, railTop: 640, left: 60 },
  // Meta Reels ad guidance: keep ~14% (270 px) top and ~35% (670 px) bottom free; buttons on the right.
  reels: { label: 'Instagram Reels', top: 270, bottom: 670, right: 130, railTop: 900, left: 60 },
  // YouTube Shorts safe-area template: ~140 px top, ~420 px bottom, ~190 px button column.
  shorts: { label: 'YouTube Shorts', top: 140, bottom: 420, right: 190, railTop: 760, left: 50 },
};

/** The reference frame the numbers above are for. */
export const SAFE_FRAME = { width: 1080, height: 1920 };

export function platformNames(): string[] {
  return Object.keys(SAFE_ZONES);
}

/** Parses "tiktok", "tiktok,reels" or "all"; throws on an unknown name. */
export function parsePlatforms(v: string | undefined): string[] {
  if (!v) return [];
  const names = v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = names.includes('all') ? platformNames() : names;
  for (const n of out) if (!SAFE_ZONES[n]) throw new Error(`Unknown platform "${n}". Platforms: ${platformNames().join(', ')}`);
  return [...new Set(out)];
}

export interface ZoneRect {
  name: string;
  /** Pixels in the given frame, y down. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The covered areas of one platform in a frame of `width` x `height` pixels (scaled from 1080x1920). */
export function zoneRects(platform: string, width: number, height: number): ZoneRect[] {
  const z = SAFE_ZONES[platform];
  if (!z) throw new Error(`Unknown platform "${platform}"`);
  const sx = width / SAFE_FRAME.width;
  const sy = height / SAFE_FRAME.height;
  return [
    { name: 'top bar', x0: 0, y0: 0, x1: width, y1: z.top * sy },
    { name: 'caption and username', x0: 0, y0: height - z.bottom * sy, x1: width, y1: height },
    { name: 'action buttons', x0: width - z.right * sx, y0: z.railTop * sy, x1: width, y1: height - z.bottom * sy },
    { name: 'left edge', x0: 0, y0: z.top * sy, x1: z.left * sx, y1: height - z.bottom * sy },
  ];
}
