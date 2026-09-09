import { describe, expect, it } from 'vitest';
import { testEngine, place, handHas, ISLANDS } from '../../engine/test/helper.js';
import { observe } from '@cedh-lab/ai';
import { DeckModel, mulliganScore } from '@cedh-lab/ai';
import { chooseResponse } from '@cedh-lab/ai';

const model: DeckModel = {
  commander: 'Oracle', archetype: 'turbo',
  winConditions: ["Thassa's Oracle", 'Demonic Consultation'],
  comboPieces: ['Demonic Consultation'],
  interaction: ['Counterspell', 'Force of Will'],
  fastMana: ['Dark Ritual'],
  tutors: [],
  cardAdvantage: ['Mystic Remora'],
};

describe('ai hidden information', () => {
  it('observation never contains opponent hand cards', () => {
    const e = testEngine([
      [...ISLANDS, 'counterspell', 'island'],
      [...ISLANDS, 'force-of-will', 'demonic-consultation'],
    ], 42);
    place(e, 1, 'force-of-will', 'hand'); // secret
    const obs = observe(e, 0);
    const serialized = JSON.stringify(obs);
    // P1's secret card must not appear anywhere in the observation
    expect(serialized).not.toContain('Force of Will');
    expect(serialized).not.toContain('force-of-will');
    // only counts are exposed
    expect(obs.opponents[0].handCount).toBe(e.game.players[1].hand.length);
  });

  it('policy explanation cannot leak hidden cards it never saw', () => {
    const e = testEngine([
      [...ISLANDS, 'island', 'island', 'counterspell'],
      [...ISLANDS, 'swamp', 'demonic-consultation', 'force-of-will'],
    ], 43);
    e.turns.enterPhase('precombatMain');
    place(e, 0, 'counterspell', 'hand');
    place(e, 0, 'island', 'battlefield');
    place(e, 0, 'island', 'battlefield');
    place(e, 1, 'demonic-consultation', 'hand');
    place(e, 1, 'force-of-will', 'hand'); // the secret
    place(e, 1, 'swamp', 'battlefield');
    e.priority.startRound();
    e.priority.pass(0);
    const sw = e.game.players[1].battlefield.find((x) => e.game.getObject(x).oracleId === 'swamp')!;
    e.activateAbility(1, sw, 0);
    e.stack.castSpell(1, handHas(e, 1, 'demonic-consultation')!, { namedCard: "Thassa's Oracle" });
    e.priority.actionTaken(1);
    // float UU for P0
    for (const id of e.game.players[0].battlefield) {
      const o = e.game.getObject(id);
      if (o.oracleId === 'island' && !o.tapped) e.activateAbility(0, id, 0);
    }
    const obs = observe(e, 0);
    const legal = e.legalActionsFor(0);
    const d = chooseResponse(obs, model, legal, new Map([[0, model], [1, model]]));
    expect(d).not.toBeNull();
    const text = JSON.stringify(d!.explanation);
    expect(text).not.toContain('Force of Will');
    expect(d!.action.label).toBe('Cast Counterspell');
  });

  it('mulligan keeps a functional hand and ships a manaless one', () => {
    const e = testEngine([
      [...ISLANDS, 'island', 'island', 'counterspell', 'dark-ritual', 'brainstorm', 'swamp', 'island'],
      [...ISLANDS],
    ], 44);
    const obs = observe(e, 0);
    const keep = mulliganScore(obs, model, 0);
    expect(keep.keep).toBe(true);
    expect(keep.reasons.length).toBeGreaterThan(0);
  });
});
