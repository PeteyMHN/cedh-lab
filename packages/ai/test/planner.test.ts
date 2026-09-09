import { describe, expect, it } from 'vitest';
import { testEngine, place, handHas, ISLANDS } from '../../engine/test/helper.js';
import { observe } from '@cedh-lab/ai';
import { planManaThenCast } from '@cedh-lab/ai';

describe('compound planning', () => {
  it('plans tap-then-cast for an affordable-after-taps spell', async () => {
    const e = testEngine([
      [...ISLANDS, 'island', 'island', 'brainstorm'],
      [...ISLANDS],
    ], 21);
    await e.turns.enterPhase('precombatMain');
    place(e, 0, 'brainstorm', 'hand');
    place(e, 0, 'island', 'battlefield');
    place(e, 0, 'island', 'battlefield');
    e.priority.startRound();
    const obs = observe(e, 0);
    const legal = e.legalActionsFor(0);
    // Brainstorm not castable from empty pool...
    expect(legal.some((a) => a.kind === 'cast' && a.objectId === handHas(e, 0, 'brainstorm'))).toBe(false);
    const plan = planManaThenCast(obs, legal, handHas(e, 0, 'brainstorm')!);
    expect(plan).not.toBeNull();
    // ...but the plan taps both islands, then casts.
    expect(plan!.length).toBe(3);
    expect(plan!.slice(0, 2).every((s) => s.kind === 'activate')).toBe(true);
    expect(plan![2]).toMatchObject({ kind: 'cast', objectId: handHas(e, 0, 'brainstorm') });
    // taps target untapped mana sources only
    for (const tap of plan!.slice(0, 2)) {
      const src = e.game.getObject(tap.objectId!);
      expect(src.tapped).toBe(false);
      expect(src.oracleId).toBe('island');
    }
  });

  it('returns null when colors are infeasible (no blue source for Brainstorm)', async () => {
    const e = testEngine([
      [...ISLANDS, 'forest', 'forest', 'brainstorm'],
      [...ISLANDS],
    ], 22);
    await e.turns.enterPhase('precombatMain');
    place(e, 0, 'brainstorm', 'hand');
    place(e, 0, 'forest', 'battlefield');
    place(e, 0, 'forest', 'battlefield');
    e.priority.startRound();
    const obs = observe(e, 0);
    const plan = planManaThenCast(obs, e.legalActionsFor(0), handHas(e, 0, 'brainstorm')!);
    expect(plan).toBeNull(); // forests can't make blue: don't tap out for nothing
  });

  it('returns null with nothing to tap', async () => {
    const e = testEngine([
      [...ISLANDS, 'brainstorm'],
      [...ISLANDS],
    ], 23);
    await e.turns.enterPhase('precombatMain');
    place(e, 0, 'brainstorm', 'hand');
    e.priority.startRound();
    const obs = observe(e, 0);
    expect(planManaThenCast(obs, e.legalActionsFor(0), handHas(e, 0, 'brainstorm')!)).toBeNull();
  });
});
