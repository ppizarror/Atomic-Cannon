/**
 * CCrateField — the supply crates (Gameplay → Crates), split out of CGameController.
 *
 * Owns the falling/landed crates, their physics and their draw, plus the floating pickup messages.
 * What it deliberately does NOT own is the AWARD: handing a tank credits/health/ammo touches the
 * economy, the squad credit pool and the audio bus, so this detects the pickup and calls back
 * through {@link CrateEnv.onCollect}. The field decides where crates are and who reached one; the
 * controller decides what that's worth.
 *
 * Crate positions ride the net snapshot, so `list`/`adopt` expose the array for serialisation —
 * the one place this isn't a closed box.
 */
import {clamp, deg2rad} from '../math/num';
import {windProfile} from '../core/wind';
import type {ISpriteSource} from '../core/rendering/sprites';

/** Tuning for the parachute drop. */
const CRATE = {
  /** Landed crate size (px); the pickup reach is `BOX / 2 + tank radius`. */
  BOX: 22,
  /** Constant chute descent speed (px/s). */
  DESCENT: 42,
  /** Pickup message lifetime (s). */
  FLOAT_TEXT_LIFE: 1.6,
  /** Free-fall accel if the chute ever detaches (px/s²). */
  GRAVITY: 240,
  /** Sideways drift per unit of wind while descending (px/s), Realistic mode only. */
  WIND_DRIFT: 9,
  /** Pendulum amplitude (±deg), pivot at the canopy top. */
  WOBBLE_DEG: 12,
  /** deg/s of the sine argument (≈1.8 s per swing). */
  WOBBLE_SPEED: 200,
} as const;

export type CrateKind = 'weapon' | 'credits' | 'health' | 'bomb';

/** A supply crate falling under (then landed without) a parachute. `y` is the crate box's
 *  position; the parachute assembly is drawn above it and swings about its canopy top. */
export interface Crate {
  x: number;
  y: number;
  vy: number;
  kind: CrateKind;
  amount: number;
  weaponIndex: number;
  landed: boolean;
  phase: number;
  id: number;
}

/** A rising, fading pickup message ("Found 800 credits"). */
export interface FloatText {
  x: number;
  y: number;
  text: string;
  color: string;
  age: number;
}

/** A tank, as the crate field needs to see one (reach test + pickup eligibility). */
export interface CrateTaker {
  isAlive(): boolean;
  getHitRadius(): number;
  distanceTo(x: number, y: number): number;
}

/** The world slice the field reads. Everything sim-affecting draws from the SEEDED rng so a
 *  networked client reproduces the same crate (or none) — crates ride the shared snapshot. */
export interface CrateEnv {
  rng: {float(): number; int(n: number): number};
  groundAt(x: number): number;
  worldWidth: number;
  wind: {x: number; y: number};
  tanks: readonly CrateTaker[];
  /** A live tank reached `crate` — award its contents (controller-owned: economy, credits, audio). */
  onCollect(crate: Crate, taker: CrateTaker): void;
}

/** What `draw` needs beyond the context: sprites, the terrain slope, and the animation clock. */
export interface CrateDrawEnv {
  assets: ISpriteSource;
  groundAt(x: number): number;
  /** Monotonic sim time (s) — drives the pendulum phase. */
  time: number;
  /** Draws one line of centred bitmap text (the pickup messages). */
  drawText(text: string, x: number, y: number, alpha: number): void;
}

export class CCrateField {
  private m_crates: Crate[] = [];
  private m_texts: FloatText[] = [];
  private m_seq = 0;

  /** Live crates — exposed because they ride the net snapshot. */
  list(): readonly Crate[] {
    return this.m_crates;
  }

  /** Anything on the field or any message still fading (keeps the render gate awake). */
  hasAny(): boolean {
    return this.m_crates.length > 0 || this.m_texts.length > 0;
  }

  clear(): void {
    this.m_crates = [];
    this.m_texts = [];
  }

  /** Replace the field wholesale from an authoritative snapshot (net adopt / reconcile). */
  adopt(crates: readonly Omit<Crate, 'id' | 'phase'>[]): void {
    this.m_crates = crates.map(c => ({...c, phase: Math.random() * 360, id: ++this.m_seq}));
  }

  /** A blast destroys any crate whose centre is within `radius` of (x, y). The original simply
   *  removes them — no reward spilled, no debris, no sound; the blast's own fireball is the visual. */
  destroyWithin(x: number, y: number, radius: number): void {
    if (!this.m_crates.length) return;
    const reach = Math.max(radius, 20) + CRATE.BOX / 2; // crater/outer-field reach
    this.m_crates = this.m_crates.filter(c => Math.hypot(c.x - x, c.y - y) > reach);
  }

  /** Queue a rising pickup message (shown for the human's own pickups). */
  addText(x: number, y: number, text: string, color: string): void {
    this.m_texts.push({x, y, text, color, age: 0});
  }

