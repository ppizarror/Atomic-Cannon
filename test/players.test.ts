/**
 * Customize Players — the roster (name / tank model / colour) reaches the match, and
 * colour is the team identity: tanks sharing a colour are grouped onto one team,
 * distinct colours split into separate teams (free-for-all).
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {priv} from './_internals';

import {CGameController} from '../src/game/CGameController';
import {TEAM_COLORS} from '../src/core/CTank';
import {Roster, ROSTER_HUMAN_SLOTS} from '../src/core/CRoster';
import {roster, setColor, setName, MAX_PLAYERS} from '../src/ui/playersStore';
import {samplePalette} from '../src/ui/palette';
import {strings} from '../src/i18n';

describe('Customize Players', () => {
  it('roster defaults: player 0 is "Player", colours are the distinct 16-palette', () => {
    expect(roster.value).toHaveLength(MAX_PLAYERS); // roster holds up to 16 players
    expect(roster.value[0].name).toBe('Player'); // player 1 is named "Player"
    expect(roster.value[0].color).toBe(TEAM_COLORS[0]); // player 1 defaults to the first palette colour
    expect(roster.value[1].color).toBe(TEAM_COLORS[1]); // player 2 defaults to a distinct colour
  });

  it('bot-pool slots (8+) default to the "…Bot" name pool, human slots to the human pool', () => {
    // The roster splits into a human pool (0..7) and a bot pool (8..15). Bot slots seed their
    // default names from botNames (AlphaBot, …), matching how the original names CPU opponents.
    expect(roster.value[1].name).toBe(strings.value.playerNames[0]); // human slot ← human pool
    expect(roster.value[ROSTER_HUMAN_SLOTS].name).toBe(strings.value.botNames[0]); // 1st bot ← 'AlphaBot'
    expect(roster.value[ROSTER_HUMAN_SLOTS + 1].name).toBe(strings.value.botNames[1]); // 2nd bot
  });

  it('edits update (and would persist) the roster', () => {
    setName(0, 'Ada');
    setColor(1, '#123456');
    expect(roster.value[0].name).toBe('Ada'); // name edit applies
    expect(roster.value[1].color).toBe('#123456'); // colour edit applies
  });

  it('the roster reaches the match and colour groups tanks into teams', () => {
    // The roster reaches the match: tanks take their name / colour / model.
    Roster.players = [
      {name: 'Red1', model: 'MA1', color: '#ff0000'},
      {name: 'Red2', model: 'Green', color: '#ff0000'},
      {name: 'Blue1', model: 'MSPO', color: '#0000ff'},
      {name: 'Green1', model: 'Standard', color: '#00ff00'},
    ];
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(4); // all four are human, so every tank takes its roster name
    gc.startGame(4);
    const t = priv(gc).m_tanks;

    expect(t[0].getName() === 'Red1' && t[2].getName() === 'Blue1').toBe(true); // tanks take their roster names
    expect(t[0].getColor() === '#ff0000' && t[2].getColor() === '#0000ff').toBe(true); // tanks take their roster colours
    expect(t[1].getTankType() === 'Green' && t[3].getTankType() === 'Standard').toBe(true); // tanks take their roster models

    // Team = colour group: the two reds share a team, the others differ.
    expect(t[0].getTeamId()).toBe(t[1].getTeamId()); // same colour → same team
    expect(t[0].getTeamId()).not.toBe(t[2].getTeamId()); // different colour → different team
    expect(new Set(t.map(x => x.getTeamId())).size).toBe(3); // three distinct colours → three teams
  });

  it('CPU opponents draw from the BOT pool (roster slots 8+) and keep those names', () => {
    // Roster layout: slots 0..7 are the human pool, slots 8..15 the bot pool. A match with
    // 1 human + 2 CPUs draws the human from slot 0 and the two bots from slots 8 and 9 — so
    // you name your bots in the Customize Players "Bot" section, and face exactly those.
    const players = Array.from({length: 16}, (_, i) => ({
      name: `Filler ${i}`,
      model: 'Standard',
      color: TEAM_COLORS[i],
    }));
    players[0] = {name: 'Ada', model: 'Standard', color: '#ff0000'};
    players[8] = {name: 'Custom Foe A', model: 'Standard', color: '#00ff00'};
    players[9] = {name: 'Custom Foe B', model: 'Standard', color: '#0000ff'};
    Roster.players = players;

    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(1); // one human, two CPUs
    gc.startGame(3);
    const t = priv(gc).m_tanks;

    expect(t[0].getName()).toBe('Ada'); // human ← slot 0
    expect(t[1].getName()).toBe('Custom Foe A'); // bot 1 ← slot 8
    expect(t[2].getName()).toBe('Custom Foe B'); // bot 2 ← slot 9
  });

  it('an empty roster falls back to distinct per-player defaults (free-for-all)', () => {
    Roster.players = [];
    const gc = new CGameController(makeCanvas());
    gc.startGame(3);
    const t = priv(gc).m_tanks;
    expect(new Set(t.map(x => x.getColor())).size).toBe(3); // fallback colours are distinct
    expect(new Set(t.map(x => x.getTeamId())).size).toBe(3); // fallback gives each its own team
  });

  it('the palette sampler maps fractional coords to the pixel colour under them', () => {
    // 2×1 image: left = red, right = blue.
    const data = {
      width: 2,
      height: 1,
      data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]),
    } as unknown as ImageData;
    expect(samplePalette(data, 0, 0)).toBe('#ff0000'); // samples the left pixel at fx=0
    expect(samplePalette(data, 1, 0)).toBe('#0000ff'); // samples the right pixel at fx=1
    expect(samplePalette(data, 2, 5)).toBe('#0000ff'); // clamps out-of-range coords
  });
});
