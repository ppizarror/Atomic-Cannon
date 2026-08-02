/**
 * EditorDone — the "Done" button that closes a Customize editor back to the Settings root.
 *
 * Four editors (Taunts, Controls, Import/Export, Players) each wrote the same
 * `<Button label={e.done} onClick={() => openSettingsPage('root')} …>`. The label comes from each
 * editor's own i18n block, so it's passed in; everything else is identical.
 */
import {Button} from './Button';
import {openSettingsPage} from './store';

export function EditorDone({label, class: cls = 'editor-exit'}: {label: string; class?: string}) {
  return <Button label={label} onClick={() => openSettingsPage('root')} class={cls} />;
}
