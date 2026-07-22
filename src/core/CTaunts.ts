/**
 * Taunts — the live message lists the engine speaks from, plus the random picker.
 *
 * A plain mutable singleton like GameConfig / GameContent: the editable lists live
 * in the UI (ui/tauntsStore, signal-backed + persisted), and ui/applySettings copies
 * the effective (edited-or-default) lists in here at boot and whenever they change,
 * so the game layer never imports the UI. The engine only reads.
 *
 * Selection is a plain uniform random index within a category (`rand() % count`);
 * the category is what's contextual (see ui/tauntsStore).
 */
export type TauntCategory = 'death' | 'postFire' | 'taunt';

export const Taunts: Record<TauntCategory, string[]> = {
  death: [],
  postFire: [],
  taunt: [],
};

/** A random line from `cat`, or '' when the list is empty (bubble is then skipped). */
export function pickTaunt(cat: TauntCategory): string {
  const lines = Taunts[cat];
  return lines.length ? lines[Math.floor(Math.random() * lines.length)] : '';
}
