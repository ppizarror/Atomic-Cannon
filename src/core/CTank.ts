/**
 * CTank - Tank Entity Class
 * 
 * Handles tank state, movement on terrain, damage, rendering
 */

import { Vec2, Vec2f } from '../math/Vec2';
import { CLand } from './CLand';

/** A drawable image plus its dimensions. */
export interface Sprite {
    bitmap: CanvasImageSource;
    width: number;
    height: number;
}

/** Anything that can resolve a logical sprite name to a drawable sprite. */
export interface ISpriteSource {
    getSprite(name: string): Sprite | null;
}

// Tank hull variants (real sprite sets under assets/tanks/), assigned per team.
const TANK_TYPES = ['Standard', 'MA1', 'MSPO', 'Sentry', 'Green', 'Atomic Cannon'];

export const TEAM_COLORS: Record<number, string> = {
  0: '#ff4444',
  1: '#4444ff',
  2: '#44ff44',
  3: '#ffff44',
};

/**
 * Tank health/shield status structure
 */
export interface STankHealth {
    nLife: number;        // Current health (0-100 typical)
    nShield: number;      // Shield points (absorbed before health)
    nArmor: number;       // Armor percentage reduction
    fRadiation: number;   // Radiation damage over time
}

/**
 * Tank state flags/members:
 * - Moving state ("Tank is moving")
 * - Underground detection ("underground")  
 * - Can move / Can't move messages
 */
export class CTank {
    
    // ========================================================================
    // CONSTRUCTION & INITIALIZATION
    // ========================================================================
    
    constructor(sName: string = '', nTeamId: number = 0) {
        this.m_nId = 0;
        this.m_pPlayerData = null;
        this.m_sName = sName;
        this.m_nTeamId = nTeamId;
        this.m_bIsHuman = false;
        this.m_sTankType = TANK_TYPES[nTeamId % TANK_TYPES.length];

        // Position and physics
        this.m_vPos = new Vec2(0, 0);
        this.m_vVel = new Vec2(0, 0);
        this.m_fAngle = 0;         // Body rotation angle (radians)
        
        // Turret state
        this.m_fTurretAngle = Math.PI / 4;   // Default aim: 45 deg up-right
        this.m_fLastTurretAngle = this.m_fTurretAngle;
        
        // Health status (life 0..1000, shield 0..1000, armor 0..100%)
        this.m_health.nLife = 1000;
        this.m_health.nShield = 0;
        this.m_health.nArmor = 0;
        this.m_health.fRadiation = 0;
        
        // State flags
        this.m_bIsAlive = true;
        this.m_bIsMoving = false;
        this.m_bFalling = false;
        this.m_bExploded = false;
        this.m_bUnderground = false;
    }
    
    /**
     * Initialize tank at position with given player data
     */
    init(x: number, pLand: CLand): void {
        this.m_vPos = new Vec2(x, 0);
        // Snap tank onto the terrain surface at its spawn column
        this.computePosition(pLand);

        // Reset to full health on spawn
        this.m_health.nLife = 1000;
    }
    
    /**
     * Compute tank's Y position based on terrain surface (called each frame)
     */
    computePosition(pLand: CLand): void {
        if (!pLand) return;
        
        const nTerrainHeight = pLand.getHeightAt(Math.floor(this.m_vPos.x));
        
        // Tank sits on top of terrain
        this.m_vPos.y = nTerrainHeight - TANK_HEIGHT_PIXELS;
        
        // Check if tank has fallen underground somehow
        if (this.m_vPos.y > nTerrainHeight) {
            this.m_bFalling = true;
        }
    }
    
    /**
     * Compute turret base rotation to match terrain slope
     */
    computeTurretBase(): void {
        // Terrain normal gives us the angle of the surface under tank
        // We use this to keep turret roughly horizontal
    }
    
    // ========================================================================
    // PHYSICS & MOVEMENT
    // ========================================================================
    
