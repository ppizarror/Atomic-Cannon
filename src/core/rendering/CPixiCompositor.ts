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

import {
  Application,
  Container,
  Particle,
  ParticleContainer,
  Rectangle,
  Sprite,
  Texture,
} from 'pixi.js';
import {ShockwaveFilter} from 'pixi-filters';

const WAVE_LIFETIME = 1.5; // seconds a shockwave stays active

export class CPixiCompositor {
  private readonly m_app: Application;
  private m_scene!: Sprite;
  private m_sceneTexture!: Texture;
  private m_sceneCanvas!: HTMLCanvasElement;
  private m_shockwave!: ShockwaveFilter;
  private m_waveAge: number = Infinity;

  // ---- GPU smoke layer
  private m_world!: Container; // scene + smoke, warped as one by the shockwave
  // ONE CONTAINER PER TEXTURE SOURCE. Pixi requires every particle in a ParticleContainer to share
  // a single texture source; mixing the exhaust atlas with the fume sprite makes the batch bind one
  // of them and render the other's quads with those UVs — rectangular garbage, and which one breaks
  // depends on firing order. Sources are few (atlas, fume sprite, puff master), so this stays at a
  // handful of draw calls instead of the thousands the 2D path cost.
  private m_smokeLayers = new Map<number, {c: ParticleContainer; pool: Particle[]; used: number}>();
  // Textures cut from the particle system's own canvases (the baked exhaust atlas, the fume
  // sprite). Keyed per source + sub-rect; the canvases are baked once, so each uploads once.
  private m_texIds = new WeakMap<CanvasImageSource, number>();
  private m_texSources = new Map<number, Texture>();
  private m_texFrames = new Map<string, Texture>();
  private m_nextTexId = 1;
  private m_smokeScale: [number, number, number, number] = [1, 1, 0, 0];

  /**
   * Map the smoke layer from WORLD coordinates onto the screen the same way the scene canvas is:
   * shift by the camera and the screen-shake, then scale the logical view up to the presentation.
   * Called once per frame before the puffs are handed over.
   */
  setSmokeTransform(
    camX: number,
    shakeX: number,
    shakeY: number,
    viewW: number,
    viewH: number,
  ): void {
    if (viewW <= 0 || viewH <= 0) return;
    const sx = this.m_app.screen.width / viewW;
    const sy = this.m_app.screen.height / viewH;
    this.m_smokeScale = [sx, sy, (shakeX - camX) * sx, shakeY * sy];
    for (const l of this.m_smokeLayers.values()) {
      l.c.scale.set(sx, sy);
      l.c.x = (shakeX - camX) * sx;
      l.c.y = shakeY * sy;
    }
  }

  /** Start a smoke frame — puffs are re-emitted from scratch every frame. */
  smokeBegin(): void {
    for (const l of this.m_smokeLayers.values()) l.used = 0;
  }

  /**
   * Add one puff, in world pixels, centred on (x, y). `src` is the canvas the sprite lives on and
   * (sx, sy, sw, sh) its sub-rect within it — the same arguments the 2D path passes to drawImage,
   * so the particle system needs no knowledge of Pixi.
   */
  smokeQuad(
    src: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    x: number,
    y: number,
    w: number,
    h: number,
    rotation: number,
    alpha: number,
    tint = 0xffffff,
  ): void {
    const id = this.sourceId(src);
    if (id < 0) return;
    const tex = this.frameTexture(src, id, sx, sy, sw, sh);
    if (!tex) return;
    const layer = this.layerFor(id);
    let p = layer.pool[layer.used];
    if (!p) {
      p = new Particle({texture: tex});
      p.anchorX = 0.5;
      p.anchorY = 0.5;
      layer.pool.push(p);
    }
    p.texture = tex;
    p.x = x;
    p.y = y;
    p.scaleX = w / sw;
    p.scaleY = h / sh;
    p.rotation = rotation;
    p.alpha = alpha;
    p.tint = tint;
    layer.used++;
  }

  /** Publish the frame's puffs — one batched draw per texture source. */
  smokeEnd(): void {
    for (const l of this.m_smokeLayers.values()) {
      const kids = l.c.particleChildren;
      kids.length = 0;
      for (let i = 0; i < l.used; i++) kids.push(l.pool[i]);
      l.c.update(); // required after touching particleChildren directly
    }
  }

