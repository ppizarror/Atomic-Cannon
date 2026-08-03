/**
 * CChatter — the tanks' speech bubbles, split out of CGameController.
 *
 * Named for the "Chatter" setting that gates it, and to stay clear of `core/CTaunts`, which is a
 * different thing: that holds the LINE POOLS (the editable death / post-fire / idle lists) while
 * this decides who speaks, when, and for how long.
 *
 * The category is driven by the event (post-fire / death / idle); the line itself is a uniform
 * random pick inside that category. Bubbles are rendered as DOM overlays (App → TauntLayer), so
 * this exposes them as fractional screen coordinates rather than drawing anything — see
 * {@link CChatter.active}.
 */
import {clamp01} from '../math/num';
import {between} from '../math/random';
import {GameConfig} from '../core/CGameConfig';
import {pickTaunt, type TauntCategory} from '../core/CTaunts';
import {strings, fmt} from '../i18n';

/** Speech-bubble tuning. */
export const TAUNT = {
  CHANCE_DEATH: 30,
  CHANCE_IDLE: 60,
  CHANCE_POSTFIRE: 8,
  /** Own goal: a tank that drops a round on itself or its own squad occasionally has a word for
   *  itself. */
  CHANCE_SELF: 35,
  FADE: 0.6,
  /** The idle timer re-arms to a random gap in this range (seconds) each turn/attempt. */
  IDLE: [7, 15],
  LIFE: 4.0,
  /** Screen-space height (px) the bubble's tail floats above the tank's centre — just clear of the
   *  turret so the tail points right at the tank. */
  RISE: 20,
  /** A graze isn't worth a line — it has to have actually hurt. */
  SELF_MIN_DAMAGE: 20,
} as const;

/** A tank, as the bubble system needs to see one. */
export interface TauntSpeaker {
  isAlive(): boolean;
  isSentry(): boolean;
  getName(): string;
  getPosition(): {x: number; y: number};
}

/** A live bubble: who is speaking, what, and how long it has been up. */
interface TauntBubble {
  id: number;
  speaker: TauntSpeaker;
  text: string;
  age: number;
}

/** A bubble projected to fractional view coordinates for the DOM overlay. */
export interface ActiveTaunt {
  id: number;
  text: string;
  xPct: number;
  yPct: number;
  alpha: number;
}

/** The view the bubbles are projected into, so they track their speaker as the camera scrolls. */
export interface TauntView {
  camX: number;
  viewW: number;
  viewH: number;
}

export class CChatter {
  private m_bubbles: TauntBubble[] = [];
  private m_seq = 0;
  private m_idleTimer: number = TAUNT.IDLE[0]; // idle-taunt countdown, re-armed each turn

  /** Drop every bubble (fresh match, or the player advancing past the standings). */
  clear(): void {
    this.m_bubbles = [];
  }

  /** Re-arm the idle countdown for a new turn. */
  armIdle(): void {
    this.m_idleTimer = between(...TAUNT.IDLE);
  }

  hasAny(): boolean {
    return this.m_bubbles.length > 0;
  }

  count(): number {
    return this.m_bubbles.length;
  }

  /**
   * Try to make `speaker` say a `cat` line: gated by the Chatter setting, the Sentry exclusion, a
   * live speaker, and a `chancePct` roll. On success a bubble replaces any this speaker already has.
   */
  try(cat: TauntCategory, speaker: TauntSpeaker | null, chancePct: number): void {
    if (!GameConfig.chatter || !speaker) return;
    // A dead tank speaks ONLY its death line — never an idle/gloat 'taunt' (which would overwrite
    // the death cry via the same-speaker filter below). Death cat is called from
    // handleTankDestroyed after the tank is already marked dead, so it is exempt from the alive check.
    if (cat !== 'death' && !speaker.isAlive()) return;
    if (speaker.isSentry()) return; // Sentries never taunt
    if (Math.random() * 100 > chancePct) return;
    const line = pickTaunt(cat);
    if (!line) return; // list emptied in the editor → nothing to say
    this.say(speaker, line);
  }

  /**
   * Put `line` in `speaker`'s mouth unconditionally — no Chatter gate, no roll. For the deliberate
   * cases: the manual "Chat Taunt" key, and the victor's gloat on the standings screen (which the
   * caller has already decided to show).
   */
  say(speaker: TauntSpeaker, line: string): void {
    this.m_bubbles = this.m_bubbles.filter(b => b.speaker !== speaker);
    this.m_bubbles.push({
      id: ++this.m_seq,
      speaker,
      text: fmt(strings.value.game.bubble, {name: speaker.getName(), line}),
      age: 0,
    });
  }

  /**
   * Age bubbles (dropping the expired) and run the idle-taunt countdown.
   *
   * `ageing` is false on the standings screen, where the victor's gloat must persist beside the
   * winner flag until the player advances (it is created at battle end, so ageing it there would
   * let it vanish mid-celebration).
   */
  update(dt: number, opts: {ageing: boolean; idleSpeaker: TauntSpeaker | null}): void {
    if (this.m_bubbles.length) {
      if (opts.ageing) {
        for (const b of this.m_bubbles) b.age += dt;
        this.m_bubbles = this.m_bubbles.filter(b => b.age < TAUNT.LIFE);
      } else {
        this.m_bubbles = this.m_bubbles.filter(b => b.speaker.isAlive());
      }
    }
    if (!opts.idleSpeaker) return;
    this.m_idleTimer -= dt;
    if (this.m_idleTimer <= 0) {
      this.try('taunt', opts.idleSpeaker, TAUNT.CHANCE_IDLE);
      this.armIdle();
    }
  }

  /** Active bubbles projected to fractional screen coords (0..1 of the view), so the DOM overlay
   *  tracks the speaker as the camera scrolls. `alpha` fades over the final TAUNT.FADE seconds. */
  active(view: TauntView): ActiveTaunt[] {
    if (!this.m_bubbles.length) return [];
    return this.m_bubbles.map(b => {
      const p = b.speaker.getPosition();
      const remain = TAUNT.LIFE - b.age;
      return {
        id: b.id,
        text: b.text,
        xPct: (p.x - view.camX) / view.viewW,
        yPct: (p.y - TAUNT.RISE) / view.viewH,
        alpha: clamp01(remain / TAUNT.FADE),
      };
    });
  }
}