    /**
     * Main update tick - called every frame during battle
     */
    update(pLand: CLand, dt: number): void {
        if (!pLand) return;

        // Where the tank rests when sitting on the current terrain surface.
        const fRestY = pLand.getHeightAt(Math.floor(this.m_vPos.x)) - TANK_HEIGHT_PIXELS;

        // Airborne when above the surface (crater under us) or moving from a kick.
        const bKicked = Math.abs(this.m_vVel.x) > 1 || this.m_vVel.y < -1;

        if (this.m_vPos.y < fRestY - 0.5 || bKicked) {
            // Fly under gravity, carrying any kick velocity, until we land.
            this.m_vVel.y += TANK_GRAVITY * dt;
            this.m_vPos.x += this.m_vVel.x * dt;
            this.m_vPos.y += this.m_vVel.y * dt;
            this.m_bFalling = true;

            // Keep within the battlefield.
            this.m_vPos.x = Math.max(TANK_RADIUS, Math.min(pLand.width - TANK_RADIUS, this.m_vPos.x));

            const fLandY = pLand.getHeightAt(Math.floor(this.m_vPos.x)) - TANK_HEIGHT_PIXELS;
            if (this.m_vVel.y >= 0 && this.m_vPos.y >= fLandY) {
                this.m_vPos.y = fLandY;
                this.m_vVel = new Vec2(0, 0);
                this.m_bFalling = false;
            }
        } else {
            // Resting on the surface: stay glued to it as the terrain deforms,
            // and tilt the body to match the local slope.
            this.m_vPos.y = fRestY;
            this.m_vVel = new Vec2(0, 0);
            this.m_bFalling = false;

            const vNormal = pLand.getNormal(Math.floor(this.m_vPos.x));
            this.m_fAngle = Math.atan2(-vNormal.x, vNormal.y);
        }

        this.m_fLastTurretAngle = this.m_fTurretAngle;
    }
    
    /**
     * Check if tank can move to new position
     */
    canMove(pLand: CLand): boolean {
        const nX = Math.floor(this.m_vPos.x);
        
        // Check bounds
        if (nX < TANK_RADIUS || nX > 800 - TANK_RADIUS) {
            return false;
        }
        
        // Get terrain height at new position
        const nTerrainHeight = pLand.getHeightAt(nX);
        
        // Calculate tank bottom Y
        const nTankBottom = Math.floor(this.m_vPos.y + TANK_HEIGHT_PIXELS);
        
        // Can't move if would be too far underground
        return (nTankBottom <= nTerrainHeight + 10);  
    }
    
    /**
     * Move tank along terrain surface
     */
    move(pLand: CLand, vDirection: Vec2, fSpeed: number): void {
        if (!this.m_bIsAlive) return;
        
        // Calculate new position
        const nNewX = this.m_vPos.x + vDirection.x * fSpeed;
        
        // Get terrain height at new x position  
        const nTerrainHeight = pLand.getHeightAt(Math.floor(nNewX));
        
        // Tank should be on terrain surface
        this.m_vPos.x = nNewX;
        this.m_vPos.y = nTerrainHeight - TANK_HEIGHT_PIXELS;
        
        this.m_bIsMoving = true;
        
        // Set body angle to slope of terrain at position
        const normal = pLand.getNormal(Math.floor(nNewX));
        this.m_fAngle = Math.atan2(-normal.x, normal.y);
    }
    
    /**
     * Stop tank movement
     */
    stopMoving(): void {
        this.m_bIsMoving = false;
        this.m_vVel = new Vec2(0, 0);
    }
    
    /**
     * Apply knockback to tank (from explosions)
     */
    kick(dir: Vec2, fForce: number): void {
        // Apply impulse velocity from kick direction
        this.m_vVel.x += dir.x * fForce;
        this.m_vVel.y += dir.y * fForce;  
        
        this.m_bFalling = true;
        this.m_bIsMoving = false;
    }
    
    /**
     * Set rotation for kick animation
     */
    kickRotation(fAngle: number): void {
        // Applied when a blast throws the tank; accumulates into the body angle.
        this.m_fAngle += fAngle;
    }
    
