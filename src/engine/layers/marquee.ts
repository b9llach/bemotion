import type { Marquee as MarqueeSpec } from '../../spec/schema';
import { Layer } from './base';

/** Infinite horizontal scroller (logo walls, testimonials). Children are spaced `gap` px apart, center to center. */
export class MarqueeLayer extends Layer<MarqueeSpec> {
  protected container = true;

  size() {
    return { w: this.spec.width ?? this.ctx.width, h: 0 };
  }

  async load(): Promise<void> {}

  protected updateContent(): void {}

  protected updateChildren(t: number, opacity: number, blur = 0): void {
    const s = this.spec;
    const n = this.children.length;
    if (!n) return;
    const gap = s.gap ?? 280;
    const period = n * gap;
    const width = s.width ?? this.ctx.width;
    const speed = (s.speed ?? 120) * (s.direction === 'right' ? -1 : 1);
    const shift = t * speed;
    this.children.forEach((c, i) => {
      let x = i * gap - shift;
      x = (((x % period) + period) % period) - period / 2;
      // Fade items out near the edges of the visible band.
      const edge = Math.min(1, Math.max(0, (width / 2 - Math.abs(x)) / (gap * 0.9)));
      c.update(t, opacity * edge, blur);
      c.root.position.x += x;
    });
  }
}
