import { describe, expect, it } from 'vitest';
import { testEngine, place, ISLANDS } from './helper.js';
import { CommanderSystem } from '@cedh-lab/engine';

describe('commander rules', () => {
  it('commander tax is {2} per previous cast', () => {
    const e = testEngine([[...ISLANDS], [...ISLANDS]], 3);
    const sys = new CommanderSystem(e.game, e.mana, () => ({ generic: 2, colored: {} }));
    expect(sys.taxOf(0, 'cmd1')).toBe(0);
    e.game.players[0].commanderCasts['cmd1'] = 1;
    expect(sys.taxOf(0, 'cmd1')).toBe(2);
    e.game.players[0].commanderCasts['cmd1'] = 3;
    expect(sys.taxOf(0, 'cmd1')).toBe(6);
  });

  it('21 commander damage loses the game', () => {
    const e = testEngine([[...ISLANDS], [...ISLANDS]], 4);
    const cmd = e.game.makeObject('llanowar-elves', 0, 'battlefield', 'Kinnan');
    cmd.isCommander = true;
    e.game.dealCommanderDamage(cmd.id, 1, 21);
    expect(e.game.players[1].hasLost).toBe(true);
  });

  it('priority passes in APNAP turn order', async () => {
    const e = testEngine([[...ISLANDS], [...ISLANDS], [...ISLANDS], [...ISLANDS]], 6);
    await e.turns.enterPhase('precombatMain');
    e.priority.startRound();
    const order: number[] = [];
    let guard = 0;
    while (guard++ < 10) {
      const p = e.priority.currentPlayer();
      if (p === null) break;
      order.push(p);
      e.priority.pass(p);
    }
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('state-based actions: lethal damage destroys', async () => {
    const e = testEngine([[...ISLANDS, 'llanowar-elves'], [...ISLANDS]], 8);
    await e.turns.enterPhase('precombatMain');
    const elfId = await place(e, 0, 'llanowar-elves', 'battlefield');
    e.game.getObject(elfId).damageMarked = 1; // lethal for 1 toughness
    await e.checkSbas();
    expect(e.game.getObject(elfId).zone).toBe('graveyard');
  });
});
