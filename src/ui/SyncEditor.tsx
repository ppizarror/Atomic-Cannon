/**
 * "Sync" — link this device to a cloud profile so settings, controls, players, taunts and high
 * scores follow the player between browsers and machines.
 *
 * Two states, and the screen is really two screens:
 *  - UNLINKED: create a new profile from what's on this device, or type an existing id to load.
 *  - LINKED: show the id (with Copy), report where the device stands, and offer a manual
 *    Upload / Download plus Desync.
 *
 * Uploading is automatic once linked — the buttons here are for impatience and for recovery, not
 * for routine use. Anything that REPLACES this device's data (linking, downloading) goes through
 * a confirmation, because it overwrites local scores; Desync doesn't, since it only forgets the
 * id and leaves both copies intact.
 *
 * Every action that rewrites storage reloads afterwards, for the same reason Import does: the
 * stores seeded their signals at load, so a rewrite underneath them only takes on the next load.
 */
import {useEffect, useState} from 'preact/hooks';
import {BmpText} from './BmpText';
import {BmpParagraph} from './BmpParagraph';
import {Button} from './Button';
import {EditorDone} from './EditorDone';
import {EditorScreen} from './EditorScreen';
import {Modal} from './Modal';
import {ModalButton} from './ModalButton';
import {uiClick} from './store';
import {strings, fmt} from '../i18n';
import type {AgoCopy} from '../i18n';
import {formatProfileCode, formatProfileInput} from '../net/profileCode';
import {
  syncLink,
  syncBusy,
  syncOutcome,
  clearSyncOutcome,
  createProfileNow,
  linkProfile,
  downloadNow,
  uploadNow,
  desync,
  type SyncOutcome,
} from './syncStore';

/** Which confirmation dialog is open, if any. */
type Confirm = 'link' | 'download' | 'desync';

// ==========================================================================
// STATUS COPY
// ==========================================================================

/** Outcomes that report a failure — the status line renders these in the alert style. */
const FAILURES: ReadonlySet<SyncOutcome> = new Set<SyncOutcome>([
  'conflict',
  'missing',
  'tooLarge',
  'rateLimited',
  'offline',
  'badData',
  'badCode',
]);

/** "just now" / "5 min ago" / "3 h ago" / "2 d ago". Built from i18n parts rather than
 *  `toLocaleString` so it stays inside the bitmap fonts' ASCII range and stays short. */
function agoText(ms: number, c: AgoCopy): string {
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (secs < 60) return c.now;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return fmt(c.minutes, {n: mins});
  const hours = Math.floor(mins / 60);
  if (hours < 24) return fmt(c.hours, {n: hours});
  return fmt(c.days, {n: Math.floor(hours / 24)});
}

// ==========================================================================
// SCREEN
// ==========================================================================

