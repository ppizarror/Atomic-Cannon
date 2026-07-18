/**
 * CExplosion - Particle Explosion Effects System
 * 
 * Creates visual explosion effects with:
 * - Expanding fireball ring
 * - Flying debris particles
 * - Screen shake on impact
 */



/**
 * Single explosion particle data
 */
interface SParticle {
  x: number;
  y: number;
  vx: number;      // Velocity X
  vy: number;      // Velocity Y  
  r: number;       // Color R
  g: number;       // Color G
  b: number;       // Color B
  age: number;     // Time alive
  lifetime: number; // Max lifespan
}

/**
 * Complete explosion instance (multiple particles)
 */
interface ExplosionInstance {
  x: number;
  y: number;
  scale: number;
  duration: number;
  color: string;
  startTime: number;
  particles: SParticle[];
}

export class CExplosion {
  
  private m_explosions: ExplosionInstance[] = [];
  

  /**
   * Create new explosion at position
   */
  createExplosion(
    x: number,
    y: number,
    scale: number = 1.0,
    nParticles: number = 20,
    durationSec: number = 1.0,
    colorStr: string = '#ff8800'
  ): void {
    
    // Parse hex color or use default orange
    let r = 255, g = 136, b = 0;
    
    if (colorStr.startsWith('#') && colorStr.length === 7) {
      const num = parseInt(colorStr.slice(1), 16);
      r = (num >> 16) & 0xff;
      g = (num >> 8) & 0xff;
      b = num & 0xff;
    }
    
    // Generate particles for this explosion
    const particles: SParticle[] = [];
    
    for (let i = 0; i < nParticles; i++) {
      // Random direction outward from center with some spread
      const angle = Math.random() * Math.PI * 2;
      const speed = 50 + Math.random() * 150; // 50-200 px/sec
      
      const p: SParticle = {
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 100, // Upward bias
        r: r + (Math.random() - 0.5) * 50,
        g: g + (Math.random() - 0.5) * 50,
        b: b,
        age: 0,
        lifetime: durationSec * (0.5 + Math.random() * 0.5)
      };
      
      particles.push(p);
    }
    
    const explosion: ExplosionInstance = {
      x, y, scale,
      duration: durationSec,
      color: colorStr,
      startTime: performance.now() / 1000,
      particles
    };
    
    this.m_explosions.push(explosion);
  }

  
  /**
   * Update all active explosions (call each frame)
   */
  update(dt: number): void {
    const GRAVITY = 300; // px/sec^2 - particles fall down
    
    for (let i = this.m_explosions.length - 1; i >= 0; i--) {
      const exp = this.m_explosions[i];
      
      // Check if explosion is complete
      const elapsed = performance.now() / 1000 - exp.startTime;
      if (elapsed > exp.duration) {
        this.m_explosions.splice(i, 1);
        continue;
      }
      
      // Update particles in this explosion
      for (const p of exp.particles) {
        p.age += dt;
        
        if (p.age < p.lifetime) {
          // Apply gravity and update position
          p.vy += GRAVITY * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          
          // Dampen velocity over time
          p.vx *= 0.99;
        }
      }
    }
  }

  
  /**
   * Draw all active explosions to canvas
   */
  draw(ctx: CanvasRenderingContext2D): void {
    for (const exp of this.m_explosions) {
      const elapsed = performance.now() / 1000 - exp.startTime;
      if (elapsed > exp.duration) continue;
      
      // Progress through explosion lifetime (0 to 1)
      const t = elapsed / exp.duration;
      
      // Draw particles
      for (const p of exp.particles) {
        // Fade out particle as it ages
        const alpha = Math.max(0, 1 - (p.age / p.lifetime));
        
        if (alpha <= 0 || p.age >= p.lifetime) continue;
        
        ctx.fillStyle = `rgba(${Math.floor(p.r)}, ${Math.floor(p.g)}, ${Math.floor(p.b)}, ${alpha})`;
        ctx.beginPath();
        
        // Particles shrink as they age
        const size = Math.max(1, 4 * (1 - t * 0.5));
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx.fill();
      }
      
      // Draw expanding shockwave ring
      if (t < 0.3) {
        const ringProgress = t / 0.3;  // Ring expands in first 30%
        const ringRadius = exp.scale * 50 * ringProgress;
        
        ctx.strokeStyle = `rgba(255, 200, 100, ${1 - ringProgress})`;
        ctx.lineWidth = 3 * (1 - ringProgress);
        ctx.beginPath();
        ctx.arc(exp.x, exp.y, ringRadius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  
  /**
   * Check if any explosions are active
   */
  hasActiveExplosions(): boolean {
    return this.m_explosions.length > 0;
  }
}

/**
 * Screen shake effect controller
 */
export class ScreenShake {
  private m_shakeIntensity: number = 0;
  private m_shakeDuration: number = 0;
  private m_startTime: number = 0;
  
  /**
   * Trigger screen shake effect
   */
  trigger(intensity: number, durationSec: number): void {
    this.m_shakeIntensity = intensity;
    this.m_shakeDuration = durationSec;
    this.m_startTime = performance.now() / 1000;
  }
  
  /**
   * Get current offset for canvas translation (call each frame)
   */
  getOffset(): { x: number; y: number } {
    const elapsed = performance.now() / 1000 - this.m_startTime;
    
    if (elapsed > this.m_shakeDuration) {
      return { x: 0, y: 0 };
    }
    
    // Shake intensity decreases over duration
    const decay = 1 - (elapsed / this.m_shakeDuration);
    const maxOffset = this.m_shakeIntensity * decay;
    
    return {
      x: (Math.random() - 0.5) * 2 * maxOffset,
      y: (Math.random() - 0.5) * 2 * maxOffset
    };
  }
  
  /**
   * Check if shake is active
   */
  isActive(): boolean {
    return performance.now() / 1000 - this.m_startTime < this.m_shakeDuration;
  }
}
