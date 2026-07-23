/**
 * The command vocabulary — every discrete turn action expressed as one
 * serializable object. This is the seam multiplayer plugs into: a remote
 * player's move, a replayed input, or a bot decision all become a `GameCommand`
 * fed through {@link applyCommand}.
 *
 * Each is one client→server intent. Aim collapses angle+power into one message
 * (as `dragAim` already reduces a mouse drag). Purely local UI gestures (drag
 * start/update) are NOT commands — only committed intents are.
 */
export type GameCommand =
  | {readonly t: 'aim'; readonly angle: number; readonly power: number}
  | {readonly t: 'resetAim'}
  | {readonly t: 'selectWeapon'; readonly index: number}
  | {readonly t: 'buy'; readonly index: number}
  | {readonly t: 'sell'; readonly index: number}
  | {readonly t: 'autobuy'}
  | {readonly t: 'move'; readonly destX: number}
  | {readonly t: 'jet'; readonly up: boolean; readonly left: boolean; readonly right: boolean}
  | {readonly t: 'cutJet'}
  | {readonly t: 'fire'};

export type GameCommandType = GameCommand['t'];

/**
 * The subset of the controller a command touches. CGameController satisfies this
 * structurally; depending on the interface (not the 165 KB class) keeps the
 * command layer decoupled and unit-testable with a mock target.
 */
export interface CommandTarget {
  setAngle(angle: number): void;
  setPower(power: number): void;
  resetAim(): void;
  selectWeapon(index: number): void;
  buyWeapon(index: number): boolean;
  sellWeapon(index: number): boolean;
  autoBuyWeapons(): void;
  commandMoveTo(destX: number): void;
  setJetInput(up: boolean, left: boolean, right: boolean): void;
  cutJet(): void;
  fire(): void;
}

/**
 * Apply one command to the game. Pure dispatch — all validation (whose turn,
 * shot-in-flight, paused) lives in the target methods, which already guard
 * themselves, so a command from the wire is as safe as one from the mouse.
 * The `switch` is exhaustive; a new command type is a compile error until handled.
 */
export function applyCommand(gc: CommandTarget, cmd: GameCommand): void {
  switch (cmd.t) {
    case 'aim':
      gc.setAngle(cmd.angle);
      gc.setPower(cmd.power);
      return;
    case 'resetAim':
      gc.resetAim();
      return;
    case 'selectWeapon':
      gc.selectWeapon(cmd.index);
      return;
    case 'buy':
      gc.buyWeapon(cmd.index);
      return;
    case 'sell':
      gc.sellWeapon(cmd.index);
      return;
    case 'autobuy':
      gc.autoBuyWeapons();
      return;
    case 'move':
      gc.commandMoveTo(cmd.destX);
      return;
    case 'jet':
      gc.setJetInput(cmd.up, cmd.left, cmd.right);
      return;
    case 'cutJet':
      gc.cutJet();
      return;
    case 'fire':
      gc.fire();
      return;
    default: {
      const _exhaustive: never = cmd;
      return _exhaustive;
    }
  }
}