    // ========================================================================
    // COMBAT & DAMAGE
    // ========================================================================
    
    /**
     * Apply damage to tank (called from hit detection)
     */
    hit(fDamage: number, bShieldOnly: boolean = false): void {
        if (!this.m_bIsAlive) return;
        this.m_nHitCount++;

        let dmg = fDamage;

        // Shield fully absorbs the hit only if it exceeds the damage; otherwise
        // the shield is destroyed and the FULL damage still passes through
        // (a quirk of the original — the shield does not partially subtract).
        if (this.m_health.nShield > dmg) {
            this.m_health.nShield -= dmg;
            dmg = 0;
        } else if (this.m_health.nShield > 0) {
            this.m_health.nShield = 0;
        }

        if (!bShieldOnly && dmg > 0) {
            // Armor is a 0..100% reduction of the through-damage.
            this.m_health.nLife -= dmg * (1 - this.m_health.nArmor / 100);
        }

        if (this.m_health.nLife <= 0) {
            this.m_health.nLife = 0;
            this.m_bExploded = true;
            this.m_bIsAlive = false;
        }
    }
    
    /**
     * True when the point (cx,cy) is within nRadius of the tank centre.
     */
    isInBlastRadius(cx: number, cy: number, nRadius: number): boolean {
        return this.distanceTo(cx, cy) <= nRadius + TANK_RADIUS;
    }

    /**
     * Apply radiation damage accumulated over dt seconds. Radiation bypasses
     * shield/armor and burns health directly.
     */
    applyRadiationDamage(fAmount: number, dt: number): void {
        if (!this.m_bIsAlive) return;

        this.m_health.fRadiation += fAmount;
        this.m_health.nLife -= fAmount;

        if (this.m_health.nLife <= 0) {
            this.m_health.nLife = 0;
            this.m_bExploded = true;
            this.m_bIsAlive = false;
        }
    }

    /**
     * Get number of hits taken by tank in battle
     */
    getHitsInt(): number {
        return this.m_nHitCount;
    }
    
    /**
     * Hit test for click detection on tank sprite
     */
    hittest(point: Vec2): boolean {
        // Check if point is within tank's bounding box
        // Uses current position and scale
        
        const dx = Math.abs(point.x - this.m_vPos.x);
        const dy = Math.abs(point.y - (this.m_vPos.y + TANK_HEIGHT_PIXELS/2));
        
        return (dx < TANK_RADIUS && dy < TANK_HEIGHT_PIXELS);
    }
    
    // ========================================================================
    // RENDERING
    // ========================================================================
    
    /**
     * Render the tank to the canvas. Uses the loaded hull sprite when available
     * and falls back to a vector silhouette while assets are still loading.
     */
    draw(ctx: CanvasRenderingContext2D, assets?: ISpriteSource): void {
        if (!this.m_bIsAlive && !this.m_bExploded) return;

        const cx = this.m_vPos.x;
        const surfaceY = this.m_vPos.y + TANK_HEIGHT_PIXELS;   // ground contact line

        const bodyKey = `tanks/${this.m_sTankType} ${this.m_bExploded ? 'wreck' : 'body'}`;
        const sprite = assets?.getSprite(bodyKey) ?? null;

        ctx.save();
        ctx.translate(cx, surfaceY);
        ctx.rotate(this.m_fAngle);   // tilt to terrain slope

        if (sprite) {
            const w = TANK_DRAW_WIDTH;
            const h = (sprite.height / sprite.width) * w;
            ctx.drawImage(sprite.bitmap, -w / 2, -h, w, h);
        } else {
            this.drawVectorHull(ctx);
        }
        ctx.restore();

        // Barrel + turret dome (aim is independent of body tilt)
        if (!this.m_bExploded && this.m_bIsAlive) {
            this.drawBarrel(ctx);
            this.drawHealthBar(ctx, surfaceY);
        }
    }

