/**
 * CGameController - Main Game Controller
 * 
 * Central coordinator for:
 * - Turn-based battle flow state machine  
 * - Tank management and player turns
 * - Firing sequence coordination
 * - Wind and physics parameters
 */

import { CLand } from '../core/CLand';
import { CTank, TEAM_COLORS } from '../core/CTank';
import { CShot } from '../core/CShot';
import { getWeapon, WEAPON_DATABASE, getDefaultWeaponIndex, CWeapon } from '../core/CWeapon';
import { Vec2 } from '../math/Vec2';
import { CExplosion, ScreenShake } from '../core/CExplosion';
import { CAssetManager } from '../core/rendering/CAssetManager';
import { weaponFlyStep, weaponDetonate, EXT, type ShotWorld } from '../core/weapons/WeaponBehavior';

/**
 * Game state machine states
 */
export enum EGameState {
  Menu = 'menu',
  WeaponSelect = 'weaponselect', 
  Battle = 'battle',
  ShotFlying = 'shot_flying',
  Explosion = 'explosion',
  BattleEnd = 'battle_end'
}

// Bot names
const BOT_NAMES = [
  'Whopper', 'BrainBot', 'RandBot', 'AlphaBot', 'MechaBot',
  'FlashBot', 'GammaBot', 'ShazBot', 'BetaBot', 'DeltaBot'
];

import landData from '../data/land.json';

interface LandConfig {
  bg: string;
  weather: { type: string; intensity: number }[];
  layers: { tile: string; depth: number }[];
}
const LAND_DATA = landData as LandConfig[];

/**
 * CGameController - Main game controller
 */
export class CGameController implements ShotWorld {

  // ========================================================================
  // CONSTRUCTION & INITIALIZATION
  // ========================================================================
  
  constructor(canvas: HTMLCanvasElement) {
    this.m_canvas = canvas;
    this.m_ctx = canvas.getContext('2d')!;
    
    // Terrain fills the full viewport so its body covers the bottom of the
    // screen — the background's foreground never shows in the HUD strip.
    this.m_land = new CLand(canvas.width, canvas.height);
    
    this.m_tanks = [];
    this.m_shots = [];
    this.m_explosionSystem = new CExplosion();
    this.m_screenShake = new ScreenShake();
    this.m_assets = new CAssetManager();
    
    // Initialize weapon list (index into WEAPON_DATABASE)
    this.m_currentWeaponIndex = getDefaultWeaponIndex();
    
    // Wind: positive = right, negative = left
    this.m_wind = new Vec2(0, 0);
    
    // UI control values
    this.m_angle = 45;
    this.m_power = 50;
  }
  
  /**
   * Start new game with specified number of players
   */
  startGame(nPlayers: number = 2): void {
    // Reset state
    this.m_tanks = [];
    this.m_shots = [];
    this.m_mines = [];
    this.m_sentries = [];
    this.m_aimMarkers = [];

    // Generate terrain
    this.m_land.generateRandomTerrain();
    
    // Create tanks for each player (alternating teams)
    for (let i = 0; i < nPlayers; i++) {
      const teamId = i % 2;
      
      // Position tanks at opposite ends of screen
      let xPos: number;
      if (i === 0) {
        xPos = 100 + Math.random() * 50;  // Left side for player 1
      } else if (i === nPlayers - 1) {
        xPos = this.m_canvas.width - 150 + Math.random() * 50;  // Right side
      } else {
        // Bots scattered in middle
        xPos = 200 + Math.random() * (this.m_canvas.width - 400);
      }
      
      const tankName = i === 0 ? 'Player' : BOT_NAMES[i % BOT_NAMES.length];
      
      const pTank = new CTank(tankName, teamId);
      pTank.init(xPos, this.m_land);
      pTank.setHuman(i === 0); // Only first player is human
      
      this.m_tanks.push(pTank);
    }

    // Preload hull sprites for the tanks in play (fire-and-forget; the renderer
    // falls back to vector hulls until they are ready).
    for (const tank of this.m_tanks) {
      for (const s of tank.getRequiredSprites()) {
        this.m_assets.loadSprite(s.name, s.file);
      }
    }

    // Preload projectile sprites (each weapon's `bitmap` under assets/weapons/).
    // They all use a magenta (255,0,255) background, same as the hull sprites.
    const bitmaps = new Set(WEAPON_DATABASE.map(w => w.bitmap).filter(Boolean));
    for (const bmp of bitmaps) {
      this.m_assets.loadSprite(`weapons/${bmp}`, `/assets/weapons/${bmp}`);
    }

    // Pick a landscape (background + depth-layered terrain textures + weather).
    this.loadLandscape();

    // Randomize wind
    this.updateWind();
    
    // Set initial state
    // Player 0 (the human) takes the first turn.
    this.m_currentPlayerIndex = 0;
    this.beginTurn();
  }

