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
