/**
 * CPixiCompositor - WebGL presentation layer.
 *
 * The game renders its scene to an offscreen 2D canvas. This class hands that
 * canvas to PixiJS as a full-viewport sprite so we can run GPU post-effects on
 * the whole frame — most importantly the expanding shockwave ("diffraction")
 * that ripples the scene when a heavy weapon lands.
 *
 * Hot particle layers can migrate to native Pixi sprites later; presentation and
 * the screen-warp live here regardless.
 */

import { Application, Sprite, Texture } from 'pixi.js';
import { ShockwaveFilter } from 'pixi-filters';

const WAVE_LIFETIME = 1.4;   // seconds a shockwave stays active

export class CPixiCompositor {

  private m_app: Application;
  private m_scene!: Sprite;
  private m_sceneTexture!: Texture;
  private m_shockwave!: ShockwaveFilter;
  private m_waveAge: number = Infinity;

  // Logical size of the scene canvas (game-world pixels).
  private m_worldW: number = 1;
  private m_worldH: number = 1;

  constructor() {
    this.m_app = new Application();
  }

  /**
   * Start Pixi and present `sceneCanvas` (the 2D game buffer). Pixi creates its
   * own view canvas, exposed via `app.canvas` for the caller to mount. Forces
   * the WebGL backend so a single GLSL post-filter works everywhere.
   */
  async init(sceneCanvas: HTMLCanvasElement): Promise<void> {
    this.m_worldW = sceneCanvas.width;
    this.m_worldH = sceneCanvas.height;

    await this.m_app.init({
      preference: 'webgl',
      resizeTo: window,
      antialias: false,
      background: 0x000000,
    });

    this.m_sceneTexture = Texture.from(sceneCanvas);
    this.m_scene = new Sprite(this.m_sceneTexture);
    this.m_app.stage.addChild(this.m_scene);

    this.m_shockwave = new ShockwaveFilter({
      center: { x: 0, y: 0 },
      amplitude: 34,
      wavelength: 180,
      brightness: 1.15,
      speed: 900,
      radius: -1,
    });
    this.m_shockwave.enabled = false;
    this.m_scene.filters = [this.m_shockwave];

    this.resize();
  }

  /** Fit the scene sprite to the current viewport. */
  resize(): void {
    this.m_scene.width = this.m_app.screen.width;
    this.m_scene.height = this.m_app.screen.height;
  }

  /**
   * Trigger a shockwave at world position (wx, wy). `strength` scales the ripple
   * (e.g. ~1 for a shell, ~2.5 for a nuke).
   */
  shockwave(wx: number, wy: number, strength: number = 1): void {
    // Map world coords to on-screen coords (the sprite may be scaled to fit).
    const sx = (wx / this.m_worldW) * this.m_app.screen.width;
    const sy = (wy / this.m_worldH) * this.m_app.screen.height;

    this.m_shockwave.center = { x: sx, y: sy };
    this.m_shockwave.amplitude = 22 * strength;
    this.m_shockwave.wavelength = 140 + 60 * strength;
    this.m_shockwave.time = 0;
    this.m_shockwave.enabled = true;
    this.m_waveAge = 0;
  }

  /** Advance effects and push the latest scene frame to the GPU. */
  update(dt: number): void {
    // Re-upload the 2D scene into the GPU texture for this frame.
    this.m_sceneTexture.source.update();

    if (this.m_shockwave.enabled) {
      this.m_waveAge += dt;
      this.m_shockwave.time += dt;
      if (this.m_waveAge >= WAVE_LIFETIME) {
        this.m_shockwave.enabled = false;
      }
    }
  }

  get app(): Application { return this.m_app; }
}
