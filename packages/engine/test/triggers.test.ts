import { describe, expect, it } from 'vitest';
import { testEngine, passAll, place, handHas, ISLANDS } from './helper.js';

function setupFish(seed = 21): ReturnType<typeof testEngine> {
  const e = testEngine([
    [...ISLANDS, 'island', 'forest', 'brainstorm', 'llanowar-elves'],
    [...ISLANDS, 'island', 'brainstorm'],
    [...ISLANDS, 'mystic-remora'],
    [...ISLANDS, 'rhystic-study'],
  ], seed);
  e.turns.enterPhase('precombatMain');
  place(e, 2, 'mystic-remora', 'battlefield');
  place(e, 3, 'rhystic-study', 'battlefield');
  return e;
}

describe('triggers', () => {
  it('mystic remora triggers on opponent noncreature spell, not on creatures', () => {
    const e = setupFish();
    place(e, 0, 'brainstorm', 'hand');
    place(e, 0, 'island', 'battlefield');
    place(e, 0, 'llanowar-elves', 'hand');
    e.priority.startRound();
    const tap = () => {
      const id = e.game.players[0].battlefield.find((x) => e.game.getObject(x).oracleId === 'island' && !e.game.getObject(x).tapped)!;
      e.activateAbility(0, id, 0);
    };
    // cast a creature: remora does NOT trigger (study does — that's correct)
    place(e, 0, 'forest', 'battlefield');
    const forest = e.game.players[0].battlefield.find((x) => e.game.getObject(x).oracleId === 'forest' && !e.game.getObject(x).tapped)!;
    e.activateAbility(0, forest, 0);
    e.stack.castSpell(0, handHas(e, 0, 'llanowar-elves')!);
    e.priority.actionTaken(0);
    const fishTrigs = e.game.turn.stack.filter((s) => s.kind === 'triggered' && s.cardName === 'Mystic Remora');
    expect(fishTrigs).toHaveLength(0);
    passAll(e);
    expect(e.game.getObject(e.game.players[0].battlefield.find((x) => e.game.getObject(x).oracleId === 'llanowar-elves')!).zone).toBe('battlefield');
    // cast a noncreature: remora triggers (active player regains priority)
    e.priority.startRound();
    tap();
    e.stack.castSpell(0, handHas(e, 0, 'brainstorm')!);
    e.priority.actionTaken(0);
    const trigs = e.game.turn.stack.filter((s) => s.kind === 'triggered');
    // both fish trigger on the noncreature spell: Remora (P2) + Study (P3)
    expect(trigs).toHaveLength(2);
    const remora = trigs.find((t) => t.cardName === 'Mystic Remora')!;
    expect(remora.controller).toBe(2);
  });

  it('APNAP: remora (P2) trigger goes on stack before study (P3) when P0 is active', () => {
    const e = setupFish();
    place(e, 0, 'brainstorm', 'hand');
    place(e, 0, 'island', 'battlefield');
    e.priority.startRound();
    const id = e.game.players[0].battlefield.find((x) => e.game.getObject(x).oracleId === 'island' && !e.game.getObject(x).tapped)!;
    e.activateAbility(0, id, 0);
    e.stack.castSpell(0, handHas(e, 0, 'brainstorm')!);
    e.priority.actionTaken(0);
    const trigs = e.game.turn.stack.filter((s) => s.kind === 'triggered');
    expect(trigs.map((t) => t.controller)).toEqual([2, 3]); // bottom→top: P2 then P3
  });

  it('declining to pay draws the fish controller a card', () => {
    const e = setupFish();
    const before = e.game.players[2].hand.length;
    place(e, 0, 'brainstorm', 'hand');
    place(e, 0, 'island', 'battlefield');
    e.priority.startRound();
    const id = e.game.players[0].battlefield.find((x) => e.game.getObject(x).oracleId === 'island' && !e.game.getObject(x).tapped)!;
    e.activateAbility(0, id, 0);
    e.stack.castSpell(0, handHas(e, 0, 'brainstorm')!);
    e.priority.actionTaken(0);
    passAll(e);
    expect(e.game.players[2].hand.length).toBe(before + 1);
    expect(e.game.verifyChain()).toBe(true);
  });

  it('thassa oracle wins with empty library on ETB', () => {
    const e = testEngine([
      [...ISLANDS, 'island', 'island', 'thassas-oracle'],
      [...ISLANDS],
    ], 33);
    e.turns.enterPhase('precombatMain');
    place(e, 0, 'thassas-oracle', 'hand');
    place(e, 0, 'island', 'battlefield');
    place(e, 0, 'island', 'battlefield');
    // empty P0's library
    e.game.players[0].library = [];
    e.priority.startRound();
    const isles = e.game.players[0].battlefield.filter((x) => e.game.getObject(x).oracleId === 'island' && !e.game.getObject(x).tapped);
    e.activateAbility(0, isles[0], 0);
    e.activateAbility(0, isles[1], 0);
    e.stack.castSpell(0, handHas(e, 0, 'thassas-oracle')!);
    e.priority.actionTaken(0);
    passAll(e);
    expect(e.game.winners).toContain(0);
    expect(e.game.isOver).toBe(true);
  });
});