  /** The layer that batches this texture source, created (and placed in the world) on demand. */
  private layerFor(id: number): {c: ParticleContainer; pool: Particle[]; used: number} {
    let l = this.m_smokeLayers.get(id);
    if (!l) {
      const c = new ParticleContainer({
        dynamicProperties: {position: true, scale: true, rotation: true, color: true},
      });
      const [sx, sy, ox, oy] = this.m_smokeScale;
      c.scale.set(sx, sy);
      c.x = ox;
      c.y = oy;
      this.m_world.addChild(c);
      l = {c, pool: [], used: 0};
      this.m_smokeLayers.set(id, l);
    }
    return l;
  }

  /** Stable id per source canvas; uploads it on first sight. -1 if it can't be uploaded. */
  private sourceId(src: CanvasImageSource): number {
    let id = this.m_texIds.get(src);
    if (id === undefined) {
      id = this.m_nextTexId++;
      this.m_texIds.set(src, id);
      try {
        this.m_texSources.set(id, Texture.from(src as HTMLCanvasElement));
      } catch {
        return -1;
      }
    }
    return this.m_texSources.has(id) ? id : -1;
  }

  /** A Texture for a sub-rect of an already-uploaded source, cached per frame rect. */
  private frameTexture(
    _src: CanvasImageSource,
    id: number,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
  ): Texture | null {
    const base = this.m_texSources.get(id);
    if (!base) return null;
    // Whole-canvas sprite → use the base texture directly.
    if (sx === 0 && sy === 0 && sw === base.width && sh === base.height) return base;
    const key = `${id}:${sx},${sy},${sw},${sh}`;
    let t = this.m_texFrames.get(key);
    if (!t) {
      t = new Texture({source: base.source, frame: new Rectangle(sx, sy, sw, sh)});
      this.m_texFrames.set(key, t);
    }
    return t;
  }

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

    // Smoke is the one layer that does NOT go through the 2D scene canvas. Every puff would
    // otherwise be its own drawImage — measured at ~0.59us each, an order of magnitude worse than
    // the dirt chunks that get plotted into a pixel buffer, and the dominant cost of a heavy frame.
    // A ParticleContainer batches the whole layer into one GPU draw call instead (measured 50k
    // particles in 2.4ms vs ~30ms on canvas2d), which is what buys the headroom for denser smoke.
    // Scene and smoke share ONE container so the shockwave filter warps them together. Filtering
    // only the scene sprite would ripple the world and leave the smoke hanging rigidly over it.
    // Smoke layers are added to this as their sources appear.
    this.m_world = new Container();
    this.m_world.addChild(this.m_scene);
    this.m_app.stage.addChild(this.m_world);

    this.m_shockwave = new ShockwaveFilter({
      center: {x: 0, y: 0},
      amplitude: 34,
      wavelength: 180,
      brightness: 1.15,
      speed: 900,
      radius: -1,
    });
    this.m_shockwave.enabled = false;
    this.m_world.filters = [this.m_shockwave];

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
   * The scene render target was resized externally (a window resize re-renders the world at
   * native pixels). Rebuild the GPU texture from the (already-resized) scene canvas and re-fit.
   * This is the NATIVE pixel size and is independent of the logical world→screen mapping, which
   * is set separately via setWorldSize().
   */
  setSceneSize(): void {
    this.m_sceneTexture.destroy();
    this.m_sceneTexture = Texture.from(this.m_sceneCanvas);
    this.m_scene.texture = this.m_sceneTexture;
    this.resize();
  }

  /**
   * Set the LOGICAL world size used to map world coords → screen for the shockwave. This is the
   * controller's fixed logical view size, not the native canvas size, so a window resize (which
   * changes only the render resolution) leaves the shockwave placement correct.
   */
  setWorldSize(w: number, h: number): void {
    this.m_worldW = w;
    this.m_worldH = h;
  }

  /**
   * Fit the presentation to the current viewport. Explicitly resizes the Pixi
   * renderer to the live element size (Pixi's own `resizeTo` throttles and can
   * miss a fast resize, e.g. toggling devtools) and then fits the scene sprite.
   */
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
