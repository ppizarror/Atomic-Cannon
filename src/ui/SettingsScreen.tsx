/**
 * The shared chrome for the Settings root, each settings option page, and the Play
 * setup screen: the full-screen `.settings-screen` frame plus the bottom-centre hover
 * subtitle. Callers supply the body — a scrollable or plain widget list, the one part
 * that genuinely differs — as children, and the already-resolved subtitle text (their
 * own `hover ?? default`). An empty subtitle renders nothing, so the root's "no hint"
 * state matches the old `sub ? … : null`.
 */
import type {ComponentChildren} from 'preact';
import {BmpText} from './BmpText';

export function SettingsScreen({
  subtitle,
  spacing,
  children,
}: {
  subtitle: string;
  spacing?: number;
  children: ComponentChildren;
}) {
  return (
    <div class="settings-screen">
      {children}
      <div class="settings-subtitle">
        {subtitle ? <BmpText font="beijing-16-out" text={subtitle} spacing={spacing} /> : null}
      </div>
    </div>
  );
}