  /**
   * Pick a random landscape from land.json and load its background + depth-sorted
   * terrain textures. Fire-and-forget: the terrain shows a gradient until ready.
   */
  private async loadLandscape(): Promise<void> {
    const cfg = LAND_DATA[Math.floor(Math.random() * LAND_DATA.length)];

    this.m_assets.loadImage('bg', '/assets/' + cfg.bg);

    await Promise.all(cfg.layers.map(l =>
      this.m_assets.loadImage('tile:' + l.tile, '/assets/' + l.tile)));

    const layers = cfg.layers
      .map(l => {
        const sprite = this.m_assets.getSprite('tile:' + l.tile);
        return sprite ? { image: sprite.bitmap, depth: l.depth } : null;
      })
      .filter((x): x is { image: CanvasImageSource; depth: number } => x !== null);

    this.m_land.setLayers(layers);
  }


  // ========================================================================
  // GAME LOOP & UPDATE
  // ========================================================================
  
  /**
   * Main update tick - called every frame via requestAnimationFrame
   */
  update(dt: number): void {
    switch (this.m_gameState) {
      case EGameState.Battle:
        this.updateBattle(dt);
        break;
        
      case EGameState.ShotFlying:
        this.updateShotInFlight(dt);
        break;
        
      case EGameState.Explosion:
        // Wait for explosion effects to complete
        if (!this.m_explosionSystem.hasActiveExplosions() && 
            !this.m_screenShake.isActive()) {
          this.checkBattleEnd();
        }
        break;
    }
    
    // Always update terrain, wind and visual effects
    this.m_land.update(dt);
    this.updateWindDrift(dt);
    this.m_explosionSystem.update(dt);
  }
  
  /**
   * Render frame to canvas - called every frame
   */
  draw(): void {
    const ctx = this.m_ctx;
    
    // Apply screen shake offset
    const shakeOffset = this.m_screenShake.getOffset();
    ctx.save();
    ctx.translate(shakeOffset.x, shakeOffset.y);
    
    // Backdrop: real background image once loaded, else a night-sky gradient.
    const bg = this.m_assets.getSprite('bg');
    if (bg) {
      ctx.drawImage(bg.bitmap, 0, 0, this.m_canvas.width, this.m_canvas.height);
    } else {
      const skyGradient = ctx.createLinearGradient(0, 0, 0, this.m_canvas.height - 120);
      skyGradient.addColorStop(0, '#1a1a2e');     // Dark night
      skyGradient.addColorStop(0.6, '#16213e');   // Mid blue
      skyGradient.addColorStop(1, '#0f3460');     // Horizon

      ctx.fillStyle = skyGradient;
      ctx.fillRect(0, 0, this.m_canvas.width, this.m_canvas.height);

      // Draw stars (subtle background)
      this.drawStars(ctx);
    }
    
    // Draw terrain
    this.m_land.draw(ctx);
    
    // Draw tanks
    for (const tank of this.m_tanks) {
      if (tank.isAlive()) {
        tank.draw(ctx, this.m_assets);
        
        // Highlight current player's tank with indicator
        if (this.getCurrentTank() === tank && 
            this.m_gameState !== EGameState.ShotFlying &&
            this.m_gameState !== EGameState.Explosion) {
          this.drawTurnIndicator(ctx, tank);
        }
      } else if (!tank.m_bExploded || tank.isAlive()) {
        // Skip dead tanks that are already exploded
      } else {
        // Draw wreckage for exploded but not yet cleaned up tanks
        tank.draw(ctx, this.m_assets);
      }
    }
    
    // Draw active shots (real projectile sprite, tinted trail fallback).
    for (const shot of this.m_shots) {
      if (!shot.isDead()) {
        const wi = shot.getWeaponIndex() >= 0 ? shot.getWeaponIndex() : this.m_currentWeaponIndex;
        const weapon = getWeapon(wi);
        const sprite = this.m_assets.getSprite(`weapons/${weapon.getBitmap()}`);
        shot.draw(ctx, weapon.getColor(), sprite?.bitmap ?? null, weapon.getSize());
      }
    }

    this.drawPlacedEntities(ctx);

    // Draw explosions on top
    this.m_explosionSystem.draw(ctx);
    
    ctx.restore();
  }


