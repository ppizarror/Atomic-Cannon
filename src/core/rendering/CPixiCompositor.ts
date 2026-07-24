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

import {Application, Sprite, Texture} from 'pixi.js';
import {ShockwaveFilter} from 'pixi-filters';

const WAVE_LIFETIME = 1.4; // seconds a shockwave stays active

export class CPixiCompositor {
  private readonly m_app: Application;
  private m_scene!: Sprite;
  private m_sceneTexture!: Texture;
  private m_sceneCanvas!: HTMLCanvasElement;
  private m_shockwave!: ShockwaveFilter;
  private m_waveAge: number = Infinity;

  // The element the presentation fills (so resize() can read its live size).
  private m_resizeTo: HTMLElement | Window = window;

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
  async init(
    sceneCanvas: HTMLCanvasElement,
    resizeTo: HTMLElement | Window = window,
  ): Promise<void> {
    this.m_worldW = sceneCanvas.width;
    this.m_worldH = sceneCanvas.height;
    this.m_sceneCanvas = sceneCanvas;
    this.m_resizeTo = resizeTo;

    await this.m_app.init({
      preference: 'webgl',
      resizeTo,
      antialias: false,
      background: 0x000000,
    });

    this.m_sceneTexture = Texture.from(sceneCanvas);
    this.m_scene = new Sprite(this.m_sceneTexture);
    this.m_app.stage.addChild(this.m_scene);

    this.m_shockwave = new ShockwaveFilter({
      center: {x: 0, y: 0},
      amplitude: 34,
      wavelength: 180,
      brightness: 1.15,
      speed: 900,
      radius: -1,
    });
    this.m_shockwave.enabled = false;
    this.m_scene.filters = [this.m_shockwave];

    this.resize();

    // Pre-warm the shockwave shader. Its GLSL program is compiled+linked on the
    // FIRST render with the filter enabled — a ~50ms stall that otherwise lands on
    // the first nuke of a match (the "first fire is laggy" hitch). Compile it now,
    // during load: the canvas isn't mounted yet (main mounts it after init) and the
    // scene texture is blank, so this one render is invisible and one-time.
    this.m_shockwave.enabled = true;
    this.m_shockwave.time = 0;
    try {
      this.m_app.renderer.render(this.m_app.stage);
    } catch {
      /* headless/edge backends may reject an early render — safe to skip */
    }
    this.m_shockwave.enabled = false;
  }

  /**
   * Fit the presentation to the current viewport. Explicitly resizes the Pixi
   * renderer to the live element size (Pixi's own `resizeTo` throttles and can
   * miss a fast resize, e.g. toggling devtools) and then fits the scene sprite.
   */
  /**
   * The scene canvas was resized externally (e.g. a network match fixes a shared logical
   * resolution). Rebuild the GPU texture at the new size and re-fit. World→screen mapping
   * reads `m_worldW/H`, so update those too.
   */
  setSceneSize(w: number, h: number): void {
    this.m_worldW = w;
    this.m_worldH = h;
    this.m_sceneTexture.destroy();
    this.m_sceneTexture = Texture.from(this.m_sceneCanvas);
    this.m_scene.texture = this.m_sceneTexture;
    this.resize();
  }

  resize(): void {
    const el = this.m_resizeTo;
    const w = el instanceof Window ? window.innerWidth : el.clientWidth;
    const h = el instanceof Window ? window.innerHeight : el.clientHeight;
    if (
      w > 0 &&
      h > 0 &&
      (Math.round(this.m_app.renderer.width) !== w || Math.round(this.m_app.renderer.height) !== h)
    ) {
      this.m_app.renderer.resize(w, h);
    }
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

    this.m_shockwave.center = {x: sx, y: sy};
    this.m_shockwave.amplitude = 22 * strength;
    this.m_shockwave.wavelength = 140 + 60 * strength;
    this.m_shockwave.time = 0;
    this.m_shockwave.enabled = true;
    this.m_waveAge = 0;
  }

  /**
   * Advance effects and (optionally) push the latest scene frame to the GPU.
   * `sceneChanged` is the present-on-demand gate: when the 2D scene was NOT
   * redrawn this frame we skip the full-canvas texture re-upload (the expensive
   * CPU→GPU transfer). The shockwave still advances every call — it's a GPU
   * post-filter that warps the already-uploaded texture, so it keeps animating
   * over a static scene with no re-upload needed.
   */
  update(dt: number, sceneChanged: boolean = true): void {
    // Re-upload the 2D scene into the GPU texture only when it actually changed.
    if (sceneChanged) this.m_sceneTexture.source.update();

    if (this.m_shockwave.enabled) {
      this.m_waveAge += dt;
      this.m_shockwave.time += dt;
      if (this.m_waveAge >= WAVE_LIFETIME) {
        this.m_shockwave.enabled = false;
      }
    }
  }

  get app(): Application {
    return this.m_app;
  }
}
