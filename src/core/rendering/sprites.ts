/**
 * Sprite source interfaces — the contract between drawing code (tanks, particles,
 * terrain) and whatever resolves a logical sprite name to a drawable bitmap
 * (CAssetManager). These lived in CTank and were re-declared ad hoc in
 * CParticleSystem (`SpriteSrc`); they belong here in core/rendering next to their
 * implementer.
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
