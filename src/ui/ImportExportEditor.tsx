/**
 * "Import / Export" — back up, restore, or wipe every persisted setting.
 *
 *  - Export writes a single JSON backup of the whole `atomic.` storage namespace and
 *    downloads it.
 *  - Import reads such a file back and, on a valid backup, reloads so every store re-seeds
 *    from the restored storage.
 *  - Reset All… clears the namespace after a confirmation dialog, then reloads — a clean
 *    slate, as if the game had never been played.
 *
 * The reload after Import / Reset is deliberate: the stores seed their signals once at load,
 * so rewriting localStorage underneath them only takes effect on the next load.
 */
import {useRef, useState} from 'preact/hooks';
import {BmpText} from './BmpText';
import {BmpParagraph} from './BmpParagraph';
import {Button} from './Button';
import {EditorDone} from './EditorDone';
import {EditorScreen} from './EditorScreen';
import {Modal} from './Modal';
import {ModalButton} from './ModalButton';
import {uiClick} from './store';
import {strings, fmt} from '../i18n';
import {exportSettings, importSettings, resetAllSettings} from '../util/settingsBackup';

const BACKUP_FILE = 'atomic-cannon-settings.json';

export function ImportExportEditor() {
  const e = strings.value.editors.importExport;
  const [status, setStatus] = useState('');
  const [failed, setFailed] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Serialize the whole namespace and hand the browser a download.
  const onExport = () => {
    uiClick();
    const blob = new Blob([JSON.stringify(exportSettings(), null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = BACKUP_FILE;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Open the file picker; the actual read happens in onFile once a file is chosen.
  const onImport = () => {
    uiClick();
    fileInput.current?.click();
  };

  const onFile = (ev: Event) => {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // let the same file be re-picked later
    if (!file) return;
    file
      .text()
      .then(text => {
        const n = importSettings(text);
        if (n < 0) {
          setFailed(true);
          setStatus(e.importFailed);
          return;
        }
        setFailed(false);
        setStatus(fmt(e.imported, {n}));
        // Show the status briefly, then reload so every store re-seeds from the import.
        setTimeout(() => location.reload(), 500);
      })
      .catch(() => {
        setFailed(true);
        setStatus(e.importFailed);
      });
  };

  const onResetConfirm = () => {
    uiClick();
    resetAllSettings();
    location.reload();
  };

  return (
    <>
      <EditorScreen
        title={e.title}
        footer={
          <BmpText
            font="beijing-16-out"
            text={status || e.idle}
            class={failed ? 'ie-status-fail' : undefined}
          />
        }
        actions={
          <>
            <Button label={e.import} onClick={onImport} />
            <Button label={e.export} onClick={onExport} />
            <Button label={e.reset} onClick={() => (uiClick(), setConfirmReset(true))} />
            <EditorDone label={e.done} />
          </>
        }
      >
        <div class="editor-list ie-list">
          <BmpParagraph class="ie-intro" font="beijing-16-out" text={e.intro} />
          <BmpText font="beijing-16-out" text={e.importDesc} />
          <BmpText font="beijing-16-out" text={e.exportDesc} />
          <BmpText font="beijing-16-out" text={e.resetDesc} />
        </div>
      </EditorScreen>

      {/* Hidden native picker driven by the Import button. */}
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        style={{display: 'none'}}
        onChange={onFile}
      />

      {confirmReset && (
        <Modal backdrop="scrim" onClose={() => setConfirmReset(false)} class="confirm-card">
          <div class="confirm-title">
            <BmpText font="bazouk-28" text={e.confirmTitle} />
          </div>
          <BmpParagraph class="confirm-body" font="beijing-16-out" text={e.confirmBody} />
          <div class="confirm-buttons">
            <ModalButton label={e.confirmYes} onClick={onResetConfirm} />
            <ModalButton label={e.confirmNo} onClick={() => setConfirmReset(false)} />
          </div>
        </Modal>
      )}
    </>
  );
}
