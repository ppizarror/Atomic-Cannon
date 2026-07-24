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
import {EditorScreen} from './EditorScreen';
import {openSettingsPage, uiClick} from './store';
import {ACTIONS, type ActionId, keyName} from '../core/CControls';
import {bindings, rebind, unassign, resetDefaults} from './controlsStore';
import {strings, fmt} from '../i18n';

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

  const e = strings.value.editors.controls;
  const armLabel = armed ? e.actions[armed] : '';

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
    <EditorScreen
      title={e.title}
      onClick={onScreenClick}
      footer={
        armed ? (
          <>
            <BmpText font="beijing-16-out" text={fmt(e.promptDefine, {action: armLabel ?? ''})} />
            <BmpText font="beijing-16-out" text={e.promptUnassign} />
          </>
        ) : (
          <BmpText font="beijing-16-out" text={e.idle} />
        )
      }
      actions={
        <>
          <Button
            label={e.customize}
            onClick={() => (uiClick(), setSweep(true), setArmed(firstAction()))}
          />
          <Button
            label={e.defaults}
            onClick={() => (uiClick(), setArmed(null), setSweep(false), resetDefaults())}
          />
          <Button label={e.done} onClick={() => openSettingsPage('root')} class="editor-exit" />
        </>
      }
    >
      <div class="editor-list editor-controls" onClick={e => e.stopPropagation()}>
        <div class="editor-columns">
          <BmpText font="beijing-16-out" text={e.colAction} />
          <BmpText font="beijing-16-out" text={e.colButton} />
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
                <BmpText font="beijing-16-out" text={e.actions[a.id]} />
              </span>
              <span class="editor-state">
                <BmpText
                  font="beijing-16-out"
                  text={isArmed ? e.pressKey : keyName(map[a.id]) || e.unassigned}
                />
              </span>
            </button>
          );
        })}
      </div>
    </EditorScreen>
  );
}
