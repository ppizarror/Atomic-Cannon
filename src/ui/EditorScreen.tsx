/**
 * The shared frame for every Game-Content editor (Customize Controls / Players / Taunts and
 * the enable-list editors): a steel-plate screen with a bazouk title, the editor's own body,
 * a caption footer, and a row of action buttons. Each editor supplies only its `title`, body
 * (children), `footer` captions, and `actions` — the copy-pasted scaffold lives here once.
 */
import type {ComponentChildren} from 'preact';
import {BmpText} from './BmpText';

export function EditorScreen({
  title,
  children,
  footer,
  actions,
  onClick,
}: {
  title: string;
  children: ComponentChildren;
  footer: ComponentChildren;
  actions: ComponentChildren;
  /** Screen-level click (Customize Controls uses it to unassign the armed row). */
  onClick?: () => void;
}) {
  return (
    <div class="editor-screen" onClick={onClick}>
      <div class="editor-title">
        <BmpText font="bazouk-28" text={title} />
      </div>
      {children}
      <div class="editor-footer">{footer}</div>
      <div class="editor-buttons">{actions}</div>
    </div>
  );
}
