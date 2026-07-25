/**
 * Localised UI copy. Everything the interface shows in prose lives in a per-locale
 * `Strings` table so adding a language is a matter of dropping in one more table —
 * no strings are hard-coded at the call sites. Long-form copy (the About screen) is
 * stored as flowing paragraphs and wrapped to the panel width at draw time (see
 * wrapText), so a translation of any length re-flows correctly without hand-tuned
 * line breaks.
 *
 * Runtime substitution: any `{token}` in a string is filled by `fmt(str, {token: v})`
 * (see index.ts). Game data that doubles as an engine key (weapon ids, weapon type
 * discriminants, tank model / asset names) is NOT stored here — only the text the
 * player reads. Weapon display names/descriptions live in `weapons`, keyed by the
 * stable weapon id from data/weapons.json; weapon category labels live in `weaponTypes`.
 */

import type {ActionId} from '../core/CControls';

/** One block of the About screen: an optional heading, flowing body paragraphs, and
 *  an optional bullet list. Each paragraph / bullet is a single flowing string. */
export interface AboutSection {
  heading?: string;
  body?: string[];
  bullets?: string[];
}

/** A single option row's copy: its label, its hover tooltip, and — for enum rows —
 *  the cycle-through value labels (index-aligned with the catalog's `scale` table). */
export interface RowCopy {
  label: string;
  tip: string;
  options?: readonly string[];
}

/** A menu/category entry: the button label and its bottom-of-screen hover subtitle. */
export interface EntryCopy {
  label: string;
  sub: string;
}

/** One help-screen control: its name and one-line description. */
export interface HelpItem {
  name: string;
  desc: string;
}

/** A weapon's player-facing text, keyed by weapon id. `desc` is optional — a weapon
 *  with no depot description falls back to `depot.noDescription`. */
export interface WeaponCopy {
  name: string;
  desc?: string;
}

export interface Strings {
  // ── Shared atoms ──────────────────────────────────────────────────────────
  common: {
    /** Toggle-row value when enabled. */
    on: string;
    /** Toggle-row value when disabled. */
    off: string;
  };

  // ── Main menu ─────────────────────────────────────────────────────────────
  menu: {
    play: string;
    quickPlay: string;
    network: string;
    settings: string;
    manual: string;
    about: string;
    highScores: string;
    /** Corner link to the project's source repository. */
    repoLabel: string;
  };

  // ── Network / multiplayer ─────────────────────────────────────────────────
  net: {
    title: string;
    create: string;
    join: string;
    back: string;
    leave: string;
    nameLabel: string;
    codeLabel: string;
    codePlaceholder: string;
    creating: string;
    /** Above the room code on the host's lobby. */
    shareHint: string;
    copy: string;
    copied: string;
    lobbyTitle: string;
    you: string;
    host: string;
    ready: string;
    notReady: string;
    start: string;
    waitingHost: string;
    windOpts: {calm: string; normal: string; strong: string};
    /** The read-only "match settings" dialog shown in the lobby (host's config, for everyone). */
    matchInfo: {
      title: string;
      view: string; // lobby button that opens the dialog (joiner)
      edit: string; // lobby button that opens the dialog (host)
      close: string;
      done: string; // host's "apply/close" button
      hostNote: string; // "Set by the host" caption (joiner)
      editNote: string; // "these apply to everyone" caption (host)
      players: string; // max players
      tanks: string; // tanks per player (squad size)
      alternate: string; // interleave team turns
      battles: string; // war length (Deathmatch)
      mapSize: string;
      wind: string;
      health: string;
      tankSize: string;
      explosion: string;
      recoil: string;
      bury: string;
      relTurrets: string;
      utilTurn: string;
      crates: string;
      credits: string;
      gameType: string;
      rounds: string;
      deathmatch: string;
    };
    /** fmt: {n} connected of {min} required. */
    needPlayers: string;
    /** Fallback display name when a player/chat sender's real name isn't known — `{n}` is their id. */
    playerNum: string;
    /** Connection status pills. */
    status: {connecting: string; open: string; reconnecting: string; closed: string};
    errorTitle: string;
    retry: string;
    /** Client-side failure messages shown in the network error screen. */
    errCreateRoom: string;
    errBadCode: string;
    /** In-battle banners. `{name}` / `{n}` substituted. */
    ownReconnecting: string;
    playerDropped: string;
    playersDropped: string;
    endMatch: string;
    /** Placeholder in the in-match chat input. */
    chatPlaceholder: string;
    /** In-battle banner when a lockstep divergence (cheat/desync) is detected. */
    desyncWarning: string;
    /** In-battle pill shown to a mid-match spectator. */
    spectating: string;
  };