  /** Mines, sentries and tracer markers placed on the field. */
  private drawPlacedEntities(ctx: CanvasRenderingContext2D): void {
    for (const m of this.m_mines) {
      ctx.fillStyle = m.armed > 0 ? '#886600' : '#ffcc00';
      ctx.beginPath(); ctx.arc(m.x, m.y - 2, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#000'; ctx.fillRect(m.x - 5, m.y - 1, 10, 2);
    }
    for (const s of this.m_sentries) {
      ctx.fillStyle = '#9aa';
      ctx.fillRect(s.x - 5, s.y - 10, 10, 10);
      ctx.fillRect(s.x, s.y - 8, 12, 3);
    }
    for (const mk of this.m_aimMarkers) {
      ctx.strokeStyle = 'rgba(255,80,80,0.8)'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mk.x - 6, mk.y); ctx.lineTo(mk.x + 6, mk.y);
      ctx.moveTo(mk.x, mk.y - 6); ctx.lineTo(mk.x, mk.y + 6);
      ctx.stroke();
    }
  }

  /**
   * Background stars for atmosphere
   */
  private drawStars(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = '#ffffff';
    
    // Static stars (seeded random)
    const starPositions = [
      [50, 30], [150, 60], [300, 25], [450, 80], [600, 40],
      [700, 55], [100, 100], [250, 120], [500, 90], [650, 110]
    ];
    
    for (const [x, y] of starPositions) {
      const brightness = 0.3 + Math.sin(Date.now() / 1000 + x) * 0.2;
      ctx.globalAlpha = brightness;
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, Math.PI * 2);
      ctx.fill();
    }
    
