/**
 * 2D Vector Math Class
 */
export class Vec2<T extends number = number> {
  constructor(
    public x: T,
    public y: T,
  ) {}

  clone(): Vec2<T> {
    return new Vec2(this.x, this.y);
  }

  add(v: Vec2<T>): Vec2<T> {
    return new Vec2((this.x + v.x) as T, (this.y + v.y) as T);
  }

  sub(v: Vec2<T>): Vec2<T> {
    return new Vec2((this.x - v.x) as T, (this.y - v.y) as T);
  }

  mul(scalar: number): Vec2<number> {
    return new Vec2(this.x * scalar, this.y * scalar);
  }

  div(scalar: number): Vec2<number> {
    return new Vec2(this.x / scalar, this.y / scalar);
  }

  dot(v: Vec2<T>): T {
    return (this.x * v.x + this.y * v.y) as T;
  }

  length(): number {
    return Math.sqrt(this.x ** 2 + this.y ** 2);
  }

  normalize(): Vec2<number> {
    const len = this.length();
    if (len === 0) return new Vec2(0, 0);
    return this.div(len);
  }

  angle(): number {
    return Math.atan2(this.y, this.x);
  }

  rotate(angle: number): Vec2<number> {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Vec2(this.x * cos - this.y * sin, this.x * sin + this.y * cos);
  }

  distanceTo(v: Vec2<T>): number {
    return Math.sqrt((this.x - v.x) ** 2 + (this.y - v.y) ** 2);
  }

  /**
   * Unit aim/launch direction for a screen-space angle (y-down): `(cos θ, −sin θ)`,
   * so 0 points right and positive θ points UP. This is the convention used for
   * turret aim, projectile launch and muzzle FX — build those directions here.
   */
  static fromAngle(rad: number): Vec2<number> {
    return new Vec2(Math.cos(rad), -Math.sin(rad));
  }
}
