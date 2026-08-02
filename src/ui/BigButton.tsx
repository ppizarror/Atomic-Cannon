/**
 * The large `bazouk-28` menu-action button (the `settings-row srow-done` skin) shared by
 * the Play setup, Settings pages, and Network screens — Start / Cancel / Done / Ready /
 * Back. Optional `onEnter`/`onLeave` drive the bottom-centre hover subtitle on the screens
 * that show one (Settings / Play); Network omits them.
 */
import {BmpText} from './BmpText';
import {hoverProps} from './hoverProps';

export function BigButton({
  label,
  onClick,
  disabled,
  onEnter,
  onLeave,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  onEnter?: () => void;
  onLeave?: () => void;
}) {
  return (
    <button
      class="settings-row srow-done menu-btn"
      disabled={disabled}
      {...hoverProps(onEnter, onLeave)}
      onClick={onClick}
    >
      <BmpText font="bazouk-28" text={label} />
    </button>
  );
}
