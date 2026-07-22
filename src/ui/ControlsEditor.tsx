/**
 * "Customize Controls" — the key-binding editor. A two-column Action / Button list
 * over the brushed-steel plate: each row shows an action and its current key. Click a
 * row (or `Customize` to sweep from the top) to arm it, then press any key to bind it;
 * while armed, clicking the screen instead unassigns the action. `Defaults` restores
 * the factory keys; `Done` returns to the Settings root. Bindings persist
 * (controlsStore) and drive gameplay input immediately.
 */
import {useEffect, useState} from 'preact/hooks';
import {BmpText} from './BmpText';
import {Button} from './Button';
import {openSettingsPage, uiClick} from './store';
import {ACTIONS, type ActionId, keyName} from '../core/CControls';
import {bindings, rebind, unassign, resetDefaults} from './controlsStore';

// Sweep order for the guided "Customize" pass and the row list: every action, in
// registered order.
const firstAction = (): ActionId => ACTIONS[0].id;
const nextAction = (id: ActionId): ActionId | null => {
  const i = ACTIONS.findIndex(a => a.id === id);
  return i >= 0 && i + 1 < ACTIONS.length ? ACTIONS[i + 1].id : null;
};

export function ControlsEditor() {
  const map = bindings.value; // subscribe so rows re-render on rebind
  const [armed, setArmed] = useState<ActionId | null>(null);
  const [sweep, setSweep] = useState(false);

  // While a row is armed, the next key press binds it. In a guided sweep we advance
  // to the next action; otherwise we disarm. Capture on the window so the key never
  // reaches gameplay, and prevent the browser default (Space scroll, arrow scroll…).
  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      rebind(armed, e.code);
      uiClick();
      const nxt = sweep ? nextAction(armed) : null;
      if (nxt) setArmed(nxt);
      else {
        setArmed(null);
        setSweep(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [armed, sweep]);

  const armLabel = armed ? ACTIONS.find(a => a.id === armed)?.label : '';

  // Clicking the screen while armed unassigns the armed action (matching the editor's
  // "or click to unassign"); clicking a row arms that row instead.
  const onScreenClick = () => {
    if (!armed) return;
    unassign(armed);
    uiClick();
    setArmed(null);
    setSweep(false);
  };

  return (
    <div class="editor-screen" onClick={onScreenClick}>
      <div class="editor-title">
        <BmpText font="bazouk-28" text="Customize Controls" />
      </div>

      <div class="editor-list editor-controls" onClick={e => e.stopPropagation()}>
        <div class="editor-columns">
          <BmpText font="beijing-16-out" text="Action" />
          <BmpText font="beijing-16-out" text="Button" />
        </div>
        {ACTIONS.map(a => {
          const isArmed = armed === a.id;
          return (
            <button
              key={a.id}
              class={`editor-row ${isArmed ? 'armed' : ''}`}
              onClick={e => {
                e.stopPropagation();
                uiClick();
                setSweep(false);
                setArmed(isArmed ? null : a.id);
              }}
            >
              <span class="editor-body">
                <BmpText font="beijing-16-out" text={a.label} />
              </span>
              <span class="editor-state">
                <BmpText
                  font="beijing-16-out"
                  text={isArmed ? 'Press a key…' : keyName(map[a.id])}
                />
              </span>
            </button>
          );
        })}
      </div>

      <div class="editor-footer">
        {armed ? (
          <>
            <BmpText font="beijing-16-out" text={`Press a key to define "${armLabel}".`} />
            <BmpText font="beijing-16-out" text="Or click the screen to unassign." />
          </>
        ) : (
          <BmpText font="beijing-16-out" text="Click an action to rebind its key" />
        )}
      </div>

      <div class="editor-buttons">
        <Button
          label="Customize"
          onClick={() => (uiClick(), setSweep(true), setArmed(firstAction()))}
        />
        <Button
          label="Defaults"
          onClick={() => (uiClick(), setArmed(null), setSweep(false), resetDefaults())}
        />
        <Button label="Done" onClick={() => openSettingsPage('root')} class="editor-exit" />
      </div>
    </div>
  );
}
