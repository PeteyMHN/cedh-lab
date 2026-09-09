import { describe, expect, it } from 'vitest';
import { testEngine, passAll, place, handHas, ISLANDS } from './helper.js';

describe('determinism', () => {
  it('same seed produces identical event hashes', () => {
    const decks = [[...ISLANDS, 'dark-ritual', 'brainstorm'], [...ISLANDS, 'counterspell', 'brainstorm']];
    const a = testEngine(decks, 99);
    const b = testEngine(decks, 99);
    expect(a.game.events.map((e) => e.hash)).toEqual(b.game.events.map((e) => e.hash));
  });
  it('different seeds diverge', () => {
    const decks = [[...ISLANDS, 'dark-ritual'], [...ISLANDS, 'counterspell']];
    const a = testEngine(decks, 1);
    const b = testEngine(decks, 2);
    expect(a.game.events.map((e) => e.hash)).not.toEqual(b.game.events.map((e) => e.hash));
  });
  it('event chain verifies', () => {
    const e = testEngine([[...ISLANDS, 'brainstorm'], [...ISLANDS]]);
    expect(e.game.verifyChain()).toBe(true);
  });
  it('snapshot/restore round-trips', async () => {
    const e = testEngine([[...ISLANDS, 'dark-ritual'], [...ISLANDS]], 5);
    await place(e, 0, 'dark-ritual', 'hand');
    const snap = e.game.snapshot();
    const hashBefore = e.game.events[e.game.events.length - 1].hash;
    e.game.draw(0, 2);
    expect(e.game.events[e.game.events.length - 1].hash).not.toBe(hashBefore);
    e.game.restore(snap);
    expect(e.game.players[0].hand.length).toBe(8); // 7 + placed
    expect(e.game.verifyChain()).toBe(true);
  });
});

describe('stack', () => {
  it('resolves LIFO', async () => {
    const e = testEngine([[...ISLANDS, 'swamp', 'brainstorm', 'dark-ritual'], [...ISLANDS]], 7);
    await e.turns.enterPhase('precombatMain');
    await place(e, 0, 'brainstorm', 'hand');
    await place(e, 0, 'dark-ritual', 'hand');
    await place(e, 0, 'island', 'battlefield');
    await place(e, 0, 'swamp', 'battlefield');
    const tap = async (oracleId: string) => {
      const id = e.game.players[0].battlefield.find((x) => e.game.getObject(x).oracleId === oracleId && !e.game.getObject(x).tapped)!;
      await e.activateAbility(0, id, 0);
    };
    e.priority.startRound();
    await tap('island');
    await e.stack.castSpell(0, handHas(e, 0, 'brainstorm')!); // bottom of stack
    e.priority.actionTaken(0);
    await tap('swamp');
    await e.stack.castSpell(0, handHas(e, 0, 'dark-ritual')!); // top of stack
    e.priority.actionTaken(0);
    await passAll(e);
    const resolves = e.game.events.filter((ev) => ev.type === 'RESOLVE_END').map((ev) => ev.payload.card);
    // Dark Ritual was cast last → resolves first
    expect(resolves.indexOf('Dark Ritual')).toBeLessThan(resolves.indexOf('Brainstorm'));
    expect(e.game.players[0].manaPool.B).toBeGreaterThanOrEqual(3);
    expect(e.game.verifyChain()).toBe(true);
  });

  it('counterspell removes the spell, which never resolves', async () => {
    const e = testEngine([
      [...ISLANDS, 'island', 'brainstorm'],
      [...ISLANDS, 'island', 'island', 'counterspell'],
    ], 11);
    await e.turns.enterPhase('precombatMain');
    await place(e, 0, 'brainstorm', 'hand');
    await place(e, 0, 'island', 'battlefield');
    await place(e, 1, 'counterspell', 'hand');
    await place(e, 1, 'island', 'battlefield');
    await place(e, 1, 'island', 'battlefield');
    const tapOne = async (p: number) => {
      const id = e.game.players[p].battlefield.find((x) => e.game.getObject(x).oracleId === 'island' && !e.game.getObject(x).tapped)!;
      await e.activateAbility(p, id, 0);
    };
    e.priority.startRound();
    // P0 casts Brainstorm
    await tapOne(0);
    await e.stack.castSpell(0, handHas(e, 0, 'brainstorm')!);
    e.priority.actionTaken(0);
    e.priority.pass(0); // P1's turn for priority
    // P1 counters it
    await tapOne(1); await tapOne(1);
    const bs = e.game.turn.stack.find((s) => s.cardName === 'Brainstorm')!;
    await e.stack.castSpell(1, handHas(e, 1, 'counterspell')!, { targets: [bs.id] });
    e.priority.actionTaken(1);
    await passAll(e);
    // brainstorm countered: in graveyard, never resolved (no RESOLVE_END for it)
    const bsObj = e.game.players[0].graveyard.map((id) => e.game.getObject(id));
    expect(bsObj.some((o) => o.oracleId === 'brainstorm')).toBe(true);
    expect(e.game.events.filter((ev) => ev.type === 'RESOLVE_END' && ev.payload.card === 'Brainstorm')).toHaveLength(0);
    expect(e.game.verifyChain()).toBe(true);
  });

  it('a spell with no legal targets on resolution fizzles (two Swords, one Elf)', async () => {
    const e = testEngine([
      [...ISLANDS, 'plains', 'swords-to-plowshares'],
      [...ISLANDS, 'plains', 'swords-to-plowshares', 'llanowar-elves'],
    ], 13);
    await e.turns.enterPhase('precombatMain');
    await place(e, 0, 'plains', 'battlefield');
    await place(e, 0, 'swords-to-plowshares', 'hand');
    await place(e, 1, 'plains', 'battlefield');
    await place(e, 1, 'swords-to-plowshares', 'hand');
    const elfId = await place(e, 1, 'llanowar-elves', 'battlefield');
    const tapPlains = async (p: number) => {
      const id = e.game.players[p].battlefield.find((x) => e.game.getObject(x).oracleId === 'plains' && !e.game.getObject(x).tapped)!;
      await e.activateAbility(p, id, 0);
    };
    e.priority.startRound();
    // P0: Swords #1 targeting the Elf
    await tapPlains(0);
    await e.stack.castSpell(0, handHas(e, 0, 'swords-to-plowshares')!, { targets: [elfId] });
    e.priority.actionTaken(0);
    e.priority.pass(0); // P1's turn for priority
    // P1: Swords #2 targeting the same Elf (resolves first)
    await tapPlains(1);
    await e.stack.castSpell(1, handHas(e, 1, 'swords-to-plowshares')!, { targets: [elfId] });
    e.priority.actionTaken(1);
    await passAll(e);
    // Elf exiled by Swords #2; P1 (its controller) gained 1 life
    expect(e.game.getObject(elfId).zone).toBe('exile');
    expect(e.game.players[1].life).toBe(41);
    // Swords #1 fizzled: FIZZLE event, no second life gain
    const fizzle = e.game.events.find((ev) => ev.type === 'FIZZLE');
    expect(fizzle).toBeTruthy();
    expect(fizzle!.payload.card).toBe('Swords to Plowshares');
    expect(e.game.players[0].life).toBe(40);
    expect(e.game.verifyChain()).toBe(true);
  });
});