    /** Simple team-coloured silhouette used until the hull sprite loads. */
    private drawVectorHull(ctx: CanvasRenderingContext2D): void {
        const color = TEAM_COLORS[this.m_nTeamId] ?? '#cccccc';
        const w = TANK_DRAW_WIDTH;

        ctx.fillStyle = this.m_bExploded ? '#333333' : color;
        ctx.beginPath();
        ctx.moveTo(-w / 2, 0);
        ctx.lineTo(w / 2, 0);
        ctx.lineTo(w / 2 - 5, -10);
        ctx.lineTo(-w / 2 + 5, -10);
        ctx.closePath();
        ctx.fill();

        // Rounded turret base
        ctx.beginPath();
        ctx.arc(0, -10, 7, Math.PI, 0);
        ctx.fill();
    }

    /** Draw the gun barrel from the turret pivot along the aim direction. */
    private drawBarrel(ctx: CanvasRenderingContext2D): void {
        const pivotX = this.m_vPos.x;
        const pivotY = this.m_vPos.y;
        const muzzle = this.getMuzzlePosition();

        ctx.strokeStyle = '#d0d0d0';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(pivotX, pivotY);
        ctx.lineTo(muzzle.x, muzzle.y);
        ctx.stroke();
    }

    /** Small life/shield bar floating above the tank. */
    private drawHealthBar(ctx: CanvasRenderingContext2D, surfaceY: number): void {
        const w = TANK_DRAW_WIDTH;
        const x = this.m_vPos.x - w / 2;
        const y = surfaceY - TANK_HEIGHT_PIXELS - 22;

        const life = Math.max(0, this.m_health.nLife) / 1000;
        const shield = Math.max(0, this.m_health.nShield) / 1000;

        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(x, y, w, 5);
        ctx.fillStyle = life > 0.5 ? '#41d95d' : life > 0.25 ? '#e0c040' : '#e04040';
        ctx.fillRect(x, y, w * life, 5);

        if (shield > 0) {
            ctx.fillStyle = '#40b0ff';
            ctx.fillRect(x, y - 3, w * shield, 2);
        }
    }
    
    // ========================================================================
    // TURRET CONTROL  
    // ========================================================================
    
    /**
     * Get current turret rotation angle
     */
    getTurretAngle(): number {
        return this.m_fTurretAngle;
    }

    /**
     * Aim the turret from a UI angle in degrees, where 0 = horizontal-right,
     * 90 = straight up, 180 = horizontal-left. Stored internally as a signed
     * elevation: sign selects side (+right / -left), magnitude is elevation
     * above the horizon (0..90 deg).
     */
    setTurretAngle(fDegrees: number): void {
        this.m_fLastTurretAngle = this.m_fTurretAngle;

        const clamped = Math.max(0, Math.min(180, fDegrees));
        const signedElevationDeg = clamped <= 90 ? clamped : -(180 - clamped);
        this.m_fTurretAngle = (signedElevationDeg * Math.PI) / 180;
    }

    /**
     * Unit vector the barrel points along, matching the projectile launch
     * direction: up is negative-Y.
     */
    aimUnit(): Vec2 {
        const r = this.m_fTurretAngle;
        return r >= 0
            ? new Vec2(Math.cos(r), -Math.sin(r))     // right side
            : new Vec2(-Math.cos(r), Math.sin(r));    // left side
    }

    /**
     * World position of the barrel tip, where a shot should spawn.
     */
    getMuzzlePosition(): Vec2 {
        const aim = this.aimUnit();
        return new Vec2(
            this.m_vPos.x + aim.x * TANK_TURRET_LENGTH,
            this.m_vPos.y + aim.y * TANK_TURRET_LENGTH
        );
    }
    
    /**
     * Set turret aim direction (called from player input or AI)
     */
    setRelativeTurret(fDelta: number): void {
        this.m_fLastTurretAngle = this.m_fTurretAngle;
        this.m_fTurretAngle += fDelta;
        
        // Clamp to valid range
        this.m_fTurretAngle = Math.max(-Math.PI/2, 
                                Math.min(Math.PI/2, this.m_fTurretAngle));
    }
    