export function SyncEditor() {
  const e = strings.value.editors.sync;
  const link = syncLink.value;
  const busy = syncBusy.value;
  const outcome = syncOutcome.value;
  const [typed, setTyped] = useState('');
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  // A status left over from a previous visit describes a state that may no longer hold.
  useEffect(() => clearSyncOutcome(), []);

  // Reload once storage has been rewritten under the already-seeded stores.
  const reloadIf = (ok: boolean): void => {
    if (ok) setTimeout(() => location.reload(), 500); // let the status line be read first
  };

  const onCreate = (): void => {
    uiClick();
    void createProfileNow();
  };
  const onLink = (): void => {
    uiClick();
    setConfirm(null);
    void linkProfile(typed).then(reloadIf);
  };
  const onDownload = (): void => {
    uiClick();
    setConfirm(null);
    void downloadNow().then(reloadIf);
  };
  const onUpload = (): void => {
    uiClick();
    void uploadNow();
  };
  const onDesync = (): void => {
    uiClick();
    setConfirm(null);
    desync();
  };

  // The footer line: the last action's result if there is one, else where this device stands.
  const status = busy
    ? e.working
    : outcome
      ? e.outcome[outcome]
      : !link.code
        ? e.idle
        : link.stale
          ? e.stateConflict
          : link.dirty
            ? e.statePending
            : fmt(e.stateSynced, {when: agoText(link.lastSync, e.ago)});
  const failed = !busy && !!outcome && FAILURES.has(outcome);

  return (
    <>
      <EditorScreen
        title={e.title}
        footer={<BmpText font="beijing-16-out" text={status} class={failed ? 'ie-status-fail' : undefined} />}
        actions={
          link.code ? (
            <>
              <Button label={e.upload} onClick={onUpload} disabled={busy} />
              <Button label={e.download} onClick={() => (uiClick(), setConfirm('download'))} disabled={busy} />
              <Button label={e.desync} onClick={() => (uiClick(), setConfirm('desync'))} disabled={busy} />
              <EditorDone label={e.done} />
            </>
          ) : (
            <>
              <Button label={e.create} onClick={onCreate} disabled={busy} />
              <Button label={e.link} onClick={() => (uiClick(), setConfirm('link'))} disabled={busy || !typed.trim()} />
              <EditorDone label={e.done} />
            </>
          )
        }
      >
        <div class="editor-list ie-list">
          {link.code ? <LinkedBody /> : <UnlinkedBody typed={typed} onType={setTyped} />}
        </div>
      </EditorScreen>

      {confirm && (
        <ConfirmDialog
          kind={confirm}
          onCancel={() => setConfirm(null)}
          onConfirm={confirm === 'link' ? onLink : confirm === 'download' ? onDownload : onDesync}
        />
      )}
    </>
  );
}

// ==========================================================================
// BODY PANELS
// ==========================================================================

function LinkedBody() {
  const e = strings.value.editors.sync;
  const code = syncLink.value.code;
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(formatProfileCode(code)).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <>
      <BmpParagraph class="ie-intro" font="beijing-16-out" text={e.linkedIntro} />
      <BmpText font="beijing-16-out" text={e.idLabel} />
      <div class="sync-code-display">
        <span class="sync-code-value">{formatProfileCode(code)}</span>
        <button class="btn" onClick={copy}>
          <BmpText font="msans-14" text={copied ? e.copied : e.copy} />
        </button>
      </div>
      <BmpText font="beijing-16-out" text={e.uploadDesc} />
      <BmpText font="beijing-16-out" text={e.downloadDesc} />
      <BmpText font="beijing-16-out" text={e.desyncDesc} />
    </>
  );
}

function UnlinkedBody({typed, onType}: {typed: string; onType: (v: string) => void}) {
  const e = strings.value.editors.sync;
  return (
    <>
      <BmpParagraph class="ie-intro" font="beijing-16-out" text={e.intro} />
      <BmpText font="beijing-16-out" text={e.createDesc} />
      <BmpText font="beijing-16-out" text={e.linkDesc} />
      <div class="sync-field">
        <BmpText font="beijing-16-out" text={e.idLabel} spacing={-1} />
        <input
          class="sync-input"
          type="text"
          maxLength={13} /* 12 code chars + the grouping hyphen */
          placeholder={e.idPlaceholder}
          value={typed}
          onInput={ev => {
            const it = (ev as InputEvent).inputType;
            const paste = it === 'insertFromPaste' || it === 'insertFromDrop';
            onType(formatProfileInput((ev.currentTarget as HTMLInputElement).value, paste));
          }}
        />
      </div>
    </>
  );
}

// ==========================================================================
// CONFIRMATIONS
// ==========================================================================

function ConfirmDialog({kind, onConfirm, onCancel}: {kind: Confirm; onConfirm: () => void; onCancel: () => void}) {
  const e = strings.value.editors.sync;
  const c = e.confirm[kind];
  return (
    <Modal backdrop="scrim" onClose={onCancel} class="confirm-card">
      <div class="confirm-title">
        <BmpText font="bazouk-28" text={c.title} />
      </div>
      <BmpParagraph class="confirm-body" font="beijing-16-out" text={c.body} />
      <div class="confirm-buttons">
        <ModalButton label={c.yes} onClick={onConfirm} />
        <ModalButton label={e.confirmNo} onClick={onCancel} />
      </div>
    </Modal>
  );
}