  /**
   * Once per ROUND (turn order wrapped), roll the Crates chance and — if the field isn't full
   * (max 2 × live tanks) — drop one parachute crate from the top at a random column.
   */
  maybeSpawn(chancePct: number, env: CrateEnv, weaponFor: (kind: CrateKind) => number): void {
    if (chancePct <= 0) return;
    if (env.rng.float() * 100 >= chancePct) return;
    const alive = env.tanks.filter(t => t.isAlive()).length;
    if (this.m_crates.length >= 2 * alive) return;
    this.add(10 + env.rng.float() * Math.max(1, env.worldWidth - 20), env, weaponFor);
  }

  /** Push one crate dropping from the top at column `x`, with contents rolled 50% weapon
   *  / 20% credits / 20% health / 10% bomb (or a forced `kind` for dev previews). */
  add(x: number, env: CrateEnv, weaponFor: (kind: CrateKind) => number, forced?: CrateKind): void {
    const roll = env.rng.float() * 100;
    const kind: CrateKind =
      forced ?? (roll < 50 ? 'weapon' : roll < 70 ? 'credits' : roll < 90 ? 'health' : 'bomb');
    let amount = 0,
      weaponIndex = -1;
    if (kind === 'weapon') weaponIndex = weaponFor('weapon');
    else if (kind === 'credits')
      amount = (env.rng.int(9) + 1) * 200; // 200..1800
    else if (kind === 'health')
      amount = (env.rng.int(9) + 1) * 100; // 100..900
    else weaponIndex = weaponFor('bomb');
    this.m_crates.push({
      x,
      y: 0, // top of the map
      vy: 0,
      kind,
      amount,
      weaponIndex,
      landed: false,
      phase: Math.random() * 360,
      id: ++this.m_seq,
    });
  }

  /** Per-frame crate physics: descend under the chute (constant speed), land on the terrain, and
   *  get collected by any tank within reach. Also ages pickup messages. */
  update(dt: number, env: CrateEnv): void {
    if (this.m_crates.length) {
      const survivors: Crate[] = [];
      for (const c of this.m_crates) {
        const ground = env.groundAt(c.x);
        if (c.y < ground) {
          if (!c.landed) {
            c.y += CRATE.DESCENT * dt; // constant chute descent
            // Realistic wind: a parachute is almost all sail, so it drifts strongly downwind. The
            // altitude profile eases the drift as it nears the ground (windProfile → 0 at the
            // soil), so it settles rather than skating along. Linear mode → 0 (falls straight).
            const wf = windProfile(ground - c.y);
            c.x = clamp(c.x + env.wind.x * CRATE.WIND_DRIFT * wf * dt, 0, env.worldWidth);
          } else {
            c.vy += CRATE.GRAVITY * dt; // detached chute → free-fall (rarely used)
            c.y += c.vy * dt;
          }
        } else {
          c.y = ground;
          c.vy = 0;
          c.landed = true;
        }
        // Pickup: any live tank whose centre is within (crate box + tank radius).
        const taker = env.tanks.find(t => {
          if (!t.isAlive()) return false;
          return t.distanceTo(c.x, c.y) <= CRATE.BOX / 2 + t.getHitRadius();
        });
        if (taker) env.onCollect(c, taker);
        else survivors.push(c);
      }
      this.m_crates = survivors;
    }
    if (this.m_texts.length) {
      for (const f of this.m_texts) f.age += dt;
      this.m_texts = this.m_texts.filter(f => f.age < CRATE.FLOAT_TEXT_LIFE);
    }
  }

  /** Draw the live crates: falling ones as the wobbling parachute assembly (pendulum swing about
   *  the canopy top), landed ones as the bare crate tilted to the slope. */
  draw(ctx: CanvasRenderingContext2D, env: CrateDrawEnv): void {
    const chute = env.assets.getSprite('gui/crate-chute');
    const box = env.assets.getSprite('gui/crate');
    for (const c of this.m_crates) {
      if (!c.landed && chute) {
        const w = chute.width,
          h = chute.height;
        // Pendulum: swing the whole assembly about its canopy top. The crate box hangs at the
        // bottom, so anchor the sprite's bottom near (x, y) and rotate about the top.
        const rot = Math.sin(deg2rad(env.time * CRATE.WOBBLE_SPEED + c.phase)) * deg2rad(CRATE.WOBBLE_DEG); // prettier-ignore
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.translate(c.x, c.y - h); // canopy-top pivot
        ctx.rotate(rot);
        ctx.drawImage(chute.bitmap, -w / 2, 0, w, h);
        ctx.restore();
      } else if (box) {
        const w = box.width,
          h = box.height;
        const slope = Math.atan2(env.groundAt(c.x + w / 4) - env.groundAt(c.x - w / 4), w / 2);
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.translate(c.x, c.y);
        ctx.rotate(slope); // sit flush on the terrain slope
        ctx.drawImage(box.bitmap, -w / 2, -h, w, h); // bottom edge on the ground
        ctx.restore();
      }
    }
  }

  /** Draw the floating crate-pickup messages (rising + fading), in a bitmap font. */
  drawTexts(env: CrateDrawEnv): void {
    for (const f of this.m_texts) {
      const t = f.age / CRATE.FLOAT_TEXT_LIFE;
      env.drawText(f.text, f.x, f.y - t * 26, 1 - t);
    }
  }
}
