/**
 * CTank - Tank Entity Class
 * 
 * Discovered from: nm output with C++ demangled symbols  
 * Handles tank state, movement on terrain, damage, rendering
 */

import { Vec2, Vec2f } from '../math/Vec2';
import { CLand } from './CLand';

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
 * Tank state flags/members from strings analysis:
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

        // Position and physics
        this.m_vPos = new Vec2(0, 0);
        this.m_vVel = new Vec2(0, 0);
        this.m_fAngle = 0;         // Body rotation angle (radians)
        
        // Turret state
        this.m_fTurretAngle = 0;   // Current turret aim direction
        this.m_fLastTurretAngle = 0;
        
        // Health status
        this.m_health.nLife = 100;
        this.m_health.nShield = 500;  // Shield: "Shield %d/1000" from strings
        this.m_health.nArmor = 50;    // Default armor ~50%
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
     * Original: CTank::init(Vec2<float>, CPlayerData*, int team)
     */
    init(x: number, pLand: CLand): void {
        this.m_vPos = new Vec2(x, 0);
        // Snap tank onto the terrain surface at its spawn column
        this.computePosition(pLand);

        // Reset to full health on spawn
        this.m_health.nLife = 100;
        this.m_health.nShield = 500;
    }
    
    /**
     * Compute tank's Y position based on terrain surface (called each frame)
     * Original: CTank::computePosition(CLand&)
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
     * Original: CTank::computeTurretBase()
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
     * Original: CTank::update(CLand&, bool, float, Vec2<float>, float)
     */
    update(
        pLand: CLand,
        bIsUnderground: boolean,
        fGravity: number,
        vWind: Vec2,
        dt: number
    ): void {
        
        // Update position based on velocity
        if (this.m_bIsMoving) {
            this.m_vPos.x += this.m_vVel.x * dt;
            this.m_vPos.y += this.m_vVel.y * dt;
            
            // Apply gravity to vertical component
            this.m_vVel.y += fGravity * dt;
            
            // Wind affects horizontal velocity slightly
            this.m_vVel.x += vWind.x * dt * 0.01;  // Wind factor
        }
        
        // Compute terrain height at current position
        const nTerrainHeight = pLand.getHeightAt(Math.floor(this.m_vPos.x));
        
        // Check for ground collision / underground status  
        this.m_bUnderground = (this.m_vPos.y >= nTerrainHeight);
        
        if (this.m_bUnderground && !bIsUnderground) {
            // Tank went underground - apply damage or correction
            this.m_vPos.y = nTerrainHeight - TANK_HEIGHT_PIXELS;
            
            // Stop vertical movement, bounce effect
            this.m_vVel.y *= -0.3;  // Bounce damping
        }
        
        // Check if tank can continue moving (collision with walls, etc.)
        if (!this.canMove(pLand)) {
            this.stopMoving();
        }
        
        // Update turret angle toward target direction
        const fAngleDiff = this.m_fTurretAngle - this.m_fLastTurretAngle;
        this.m_fLastTurretAngle = this.m_fTurretAngle;
    }
    
    /**
     * Check if tank can move to new position
     * Original: CTank::canMove(CLand&)
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
     * Original: CTank::move(CLand&, Vec2<float>&, float)
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
     * Original: CTank::stopMoving()
     */
    stopMoving(): void {
        this.m_bIsMoving = false;
        this.m_vVel = new Vec2(0, 0);
    }
    
    /**
     * Apply knockback to tank (from explosions)
     * Original: CTank::kick(Vec2<float>& dir, float force)
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
     * Original: CTank::kickRotation(float angle)
     */
    kickRotation(fAngle: number): void {
        // Used when tank is thrown by explosion - rapid spinning
        throw new Error('STUB');
    }
    
    // ========================================================================
    // COMBAT & DAMAGE
    // ========================================================================
    
    /**
     * Apply damage to tank (called from hit detection)
     * Original: CTank::hit(float, bool shieldOnly)
     */
    hit(fDamage: number, bShieldOnly: boolean): void {
        if (!this.m_bIsAlive) return;
        
        // Shield absorbs damage first
        if (this.m_health.nShield > 0) {
            const nShieldDamage = Math.min(this.m_health.nShield, fDamage);
            this.m_health.nShield -= nShieldDamage;
            fDamage -= nShieldDamage;
            
            // "Shield %d/1000" format from strings
        }
        
        if (!bShieldOnly && fDamage > 0) {
            // Apply remaining damage to health (reduced by armor)
            const fArmorReduction = this.m_health.nArmor / 100.0;
            const fActualDamage = fDamage * (1.0 - fArmorReduction);
            
            this.m_health.nLife -= Math.floor(fActualDamage);
        }
        
        // Check for death
        if (this.m_health.nLife <= 0) {
            this.m_bExploded = true;
            this.m_bIsAlive = false;
        }
    }
    
    /**
     * Get number of hits taken by tank in battle
     * Original: CTank::getHitsInt()
     */
    getHitsInt(): number {
        return this.m_nHitCount;
    }
    
    /**
     * Hit test for click detection on tank sprite
     * Original: CTank::hittest(Vec2<int> const& point)
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
     * Draw tank to screen buffer
     * Original: CTank::draw(CBitmap&, int, int, CLand&, bool, bool, bool)
     */
    draw(
        pDestBmp: unknown,
        nOffsetX: number,
        nOffsetY: number,
        pLand: CLand,
        bTeamColorize: boolean,
        bExploded: boolean,
        bFalling: boolean
    ): void {
        
        if (!this.m_bIsAlive && !bExploded) return;
        
        // Tank body sprite (32x32, colorizable per team)
        // Original paths from strings:
        // tanks/%s_body.bmp - main tank body
        
        const nDrawX = Math.floor(this.m_vPos.x + nOffsetX);
        const nDrawY = Math.floor(this.m_vPos.y + nOffsetY);
        
        if (bExploded) {
            // Draw wrecked sprite
            this.drawWreckSprite(pDestBmp, nDrawX, nDrawY);
        } else {
            // Draw tank body
            this.drawBodySprite(pDestBmp, nDrawX, nDrawY, bTeamColorize);
            
            // Draw turret on top (rotated)
            if (!this.m_bFalling) {
                this.drawTurretSprite(pDestBmp, nDrawX, nDrawY);
            }
        }
    }
    
    /**
     * Draw tank body sprite with optional team colorization
     */
    private drawBodySprite(
        pDestBmp: unknown,
        x: number,
        y: number,
        bColorize: boolean
    ): void {
        // Original: uses tanks/%s_body.bmp pattern
        // Team colors applied via colorize() function from strings
        
        if (bColorize) {
            // Apply team color tint to sprite
            // __ZN11CAtomicCannon8colorizemRff
            this.applyTeamColor(pDestBmp, x, y);
        }
        
        throw new Error('STUB');
    }
    
    /**
     * Draw turret with rotation toward aim angle  
     */
    private drawTurretSprite(
        pDestBmp: unknown,
        x: number,
        y: number
    ): void {
        // Original: uses tanks/%s_turret.bmp pattern
        
        throw new Error('STUB');
    }
    
    /**
     * Draw destroyed tank wreck sprite
     */
    private drawWreckSprite(
        pDestBmp: unknown,
        x: number,
        y: number
    ): void {
        // Original: tanks/%s_wreck.bmp  
        
        throw new Error('STUB');
    }
    
    /**
     * Apply team color to sprite (colorizeRmff from strings)
     */
    private applyTeamColor(
        pDestBmp: unknown,
        x: number,
        y: number
    ): void {
        // Team colors identified from binary:
        // Red, Blue, Green, eWhiteSmall, eLightOrange, eRed, etc.
        
        throw new Error('STUB');
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
    
    // Position and movement
    public m_vPos: Vec2;                // Tank center position
    private m_vVel: Vec2;               // Velocity vector
    private m_fAngle: number;           // Body rotation angle
    
    // Turret state  
    private m_fTurretAngle: number;     // Current aim direction (radians)
    public m_fLastTurretAngle: number;
    
    // Health status
    private m_health: STankHealth = {
        nLife: 100,
        nShield: 500, 
        nArmor: 50,
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

const TANK_RADIUS = 16;                 // Half-width of tank sprite (32x32)
const TANK_HEIGHT_PIXELS = 24;          // Approximate height in pixels
const TANK_TURRET_LENGTH = 20;          // Turret barrel length for muzzle calc
