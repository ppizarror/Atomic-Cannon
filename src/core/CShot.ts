/**
 * CShot - Projectile Class
 */

import {Vec2} from '../math/Vec2';
import {CLand} from './CLand';
import {CTank} from './CTank';

// Trajectory constants — the single source of truth, shared with the aim AI so a
// simulated shot matches a real one exactly. Calibrated to our px/second space;
// the original's ratios (gravity vs launch speed vs wind) are preserved.
export const SHOT_GRAVITY = 500;       // px/s^2 downward
export const SHOT_WIND_ACCEL = 15;     // wind display units -> px/s^2 of sideways drift
export const SHOT_SPEED_SCALE = 0.9;   // launch speed per unit power

interface TrailPoint {
    x: number;
    y: number;
    age: number;
}

export class CShot {

    private static GRAVITY = SHOT_GRAVITY;
    private static WIND_ACCEL = SHOT_WIND_ACCEL;   // wind display units -> px/s^2 of drift

    constructor() {
        this.m_pos = new Vec2(0, 0);
        this.m_vel = new Vec2(0, 0);
        this.m_owner = null;
        this.m_damage = 0;
        this.m_radius = 50;
        this.m_power = 50;
        this.m_bIsDead = false;
        this.m_bTrailActive = true;
        this.m_trailPoints = [];
        this.m_maxTrailAge = 0.5;
        this.m_maxTrailPoints = 20;
    }

    init(
        pos: Vec2,
        angleDegrees: number,
        power: number,
        damage: number,
        radius: number,
        owner?: CTank | null
    ): void {
        this.m_pos = pos.clone();
        this.m_owner = owner || null;
        this.m_damage = damage;
        this.m_radius = radius;
        this.m_power = power;

        const fRadAngle = -((angleDegrees / 180) * Math.PI);

        const speed = power * SHOT_SPEED_SCALE;

        this.m_vel.x = Math.cos(fRadAngle) * speed;
        this.m_vel.y = Math.sin(fRadAngle) * speed;

        this.m_bIsDead = false;
        this.m_trailPoints = [];
        this.addTrailPoint();
    }

    initFromTank(
        muzzlePos: Vec2,
        turretAngleRad: number,
        power: number,
        damage: number,
        radius: number,
        owner: CTank
    ): void {
        this.m_pos = muzzlePos.clone();
        this.m_owner = owner;
        this.m_damage = damage;
        this.m_radius = radius;
        this.m_power = power;

        const speed = power * SHOT_SPEED_SCALE;

        // Unified aim: θ measured CCW from horizontal-right, screen-Y down → up = -sin.
        // Works for every direction, including below-horizon (negative) angles.
        this.m_vel.x = Math.cos(turretAngleRad) * speed;
        this.m_vel.y = -Math.sin(turretAngleRad) * speed;

        this.m_bIsDead = false;
        this.m_trailPoints = [];
        this.addTrailPoint();
    }

    /** Spawn with an explicit velocity — used for cluster submunitions. */
    initFromVelocity(
        pos: Vec2,
        vx: number,
        vy: number,
        damage: number,
        radius: number,
        owner: CTank | null
    ): void {
        this.m_pos = pos.clone();
        this.m_vel = new Vec2(vx, vy);
        this.m_owner = owner || null;
        this.m_damage = damage;
        this.m_radius = radius;
        this.m_bIsDead = false;
        this.m_trailPoints = [];
        this.addTrailPoint();
    }

    /**
     * Semi-implicit Euler step (matches the original): gravity + wind added as
     * acceleration, then position advances. Beam-type shots skip gravity so they
     * fly straight.
     */
    update(dt: number, wind: Vec2): void {
        if (this.m_bIsDead) return;

        this.m_prevY = this.m_pos.y;

        if (!this.m_skipGravity) {
            // Rebound/jet shots invert gravity once they've dipped below the surface.
            const g = this.m_antiGrav ? -CShot.GRAVITY : CShot.GRAVITY;
            this.m_vel.y += g * dt;
        }
        this.m_vel.x += wind.x * CShot.WIND_ACCEL * dt;
        this.m_vel.y += wind.y * CShot.WIND_ACCEL * dt;

        this.m_pos = new Vec2(
            this.m_pos.x + this.m_vel.x * dt,
            this.m_pos.y + this.m_vel.y * dt
        );

        this.m_movingDown = this.m_prevY < this.m_pos.y;
        this.m_age += dt;

        if (this.m_bTrailActive) {
            this.addTrailPoint();
            this.pruneTrailPoints(dt);
        }
    }

    setSkipGravity(skip: boolean): void {
        this.m_skipGravity = skip;
    }

    setAntiGrav(on: boolean): void {
        this.m_antiGrav = on;
    }

    isAntiGrav(): boolean {
        return this.m_antiGrav;
    }

    // Kinematic accessors the weapon behaviours read/write (roller snap, apex test…).
    getVelocity(): Vec2 {
        return this.m_vel.clone();
    }

    setVelocity(vx: number, vy: number): void {
        this.m_vel = new Vec2(vx, vy);
    }

    setPosition(x: number, y: number): void {
        this.m_pos = new Vec2(x, y);
    }

