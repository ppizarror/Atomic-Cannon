/**
 * CShot - Projectile Class
 */

import { Vec2 } from '../math/Vec2';
import { CLand } from './CLand';
import { CTank } from './CTank';

interface TrailPoint {
  x: number;
  y: number;
  age: number;
}

export class CShot {

  private static GRAVITY = 500;

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

    const SPEED_SCALE = 8;
    const speed = power * SPEED_SCALE;

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

    const SPEED_SCALE = 8;
    const speed = power * SPEED_SCALE;

    if (turretAngleRad >= 0) {
      // Aiming right side
      this.m_vel.x = Math.cos(turretAngleRad) * speed;
      this.m_vel.y = -Math.sin(Math.abs(turretAngleRad)) * speed;
    } else {
      // Aiming left side  
      this.m_vel.x = -Math.cos(Math.abs(turretAngleRad)) * speed;
      this.m_vel.y = -Math.sin(Math.abs(turretAngleRad)) * speed;
    }

    this.m_bIsDead = false;
    this.m_trailPoints = [];
    this.addTrailPoint();
  }

  update(dt: number, windX: number = 0): void {
    if (this.m_bIsDead) return;

    this.m_vel.y += CShot.GRAVITY * dt;
    this.m_vel.x += windX * dt * 0.5;

    const dxdt = this.m_vel.x * dt;
    const dydt = this.m_vel.y * dt;
    
    this.m_pos = new Vec2(
      this.m_pos.x + (this.m_vel.x * dt),
      this.m_pos.y + (this.m_vel.y * dt)
    );

    if (this.m_bTrailActive) {
      this.addTrailPoint();
      this.pruneTrailPoints(dt);
    }
  }

  private addTrailPoint(): void {
    const pt: TrailPoint = { x: this.m_pos.x, y: this.m_pos.y, age: 0 };

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

  draw(ctx: CanvasRenderingContext2D, color: string = '#ff8800'): void {
    if (this.m_bIsDead) return;

    this.drawStreak(ctx);

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

  getDamage(): number { return this.m_damage; }
  getRadius(): number { return this.m_radius; }
  getOwner(): CTank | null { return this.m_owner; }
  
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
}
