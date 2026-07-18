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
import { getWeapon, WEAPON_DATABASE, getDefaultWeaponIndex } from '../core/CWeapon';
import { CExplosion, ScreenShake } from '../core/CExplosion';
import { CAssetManager } from '../core/rendering/CAssetManager';

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

// Battlefield backdrop drawn behind the terrain.
const BACKGROUND_PATH = '/assets/bg/03.jpg';

/**
 * CGameController - Main game controller
 */
export class CGameController {
  
  // ========================================================================
  // CONSTRUCTION & INITIALIZATION
  // ========================================================================
  
  constructor(canvas: HTMLCanvasElement) {
    this.m_canvas = canvas;
    this.m_ctx = canvas.getContext('2d')!;
    
    this.m_land = new CLand(canvas.width, canvas.height - 120); // Account for UI
    
    this.m_tanks = [];
    this.m_shots = [];
    this.m_explosionSystem = new CExplosion();
    this.m_screenShake = new ScreenShake();
    this.m_assets = new CAssetManager();

    // Background loads immediately; the render loop falls back to a gradient
    // until it is ready.
    this.m_assets.loadImage('bg', BACKGROUND_PATH);
    
    // Initialize weapon list (index into WEAPON_DATABASE)
    this.m_currentWeaponIndex = getDefaultWeaponIndex();
    
    // Wind: positive = right, negative = left
    this.m_windSpeed = 0;  // pixels/sec influence
    
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

    // Randomize wind
    this.updateWind();
    
    // Set initial state
    this.m_currentPlayerIndex = 0;
    this.m_gameState = EGameState.Battle;
    this.advanceToNextPlayer();
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
    
    // Always update terrain and visual effects
    this.m_land.update(dt);
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
    
    // Draw active shots and effects
    for (const shot of this.m_shots) {
      if (!shot.isDead()) {
        const weapon = getWeapon(this.m_currentWeaponIndex);
        shot.draw(ctx, weapon.getColor());
      }
    }
    
    // Draw explosions on top
    this.m_explosionSystem.draw(ctx);
    
    ctx.restore();
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
      shot.update(dt, this.m_windSpeed);
      
      // Check terrain collision
      if (shot.checkTerrainCollision(this.m_land)) {
        this.handleShotImpact(shot);
        continue;
      }
      
      // Check tank collisions
      for (const tank of this.m_tanks) {
        if (!tank.isAlive()) continue;
        
        if (shot.checkTankCollision(tank)) {
          // Direct hit on a tank.
          this.handleShotImpact(shot);
          break;
        }
      }
    }
    