    isMovingDown(): boolean {
        return this.m_movingDown;
    }

    getAge(): number {
        return this.m_age;
    }

    getPower(): number {
        return this.m_power;
    }

    setPower(p: number): void {
        this.m_power = p;
    }

    kill(): void {
        this.m_bIsDead = true;
    }

    private addTrailPoint(): void {
        const pt: TrailPoint = {x: this.m_pos.x, y: this.m_pos.y, age: 0};

        this.m_trailPoints.push(pt);

        if (this.m_trailPoints.length > this.m_maxTrailPoints) {
            this.m_trailPoints.shift();
        }
    }

    private pruneTrailPoints(dt: number): void {
        for (const pt of this.m_trailPoints) {
            pt.age += dt;
        }

        this.m_trailPoints = this.m_trailPoints.filter(
            pt => pt.age < this.m_maxTrailAge
        );
    }

    checkTerrainCollision(land: CLand): boolean {
        const nTerrainHeight = land.getHeightAt(Math.floor(this.m_pos.x));

        if (this.m_pos.y >= nTerrainHeight - 5) {
            return true;
        }

        if (this.m_pos.x < -50 || this.m_pos.x > land.width + 50 ||
            this.m_pos.y > land.height + 50) {
            this.m_bIsDead = true;
            return false;
        }

        return false;
    }

    checkTankCollision(tank: CTank): boolean {
        if (!tank.isAlive()) return false;

        const dist = tank.distanceTo(this.m_pos.x, this.m_pos.y);
        return (dist < 16);
    }

    getPosition(): Vec2 {
        return this.m_pos.clone();
    }

    isDead(): boolean {
        return this.m_bIsDead;
    }

    draw(ctx: CanvasRenderingContext2D, color: string = '#ff8800', sprite: CanvasImageSource | null = null, size = 12): void {
        if (this.m_bIsDead) return;

        // No procedural streak — the trail is entirely sprite-based particles now
        // (per-weapon trailType), so trailType-0 weapons (nukes/beams) fly cleanly.

        // Real projectile sprite, rotated to point along its velocity. The original
        // draws these scaled by a uniform map scale; we normalise each sprite's
        // longest side to a consistent on-screen size (from the weapon's `size`) so a
        // huge sprite (ball/mine) and a tiny one (shell) read at comparable scale.
        if (sprite) {
            const nw = (sprite as { width: number }).width;
            const nh = (sprite as { height: number }).height;
            const targetLong = Math.max(14, Math.min(34, size * 1.3));
            const k = targetLong / Math.max(nw, nh);
            const w = nw * k, h = nh * k;
            const ang = Math.atan2(this.m_vel.y, this.m_vel.x);
            ctx.save();
            ctx.translate(this.m_pos.x, this.m_pos.y);
            ctx.rotate(ang);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(sprite, -w / 2, -h / 2, w, h);
            ctx.restore();
            return;
        }

        // Fallback glowing dot until the sprite is loaded.
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(this.m_pos.x, this.m_pos.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(this.m_pos.x, this.m_pos.y, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    private drawStreak(ctx: CanvasRenderingContext2D): void {
        if (this.m_trailPoints.length < 2) return;

        for (let i = 1; i < this.m_trailPoints.length; i++) {
            const pt0 = this.m_trailPoints[i - 1];
            const pt1 = this.m_trailPoints[i];

            const alpha = Math.max(0, 1 - (pt1.age / this.m_maxTrailAge));

            ctx.strokeStyle = `rgba(255, 136, 0, ${alpha})`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(pt0.x, pt0.y);
            ctx.lineTo(pt1.x, pt1.y);
            ctx.stroke();
        }
    }

    getDamage(): number {
        return this.m_damage;
    }

    getRadius(): number {
        return this.m_radius;
    }

    getOwner(): CTank | null {
        return this.m_owner;
    }

    // Which weapon fired this shot, and how deep in the cluster chain it is
    // (0 = the shot the player fired, 1 = its submunitions, ...).
    setWeaponIndex(i: number): void {
        this.m_weaponIndex = i;
    }

    getWeaponIndex(): number {
        return this.m_weaponIndex;
    }

    setGeneration(g: number): void {
        this.m_generation = g;
    }

    getGeneration(): number {
        return this.m_generation;
    }

    m_bIsDead: boolean;

    private m_pos: Vec2;
    private m_vel: Vec2;
    private m_owner: CTank | null;
    private m_damage: number;
    private m_radius: number;
    private m_power: number;
    private m_bTrailActive: boolean;
    private m_trailPoints: TrailPoint[];
    private m_maxTrailAge: number;
    private m_maxTrailPoints: number;
    private m_weaponIndex: number = -1;
    private m_generation: number = 0;
    private m_skipGravity: boolean = false;
    private m_antiGrav: boolean = false;
    private m_prevY: number = 0;
    private m_movingDown: boolean = false;
    private m_age: number = 0;
    // Behaviour scratch: roller "grounded" latch, beam "fired" latch, battery drop
    // counter (see weapon_types.md).
    grounded: boolean = false;
    fired: boolean = false;
    batteryDrops: number = 0;
}
