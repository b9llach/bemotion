import { SAFE_FRAME, SAFE_ZONES, zoneRects } from '../spec/safezones';

/**
 * `?safe=tiktok` (or reels, shorts) in the preview: the platform's interface areas drawn as translucent
 * bands over the canvas, so text and logos can be kept out of them while editing. Purely visual; it
 * ignores the pointer so the editor works through it.
 */
export function attachSafeOverlay(frame: HTMLElement, canvas: HTMLCanvasElement, platform: string): void {
  const z = SAFE_ZONES[platform];
  if (!z) return;
  const box = document.createElement('div');
  box.className = 'safe-overlay';
  box.title = `${z.label} safe zones`;
  const W = SAFE_FRAME.width;
  const H = SAFE_FRAME.height;
  for (const r of zoneRects(platform, W, H)) {
    const el = document.createElement('div');
    el.className = r.name === 'action buttons' ? 'safe-zone rail' : 'safe-zone';
    el.style.left = `${(r.x0 / W) * 100}%`;
    el.style.top = `${(r.y0 / H) * 100}%`;
    el.style.width = `${((r.x1 - r.x0) / W) * 100}%`;
    el.style.height = `${((r.y1 - r.y0) / H) * 100}%`;
    if (r.name !== 'left edge') {
      const tag = document.createElement('span');
      tag.textContent = r.name === 'top bar' ? `${z.label}: ${r.name}` : r.name;
      el.appendChild(tag);
    }
    box.appendChild(el);
  }
  frame.appendChild(box);
  const place = () => {
    box.style.left = `${canvas.offsetLeft}px`;
    box.style.top = `${canvas.offsetTop}px`;
    box.style.width = `${canvas.offsetWidth}px`;
    box.style.height = `${canvas.offsetHeight}px`;
  };
  place();
  new ResizeObserver(place).observe(canvas);
}