  // ── About card ────────────────────────────────────────────────────────────
  about: {
    title: string;
    subtitle: string;
    /** The credits / story document, top to bottom. */
    sections: AboutSection[];
    back: string;
    /** Global play-stats panel (counters + games-per-country). `byCountry` takes `{n}`. */
    stats: {
      title: string;
      unavailable: string;
      games: string;
      onlineGames: string;
      tanksDestroyed: string;
      weaponsFired: string;
      shotsFired: string;
      damageDealt: string;
      nukesFired: string;
      terrainCarved: string;
      creditsSpent: string;
      playTime: string;
      longestGame: string;
      byCountry: string;
      mapEmpty: string;
    };
  };

  // ── Manual / How-to-play card (main-menu help document) ────────────────────
  manual: {
    title: string;
    subtitle: string;
    /** The manual document (gameplay / controls / weapons / tips), top to bottom.
     *  Reuses the About section shape and the same bitmap-font card chrome. */
    sections: AboutSection[];
    back: string;
  };

  // ── Battle Heroes / High Scores ───────────────────────────────────────────
  heroes: {
    title: string;
    callsign: string;
    /** Right column header for Points/Rounds games. */
    score: string;
    /** Right column header for Deathmatch games. */
    kills: string;
    empty: string;
    /** Footer tally; `{won}` / `{lost}` are substituted. */
    record: string;
    prompt: string;
  };

  // ── Global overlays (App root) ────────────────────────────────────────────
  app: {
    /** FPS overlay — `{n}` is the frame rate. */
    fps: string;
    /** Frame-count overlay — `{n}` is the frame counter. */
    frame: string;
    /** Flight fuel HUD — `{s}` seconds remaining. */
    jetFuel: string;
    flyHint: string;
    tooSmallTitle: string;
    tooSmallLead: string;
    /** `{w}` x `{h}` minimum. */
    tooSmallSize: string;
    tooSmallEnlarge: string;
    /** `{w}` x `{h}` current. */
    tooSmallCurrent: string;
    /** Loading screen caption shown while a match's textures load (animated dots are appended). */
    loading: string;
  };

  // ── Pause menu ────────────────────────────────────────────────────────────
  pause: {
    title: string;
    resume: string;
    settings: string;
    quit: string;
  };

  // ── Help overlay (battle controls) ────────────────────────────────────────
  help: {
    title: string;
    subtitle: string;
    close: string;
    controls: {
      selectWeapon: HelpItem;
      power: HelpItem;
      angle: HelpItem;
      fire: HelpItem;
      clickAim: HelpItem;
      reset: HelpItem;
      buy: HelpItem;
      menu: HelpItem;
      wind: HelpItem;
      shotTimer: HelpItem;
    };
  };

  // ── Battle HUD ────────────────────────────────────────────────────────────
  hud: {
    powerTitle: string;
    fire: string;
    aimTitle: string;
    windOff: string;
    // Hotspot tooltips
    prevWeapon: string;
    nextWeapon: string;
    powerUp: string;
    powerDown: string;
    depot: string;
    resetShot: string;
    help: string;
    aimLeft: string;
    aimRight: string;
    menu: string;
    // Cluster panel labels
    selectWeapon: string;
    power: string;
    angle: string;
    wind: string;
    // Side LCD — weapon details (labels precede a value at the call site)
    weaponDetails: string;
    lcd: {
      type: string;
      power: string;
      damage: string;
      radius: string;
      variance: string;
      fodder: string;
      dmgPerArea: string;
      earth: string;
      spawn: string;
      cluster: string;
      succession: string;
      battery: string;
      radiation: string;
    };
    // Side LCD — player stats
    stat: {
      team: string;
      life: string;
      shield: string;
      armor: string;
      hazmat: string;
      credits: string;
      position: string;
    };
    windMeasurements: string;
    vel: string;
    acc: string;
    canMove: string;
    cantMove: string;
    underground: string;
  };

  // ── Weapons Depot ─────────────────────────────────────────────────────────
  depot: {
    title: string;
    subtitle: string;
    noDescription: string;
    col: {
      qty: string;
      name: string;
      type: string;
      power: string;
      cost: string;
    };
    clickToClose: string;
    /** Footer credits readout — `{n}` credits. */
    credits: string;
    buy: string;
    sell: string;
    autoBuy: string;
    stats: string;
    close: string;
    stat: {
      type: string;
      damage: string;
      radius: string;
      dmgArea: string;
      variance: string;
      fodder: string;
      cluster: string;
      cost: string;
      owned: string;
    };
  };

