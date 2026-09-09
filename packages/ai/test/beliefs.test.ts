import { describe, expect, it } from 'vitest';
import { testEngine, place, ISLANDS } from '../../engine/test/helper.js';
import { BeliefTracker } from '@cedh-lab/ai';
import { DeckModel } from '@cedh-lab/ai';
import { observe } from '@cedh-lab/ai';
import { KnownCard } from '@cedh-lab/ai';

const model: DeckModel = {
  commander: 'Test', archetype: 'turbo',
  winConditions: ["Thassa's Oracle"], comboPieces: ['Demonic Consultation'],
  interaction: ['Counterspell', 'Force of Will'],
  fastMana: ['Dark Ritual'], tutors: ['Demonic Tutor'],
  cardAdvantage: ['Mystic Remora'],
};
const models = new Map([[0, model], [1, model]]);

describe('beliefs', () => {
  it('starts at priors and updates on legally revealed cards', () => {
    const e = testEngine([[...ISLANDS], [...ISLANDS, 'island']], 9);
    place(e, 1, 'island', 'battlefield'); // P1 has untapped mana: not tapped out
    const tracker = new BeliefTracker(0, [0, 1], models);
    const beforeInteraction = tracker.forOpponent(1)!.likelyInteraction;
    expect(beforeInteraction).toBe(0.25);

    // P1 reveals a Force of Will through legal means (memory injection
    // simulates a reveal event; the tracker only reads the observation).
    const memory = new Map<number, KnownCard[]>([
      [1, [{ name: 'Force of Will', oracleId: 'force-of-will', how: 'revealed' }]],
    ]);
    tracker.update(observe(e, 0, memory));
    const after = tracker.forOpponent(1)!;
    expect(after.revealedCards).toContain('Force of Will');
    expect(after.likelyInteraction).toBeGreaterThan(beforeInteraction);
  });

  it('tapped-out opponents are believed to hold no interaction', () => {
    const e = testEngine([[...ISLANDS], [...ISLANDS]], 10);
    const tracker = new BeliefTracker(0, [0, 1], models);
    // P1 has no untapped permanents (empty battlefield) -> tappedOut
    tracker.update(observe(e, 0));
    expect(tracker.forOpponent(1)!.likelyInteraction).toBeLessThan(0.25);
  });

  it('patch() writes live beliefs into the observation without mutating it', () => {
    const e = testEngine([[...ISLANDS], [...ISLANDS]], 11);
    const tracker = new BeliefTracker(0, [0, 1], models);
    const memory = new Map<number, KnownCard[]>([
      [1, [{ name: 'Demonic Consultation', oracleId: 'demonic-consultation', how: 'revealed' }]],
    ]);
    tracker.update(observe(e, 0, memory));
    const obs = observe(e, 0, memory);
    const patched = tracker.patch(obs);
    expect(patched.opponents[0].pWinAttemptNextTurn).toBeGreaterThan(obs.opponents[0].pWinAttemptNextTurn);
    // original untouched
    expect(obs.opponents[0].pWinAttemptNextTurn).toBe(0.1);
  });
});
