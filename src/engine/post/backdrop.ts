import * as THREE from 'three';

/**
 * What glass surfaces see behind them: the compositor renders everything below the lowest glass
 * layer, blurs it into this texture, then draws the glass and everything above it.
 * Shared uniform objects, so every glass material reads the current frame's backdrop.
 */
export const BACKDROP = {
  tBackdrop: { value: null as THREE.Texture | null },
  /** Size of the scene target in px (glass maps gl_FragCoord into the backdrop with it). */
  uViewRes: { value: new THREE.Vector2(1, 1) },
};

/** Marks a mesh as glass: it is drawn in the second pass, over a backdrop blurred by `blur` screen px. */
export interface GlassTag {
  blur: number;
}
