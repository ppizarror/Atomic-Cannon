/**
 * Sprite source interfaces — the contract between drawing code (tanks, particles,
 * terrain) and whatever resolves a logical sprite name to a drawable bitmap
 * (CAssetManager). They live here in core/rendering, next to their implementer, so
 * drawing code shares one declaration instead of each consumer restating it.
 */

export interface Sprite {
  bitmap: CanvasImageSource;
  width: number;
  height: number;
}

/** Anything that can resolve a logical sprite name to a drawable sprite. */
export interface ISpriteSource {
  getSprite(name: string): Sprite | null;
}
