/**
 * In-match chat — a compact overlay shown during a networked battle. Recent messages sit in the
 * bottom-left; a single input sends to everyone (the server echoes it back, so your own line shows
 * up like anyone else's). The global key handler ignores keystrokes while a text field is focused
 * (main.tsx isTypingTarget), so typing here never moves the turret; we also blur after sending so
 * the very next Space/arrow goes back to the game.
 */
import {useEffect, useRef, useState} from 'preact/hooks';
import {screen} from './store';
import {netState, chatLog, sendChat} from './networkStore';
import {strings} from '../i18n';

export function NetChat() {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const log = chatLog.value;

  // Keep the newest line in view as messages arrive.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  // Only during an active networked battle.
  if (screen.value !== 'battle' || netState.value.phase !== 'playing') return null;

  const submit = (e: Event) => {
    e.preventDefault();
    sendChat(text);
    setText('');
    inputRef.current?.blur(); // hand keyboard focus back to the game
  };

  return (
    <div class="net-chat">
      {log.length > 0 && (
        <div class="net-chat-log" ref={listRef}>
          {log.map(m => (
            <div key={m.seq} class={`net-chat-line${m.mine ? ' mine' : ''}`}>
              <span class="net-chat-name">{m.name}:</span>{' '}
              <span class="net-chat-text">{m.text}</span>
            </div>
          ))}
        </div>
      )}
      <form class="net-chat-form" onSubmit={submit}>
        <input
          ref={inputRef}
          class="net-chat-input"
          type="text"
          maxLength={200}
          placeholder={strings.value.net.chatPlaceholder}
          value={text}
          onInput={e => setText((e.currentTarget as HTMLInputElement).value)}
          // Esc drops focus back to the game without sending.
          onKeyDown={e => {
            if (e.key === 'Escape') inputRef.current?.blur();
          }}
        />
      </form>
    </div>
  );
}
