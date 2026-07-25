/**
 * Network screen — Create / Join a room by code, then a lobby. Renders from the
 * `netState` signal: entry (create or join), a connecting state, the lobby
 * (roster + ready + host Start), an error card, and a placeholder while a match
 * starts (networked gameplay arrives in a later phase).
 */
import {useState} from 'preact/hooks';
import {strings, fmt} from '../i18n';
import {BmpText} from './BmpText';
import {BigButton} from './BigButton';
import {Modal} from './Modal';
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
  updateMatchConfig,
  leaveRoom,
  resetNet,
} from './networkStore';

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

// Format a physics scalar as a multiplier, e.g. 1 → "1x", 1.35 → "1.35x". Uses ASCII "x"
// (the bitmap font has no "×" glyph) and trims float noise to at most 2 decimals.
function mult(n: number): string {
  return `${Math.round(n * 100) / 100}x`;
}

/**
 * One settings row: a label and a set of choices. For the HOST it renders a segmented picker
 * (click to change → broadcast); for everyone else it renders just the selected value, so the
 * exact same dialog doubles as the host's editor and the joiners' read-only view.
 */
function SegField<T extends number | boolean>({
  label,
  value,
  options,
  onPick,
  editable,
}: {
  label: string;
  value: T;
  options: {label: string; val: T}[];
  onPick: (v: T) => void;
  editable: boolean;
}) {
  const selected = options.find(o => o.val === value);
  return (
    <div class="net-set-row">
      <span class="net-set-label">
        <BmpText font="beijing-16-out" text={label} spacing={-1} />
      </span>
      {editable ? (
        <div class="net-seg">
          {options.map((o, i) => (
            <button
              key={i}
              class={`net-seg-btn ${o.val === value ? 'net-seg-on' : ''}`}
              onClick={() => onPick(o.val)}
            >
              <BmpText font="beijing-16-out" text={o.label} spacing={-1} />
            </button>
          ))}
        </div>
      ) : (
        <span class="net-info-v">
          <BmpText font="beijing-16-out" text={selected?.label ?? String(value)} spacing={-1} />
        </span>
      )}
    </div>
  );
}

// Numeric choice presets → segmented options, labelled by `fmt` (defaults to the raw number).
function numOpts(
  vals: number[],
  fmt: (v: number) => string = String,
): {label: string; val: number}[] {
  return vals.map(v => ({label: fmt(v), val: v}));
}

/**
 * The lobby "Match Settings" dialog — the host EDITS every match parameter here and it
 * broadcasts live to the whole room; joiners see the exact same dialog read-only. All of it is
 * applied identically on every client at Start (the deterministic MatchConfig pipeline), so
 * there's no way for two players to end up on different physics/rules.
 */
