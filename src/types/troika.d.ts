declare module 'troika-three-text' {
  import { Color, Mesh } from 'three';

  export interface TextRenderInfo {
    blockBounds: [number, number, number, number];
    visibleBounds: [number, number, number, number];
    caretPositions?: Float32Array;
    lineHeight: number;
    topBaseline: number;
    ascender: number;
    descender: number;
    capHeight: number;
  }

  type ColorLike = string | number | Color;

  export class Text extends Mesh {
    text: string;
    font: string | null;
    fontSize: number;
    lineHeight: number | 'normal';
    letterSpacing: number;
    maxWidth: number;
    textAlign: 'left' | 'right' | 'center' | 'justify';
    anchorX: number | string;
    anchorY: number | string;
    color: ColorLike | null;
    fillOpacity: number;
    outlineWidth: number | string;
    outlineBlur: number | string;
    outlineColor: ColorLike;
    outlineOpacity: number;
    outlineOffsetX: number | string;
    outlineOffsetY: number | string;
    strokeWidth: number | string;
    strokeColor: ColorLike;
    strokeOpacity: number;
    clipRect: [number, number, number, number] | null;
    sdfGlyphSize: number | null;
    glyphGeometryDetail: number;
    gpuAccelerateSDF: boolean;
    readonly textRenderInfo: TextRenderInfo | null;
    sync(callback?: () => void): void;
    dispose(): void;
  }

  /** Draws every Text added to it in one call (each keeps its own matrix, color, opacity and clip). */
  export class BatchedText extends Text {
    addText(text: Text): void;
    removeText(text: Text): void;
  }

  export function preloadFont(opts: { font?: string; characters?: string | string[]; sdfGlyphSize?: number }, callback: () => void): void;
  export function configureTextBuilder(config: Record<string, unknown>): void;
}
