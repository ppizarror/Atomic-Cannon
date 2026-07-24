/**
 * Network screen — Create / Join a room by code, then a lobby. Renders from the
 * `netState` signal: entry (create or join), a connecting state, the lobby
 * (roster + ready + host Start), an error card, and a placeholder while a match
 * starts (networked gameplay arrives in a later phase).
 */
import {useState} from 'preact/hooks';
import {strings, fmt} from '../i18n';
import {BmpText} from './BmpText';
import {goToMenu, uiMenuBack} from './store';
import {formatRoomCode, formatCodeInput} from '../net/roomCode';
import {
  netState,
  playerName,
  setPlayerName,
  createRoom,
  joinRoom,
  setReady,
  startMatch,
  updateSettings,
  leaveRoom,
  resetNet,
} from './networkStore';

function BigButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button class="settings-row srow-done menu-btn" disabled={disabled} onClick={onClick}>
      <BmpText font="bazouk-28" text={label} />
    </button>
  );
}

function toMenu(): void {
  resetNet();
  goToMenu();
  uiMenuBack(); // match the other screens' "back to menu" whirr
}

function Entry() {
  const n = strings.value.net;
  const [code, setCode] = useState('');
  return (
    <div class="net-panel">
      <BmpText font="bazouk-28" text={n.title} />

      <div class="net-field">
        <BmpText font="beijing-16-out" text={n.nameLabel} spacing={-1} />
        <input
          class="net-input"
          type="text"
          maxLength={24}
          value={playerName.value}
          onInput={e => setPlayerName((e.currentTarget as HTMLInputElement).value)}
        />
      </div>

      <BigButton label={n.create} onClick={createRoom} />

      <div class="net-divider" />

      <div class="net-field">
        <BmpText font="beijing-16-out" text={n.codeLabel} spacing={-1} />
        <input
          class="net-input net-code"
          type="text"
          maxLength={7}
          placeholder={n.codePlaceholder}
          value={code}
          onInput={e => {
            const it = (e as InputEvent).inputType;
            const paste = it === 'insertFromPaste' || it === 'insertFromDrop';
            setCode(formatCodeInput((e.currentTarget as HTMLInputElement).value, paste));
          }}
        />
      </div>
      <BigButton label={n.join} onClick={() => joinRoom(code)} disabled={!code.trim()} />

      <div class="net-divider" />
      <BigButton label={n.back} onClick={toMenu} />
    </div>
  );
}

function Connecting() {
  const n = strings.value.net;
  const s = netState.value;
  const label = s.code ? n.status.connecting : n.creating;
  return (
    <div class="net-panel">
      <BmpText font="bazouk-28" text={n.title} />
      <BmpText font="beijing-16-out" text={label} spacing={-1} />
      <BigButton label={n.back} onClick={toMenu} />
    </div>
  );
}

function StatusPill() {
  const n = strings.value.net;
  const st = netState.value.status;
  const text =
    st === 'open'
      ? n.status.open
      : st === 'reconnecting'
        ? n.status.reconnecting
        : st === 'closed'
          ? n.status.closed
          : n.status.connecting;
  return (
    <div class="net-status">
      <BmpText font="beijing-16-out" text={text} spacing={-1} />
    </div>
  );
}

function CodeDisplay({code}: {code: string}) {
  const n = strings.value.net;
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(formatRoomCode(code)).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <>
      <BmpText font="beijing-16-out" text={n.shareHint} spacing={-1} />
      <div class="net-code-display">
        <span class="net-code-value">{formatRoomCode(code)}</span>
        <button class="btn" onClick={copy}>
          <BmpText font="msans-14" text={copied ? n.copied : n.copy} />
        </button>
      </div>
    </>
  );
}

/**
 * Host-only match settings shown in the lobby: wind strength and map size. Both broadcast
 * to every client and are captured at Start so the world is identical (and deterministic)
 * on all machines. Non-hosts see the same values read-only via the roster/summary.
 */
