/**
 * CTank - Tank Entity Class
 *
 * Handles tank state, movement on terrain, damage, rendering
 */

import {Vec2, Vec2f} from '../math/Vec2';
import {CLand} from './CLand';
import {GameConfig} from './CGameConfig';
import {getFont, type FontId} from '../ui/BitmapFont';

// Tank-badge text font — small pixel font rendered at NATIVE size (10px) so it
// stays crisp at a compact label size.
const BADGE_FONT: FontId = 'silkscreen-8-white';

// Render text with one of the game's bitmap fonts (cached). Returns null until the
// font has loaded, so callers can fall back to a canvas font that first frame.
const labelCache = new Map<string, HTMLCanvasElement>();

function bmpLabel(font: FontId, text: string, tint: string): HTMLCanvasElement | null {
    const key = `${font}|${tint}|${text}`;
    const c = labelCache.get(key);
    if (c) return c;
    const f = getFont(font);
    if (!f.ready) return null;
    const cv = f.render(text, {tint});
    labelCache.set(key, cv);
    return cv;
}

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

// Tank variants
const PLAYER_TANKS = ['Standard', 'MA1', 'MSPO', 'Green', 'Atomic Cannon'];

// The 16-team palette (0xRRGGBB). Team 0 = blue.
export const TEAM_COLORS: Record<number, string> = {
    0: '#0000ff', 1: '#ff0000', 2: '#00ff00', 3: '#0080ff',
    4: '#f000f0', 5: '#8000ff', 6: '#00ffff', 7: '#800080',
    8: '#000080', 9: '#008000', 10: '#800000', 11: '#ffff00',
    12: '#ff8000', 13: '#ff0080', 14: '#00ff80', 15: '#80ff00',
};

