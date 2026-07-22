/**
 * "Customize Taunts" — edit the three speech-bubble message lists (Taunts / Post-Fire
 * / Death). The original let you edit loose "chat *.txt" files; the browser can't, so
 * each list is editable here and persists (tauntsStore), overriding the shipped
 * defaults. A category selector switches lists; each line is a text field with a
 * delete button; Add appends a blank line; Reset restores that list's defaults.
 *
 * Edits apply live — a taunt is only read at the moment a bubble fires — so there's no
 * "applies next game" caveat.
 */
import {BmpText} from './BmpText';
import {Button} from './Button';
import {openSettingsPage, uiClick} from './store';
import {
  TAUNT_CATEGORIES,
  tauntLines,
  setTauntLines,
  resetTauntLines,
  tauntsEdited,
  type TauntCategory,
} from './tauntsStore';
import {useState} from 'preact/hooks';

export function TauntEditor() {
  const [cat, setCat] = useState<TauntCategory>('taunt');
  const lines = tauntLines(cat); // subscribes to the store signal

  const commit = (next: string[]) => setTauntLines(cat, next);
  const editLine = (i: number, v: string) => commit(lines.map((l, j) => (j === i ? v : l)));
  const removeLine = (i: number) => (uiClick(), commit(lines.filter((_, j) => j !== i)));
  const addLine = () => (uiClick(), commit([...lines, '']));
  const meta = TAUNT_CATEGORIES.find(c => c.id === cat)!;

  return (
    <div class="editor-screen">
      <div class="editor-title">
        <BmpText font="bazouk-28" text="Customize Taunts" />
      </div>

      {/* Category selector: one button per list, the active one highlighted. */}
      <div class="taunt-tabs">
        {TAUNT_CATEGORIES.map(c => (
          <Button
            key={c.id}
            label={c.label}
            onClick={() => (uiClick(), setCat(c.id))}
            class={`taunt-tab${c.id === cat ? ' active' : ''}`}
          />
        ))}
      </div>

      <div class="taunt-edit-list editor-list">
        {lines.map((l, i) => (
          <div key={i} class="taunt-edit-row">
            <input
              class="taunt-input"
              type="text"
              maxLength={120}
              value={l}
              placeholder="(empty — will be ignored)"
              onInput={e => editLine(i, (e.currentTarget as HTMLInputElement).value)}
            />
            <button class="taunt-del" title="Delete line" onClick={() => removeLine(i)}>
              <BmpText font="beijing-16-out" text="X" />
            </button>
          </div>
        ))}
        {lines.length === 0 ? (
          <div class="taunt-empty">
            <BmpText font="beijing-16-out" text="No lines — Add one or Reset to defaults." />
          </div>
        ) : null}
      </div>

      <div class="editor-footer">
        <BmpText font="beijing-16-out" text={meta.desc} />
        <BmpText
          font="beijing-16-out"
          text={`${lines.length} line${lines.length === 1 ? '' : 's'}`}
        />
      </div>

      <div class="editor-buttons">
        <Button label="Add" onClick={addLine} />
        <Button
          label="Reset"
          onClick={() => (uiClick(), resetTauntLines(cat))}
          class={tauntsEdited(cat) ? '' : 'editor-exit'}
        />
        <Button label="Done" onClick={() => openSettingsPage('root')} class="editor-exit" />
      </div>
    </div>
  );
}