    // Check if all shots are done
    const stillFlying = activeShots.some(s => !s.isDead());
    if (!stillFlying) {
      this.m_gameState = EGameState.Battle;
      
      // If current player is human, re-enable controls
      // Otherwise AI takes their turn immediately
      setTimeout(() => {
        if (this.getCurrentTank().isBot()) {
          this.advanceToNextPlayer();
          this.executeBotTurn();
        }
      }, 500);
    }
  }
  
  /**
   * Handle shot impact at current position
   */
  private handleShotImpact(shot: CShot): void {
    const pos = shot.getPosition();
    
    // Mark shot as dead
    shot.m_bIsDead = true;
    
    // Create explosion effect
    this.m_explosionSystem.createExplosion(pos.x, pos.y, 1.5);
    
    // Screen shake on impact
    this.m_screenShake.trigger(8, 0.3);
    
    // Apply terrain deformation (blast crater)
    this.m_land.blastCircle(Math.floor(pos.x), Math.floor(pos.y), shot.getRadius());
    
    // Add dirt shower particles
    this.m_land.addShowerParticles(Math.floor(pos.x), Math.floor(this.m_land.getHeightAt(Math.floor(pos.x))), 10);
    
    // Apply damage to tanks in blast radius
    const weapon = getWeapon(this.m_currentWeaponIndex);

    // Ripple the whole scene — bigger for nukes / large blasts.
    const waveStrength = (weapon.isNuclear() ? 2.6 : 1.0) + shot.getRadius() / 120;
    this.m_onImpact?.(pos.x, pos.y, waveStrength);

    for (const tank of this.m_tanks) {
      if (!tank.isAlive()) continue;
      
      if (tank.isInBlastRadius(pos.x, pos.y, shot.getRadius())) {
        // Damage falls off linearly from the blast centre to its edge.
        const dist = tank.distanceTo(pos.x, pos.y);
        const falloff = Math.max(0, 1 - dist / (shot.getRadius() + 1));

        // Pass raw damage; the tank applies its own shield/armor model.
        tank.hit(shot.getDamage() * falloff);

        if (!tank.isAlive()) {
          this.handleTankDestroyed(tank);
        }
      }
    }
    
    // Handle nuclear weapons - create radiation zone
    if (weapon.isNuclear()) {
      this.m_land.blastIradiate(
        Math.floor(pos.x),
        Math.floor(this.m_land.getHeightAt(Math.floor(pos.x))),
        80,     // Radius
        10,     // Damage per second
        15      // Duration seconds
      );
    }
    
    // Transition to explosion state (wait for effects)
    this.m_gameState = EGameState.Explosion;
  }


  /**
   * Check if battle has ended
   */
  private checkBattleEnd(): void {
    const aliveTanks = this.m_tanks.filter(t => t.isAlive());
    
    if (aliveTanks.length <= 1) {
      // Battle over!
      this.m_gameState = EGameState.BattleEnd;
      
      if (aliveTanks.length === 1) {
        console.log(`Winner: ${aliveTanks[0].getName()}!`);
        
        // Show victory indicator
        const winner = aliveTanks[0];
        document.getElementById('turn-indicator')!.textContent = `${winner.getName()} WINS!`;
        document.getElementById('turn-indicator')!.classList.add('visible');
      }
    } else {
      // Continue to next player
      this.advanceToNextPlayer();
      
      if (this.getCurrentTank().isBot()) {
        setTimeout(() => this.executeBotTurn(), 500);
      }
    }
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
    
    // Find next alive player in rotation
    let attempts = 0;
    do {
      this.m_currentPlayerIndex = (this.m_currentPlayerIndex + 1) % nPlayers;
      attempts++;
      
      if (attempts > nPlayers * 2) {
        console.warn('All players dead or stuck');
        break;
      }
    } while (!this.getCurrentTank().isAlive());
    
    // Update UI
    const tank = this.getCurrentTank();
    document.getElementById('turn-indicator')!.textContent = `${tank.getName()}'s Turn`;
    document.getElementById('turn-indicator')!.classList.add('visible');
    
    setTimeout(() => {
      document.getElementById('turn-indicator')!.classList.remove('visible');
    }, 1500);
    
    // Update current player display
    const teamColor = TEAM_COLORS[tank.getTeamId()] || '#ff4444';
    document.getElementById('current-player')!.innerHTML = 
      `<span style="color:${teamColor}">${tank.getName()}</span> - Tank ${this.m_tanks.indexOf(tank) + 1}`;
    
    // Update health bars
    const health = tank.getHealth();
    document.getElementById('life-fill')!.style.width = `${Math.max(0, health.nLife)}%`;
    document.getElementById('shield-fill')!.style.width = `${(Math.max(0, health.nShield) / 500) * 100}%`;
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
    
    // Get muzzle position and firing parameters
    const muzzlePos = tank.getMuzzlePosition();
    
    // Create new shot
    const pShot = new CShot();
    pShot.initFromTank(
      muzzlePos,
      tank.getTurretAngle(),
      this.m_power,           // Power from UI control
      weapon.getDamage(),
      weapon.getRadius(),
      tank
    );
    
    this.m_shots.push(pShot);
    
    // Transition to shot flying state
    this.m_gameState = EGameState.ShotFlying;
    
    // Fire button disabled during animation
    (document.getElementById('fire-btn') as HTMLButtonElement).disabled = true;
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
      this.advanceToNextPlayer();
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
    
    // Update UI to show bot's choices
    document.getElementById('angle-value')!.textContent = String(Math.floor(this.m_angle));
    (document.getElementById('angle-slider') as HTMLInputElement).value = String(Math.floor(this.m_angle));
    document.getElementById('power-value')!.textContent = String(Math.floor(this.m_power));
    (document.getElementById('power-slider') as HTMLInputElement).value = String(Math.floor(this.m_power));
    
    // Execute fire after brief "thinking" delay
    setTimeout(() => {
      this.fire();
      
      // Re-enable controls when shot completes
      const checkComplete = () => {
        if (this.m_gameState === EGameState.Battle) {
          (document.getElementById('fire-btn') as HTMLButtonElement).disabled = false;
        } else {
          setTimeout(checkComplete, 100);
        }
      };
    }, 800); // Bot "aiming" delay
  }


  // ========================================================================
  // WIND & PHYSICS
  // ========================================================================
  
  /**
   * Randomize wind for new round
   */
  private updateWind(): void {
    this.m_windSpeed = (Math.random() - 0.5) * 10; // -5 to +5 range
    
    const absWind = Math.abs(this.m_windSpeed);
    const arrow = this.m_windSpeed >= 0 ? '→' : '←';
    
    document.getElementById('wind-value')!.textContent = `${arrow} ${absWind.toFixed(1)}`;
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
  
  // Game state machine
  private m_gameState: EGameState = EGameState.Battle;
  private m_currentPlayerIndex: number = 0;
  
  // Firing controls
  private m_angle: number;
  private m_power: number;
  private m_currentWeaponIndex: number;   // Index into WEAPON_DATABASE
  
  // Physics
  private m_windSpeed: number;            // Horizontal wind influence
}
