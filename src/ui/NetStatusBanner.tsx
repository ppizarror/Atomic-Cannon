/**
 * In-battle network banner. During a networked match it surfaces connection trouble
 * the lobby would otherwise hide: our own socket reconnecting, or another player who
 * dropped (lost connection / reloaded) — so a stalled turn is explained rather than
 * looking frozen. Clears itself the moment everyone is back.
 */
import {screen} from './store';
import {netState, netDesync, netSpectating, leaveMatch} from './networkStore';
import {strings, fmt} from '../i18n';
import {BmpText} from './BmpText';

export function NetStatusBanner() {
  const s = netState.value;
  // Only during an active networked battle.
  if (screen.value !== 'battle' || s.phase !== 'playing') return null;

  const n = strings.value.net;
  let text: string | null = null;
  let othersDown = false;

  if (s.status === 'reconnecting' || s.status === 'closed') {
    text = n.ownReconnecting; // our own link is down
  } else {
    const dropped = s.players.filter(p => !p.connected && p.id !== s.youId);
    othersDown = dropped.length > 0;
    if (dropped.length === 1) text = fmt(n.playerDropped, {name: dropped[0].name});
    else if (dropped.length > 1) text = fmt(n.playersDropped, {n: dropped.length});
  }

  // A lockstep divergence (cheat/desync) outranks nothing but persists once tripped — show it if no
  // connection banner is up. We keep our own trusted state, so this is a warning, not a stall.
  if (!text && netDesync.value) text = n.desyncWarning;

  // Nothing wrong, but we're a spectator → a neutral, persistent "Spectating" tag (not the amber
  // trouble banner). Trouble/desync text takes precedence when present.
  if (!text) {
    if (!netSpectating.value) return null;
    return (
      <div class="net-banner net-banner-info">
        <BmpText font="beijing-16-out" text={n.spectating} spacing={-1} />
      </div>
    );
  }
  return (
    <div class="net-banner">
      <BmpText font="beijing-16-out" text={text} spacing={-1} />
      {/* When it's another player who's stuck, offer a way out of a hung match. */}
      {othersDown && (
        <button class="net-banner-btn" onClick={leaveMatch}>
          <BmpText font="beijing-16-out" text={n.endMatch} spacing={-1} />
        </button>
      )}
    </div>
  );
}
