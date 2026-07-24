/**
 * Active player roster consumed by the engine at `startGame` — the per-player name /
 * tank model / colour chosen in Customize Players. The UI store (ui/playersStore) is
 * the editable, persisted source; it is copied into this core holder by the settings
 * bridge (ui/applySettings) at boot and whenever the roster changes, so the engine
 * reads plain data without depending on the UI layer (mirrors core/CGameContent).
 */
export interface PlayerCfg {
  name: string;
  model: string;
  /** Hull colour and team identity — tanks sharing a colour form a team. */
  color: string;
}

export const Roster: {players: PlayerCfg[]} = {players: []};

/** The Customize Players roster (16 slots) is split into two pools: slots 0..7 are the HUMAN
 *  players, slots 8..15 the BOTS. This is the split point (= the human-pool size / MAX_HUMANS), so a
 *  match draws humans from 0.. and CPUs from here up. It is NOT "half the tank cap" — that MAX_TANKS
 *  and this are both 8 today is a coincidence; the human/bot boundary is what this names. */
export const ROSTER_HUMAN_SLOTS = 8;