    ctx.globalAlpha = 1;
  }
  
  /**
   * Draw indicator around current player's tank
   */
  private drawTurnIndicator(ctx: CanvasRenderingContext2D, tank: CTank): void {
    const pos = tank.getPosition();
    
    ctx.strokeStyle = '#ffff00';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y + 12, 25, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // "Your turn" indicator arrow
    if (tank.isHuman()) {
      ctx.fillStyle = '#ffff00';
      ctx.font = 'bold 14px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('YOUR TURN', pos.x, pos.y - 30);
    }
  }


  // ========================================================================
  // BATTLE FLOW
  // ========================================================================
  
  /**
   * Update during battle state (waiting for player input)
   */
  private updateBattle(dt: number): void {
    this.updateMines(dt);

    // Update tanks on terrain (for falling/movement animations)
    for (const tank of this.m_tanks) {
      if (tank.isAlive()) {
        tank.update(this.m_land, dt);
        
        // Apply radiation damage from nuclear zones
        const radZones = this.m_land.getRadiationZones();
        for (const rZone of radZones) {
          const dist = tank.distanceTo(rZone.x, rZone.y);
          
          if (dist < rZone.radius + 16) {  // TANK_RADIUS
            tank.applyRadiationDamage(rZone.damagePerSecond * dt, dt);
            
            if (!tank.isAlive()) {
              this.handleTankDestroyed(tank);
            }
          }
        }
      }
    }
  }
  
  /**
   * Update shot that is currently in flight
   */
  private updateShotInFlight(dt: number): void {
    const activeShots = this.m_shots.filter(s => !s.isDead());
    
    if (activeShots.length === 0) {
      // No active shots - something went wrong, return to battle
      this.m_gameState = EGameState.Battle;
      return;
    }
    
    for (const shot of activeShots) {
      shot.update(dt, this.m_wind);

      // Per-frame behaviour dispatch (extType): roller/digger/airburst/beam/…
      const weapon = getWeapon(shot.getWeaponIndex() >= 0 ? shot.getWeaponIndex() : this.m_currentWeaponIndex);
      const action = weaponFlyStep(shot, weapon, this, dt);
      if (action === 'detonate') weaponDetonate(shot, weapon, this);
      else if (action === 'consumed') shot.kill();
    }

    // Include submunitions spawned this frame, so a cluster keeps the round in
    // flight until every child has landed.
    const stillFlying = this.m_shots.some(s => !s.isDead());
    if (stillFlying) {
      this.m_gameState = EGameState.ShotFlying;
    } else {
      // The shot (and any submunitions) have resolved — end the turn after a
      // short beat so the explosion is visible.
      this.m_shots = [];
      this.m_gameState = EGameState.Battle;
      setTimeout(() => this.endTurn(), 600);
    }
  }
  
  // ========================================================================
  // ShotWorld — the surface the weapon behaviours (WeaponBehavior.ts) act on
  // ========================================================================

  get land(): CLand { return this.m_land; }
  get tanks(): CTank[] { return this.m_tanks; }
  spawnShot(shot: CShot): void { this.m_shots.push(shot); }
  explode(x: number, y: number, scale: number): void { this.m_explosionSystem.createExplosion(x, y, scale); }
  shake(mag: number, dur: number): void { this.m_screenShake.trigger(mag, dur); }
  ripple(x: number, y: number, strength: number): void { this.m_onImpact?.(x, y, strength); }
  aimMarker(x: number, y: number): void { this.m_aimMarkers.push({ x, y }); }
  deployMine(x: number, y: number, owner: CTank | null, weaponIndex: number): void {
    // Arms after a short delay so it doesn't trigger on the tank that laid it.
    this.m_mines.push({ x, y, owner, weaponIndex, armed: 0.6 });
  }
  deploySentry(x: number, y: number, owner: CTank | null, weaponIndex: number): void {
    // TODO: auto-firing turret each turn. For now the sentry is a static placed marker.
    this.m_sentries.push({ x, y, owner, weaponIndex });
  }

  /** Mines detonate when a living tank rolls over them (after they arm). */
  private updateMines(dt: number): void {
    for (let i = this.m_mines.length - 1; i >= 0; i--) {
      const m = this.m_mines[i];
      if (m.armed > 0) { m.armed -= dt; continue; }
      const near = this.m_tanks.find(t => t.isAlive() && t.distanceTo(m.x, m.y) < 20);
      if (!near) continue;
      const w = getWeapon(m.weaponIndex);
      this.m_mines.splice(i, 1);
      this.explode(m.x, m.y, 1.3);
      this.shake(8, 0.3);
      this.m_land.blastCircle(Math.floor(m.x), Math.floor(m.y), w.getRadius());
      this.applyBlast(new Vec2(m.x, m.y), w.getRadius(), w.getDamage(), m.owner, false);
    }
  }

  /**
   * Falloff blast damage + kick, applied through the tank's shield/armor model
   * (port of FUN_00404670). `full` = beam direct hit: no distance falloff.
   */
  applyBlast(pos: Vec2, radius: number, damage: number, _owner: CTank | null, full: boolean): void {
    for (const tank of this.m_tanks) {
      if (!tank.isAlive()) continue;
      const dist = tank.distanceTo(pos.x, pos.y);
      const inRange = full ? dist < Math.max(radius, 20) : dist <= radius + 1;
      if (!inRange) continue;

      const falloff = full ? 1 : Math.max(0, 1 - dist / (radius + 1));
      const dmg = damage * falloff;
      if (dmg <= 0) continue;

      tank.hit(dmg);                               // shield/armor applied by the tank

      const dx = tank.getPosition().x - pos.x;     // kick up and away from the blast
      const kickDir = new Vec2(dx >= 0 ? 0.6 : -0.6, -1).normalize();
      tank.kick(kickDir, Math.min(1, dmg / 400) * 320);

      if (!tank.isAlive()) this.handleTankDestroyed(tank);
    }
  }


  private checkBattleEnd(): void {
    this.endTurn();
  }
  
  /**
   * Handle tank destroyed event
   */
  private handleTankDestroyed(tank: CTank): void {
    const pos = tank.getPosition();
    
    // Create explosion at tank position
    this.m_explosionSystem.createExplosion(pos.x, pos.y + 12, 2.0);
    this.m_screenShake.trigger(15, 0.5);
  }


  /**
   * Advance to next living player's turn
   */
  private advanceToNextPlayer(): void {
    const nPlayers = this.m_tanks.length;

    let attempts = 0;
    do {
      this.m_currentPlayerIndex = (this.m_currentPlayerIndex + 1) % nPlayers;
      attempts++;
      if (attempts > nPlayers * 2) {
        console.warn('All players dead or stuck');
        break;
      }
    } while (!this.getCurrentTank().isAlive());
  }

  /** Start the current player's turn. The HUD (Preact) reads state via getters. */
  private beginTurn(): void {
    const tank = this.getCurrentTank();
    this.m_gameState = EGameState.Battle;

    if (tank.isBot()) {
      setTimeout(() => this.executeBotTurn(), 700);
    }
  }

  /** End the current turn: declare a winner, or hand off to the next player. */
  private endTurn(): void {
    const alive = this.m_tanks.filter(t => t.isAlive());
    if (alive.length <= 1) {
      this.m_gameState = EGameState.BattleEnd;
      this.m_winnerName = alive.length === 1 ? alive[0].getName() : '';
      return;
    }
    this.advanceToNextPlayer();
    this.beginTurn();
  }
  
  /**
   * Get current player's tank
   */
  getCurrentTank(): CTank {
    return this.m_tanks[this.m_currentPlayerIndex];
  }


  // ========================================================================
  // FIRING SEQUENCE
  // ========================================================================
  
  /**
   * Fire currently selected weapon from current player
   */
  fire(): void {
    const tank = this.getCurrentTank();
    if (!tank.isAlive()) return;

    const weapon = getWeapon(this.m_currentWeaponIndex);
    const ext = weapon.getExtType();

    // Utility items apply an effect to the firing tank instead of launching a shot.
    if (this.applyUtility(tank, weapon, ext)) {
      this.m_gameState = EGameState.Battle;
      setTimeout(() => this.endTurn(), 400);
      return;
    }

    // Death: a self-targeting round that drops straight down onto the firer.
    if (ext === EXT.DEATH) {
      const tp = tank.getPosition();
      const drop = new CShot();
      drop.initFromVelocity(new Vec2(tp.x, Math.max(0, tp.y - 220)), 0, 0, weapon.getDamage(), weapon.getRadius(), tank);
      drop.setWeaponIndex(this.m_currentWeaponIndex);
      this.m_shots.push(drop);
      this.m_gameState = EGameState.ShotFlying;
      return;
    }

    const muzzlePos = tank.getMuzzlePosition();
    const baseAngle = tank.getTurretAngle();
    const isBeam = ext === EXT.BEAM || ext === EXT.BEAM2;
    const varianceRad = weapon.getVariance() * Math.PI / 180;   // per-shot inaccuracy

    // `spread` fires a simultaneous fan of rounds; a plain weapon fires one.
    const rounds = Math.max(1, weapon.getSpreadCount());
    const spacingRad = 8 * Math.PI / 180;

    for (let i = 0; i < rounds; i++) {
      const fan = rounds > 1 ? (i - (rounds - 1) / 2) * spacingRad : 0;
      const jitter = varianceRad > 0 ? (Math.random() * 2 - 1) * varianceRad : 0;
      const pShot = new CShot();
      pShot.initFromTank(muzzlePos, baseAngle + fan + jitter, this.m_power, weapon.getDamage(), weapon.getRadius(), tank);
      pShot.setWeaponIndex(this.m_currentWeaponIndex);
      pShot.setSkipGravity(isBeam);
      this.m_shots.push(pShot);
    }

    this.m_gameState = EGameState.ShotFlying;
  }

  /**
   * Utility items (extType 7/10/11/14) modify the firing tank on use rather than
   * firing a projectile — port of the FUN_004678b0 "use item" handler. Verified
   * effects only; 3/15/17 are UNVERIFIED in the decompile and left as no-ops.
   * Returns true if the weapon was a utility (and consumed the turn).
   */
  private applyUtility(tank: CTank, weapon: CWeapon, ext: number): boolean {
    const v = weapon.getDamage();   // the effect magnitude lives in the damage field
    switch (ext) {
      case 7:  tank.addShield(v); return true;          // shield boost
      case 10: tank.addLife(v);   return true;          // repair
      case 11: tank.setArmor(v);  return true;          // set armor %
      case 14: return true;                             // secondary resist (no field yet) — consumes turn
      case 3: case 15: case 17: return true;            // UNVERIFIED effect — consume turn, no-op
      default: return false;
    }
  }


  // ========================================================================
  // BOT AI (CPU PLAYER)
  // ========================================================================
  
  /**
   * Execute bot player's turn (AI calculation and firing)
   */
  private executeBotTurn(): void {
    const botTank = this.getCurrentTank();
    
    if (!botTank.isAlive() || !botTank.isBot()) return;
    
    console.log(`${botTank.getName()} is thinking...`);
    
    // Simple AI: pick a target (random enemy)
    const enemies = this.m_tanks.filter(t => t !== botTank && t.isAlive());
    if (enemies.length === 0) {
      this.endTurn();
      return;
    }
    
    // Pick a random straightforward ballistic weapon (bots can't use exotics yet).
    const usable = WEAPON_DATABASE.filter(w => w.type === 'Shell' || w.type === 'Bomb' || w.type === 'Rocket');
    const pick = usable[Math.floor(Math.random() * usable.length)];
    this.m_currentWeaponIndex = pick ? pick.index : getDefaultWeaponIndex();
    
    // Calculate firing angle to hit target (simplified trajectory)
    const target = enemies[Math.floor(Math.random() * enemies.length)];
    const targetPos = target.getPosition();
    const botPos = botTank.getPosition();
    
    // Simple aim: aim slightly above target based on distance
    const dx = targetPos.x - botPos.x;
    const dy = targetPos.y - botPos.y;
    const distance = Math.abs(dx);
    
    // Estimate angle (simplified - not true ballistics)
    let angle = 45 + (Math.random() - 0.5) * 20; // Aim around 45 degrees with variance
    if (dx < 0) {
      // Target is to the left, aim leftward
      angle = 180 - angle;
    }
    
    // Set firing parameters
    this.m_angle = angle;
    this.m_power = Math.min(100, Math.max(30, distance / 8 + Math.random() * 20));
    
    botTank.setTurretAngle(angle);
    // The HUD (Preact) shows the bot's angle/power via getAngle()/getPower().

    // Execute fire after a brief "thinking" delay. The turn ends automatically
    // once the shot resolves (updateShotInFlight → endTurn).
    setTimeout(() => this.fire(), 800);
  }


  // ========================================================================
  // WIND & PHYSICS
  // ========================================================================
  
  private static readonly MAX_WIND = 5;

  /** Seed a fresh random wind at the start of a game. */
  private updateWind(): void {
    this.m_wind = new Vec2(
      (Math.random() * 2 - 1) * CGameController.MAX_WIND,
      (Math.random() * 2 - 1) * CGameController.MAX_WIND * 0.3,
    );
    this.m_windTimer = 0;
  }

  /**
   * Drift the wind vector slowly and re-randomise its acceleration on a timer
   * (mirrors the original's wind model). Called every frame.
   */
  private updateWindDrift(dt: number): void {
    const MAX = CGameController.MAX_WIND;
    this.m_wind.x = Math.max(-MAX, Math.min(MAX, this.m_wind.x + this.m_windAccel.x * dt));
    this.m_wind.y = Math.max(-MAX * 0.3, Math.min(MAX * 0.3, this.m_wind.y + this.m_windAccel.y * dt));

    this.m_windTimer -= dt;
    if (this.m_windTimer <= 0) {
      this.m_windTimer = Math.random() * 8 + 4;   // 4..12 s until next drift target
      this.m_windAccel = new Vec2(
        (Math.random() * 2 - 1) * 2,
        (Math.random() * 2 - 1) * 1,
      );
    }
  }


  // ========================================================================
  // UI CONTROL HANDLERS
  // ========================================================================
  
  setAngle(angle: number): void {
    this.m_angle = angle;
    const tank = this.getCurrentTank();
    
    if (tank.isHuman()) {
      tank.setTurretAngle(this.m_angle);
    }
  }
  
  setPower(power: number): void {
    this.m_power = power;
  }
  
  selectWeapon(index: number): void {
    if (index >= 0 && index < WEAPON_DATABASE.length) {
      this.m_currentWeaponIndex = index;
    }
  }

  // --- HUD accessors ---------------------------------------------------------
  getWeaponDefs() { return WEAPON_DATABASE; }
  getCurrentWeaponIndex(): number { return this.m_currentWeaponIndex; }
  getCurrentWeapon(): CWeapon { return getWeapon(this.m_currentWeaponIndex); }
  getAngle(): number { return this.m_angle; }
  getPower(): number { return this.m_power; }
  getWindValue(): number { return this.m_wind.x; }
  getCurrentPlayerName(): string { return this.getCurrentTank().getName(); }
  getCurrentTeamColor(): string { return TEAM_COLORS[this.getCurrentTank().getTeamId()] || '#ff4444'; }
  getWinnerName(): string { return this.m_winnerName; }

  /** Register a callback invoked at each shot impact (world x, y, strength). */
  setImpactListener(cb: (x: number, y: number, strength: number) => void): void {
    this.m_onImpact = cb;
  }


  // ========================================================================
  // ACCESSORS
  // ========================================================================
  
  getState(): EGameState { return this.m_gameState; }
  
  isPlayerTurn(): boolean {
    return this.getCurrentTank().isHuman() && 
           (this.m_gameState === EGameState.Battle);
  }

  // ========================================================================
  // MEMBER VARIABLES
  // ========================================================================
  
  private m_canvas: HTMLCanvasElement;
  private m_ctx: CanvasRenderingContext2D;
  
  private m_land: CLand;
  private m_tanks: CTank[] = [];
  private m_shots: CShot[];
  
  private m_explosionSystem: CExplosion;
  private m_screenShake: ScreenShake;
  private m_assets: CAssetManager;
  private m_onImpact: ((x: number, y: number, strength: number) => void) | null = null;

  // Placed entities from special weapons (Mine/Sentry) and Tracer aim markers.
  private m_mines: { x: number; y: number; owner: CTank | null; weaponIndex: number; armed: number }[] = [];
  private m_sentries: { x: number; y: number; owner: CTank | null; weaponIndex: number }[] = [];
  private m_aimMarkers: { x: number; y: number }[] = [];
  
  // Game state machine
  private m_gameState: EGameState = EGameState.Battle;
  private m_currentPlayerIndex: number = 0;
  
  // Firing controls
  private m_angle: number;
  private m_power: number;
  private m_currentWeaponIndex: number;   // Index into WEAPON_DATABASE
  
  // Physics — wind is a slowly-drifting 2-D vector (display units, ~±5).
  private m_wind: Vec2 = new Vec2(0, 0);
  private m_windAccel: Vec2 = new Vec2(0, 0);
  private m_windTimer: number = 0;

  private m_winnerName: string = '';
}