    /**
     * Get turret end point (for muzzle position calculation)
     */
    turretEnd(): Vec2 {
        // Returns position of barrel tip for shot spawn
        
        const fLength = TANK_TURRET_LENGTH;
        
        return new Vec2(
            this.m_vPos.x + Math.sin(this.m_fTurretAngle) * fLength,
            this.m_vPos.y - Math.cos(this.m_fTurretAngle) * fLength
        );
    }
    
    /**
     * Get turret blit angle for sprite rendering (converts aim to display)
     */
    getTurretBlitAngle(): number {
        // Transform physics angle to sprite rotation angle
        return this.m_fTurretAngle;  
    }
    
    // ========================================================================
    // ACCESSORS & STATE QUERIES
    // ========================================================================
    
    isAlive(): boolean { return this.m_bIsAlive; }
    isBot(): boolean { return !this.isHuman(); }
    isHuman(): boolean { return this.m_bIsHuman; }
    setHuman(bHuman: boolean): void { this.m_bIsHuman = bHuman; }

    getName(): string { return this.m_sName; }
    isLocalPlayer(): boolean { return false; }   // TODO
    
    getPosition(): Vec2 { return this.m_vPos.clone(); }
    getVelocity(): Vec2 { return this.m_vVel.clone(); }
    
    getHealth(): STankHealth { return { ...this.m_health }; }
    getTeamId(): number { return this.m_nTeamId; }

    /**
     * Sprites this tank needs, as {logical name, file path} pairs. The logical
     * names match what draw() looks up, so the loader and renderer stay in sync.
     */
    getRequiredSprites(): { name: string; file: string }[] {
        return ['body', 'wreck'].map(part => ({
            name: `tanks/${this.m_sTankType} ${part}`,
            file: `/assets/tanks/${this.m_sTankType} ${part}.bmp`,
        }));
    }
    
    /**
     * Distance from terrain surface
     */
    distFromLand(pLand: CLand): number {
        const nTerrainHeight = pLand.getHeightAt(Math.floor(this.m_vPos.x));
        return this.m_vPos.y - (nTerrainHeight - TANK_HEIGHT_PIXELS);
    }

    distanceTo(x: number, y: number): number {
        const dx = x - this.m_vPos.x;
        const dy = y - (this.m_vPos.y + TANK_HEIGHT_PIXELS / 2);
        return Math.sqrt(dx * dx + dy * dy);
    }
    
    // ========================================================================
    // MEMBER VARIABLES
    // ========================================================================
    
    private m_nId: number;              // Unique tank identifier
    
    // Player data reference  
    private m_pPlayerData: unknown;     // CPlayerData*
    
    private m_nTeamId: number = 0;      // Team assignment (for color)
    private m_sName: string = '';       // Display name (e.g. "Player", "BrainBot")
    private m_bIsHuman: boolean = false; // True for the human-controlled tank
    private m_sTankType: string = 'Standard'; // Hull sprite variant
    
    // Position and movement
    public m_vPos: Vec2;                // Tank center position
    private m_vVel: Vec2;               // Velocity vector
    private m_fAngle: number;           // Body rotation angle
    
    // Turret state  
    private m_fTurretAngle: number;     // Current aim direction (radians)
    public m_fLastTurretAngle: number;
    
    // Health status
    private m_health: STankHealth = {
        nLife: 1000,
        nShield: 0,
        nArmor: 0,
        fRadiation: 0
    };
    
    // State flags
    public m_bIsAlive: boolean = true;
    public m_bIsMoving: boolean = false;  
    private m_bFalling: boolean = false;
    public m_bExploded: boolean = false;
    private m_bUnderground: boolean = false;
    
    // Statistics tracking
    private m_nHitCount: number = 0;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const TANK_RADIUS = 16;                 // Half-width of tank collision box
const TANK_HEIGHT_PIXELS = 24;          // Approximate height in pixels
const TANK_TURRET_LENGTH = 20;          // Turret barrel length for muzzle calc
const TANK_DRAW_WIDTH = 46;             // On-screen hull width in pixels
const TANK_GRAVITY = 400;               // Fall acceleration when unsupported (px/s^2)
