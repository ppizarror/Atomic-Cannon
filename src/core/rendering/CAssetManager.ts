/**
 * CAssetManager - Sprite/Texture Loading System
 * 
 * Loads game assets from extracted data.pak files
 * Maps logical asset names to actual file paths based on asset manifest
 */

export interface SpriteSheet {
  image: HTMLImageElement;
  width: number;
  height: number;
  ready: boolean;
}

interface AssetPathMap {
  [key: string]: string;  // e.g., "tank_body_red" -> "/assets/bmp_0042.dat"
}

// Static asset path mappings based on EXE string analysis
// These paths are relative to the public/assets/ folder after extraction
const ASSET_PATHS: AssetPathMap = {
  // Tank sprites (color variants)
  'tanks/red_body': '/assets/tank_red_body.bmp',
  'tanks/red_turret': '/assets/tank_red_turret.bmp', 
  'tanks/red_wreck': '/assets/tank_red_wreck.bmp',
  
  'tanks/blue_body': '/assets/tank_blue_body.bmp',
  'tanks/blue_turret': '/assets/tank_blue_turret.bmp',
  'tanks/blue_wreck': '/assets/tank_blue_wreck.bmp',
  
  'tanks/green_body': '/assets/tank_green_body.bmp', 
  'tanks/green_turret': '/assets/tank_green_turret.bmp',
  'tanks/green_wreck': '/assets/tank_green_wreck.bmp',
  
  'tanks/yellow_body': '/assets/tank_yellow_body.bmp',
  'tanks/yellow_turret': '/assets/tank_yellow_turret.bmp', 
  'tanks/yellow_wreck': '/assets/tank_yellow_wreck.bmp',

  // GUI elements
  'gui/button': '/assets/guiButton.bmp',
  'gui/fire_button': '/assets/guiFireBig.bmp',
  'gui/shield': '/assets/shield.bmp',
  
  // Terrain tiles
  'land/lgrass': '/assets/terrain_grass.bmp',
  'land/ldirt': '/assets/terrain_dirt.bmp', 
  'land/lsnow': '/assets/terrain_snow.bmp',

  // Effects
  'effects/explosion1': '/assets/explosion1.bmp',
};

export class CAssetManager {
  
  private m_sprites: Map<string, SpriteSheet> = new Map();
  private m_loadedCount: number = 0;
  private m_totalCount: number = 0;

  constructor() {}

  /**
   * Load a sprite from an asset path
   */
  async loadSprite(name: string): Promise<SpriteSheet | null> {
    
    // Check if already loaded
    const cached = this.m_sprites.get(name);
    if (cached) return cached;
    
    // Get file path from manifest or use default pattern
    let src = ASSET_PATHS[name];
    if (!src) {
      // Try to construct path from name - convert slashes to match extracted files
      const normalizedName = name.replace('/', '_').replace('\\', '_');
      src = `/assets/${normalizedName}.bmp`;
    }
    
    return new Promise((resolve) => {
      const img = new Image();
      
      img.onload = () => {
        const sprite: SpriteSheet = {
          image: img,
          width: img.width,
          height: img.height,
          ready: true
        };
        
        this.m_sprites.set(name, sprite);
        this.m_loadedCount++;
        resolve(sprite);
      };
      
      img.onerror = () => {
        console.warn(`Failed to load sprite: ${src}`);
        resolve(null);
      };
      
      img.src = src;
      this.m_totalCount++;
    });
  }

  /**
   * Load multiple sprites in parallel
   */
  async preloadSprites(names: string[]): Promise<void> {
    const promises = names.map(name => this.loadSprite(name));
    await Promise.all(promises);
  }

  /**
   * Get a loaded sprite by name
   */
  getSprite(name: string): SpriteSheet | null {
    return this.m_sprites.get(name) || null;
  }

  /**
   * Draw a sprite to canvas at position
   */
  drawSprite(
    ctx: CanvasRenderingContext2D,
    name: string,
    x: number,
    y: number,
    options?: {
      width?: number;
      height?: number;
      rotation?: number;  // radians
      flipX?: boolean;
      opacity?: number;
    }
  ): void {
    const sprite = this.m_sprites.get(name);
    if (!sprite || !sprite.ready) return;

    ctx.save();
    
    // Apply transformations
    let drawX = x;
    let drawY = y;
    
    if (options?.rotation) {
      ctx.translate(x + sprite.width / 2, y + sprite.height / 2);
      ctx.rotate(options.rotation);
      ctx.translate(-sprite.width / 2, -sprite.height / 2);
      // After rotation translation adjustment
      drawX = 0;
      drawY = 0;
    }
    
    if (options?.flipX) {
      ctx.scale(-1, 1);
      drawX = -drawX - sprite.width; // flip anchor point
    }
    
    if (options?.opacity !== undefined && options.opacity < 1) {
      ctx.globalAlpha = options.opacity;
    }

    const w = options?.width || sprite.width;
    const h = options?.height || sprite.height;

    ctx.drawImage(
      sprite.image,
      drawX, drawY,
      w, h
    );
    
    ctx.restore();
  }

  /**
   * Get loading progress percentage
   */
  getProgress(): number {
    if (this.m_totalCount === 0) return 100;
    return Math.floor((this.m_loadedCount / this.m_totalCount) * 100);
  }
  
  /**
   * Check if all sprites are loaded
   */
  isReady(): boolean {
    return this.m_loadedCount >= this.m_totalCount && this.m_totalCount > 0;
  }

  // ========================================================================
  // SPRITE BATCH DEFINITIONS (for common loading groups)
  // ========================================================================

  /**
   * Minimal sprites needed for core gameplay
   */
  static CORE_SPRITES = [
    'tanks/red_body',
    'tanks/blue_body', 
    'effects/explosion1'
  ];

  /**
   * All tank sprite variants (body + turret + wreck)
   */
  static TANK_SPRITES = [
    'tanks/red_body', 'tanks/red_turret', 'tanks/red_wreck',
    'tanks/blue_body', 'tanks/blue_turret', 'tanks/blue_wreck',
    'tanks/green_body', 'tanks/green_turret', 'tanks/green_wreck',
    'tanks/yellow_body', 'tanks/yellow_turret', 'tanks/yellow_wreck'
  ];

  /**
   * GUI elements for HUD
   */
  static GUI_SPRITES = [
    'gui/button',
    'gui/shield' 
  ];
}