// --- team-colour body tint (HSL hue-swap: keep each pixel's luminance, force the
// team hue at sat 0.5). Cached per sprite+team. ----------
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    r /= 255;
    g /= 255;
    b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn;
    const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let h = 0;
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    if (s === 0) {
        const v = Math.round(l * 255);
        return [v, v, v];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hk = (t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return [Math.round(hk(h + 1 / 3) * 255), Math.round(hk(h) * 255), Math.round(hk(h - 1 / 3) * 255)];
}

function hueOf(hexColor: string): number {
    const n = parseInt(hexColor.slice(1), 16);
    return rgbToHsl((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff)[0];
}

const tintCache = new Map<string, HTMLCanvasElement>();

function tintToHue(sprite: Sprite, hue: number, key: string): HTMLCanvasElement {
    const cached = tintCache.get(key);
    if (cached) return cached;
    const cv = document.createElement('canvas');
    cv.width = sprite.width;
    cv.height = sprite.height;
    const g = cv.getContext('2d', {willReadFrequently: true})!;
    g.imageSmoothingEnabled = false;
    g.drawImage(sprite.bitmap, 0, 0);
    const im = g.getImageData(0, 0, cv.width, cv.height);
    const px = im.data;
    for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue;                       // keep transparency
        const l = rgbToHsl(px[i], px[i + 1], px[i + 2])[2];   // keep luminance
        const [r, gg, b] = hslToRgb(hue, 0.5, l);            // team hue, sat 0.5
        px[i] = r;
        px[i + 1] = gg;
        px[i + 2] = b;
    }
    g.putImageData(im, 0, 0);
    tintCache.set(key, cv);
    return cv;
}

/**
 * Tank health/shield status structure
 */
export interface STankHealth {
    nLife: number;        // Current health (0-100 typical)
    nShield: number;      // Shield points (absorbed before health)
    nArmor: number;       // Armor percentage reduction
    nHazmat: number;      // Hazmat percentage (radiation resistance) — HUD "Hazmat %"
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
        this.m_sName = sName;   // names keep their given case (upper/lower allowed)
        this.m_nTeamId = nTeamId;
        this.m_bIsHuman = false;
        // TEMP: random player hull per tank (until per-player tank selection exists in settings).
        this.m_sTankType = PLAYER_TANKS[Math.floor(Math.random() * PLAYER_TANKS.length)];

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
        this.m_health.nHazmat = 0;
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

        // Spawn at full health — Tank → Hitpoints sets the starting/max life.
        this.m_maxLife = GameConfig.hitpoints;
        this.m_health.nLife = this.m_maxLife;
    }

    /** Full/starting life (Hitpoints) — the denominator for life bars/percent. */
    getMaxLife(): number {
        return this.m_maxLife;
    }

    /** Shot-collision radius (scales with Player Size). */
    getHitRadius(): number {
        return tankRadius();
    }

    /**
     * Compute tank's Y position based on terrain surface (called each frame)
     */
    computePosition(pLand: CLand): void {
        if (!pLand) return;

        const nTerrainHeight = pLand.getHeightAt(Math.floor(this.m_vPos.x));

        // Tank sits on top of terrain
        this.m_vPos.y = nTerrainHeight - tankHeight();

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
        const fRestY = pLand.getHeightAt(Math.floor(this.m_vPos.x)) - tankHeight();

        // Jet flight (extType 17): while fuel remains the player thrusts against
        // gravity. UP = -1.2g vertical (net -0.2g, a gentle rise), L/R = ∓0.1g
        // horizontal; fuel drains on real dt.
        // At empty this branch is skipped and the tank simply falls & lands below.
        if (this.m_fJetFuel > 0) {
            this.m_fJetFuel = Math.max(0, this.m_fJetFuel - dt);
            const {up, left, right} = this.m_jetInput;
            const airborne = this.m_vPos.y < fRestY - 0.5;

            if (airborne || up) {
                // Semi-implicit Euler: gravity, then thrust, then integrate.
                this.m_vVel.y += TANK_GRAVITY * dt;
                if (up) this.m_vVel.y += JET_UP_ACCEL * dt;     // -1.2g
                if (left) this.m_vVel.x += JET_SIDE_ACCEL * dt;  // -0.1g
                if (right) this.m_vVel.x -= JET_SIDE_ACCEL * dt;  // +0.1g
                this.m_vPos.x += this.m_vVel.x * dt;
                this.m_vPos.y += this.m_vVel.y * dt;
                this.m_bFalling = true;
                this.m_bIsMoving = true;

                // Ceiling clamp at the top of the map.
                if (this.m_vPos.y < JET_CEILING) {
                    this.m_vPos.y = JET_CEILING;
                    if (this.m_vVel.y < 0) this.m_vVel.y = 0;
                }
                this.m_vPos.x = Math.max(tankRadius(), Math.min(pLand.width - tankRadius(), this.m_vPos.x));

                // Land when descending onto the surface (keeps fuel for re-lift).
                const fLandY = pLand.getHeightAt(Math.floor(this.m_vPos.x)) - tankHeight();
                if (this.m_vVel.y >= 0 && this.m_vPos.y >= fLandY) {
                    this.m_vPos.y = fLandY;
                    this.m_vVel = new Vec2(0, 0);
                    this.m_bFalling = false;
                    this.m_bIsMoving = false;
                    const vNormal = pLand.getNormal(Math.floor(this.m_vPos.x));
                    this.m_fAngle = Math.atan2(vNormal.x, -vNormal.y);
                }
            } else {
                // Grounded, engine idle: rest on the surface but keep the fuel.
                this.m_vPos.y = fRestY;
                this.m_vVel = new Vec2(0, 0);
                this.m_bIsMoving = false;
                const vNormal = pLand.getNormal(Math.floor(this.m_vPos.x));
                this.m_fAngle = Math.atan2(vNormal.x, -vNormal.y);
            }
            this.m_fLastTurretAngle = this.m_fTurretAngle;
            return;
        }

        // Airborne when above the surface (crater under us) or moving from a kick.
        const bKicked = Math.abs(this.m_vVel.x) > 1 || this.m_vVel.y < -1;

        if (this.m_vPos.y < fRestY - 0.5 || bKicked) {
            // Fly under gravity, carrying any kick velocity, until we land.
            this.m_vVel.y += TANK_GRAVITY * dt;
            this.m_vPos.x += this.m_vVel.x * dt;
            this.m_vPos.y += this.m_vVel.y * dt;
            this.m_bFalling = true;

            // Keep within the battlefield.
            this.m_vPos.x = Math.max(tankRadius(), Math.min(pLand.width - tankRadius(), this.m_vPos.x));

            const fLandY = pLand.getHeightAt(Math.floor(this.m_vPos.x)) - tankHeight();
            if (this.m_vVel.y >= 0 && this.m_vPos.y >= fLandY) {
                this.m_vPos.y = fLandY;
                this.m_vVel = new Vec2(0, 0);
                this.m_bFalling = false;
                this.m_bIsMoving = false;   // settled — clears the motion loop / flight exit
            }
        } else if (this.m_driveTargetX !== null) {
            // Driving along the surface toward a queued destination (bot reposition).
            this.stepDrive(pLand, dt);
            const vNormal = pLand.getNormal(Math.floor(this.m_vPos.x));
            this.m_fAngle = Math.atan2(vNormal.x, -vNormal.y);
        } else {
            // Resting on the surface: stay glued to it as the terrain deforms,
            // and tilt the body to match the local slope.
            this.m_vPos.y = fRestY;
            this.m_vVel = new Vec2(0, 0);
            this.m_bFalling = false;
            this.m_bIsMoving = false;

            const vNormal = pLand.getNormal(Math.floor(this.m_vPos.x));
            this.m_fAngle = Math.atan2(vNormal.x, -vNormal.y);   // 0 on flat, tilts with the slope
        }

        this.m_fLastTurretAngle = this.m_fTurretAngle;
    }

    /**
     * Check if tank can move to new position
     */
    canMove(pLand: CLand): boolean {
        const nX = Math.floor(this.m_vPos.x);

        // Check bounds
        if (nX < tankRadius() || nX > 800 - tankRadius()) {
            return false;
        }

        // Get terrain height at new position
        const nTerrainHeight = pLand.getHeightAt(nX);

        // Calculate tank bottom Y
        const nTankBottom = Math.floor(this.m_vPos.y + tankHeight());

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
        this.m_vPos.y = nTerrainHeight - tankHeight();

        this.m_bIsMoving = true;

        // Set body angle to slope of terrain at position
        const normal = pLand.getNormal(Math.floor(nNewX));
        this.m_fAngle = Math.atan2(normal.x, -normal.y);
    }

    /**
     * Stop tank movement
     */
    stopMoving(): void {
        this.m_bIsMoving = false;
        this.m_vVel = new Vec2(0, 0);
        this.m_driveTargetX = null;
    }

    // ── Ground drive (repositioning along the terrain surface) ───────────────

    /**
     * Begin driving toward `targetX`, crawling along the terrain surface. Stops on
     * arrival, at the map edge, or against a wall too steep to climb. `update()`
     * advances it while grounded; `isMoving()` stays true until it settles.
     */
    startDrive(targetX: number): void {
        if (!this.m_bIsAlive) return;
        this.m_driveTargetX = targetX;
        this.m_bIsMoving = true;
    }

    isDriving(): boolean {
        return this.m_driveTargetX !== null;
    }

    /** One step of a ground drive: crawl toward the target, hugging the surface. */
    private stepDrive(pLand: CLand, dt: number): void {
        const target = this.m_driveTargetX as number;
        const dir = Math.sign(target - this.m_vPos.x);
        if (dir === 0) { this.endDrive(pLand); return; }

        const stepPx = Math.min(Math.abs(target - this.m_vPos.x), TANK_DRIVE_SPEED * dt);
        let newX = this.m_vPos.x + dir * stepPx;

        // Stop at the battlefield edge.
        if (newX < tankRadius() || newX > pLand.width - tankRadius()) { this.endDrive(pLand); return; }

        // Follow the surface, but stop at terrain too steep to cross: a wall it can't
        // climb, or a cliff it won't drive off. (Screen-Y: smaller = higher ground,
        // so `rise > 0` is climbing.) Descents are allowed more freely than climbs so
        // a tank on a hilltop can still drive down either side.
        const curH = pLand.getHeightAt(Math.floor(this.m_vPos.x));
        const newH = pLand.getHeightAt(Math.floor(newX));
        const rise = curH - newH;
        const span = Math.max(1, stepPx);
        if (rise > TANK_DRIVE_MAX_CLIMB * span || -rise > TANK_DRIVE_MAX_DROP * span) { this.endDrive(pLand); return; }

        this.m_vPos.x = newX;
        this.m_vPos.y = newH - tankHeight();
        this.m_bIsMoving = true;
        if (Math.abs(newX - target) < 0.5) this.endDrive(pLand);
    }

    private endDrive(pLand: CLand): void {
        this.m_driveTargetX = null;
        this.m_bIsMoving = false;
        this.m_vPos.y = pLand.getHeightAt(Math.floor(this.m_vPos.x)) - tankHeight();
    }

    // ── Jet flight (extType 17) ──────────────────────────────────────────────

    /** Light the jet with `fuelSeconds` of fuel (the weapon's damage field). */
    igniteJet(fuelSeconds: number): void {
        this.m_fJetFuel = Math.max(0, fuelSeconds);
    }

    /** Cut the engine — drops remaining fuel (turn-end / early-out). */
    cutJet(): void {
        this.m_fJetFuel = 0;
        this.m_jetInput = {up: false, left: false, right: false};
    }

    hasJetFuel(): boolean {
        return this.m_fJetFuel > 0;
    }

    getJetFuel(): number {
        return this.m_fJetFuel;
    }

    /** Held thrust input for this frame (up/left/right). */
    setJetInput(up: boolean, left: boolean, right: boolean): void {
        this.m_jetInput = {up, left, right};
    }

    /** True while the up-thrust is firing with fuel — drives the jet.wav loop. */
    isThrustingUp(): boolean {
        return this.m_fJetFuel > 0 && this.m_jetInput.up;
    }

    isFalling(): boolean {
        return this.m_bFalling;
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
    /** Apply damage. Returns the LIFE actually removed (post shield + armor), which is
     *  what the earning economy credits — shield/armor-absorbed damage counts as 0. */
    hit(fDamage: number, bShieldOnly: boolean = false): number {
        if (!this.m_bIsAlive) return 0;
        this.m_nHitCount++;

        const lifeBefore = this.m_health.nLife;
        let dmg = fDamage;

        // Shield fully absorbs the hit only if it exceeds the damage; otherwise
        // the shield is destroyed and the FULL damage still passes through
        // (by design — the shield does not partially subtract).
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

        return lifeBefore - this.m_health.nLife;
    }

    /**
     * True when the point (cx,cy) is within nRadius of the tank centre.
     */
    isInBlastRadius(cx: number, cy: number, nRadius: number): boolean {
        return this.distanceTo(cx, cy) <= nRadius + tankRadius();
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
        const dy = Math.abs(point.y - (this.m_vPos.y + tankHeight() / 2));

        return (dx < tankRadius() && dy < tankHeight());
    }

    // ========================================================================
    // RENDERING
    // ========================================================================

    /**
     * Render the tank to the canvas. Uses the loaded hull sprite when available
     * and falls back to a vector silhouette while assets are still loading.
     */
    draw(ctx: CanvasRenderingContext2D, assets?: ISpriteSource, showDetail = false): void {
        if (!this.m_bIsAlive && !this.m_bExploded) return;

        const cx = this.m_vPos.x;
        const surfaceY = this.m_vPos.y + tankHeight();   // ground contact line

        const bodyKey = `tanks/${this.m_sTankType} ${this.m_bExploded ? 'wreck' : 'body'}`;
        const sprite = assets?.getSprite(bodyKey) ?? null;

        ctx.save();
        ctx.translate(cx, surfaceY);
        ctx.rotate(this.m_fAngle);   // tilt to terrain slope

        if (sprite) {
            const w = tankWidth();
            const h = (sprite.height / sprite.width) * w;
            // Team-tint the hull (not the wreck), keeping its shading (Tank → Colorize Team).
            const img = (this.m_bExploded || !GameConfig.colorizeTeam) ? sprite.bitmap
                : tintToHue(sprite, hueOf(TEAM_COLORS[this.m_nTeamId] ?? '#0000ff'), `${bodyKey}|${this.m_nTeamId}`);
            ctx.drawImage(img, -w / 2, -h, w, h);
        } else {
            this.drawVectorHull(ctx);
        }
        ctx.restore();

        // Barrel + turret dome (aim is independent of body tilt)
        if (!this.m_bExploded && this.m_bIsAlive) {
            this.drawBarrel(ctx, assets);
            this.drawBadge(ctx, surfaceY, showDetail, assets);
        }
    }

    /** Simple team-coloured silhouette used until the hull sprite loads. */
    private drawVectorHull(ctx: CanvasRenderingContext2D): void {
        const color = TEAM_COLORS[this.m_nTeamId] ?? '#cccccc';
        const w = tankWidth();

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
    private drawBarrel(ctx: CanvasRenderingContext2D, assets?: ISpriteSource): void {
        const pivot = this.getTurretPivot();
        const aim = this.aimUnit();

        // Use the tank's own turret sprite (coloured to match the hull). It points
        // right; we rotate it along the aim and mirror it vertically when aiming
        // left so the art stays upright. Scaled so its length = the muzzle offset.
        const turret = assets?.getSprite(`tanks/${this.m_sTankType} turret`) ?? null;
        if (turret) {
            const scale = turretLen() / turret.width;
            const tw = turret.width * scale, th = turret.height * scale;
            const img = GameConfig.colorizeTeam
                ? tintToHue(turret, hueOf(TEAM_COLORS[this.m_nTeamId] ?? '#0000ff'),
                    `tanks/${this.m_sTankType} turret|${this.m_nTeamId}`)
                : turret.bitmap;
            ctx.save();
            ctx.translate(pivot.x, pivot.y);
            ctx.rotate(Math.atan2(aim.y, aim.x));
            if (aim.x < 0) ctx.scale(1, -1);           // mirror when facing left
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(img, 0, -th / 2, tw, th);    // base at the pivot
            ctx.restore();
            return;
        }

        // Fallback: a simple grey barrel until the sprite loads.
        const muzzle = this.getMuzzlePosition();
        ctx.strokeStyle = '#d0d0d0';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(pivot.x, pivot.y);
        ctx.lineTo(muzzle.x, muzzle.y);
        ctx.stroke();
    }

    /**
     * The on-field badge, stacked upward above the tank:
     * name box (team colour) → shield bar (if any) → armour strip (if any) →
     * life bar → full stat lines (only on hover / detail). Life & shield are
     * green/blue fills over black with a red/grey depleted remainder.
     */
    private drawBadge(ctx: CanvasRenderingContext2D, surfaceY: number, showDetail: boolean, assets?: ISpriteSource): void {
        const w = Math.round(tankWidth() * 0.8);   // bars a little narrower than the hull
        const cx = this.m_vPos.x;
        const team = TEAM_COLORS[this.m_nTeamId] ?? '#0000ff';
        const life = Math.max(0, Math.min(1, this.m_health.nLife / this.m_maxLife));
        const shield = Math.max(0, Math.min(1, this.m_health.nShield / 1000));
        const armor = this.m_health.nArmor;
        const BH = 2;                                  // thin bar

        // Bar: coloured fill over a black border + a "depleted" remainder.
        const bar = (y: number, frac: number, fill: string, empty: string): number => {
            const x = cx - w / 2;
            ctx.fillStyle = '#000';
            ctx.fillRect(x - 1, y - 1, w + 2, BH + 2);
            ctx.fillStyle = empty;
            ctx.fillRect(x, y, w, BH);
            ctx.fillStyle = fill;
            ctx.fillRect(x, y, w * frac, BH);
            return y + BH + 2;
        };

        // Draw a bitmap-font stat line centred at cx, at NATIVE size (1:1 — never
        // downscaled, or the 1-bit glyphs go jaggy) over a dark strip for contrast.
        const line = (text: string, y: number): number => {
            const lab = bmpLabel(BADGE_FONT, text, '#ffffff');
            if (lab) {
                const lx = Math.round(cx - lab.width / 2), ly = Math.round(y);
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                ctx.fillRect(lx - 1, ly - 1, lab.width + 2, lab.height + 2);
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(lab, lx, ly);
                return y + lab.height + 1;
            }
            ctx.fillStyle = '#fff';
            ctx.font = '11px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(text, cx, y);
            return y + 12;
        };

        // The badge sits UNDER the tank, stacked downward.
        // Offset clears the tank even when it's tilted on a slope.
        let y = surfaceY + 11;
        // Life / shield / armour bars (Graphics → Show Power).
        if (GameConfig.showPowerBars) {
            y = bar(y, life, '#00ff00', '#ff0000');                 // life (green / red)
            if (shield > 0) y = bar(y, shield, '#0000ff', '#808080'); // shield (blue / grey)
            if (armor > 0) {                                        // armour (yellow strip)
                ctx.fillStyle = '#000';
                ctx.fillRect(cx - w / 2 - 1, y - 1, w + 2, 3);
                ctx.fillStyle = '#ffff00';
                ctx.fillRect(cx - w / 2, y, w * Math.min(1, armor / 100), 1);
                y += 3;
            }
        }

        // --- name box (team colour @ 50% + solid outline), with a shield icon; the
        // whole label is gated by Graphics → Show Team Color. Native bitmap-font size. ---
        if (GameConfig.showTeamColor) {
            const name = this.m_sName || '—';
            const lab = bmpLabel(BADGE_FONT, name, '#ffffff');
            const nameH = lab ? lab.height : 12;
            const nameW = lab ? lab.width : name.length * 6;
            const icon = shield > 0 ? (assets?.getSprite('gui/shield') ?? null) : null;
            const iconH = nameH;
            const iconW = icon ? Math.round(icon.width * (iconH / icon.height)) : 0;
            const pad = 3, gap = icon ? 2 : 0;
            const bw = Math.round(pad * 2 + iconW + gap + nameW);
            const bh = nameH + 4;
            const bx = Math.round(cx - bw / 2), by = Math.round(y + 2);

            ctx.globalAlpha = 0.5;
            ctx.fillStyle = team;
            ctx.fillRect(bx, by, bw, bh);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = team;
            ctx.lineWidth = 1;
            ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);

            let contentX = bx + pad;
            ctx.imageSmoothingEnabled = false;
            if (icon) {
                ctx.drawImage(icon.bitmap, contentX, Math.round(by + (bh - iconH) / 2), iconW, iconH);
                contentX += iconW + gap;
            }
            if (lab) {
                ctx.drawImage(lab, Math.round(contentX), Math.round(by + (bh - nameH) / 2));   // native 1:1
            } else {
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 11px sans-serif';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(name, contentX, by + bh / 2);
            }
            y = by + bh + 1;
        }

        // --- full stat lines: on hover, or always with Graphics 2 → Show Tank Stats ---
        if (showDetail || GameConfig.showTankStats) {
            y = line(`Team ${this.m_nTeamId + 1}`, y);
            y = line(`Life ${Math.round(this.m_health.nLife)}`, y);
            if (armor > 0) y = line(`Armor ${Math.round(armor)}%`, y);
            if (this.m_health.nShield > 0) y = line(`Shield ${Math.round(this.m_health.nShield)}`, y);
            y = line(`Credits ${this.m_credits}`, y);
        }
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
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
     * Aim the turret from a UI angle in degrees measured counter-clockwise from
     * horizontal-right: 0 = right, 90 = straight up, 180 = left, and NEGATIVE
     * values point below the horizon (e.g. -45 = down-right). Stored directly as
     * that angle in radians — a single full-circle value, so any direction
     * (including below-horizon aim) is representable.
     */
    setTurretAngle(fDegrees: number): void {
        this.m_fLastTurretAngle = this.m_fTurretAngle;
        this.m_fTurretAngle = (fDegrees * Math.PI) / 180;
    }

    /**
     * Unit vector the barrel points along, matching the projectile launch
     * direction. Screen-Y is down, so up = negative-Y: (cos θ, -sin θ) for all θ.
     */
    aimUnit(): Vec2 {
        const r = this.m_fTurretAngle;
        return new Vec2(Math.cos(r), -Math.sin(r));
    }

    /**
     * World position of the turret pivot — a point on the hull (top-centre),
     * carried along the body's terrain tilt so the barrel stays attached.
     */
    getTurretPivot(): Vec2 {
        const groundX = this.m_vPos.x;
        const groundY = this.m_vPos.y + tankHeight();   // ground-contact line
        const up = turretHgt();                        // turret height above ground
        const s = Math.sin(this.m_fAngle), c = Math.cos(this.m_fAngle);
        return new Vec2(groundX + up * s, groundY - up * c);  // (0,-up) rotated by body tilt
    }

    /**
     * World position of the barrel tip, where a shot should spawn.
     */
    getMuzzlePosition(): Vec2 {
        const pivot = this.getTurretPivot();
        const aim = this.aimUnit();
        return new Vec2(pivot.x + aim.x * turretLen(), pivot.y + aim.y * turretLen());
    }

    /**
     * Muzzle position the barrel WOULD have if aimed at `deg` (UI degrees), without
     * moving the turret. Lets the AI evaluate a candidate shot's true spawn point.
     */
    muzzleForAngle(deg: number): Vec2 {
        const r = (deg * Math.PI) / 180;
        const aim = new Vec2(Math.cos(r), -Math.sin(r));
        const pivot = this.getTurretPivot();
        return new Vec2(pivot.x + aim.x * turretLen(), pivot.y + aim.y * turretLen());
    }

    /**
     * Set turret aim direction (called from player input or AI)
     */
    setRelativeTurret(fDelta: number): void {
        this.m_fLastTurretAngle = this.m_fTurretAngle;
        this.m_fTurretAngle += fDelta;

        // Clamp to valid range
        this.m_fTurretAngle = Math.max(-Math.PI / 2,
            Math.min(Math.PI / 2, this.m_fTurretAngle));
    }

    /**
     * Get turret end point (for muzzle position calculation)
     */
    turretEnd(): Vec2 {
        // Returns position of barrel tip for shot spawn

        const fLength = turretLen();

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

    isAlive(): boolean {
        return this.m_bIsAlive;
    }

    isMoving(): boolean {
        return this.m_bIsMoving;
    }

    isBot(): boolean {
        return !this.isHuman();
    }

    isHuman(): boolean {
        return this.m_bIsHuman;
    }

    setHuman(bHuman: boolean): void {
        this.m_bIsHuman = bHuman;
    }

    getName(): string {
        return this.m_sName;
    }

    // Each tank keeps its OWN selected weapon so one player's choice never leaks
    // into another's turn.
    getWeaponIndex(): number {
        return this.m_weaponIndex;
    }

    setWeaponIndex(i: number): void {
        this.m_weaponIndex = i;
    }

    // Likewise, each tank keeps its OWN aim (UI angle in degrees, 0..180) and
    // power (10..1000) so they persist across turns and never leak between players.
    getAimAngle(): number {
        return this.m_aimAngle;
    }

    setAimAngle(deg: number): void {
        this.m_aimAngle = deg;
    }

    getPower(): number {
        return this.m_power;
    }

    setPower(p: number): void {
        this.m_power = p;
    }

    // The power + angle of this tank's LAST real shot,
    // saved on every non-utility fire. The reset button (↺) restores the current
    // aim to these — "set power and angle to your last shot." Seeded to the
    // starting aim so reset is sane before the first shot of a battle.
    getLastShotAngle(): number {
        return this.m_lastShotAngle;
    }

    getLastShotPower(): number {
        return this.m_lastShotPower;
    }

    saveLastShot(angleDeg: number, power: number): void {
        this.m_lastShotAngle = angleDeg;
        this.m_lastShotPower = power;
    }

    getCredits(): number {
        return this.m_credits;
    }

    setCredits(n: number): void {
        this.m_credits = n;
    }

    getTeamColor(): string {
        return TEAM_COLORS[this.m_nTeamId] ?? '#0000ff';
    }

    /** Screen/world hit-test for hover (badge detail). */
    isPointInside(px: number, py: number): boolean {
        const dx = px - this.m_vPos.x, dy = py - (this.m_vPos.y + tankHeight() / 2);
        return dx * dx + dy * dy < (tankRadius() + 8) * (tankRadius() + 8);
    }

    isLocalPlayer(): boolean {
        return false;
    }   // TODO

    getPosition(): Vec2 {
        return this.m_vPos.clone();
    }

    getVelocity(): Vec2 {
        return this.m_vVel.clone();
    }

    getHealth(): STankHealth {
        return {...this.m_health};
    }

    // Utility-weapon effects (extType 7/10/11): boost shield, repair, set armor.
    addShield(n: number): void {
        this.m_health.nShield = Math.max(0, Math.min(1000, this.m_health.nShield + n));
    }

    addLife(n: number): void {
        this.m_health.nLife = Math.max(0, Math.min(1000, this.m_health.nLife + n));
    }

    setArmor(pct: number): void {
        this.m_health.nArmor = Math.max(0, Math.min(100, pct));
    }

    getTeamId(): number {
        return this.m_nTeamId;
    }

    /**
     * Sprites this tank needs, as {logical name, file path} pairs. The logical
     * names match what draw() looks up, so the loader and renderer stay in sync.
     */
    getRequiredSprites(): { name: string; file: string }[] {
        return ['body', 'wreck', 'turret'].map(part => ({
            name: `tanks/${this.m_sTankType} ${part}`,
            file: `/assets/tanks/${this.m_sTankType} ${part}.bmp`,
        }));
    }

    /**
     * Distance from terrain surface
     */
    distFromLand(pLand: CLand): number {
        const nTerrainHeight = pLand.getHeightAt(Math.floor(this.m_vPos.x));
        return this.m_vPos.y - (nTerrainHeight - tankHeight());
    }

    distanceTo(x: number, y: number): number {
        const dx = x - this.m_vPos.x;
        const dy = y - (this.m_vPos.y + tankHeight() / 2);
        return Math.sqrt(dx * dx + dy * dy);
    }

    // ========================================================================
    // MEMBER VARIABLES
    // ========================================================================

    private m_nId: number;              // Unique tank identifier

    // Player data reference  
    private m_pPlayerData: unknown;     // per-player data reference

    private m_nTeamId: number = 0;      // Team assignment (for color)
    private m_sName: string = '';       // Display name (e.g. "Player", "BrainBot")
    private m_credits: number = 0;      // Economy credits (shown in the detail badge)
    private m_weaponIndex: number = 0;  // This tank's own selected weapon
    private m_aimAngle: number = 45;    // This tank's own aim (UI degrees, 0..180)
    private m_power: number = 500;      // This tank's own firing power (10..1000)
    private m_lastShotAngle: number = 45;   // aim of the last real shot (reset target)
    private m_lastShotPower: number = 500;
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
        nHazmat: 0,
        fRadiation: 0
    };
    // Full/starting life — set from Tank → Hitpoints on spawn. Denominator for the
    // life bar and the life-percent status so custom hitpoints scale correctly.
    private m_maxLife = 1000;

    // Jet flight (extType 17): fuel in seconds remaining, and the current held
    // thrust input. Flying == fuel > 0 (there is no separate flag).
    private m_fJetFuel: number = 0;
    private m_jetInput = {up: false, left: false, right: false};

    // State flags
    public m_bIsAlive: boolean = true;
    public m_bIsMoving: boolean = false;
    private m_bFalling: boolean = false;
    private m_driveTargetX: number | null = null;   // ground-drive destination, or null
    public m_bExploded: boolean = false;
    private m_bUnderground: boolean = false;

    // Statistics tracking
    private m_nHitCount: number = 0;
}

// ============================================================================
// CONSTANTS
// ============================================================================

// Base tank geometry (px). Player Size (Settings → Tank) scales all of it uniformly
// via GameConfig at read time, so a Small/Large tank draws, sits and collides at the
// chosen size. Accessors below are used everywhere in place of the raw constants.
const TSZ_R = 16;            // Half-width of tank collision box
const TSZ_H = 24;            // Approximate height in pixels
const TSZ_TLEN = 20;         // Turret barrel length for muzzle calc
const TSZ_THGT = 15;         // Turret pivot height above the ground line
const TSZ_W = 46;            // On-screen hull width in pixels
const tankRadius = () => TSZ_R * GameConfig.tankSizeScale;
const tankHeight = () => TSZ_H * GameConfig.tankSizeScale;
const turretLen = () => TSZ_TLEN * GameConfig.tankSizeScale;
const turretHgt = () => TSZ_THGT * GameConfig.tankSizeScale;
const tankWidth = () => TSZ_W * GameConfig.tankSizeScale;
const TANK_GRAVITY = 400;               // Fall acceleration when unsupported (px/s^2)
const TANK_DRIVE_SPEED = 70;            // Ground-drive crawl speed (px/s)
const TANK_DRIVE_MAX_CLIMB = 2.0;       // Max terrain RISE per px driven before a wall stops it
const TANK_DRIVE_MAX_DROP = 8.0;        // Max terrain DROP per px driven before a cliff stops it

// Jet thrust as multiples of gravity.
// UP = -1.2g (net -0.2g up while held); L/R = ∓0.1g. Ceiling at the map top.
const JET_UP_ACCEL = -1.2 * TANK_GRAVITY;
const JET_SIDE_ACCEL = -0.1 * TANK_GRAVITY;
const JET_CEILING = 8;
