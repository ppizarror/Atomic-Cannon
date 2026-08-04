/**
 * Battle Heroes — the hall of fame is tied to the Customize Players SLOT, not to a frozen copy of
 * the callsign. Renaming Player → Pablo has to rename that player's past scores; a name that never
 * came from the roster (a network opponent, the Wargame "Whopper") must keep the callsign it was
 * set under, since there is no slot to follow.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController} from '../src/game/CGameController';
import {GameConfig, DETAIL} from '../src/core/CGameConfig';
import {Roster, ROSTER_HUMAN_SLOTS} from '../src/core/CRoster';
import {TEAM_COLORS} from '../src/core/CTank';
import {setName} from '../src/ui/playersStore';
import {heroData, heroName, submitBattleHeroes, type HeroEntry} from '../src/ui/highscoresStore';

/** A 16-slot roster with distinct colours, so every slot is its own team. */
function fillRoster(overrides: Record<number, string> = {}): void {
  Roster.players = Array.from({length: 16}, (_, i) => ({
    name: overrides[i] ?? `Filler ${i}`,
    model: 'Standard',
    color: TEAM_COLORS[i],
  }));
}

/** The board row carrying `value` (boards accumulate across tests, so never index blindly). */
const rowWith = (list: HeroEntry[], value: number): HeroEntry => list.find(e => e.value === value)!;

describe('Battle Heroes', () => {
  it('each team reports the roster slot its callsign came from', () => {
    fillRoster({0: 'Ada', [ROSTER_HUMAN_SLOTS]: 'Foe'});
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(1); // 1 human (slot 0) + 1 CPU (bot pool, slot 8)
    gc.startGame(2);

    const heroes = gc.getBattleHeroes();
    expect(heroes.map(h => h.name)).toEqual(['Ada', 'Foe']);
    expect(heroes.map(h => h.slot)).toEqual([0, ROSTER_HUMAN_SLOTS]); // human ← slot 0, CPU ← slot 8
  });

  it('the callsign is the PLAYER name, without the squad suffix its tanks carry', () => {
    fillRoster({0: 'Ada'});
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(1);
    gc.setTanksPerTeam(2); // squads: the tanks are named "Ada 1" / "Ada 2"
    gc.startGame(2);

    expect(gc.getBattleHeroes()[0].name).toBe('Ada'); // the board row is the player, not a tank
  });

  it('the Wargame "Whopper" override is NOT tied to a slot', () => {
    fillRoster({0: 'Ada', [ROSTER_HUMAN_SLOTS]: 'Foe'});
    const detail = GameConfig.detail;
    GameConfig.detail = DETAIL.WARGAME;
    try {
      const gc = new CGameController(makeCanvas());
      gc.setHumanCount(1);
      gc.startGame(2);
      const [human, cpu] = gc.getBattleHeroes();

      expect(human.slot).toBe(0); // the human still carries their own name, so still their slot
      expect(cpu.name).toBe('Whopper'); // the CPU is renamed by the preset...
      expect(cpu.slot).toBeUndefined(); // ...so it must not follow the roster slot's name
    } finally {
      GameConfig.detail = detail;
    }
  });

  it('renaming a player renames their past scores, keeping the old callsign as a fallback', () => {
    fillRoster({0: 'Player'});
    setName(0, 'Player');
    submitBattleHeroes([{name: 'Player', score: 4242, kills: 424, slot: 0}]);

    setName(0, 'Pablo');
    const score = rowWith(heroData.value.score, 4242);
    const kills = rowWith(heroData.value.kills, 424);

    expect(score.name).toBe('Player'); // the stored snapshot is untouched...
    expect(heroName(score)).toBe('Pablo'); // ...but the board shows the current name
    expect(heroName(kills)).toBe('Pablo'); // both boards follow the slot
  });

  it('a row with no slot keeps the callsign it was set under', () => {
    // How a network opponent lands on the board: their name came from the lobby, and this device's
    // slot 0 has nothing to do with them.
    setName(0, 'Pablo');
    submitBattleHeroes([{name: 'RemoteFoe', score: 3131, kills: 313}]);

    const row = rowWith(heroData.value.score, 3131);
    expect(row.slot).toBeUndefined();
    expect(heroName(row)).toBe('RemoteFoe'); // NOT renamed to the local roster's name
  });

  it('falls back to the stored callsign when the slot has been blanked', () => {
    setName(0, '   '); // the name field allows an empty value
    expect(heroName({name: 'Player', value: 1, slot: 0})).toBe('Player');
  });

  it('a legacy row saved before slots existed still resolves', () => {
    expect(heroName({name: 'Legacy', value: 7})).toBe('Legacy'); // no slot → the stored callsign
  });
});