  // ── Play setup screen ─────────────────────────────────────────────────────
  play: {
    /** Guard message — `{min}` minimum players. */
    needPlayers: string;
    humans: RowCopy;
    computers: RowCopy;
    tanks: RowCopy;
    gameType: RowCopy;
    battles: RowCopy;
    rounds: RowCopy;
    landSize: RowCopy;
    difficulty: RowCopy;
    wind: RowCopy;
    startHint: string;
    startGame: string;
    cancelHint: string;
    cancel: string;
    ready: string;
  };

  // ── Settings ──────────────────────────────────────────────────────────────
  settings: {
    /** Root category list — label + hover subtitle each. */
    categories: {
      economy: EntryCopy;
      tank: EntryCopy;
      gameplay: EntryCopy;
      graphics: EntryCopy;
      audio: EntryCopy;
      content: EntryCopy;
      controls: EntryCopy;
      players: EntryCopy;
      taunts: EntryCopy;
      importExport: EntryCopy;
    };
    done: string;
    doneSubGame: string;
    doneSubMenu: string;
    pageDone: string;
    pageDoneSub: string;
    /** Percent formatter suffix for stepper values — `{n}%`. */
    percent: string;
    /** Auto-pagination nav row appended when a page overflows the per-page option cap. */
    nextPage: RowCopy;

    economy: {
      header: string;
      buyTime: RowCopy;
      creditStart: RowCopy;
      creditRound: RowCopy;
      creditTurn: RowCopy;
      creditKill: RowCopy;
      creditDamage: RowCopy;
      sellBack: RowCopy;
    };
    tank: {
      header: string;
      kickback: RowCopy;
      size: RowCopy;
      relTurrets: RowCopy;
      bury: RowCopy;
      powerScale: RowCopy;
      hitpoints: RowCopy;
      chatter: RowCopy;
      colorize: RowCopy;
    };
    gameplay: {
      header: string;
      battles: RowCopy;
      rounds: RowCopy;
      difficulty: RowCopy;
      wind: RowCopy;
      changeWind: RowCopy;
      windModel: RowCopy;
      explosionSize: RowCopy;
      variance: RowCopy;
      utilTurn: RowCopy;
      randTurns: RowCopy;
      altTurns: RowCopy;
      crates: RowCopy;
      updateScale: RowCopy;
      rcFires: RowCopy;
      radiation: RowCopy;
    };
    graphics: {
      header: string;
      fullScreen: RowCopy;
      language: RowCopy;
      tracking: RowCopy;
      smoke: RowCopy;
      detail: RowCopy;
      craterFill: RowCopy;
      highContrast: RowCopy;
      landType: RowCopy;
      aiStats: RowCopy;
      teamColor: RowCopy;
      smallBuy: RowCopy;
      showTurn: RowCopy;
      blastCircles: RowCopy;
      showPoints: RowCopy;
      showPower: RowCopy;
      tankStats: RowCopy;
      autoScroll: RowCopy;
      camera: RowCopy;
      lastAim: RowCopy;
      expWaves: RowCopy;
      camShake: RowCopy;
      explodeLosers: RowCopy;
      framerate: RowCopy;
      fpsCap: RowCopy;
      demo: RowCopy;
      ambientLight: RowCopy;
    };
    audio: {
      header: string;
      sound: RowCopy;
      music: RowCopy;
      soundVol: RowCopy;
      musicVol: RowCopy;
      stereo: RowCopy;
      /** Non-legacy menu navigation blips (hover / forward / back). Opt-in, OFF by default. */
      menuSounds: RowCopy;
    };
    content: {
      header: string;
      weapons: RowCopy;
      landscapes: RowCopy;
    };
  };