function MatchSettingsDialog({onClose}: {onClose: () => void}) {
  const n = strings.value.net;
  const mi = n.matchInfo;
  const c = strings.value.common;
  const s = netState.value;
  const host = s.isHost;
  const cfg = s.config;
  const onOff: {label: string; val: boolean}[] = [
    {label: c.on, val: true},
    {label: c.off, val: false},
  ];
  const windOpts = [
    {label: n.windOpts.calm, val: 0},
    {label: n.windOpts.normal, val: 1},
    {label: n.windOpts.strong, val: 2},
  ];
  const gameOpts = [
    {label: mi.rounds, val: 0},
    {label: mi.deathmatch, val: 1},
  ];

  return (
    <Modal onClose={onClose} width="min(500px, 94vw)" maxHeight="88vh" class="net-info-card">
      <div class="net-info-title">
        <BmpText font="bazouk-28" text={mi.title} />
      </div>
      <div class="net-info-note">
        <BmpText font="beijing-16-out" text={host ? mi.editNote : mi.hostNote} spacing={-1} />
      </div>

      <div class="net-info-rows">
        {/* Room-level (RoomSettings) — max players + wind + map size. */}
        <SegField
          label={mi.players}
          value={s.settings.maxPlayers}
          options={numOpts([2, 3, 4, 5, 6, 8])}
          onPick={v => updateSettings({maxPlayers: v})}
          editable={host}
        />
        <SegField
          label={mi.tanks}
          value={s.settings.tanksPerTeam}
          options={numOpts([1, 2, 3, 4])}
          onPick={v => updateSettings({tanksPerTeam: v})}
          editable={host}
        />
        {/* Interleave team turns — only meaningful with squads of 2+. */}
        {s.settings.tanksPerTeam > 1 && (
          <SegField
            label={mi.alternate}
            value={s.settings.alternateTurns}
            options={onOff}
            onPick={v => updateSettings({alternateTurns: v})}
            editable={host}
          />
        )}
        <SegField
          label={mi.wind}
          value={s.settings.wind}
          options={windOpts}
          onPick={v => updateSettings({wind: v})}
          editable={host}
        />
        <SegField
          label={mi.mapSize}
          value={s.settings.mapSize}
          options={numOpts([1, 2, 3, 4, 5])}
          onPick={v => updateSettings({mapSize: v})}
          editable={host}
        />

        {/* Gameplay (MatchConfig) — needs a published config to edit/show. */}
        {cfg && (
          <>
            <SegField
              label={mi.gameType}
              value={cfg.gameType}
              options={gameOpts}
              onPick={v => updateMatchConfig({gameType: v})}
              editable={host}
            />
            {/* War length applies to Deathmatch (Points/Rounds is a single battle). */}
            {cfg.gameType === 1 && (
              <SegField
                label={mi.battles}
                value={s.settings.battles}
                options={numOpts([1, 2, 3, 5])}
                onPick={v => updateSettings({battles: v})}
                editable={host}
              />
            )}
            <SegField
              label={mi.health}
              value={cfg.hitpoints}
              options={numOpts([500, 1000, 1500, 2000, 3000])}
              onPick={v => updateMatchConfig({hitpoints: v})}
              editable={host}
            />
            <SegField
              label={mi.credits}
              value={cfg.startCredits}
              options={numOpts([0, 1000, 3000, 5000, 10000])}
              onPick={v => updateMatchConfig({startCredits: v})}
              editable={host}
            />
            <SegField
              label={mi.explosion}
              value={cfg.explosionScale}
              options={numOpts([0.5, 1, 2, 4], mult)}
              onPick={v => updateMatchConfig({explosionScale: v})}
              editable={host}
            />
            <SegField
              label={mi.tankSize}
              value={cfg.tankSizeScale}
              options={numOpts([0.5, 1, 1.5, 2], mult)}
              onPick={v => updateMatchConfig({tankSizeScale: v})}
              editable={host}
            />
            <SegField
              label={mi.recoil}
              value={cfg.kickbackScale}
              options={numOpts([0, 1, 2], mult)}
              onPick={v => updateMatchConfig({kickbackScale: v})}
              editable={host}
            />
            <SegField
              label={mi.crates}
              value={cfg.crateChance}
              options={numOpts([0, 10, 20, 50], v => `${v}%`)}
              onPick={v => updateMatchConfig({crateChance: v})}
              editable={host}
            />
            <SegField
              label={mi.bury}
              value={cfg.buryTanks}
              options={onOff}
              onPick={v => updateMatchConfig({buryTanks: v})}
              editable={host}
            />
            <SegField
              label={mi.relTurrets}
              value={cfg.relativeTurrets}
              options={onOff}
              onPick={v => updateMatchConfig({relativeTurrets: v})}
              editable={host}
            />
            <SegField
              label={mi.utilTurn}
              value={cfg.utilityTurn}
              options={onOff}
              onPick={v => updateMatchConfig({utilityTurn: v})}
              editable={host}
            />
          </>
        )}
      </div>

      <BigButton label={host ? mi.done : mi.close} onClick={onClose} />
    </Modal>
  );
}

function Lobby() {
  const n = strings.value.net;
  const s = netState.value;
  const you = s.players.find(p => p.id === s.youId);
  const connected = s.players.filter(p => p.connected).length;
  const canStart = s.isHost && connected >= s.settings.minPlayers;
  const [showInfo, setShowInfo] = useState(false);

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

      <button class="net-info-btn" onClick={() => setShowInfo(true)}>
        <BmpText
          font="beijing-16-out"
          text={s.isHost ? n.matchInfo.edit : n.matchInfo.view}
          spacing={-1}
        />
      </button>
      {showInfo && <MatchSettingsDialog onClose={() => setShowInfo(false)} />}

      <BigButton label={you?.ready ? n.notReady : n.ready} onClick={() => setReady(!you?.ready)} />

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
