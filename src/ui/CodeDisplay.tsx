/**
 * A shareable code shown with a Copy button — the room code in the Network lobby and the profile
 * id in the Sync screen. Both display an already-grouped code beside a button that copies it and
 * flips its label to "Copied" for a beat, so the pair lives here once.
 *
 * `class` picks the skin (`net-code-*` / `sync-code-*`); the copied-label reset is the component's
 * own state, so two of these on screen can't share a stuck "Copied".
 */
import {useState} from 'preact/hooks';
import {BmpText} from './BmpText';

export function CodeDisplay({
  code,
  copyLabel,
  copiedLabel,
  class: cls,
}: {
  /** The code in its DISPLAY form (already hyphen-grouped) — this is what gets copied. */
  code: string;
  copyLabel: string;
  copiedLabel: string;
  /** Base class for the wrapper; the value span gets `<class>-value`. */
  class: string;
}) {
  const [copied, setCopied] = useState(false);
  // A clipboard write can reject (permissions, insecure context) — swallow it and leave the label
  // alone rather than surfacing a failure the player can do nothing about; the code is on screen.
  const copy = (): void => {
    void navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <div class={cls}>
      <span class={`${cls}-value`}>{code}</span>
      <button class="btn" onClick={copy}>
        <BmpText font="msans-14" text={copied ? copiedLabel : copyLabel} />
      </button>
    </div>
  );
}