  // ── Editor sub-screens ────────────────────────────────────────────────────
  editors: {
    controls: {
      title: string;
      /** Armed prompt — `{action}` is being rebound. */
      promptDefine: string;
      promptUnassign: string;
      idle: string;
      customize: string;
      defaults: string;
      done: string;
      colAction: string;
      colButton: string;
      pressKey: string;
      /** Shown in the Button column when an action has no key bound. */
      unassigned: string;
      /** Player-facing action names, keyed by the core ActionId (core holds no copy). */
      actions: Record<ActionId, string>;
    };
    players: {
      color: string;
      palette: string;
      title: string;
      footer: string;
      done: string;
      /** `{n}` is the 1-based number within the pool (human pool or bot pool). */
      playerName: string;
      botName: string;
      /** Slot-type badges — whether this roster slot is in the human pool or the bot pool. */
      human: string;
      computer: string;
    };
    taunts: {
      title: string;
      add: string;
      reset: string;
      done: string;
      /** Line count — `{n}` lines. */
      lineOne: string;
      lineMany: string;
      emptyPlaceholder: string;
      deleteLine: string;
      empty: string;
      categories: {
        taunt: EntryCopy;
        postFire: EntryCopy;
        death: EntryCopy;
      };
    };
    importExport: {
      title: string;
      /** One-line description of the screen, shown in the body panel. */
      intro: string;
      /** Body rows describing each action. */
      importDesc: string;
      exportDesc: string;
      resetDesc: string;
      /** Action buttons. */
      import: string;
      export: string;
      reset: string;
      done: string;
      /** Footer hint shown when idle. */
      idle: string;
      /** Status after a successful import — `{n}` is the number of setting groups restored. */
      imported: string;
      /** Status when the chosen file isn't a valid backup. */
      importFailed: string;
      /** Reset confirmation dialog. */
      confirmTitle: string;
      confirmBody: string;
      confirmYes: string;
      confirmNo: string;
    };
    enableList: {
      /** Row state when the item is on. */
      enabled: string;
      /** Row state when the item is off. */
      disabled: string;
      /** Pagination — `{page}` of `{pages}`. */
      pagination: string;
      prev: string;
      next: string;
      exit: string;
      weaponsTitle: string;
      weaponsFooter: string;
      landscapesTitle: string;
      landscapesFooter: string;
    };
  };

  // ── War standings / battle-end overlay ────────────────────────────────────
  warStandings: {
    name: string;
    points: string;
    kills: string;
    deaths: string;
    life: string;
    accuracy: string;
    damageHit: string;
    /** `{name}` wins the battle. */
    winsBattle: string;
    /** `{name}` wins the war. */
    winsWar: string;
    /** `{name}` is winning the war. */
    winningWar: string;
    notOver: string;
    /** Battle `{n}` of `{total}` completed. */
    battleCompleted: string;
    allDead: string;
    /** Rounds/Points: every team finished on equal points. */
    draw: string;
    victory: string;
    defeat: string;
    winConditionKills: string;
    exitPrompt: string;
    nextPrompt: string;
  };

  // ── In-game generated text ────────────────────────────────────────────────
  game: {
    /** Default human player name. */
    defaultPlayer: string;
    /** Themed map names by dominant weather (depot footer). */
    mapNames: {snow: string; dust: string; rain: string; hail: string; default: string};
    /** Team member suffix — `{name} {n}`. */
    teamMember: string;
    /** Crate pickup — `{n}` credits. */
    foundCredits: string;
    /** Crate pickup — `{n}` health. */
    gainedHealth: string;
    /** Crate pickup — `{weapon}` found. */
    foundWeapon: string;
    /** Speech bubble — `{name}: {line}`. */
    bubble: string;
    /** Fallback name for an unnamed sentry tank. */
    sentry: string;
    /** Wargame Detail preset: every CPU is renamed to this (the WarGames "WOPR"). */
    whopper: string;
    /** Hint chip shown over the move band while placing a Move (click-to-move). */
    moveHint: string;
    /** Placeholder rendered on a tank badge with no name. */
    noName: string;
    /** On-canvas tank badge stats. */
    tankTeam: string;
    tankLife: string;
    tankArmor: string;
    tankShield: string;
    tankCredits: string;
    /** Per-tank battle-status line — `{name}: {pct}% life`. */
    statusLife: string;
    /** Battle/shot status line — Battle `{battle}` of `{total}` - Shot `{shot}`. */
    statusBattle: string;
    /** Rounds/Points status line — Round `{round}` of `{total}`. */
    statusRound: string;
    /** Top-left status hint shown while the acting tank is buried (Bury Tanks). */
    cantMoveUnderground: string;
  };

  /** Default human-player names — the roster prefill pool (cycled past the list). A
   *  separate pool from the bot names. */
  playerNames: readonly string[];

  /** Computer-opponent names — the "…Bot" pool assigned to CPU players; seeds the roster's
   *  bot-pool slot defaults, distinct from the human name pool. */
  botNames: readonly string[];

  /** Default taunt content, editable in the Taunt editor and spoken in-game. */
  taunts: {
    death: readonly string[];
    postFire: readonly string[];
    taunt: readonly string[];
  };

  /** Weapon category display labels, keyed by the weapon `type` discriminant. */
  weaponTypes: Record<string, string>;

  /** Weapon display names + descriptions, keyed by weapon id (data/weapons.json). */
  weapons: Record<string, WeaponCopy>;
}

/** Metadata for a shipped locale: its code and the name shown in the picker
 *  (in the language's own words). */
export interface LocaleInfo {
  code: LocaleCode;
  /** Endonym — the language's name in itself (e.g. "English", "Español"). */
  name: string;
}

/** Codes of the locales that ship with the game. Extend as tables are added. */
export type LocaleCode = 'en' | 'es';
