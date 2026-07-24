/**
 * Customize Players — the roster (name / tank model / colour) reaches the match, and
 * colour is the team identity: tanks sharing a colour are grouped onto one team,
 * distinct colours split into separate teams (free-for-all).
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController} from '../src/game/CGameController';
import {CTank, TEAM_COLORS} from '../src/core/CTank';
import {Roster} from '../src/core/CRoster';
import {roster, setColor, setName, MAX_PLAYERS} from '../src/ui/playersStore';
import {samplePalette} from '../src/ui/palette';

type Tanks = {m_tanks: CTank[]};

describe('Customize Players', () => {
  it('roster defaults: player 0 is "Player", colours are the distinct 16-palette', () => {
    expect(roster.value).toHaveLength(MAX_PLAYERS); // roster holds up to 16 players
    expect(roster.value[0].name).toBe('Player'); // player 1 is named "Player"
    expect(roster.value[0].color).toBe(TEAM_COLORS[0]); // player 1 defaults to the first palette colour
    expect(roster.value[1].color).toBe(TEAM_COLORS[1]); // player 2 defaults to a distinct colour
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
    const t = (gc as unknown as Tanks).m_tanks;

    expect(t[0].getName() === 'Red1' && t[2].getName() === 'Blue1').toBe(true); // tanks take their roster names
    expect(t[0].getColor() === '#ff0000' && t[2].getColor() === '#0000ff').toBe(true); // tanks take their roster colours
    expect(t[1].getTankType() === 'Green' && t[3].getTankType() === 'Standard').toBe(true); // tanks take their roster models

    // Team = colour group: the two reds share a team, the others differ.
    expect(t[0].getTeamId()).toBe(t[1].getTeamId()); // same colour → same team
    expect(t[0].getTeamId()).not.toBe(t[2].getTeamId()); // different colour → different team
    expect(new Set(t.map(x => x.getTeamId())).size).toBe(3); // three distinct colours → three teams
  });

  it('CPU opponents keep their Customize Players roster name (nameable, like the original)', () => {
    Roster.players = [
      {name: 'Ada', model: 'Standard', color: '#ff0000'},
      {name: 'Custom Foe A', model: 'Standard', color: '#00ff00'},
      {name: 'Custom Foe B', model: 'Standard', color: '#0000ff'},
    ];
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(1); // one human, two CPUs
    gc.startGame(3);
    const t = (gc as unknown as Tanks).m_tanks;

    expect(t[0].getName()).toBe('Ada'); // the human keeps their roster name
    // A CPU is just a slot beyond the human count — it uses its roster name too, so you can
    // name your bots in Customize Players (the old bot-pool override is gone).
    expect(t[1].getName()).toBe('Custom Foe A');
    expect(t[2].getName()).toBe('Custom Foe B');
  });

  it('an empty roster falls back to distinct per-player defaults (free-for-all)', () => {
    Roster.players = [];
    const gc = new CGameController(makeCanvas());
    gc.startGame(3);
    const t = (gc as unknown as Tanks).m_tanks;
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