function MatchSettings() {
  const n = strings.value.net;
  const s = netState.value;
  if (!s.isHost) return null;
  const windLabels = [n.windOpts.calm, n.windOpts.normal, n.windOpts.strong];

  return (
    <div class="net-settings">
      <div class="net-set-title">
        <BmpText font="beijing-16-out" text={n.matchSettings} spacing={-1} />
      </div>

      <div class="net-set-row">
        <span class="net-set-label">
          <BmpText font="beijing-16-out" text={n.windLabel} spacing={-1} />
        </span>
        <div class="net-seg">
          {windLabels.map((label, i) => (
            <button
              key={i}
              class={`net-seg-btn ${s.settings.wind === i ? 'net-seg-on' : ''}`}
              onClick={() => updateSettings({wind: i})}
            >
              <BmpText font="beijing-16-out" text={label} spacing={-1} />
            </button>
          ))}
        </div>
      </div>

      <div class="net-set-row">
        <span class="net-set-label">
          <BmpText font="beijing-16-out" text={n.mapSizeLabel} spacing={-1} />
        </span>
        <div class="net-seg">
          {[1, 2, 3, 4, 5].map(size => (
            <button
              key={size}
              class={`net-seg-btn ${s.settings.mapSize === size ? 'net-seg-on' : ''}`}
              onClick={() => updateSettings({mapSize: size})}
            >
              <BmpText font="beijing-16-out" text={String(size)} spacing={-1} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Lobby() {
  const n = strings.value.net;
  const s = netState.value;
  const you = s.players.find(p => p.id === s.youId);
  const connected = s.players.filter(p => p.connected).length;
  const canStart = s.isHost && connected >= s.settings.minPlayers;

  return (
    <div class="net-panel">
      <BmpText font="bazouk-28" text={n.lobbyTitle} />
      <StatusPill />
      <CodeDisplay code={s.code} />

      <div class="net-roster">
        {s.players.map(p => (
          <div key={p.id} class={`net-row ${p.id === s.youId ? 'net-you' : ''}`}>
            <span
              class="net-swatch"
              style={{background: p.color, opacity: p.connected ? 1 : 0.4}}
            />
            <span class="net-row-name">
              <BmpText font="beijing-16-out" text={p.name} spacing={-1} />
            </span>
            {p.isHost && (
              <span class="net-tag">
                <BmpText font="beijing-16-out" text={n.host} spacing={-1} />
              </span>
            )}
            {p.id === s.youId && (
              <span class="net-tag">
                <BmpText font="beijing-16-out" text={n.you} spacing={-1} />
              </span>
            )}
            <span class={`net-ready ${p.ready ? '' : 'net-notready'}`}>
              <BmpText font="beijing-16-out" text={p.ready ? n.ready : n.notReady} spacing={-1} />
            </span>
          </div>
        ))}
      </div>

      <MatchSettings />

      <button class="settings-row srow-done menu-btn" onClick={() => setReady(!you?.ready)}>
        <BmpText font="bazouk-28" text={you?.ready ? n.notReady : n.ready} />
      </button>

      {s.isHost ? (
        <BigButton label={n.start} onClick={startMatch} disabled={!canStart} />
      ) : (
        <BmpText font="beijing-16-out" text={n.waitingHost} spacing={-1} />
      )}

      {!canStart && s.isHost && (
        <div class="net-status">
          <BmpText
            font="beijing-16-out"
            text={fmt(n.needPlayers, {n: connected, min: s.settings.minPlayers})}
            spacing={-1}
          />
        </div>
      )}

      <div class="net-divider" />
      <BigButton label={n.leave} onClick={leaveRoom} />
    </div>
  );
}

function Playing() {
  const n = strings.value.net;
  return (
    <div class="net-panel">
      <BmpText font="bazouk-28" text={n.lobbyTitle} />
      <BmpText font="beijing-16-out" text={n.status.open} spacing={-1} />
      <BigButton label={n.leave} onClick={leaveRoom} />
    </div>
  );
}

function ErrorCard() {
  const n = strings.value.net;
  const err = netState.value.lastError;
  return (
    <div class="net-panel">
      <BmpText font="bazouk-28" text={n.errorTitle} />
      {err && <BmpText font="beijing-16-out" text={err.message} spacing={-1} />}
      <BigButton label={n.retry} onClick={toMenu} />
    </div>
  );
}

function Inner() {
  switch (netState.value.phase) {
    case 'connecting':
      return <Connecting />;
    case 'lobby':
      return <Lobby />;
    case 'playing':
      return <Playing />;
    case 'error':
      return <ErrorCard />;
    case 'idle':
    case 'closed':
    default:
      return <Entry />;
  }
}

export function Network() {
  return (
    <div class="net-screen">
      <Inner />
    </div>
  );
}
