/** Coordinator's Phase-1 fix tests: flash timing, ability costs at activation, Mana Vault. */
import { describe, expect, it } from 'vitest';
import { testEngine, place, passAll, ISLANDS } from './helper.js';

const SWAMPS = Array(10).fill('swamp');

describe('phase-1 coordinator fixes', () => {
  it('flash creature casts at instant speed (in response, stack non-empty)', async () => {
    const e = testEngine([
      [...ISLANDS, 'orcish-bowmasters', 'counterspell'],
      [...SWAMPS, 'dark-ritual'],
    ]);
    // P1 casts Dark Ritual; P0 responds with Bowmasters (flash)
    const ritual = await place(e, 1, 'dark-ritual', 'hand');
    e.game.players[1].manaPool.B = 1;
    await e.stack.castSpell(1, ritual); // stack non-empty now
    const bow = await place(e, 0, 'orcish-bowmasters', 'hand');
    e.game.players[0].manaPool.B = 1;
    e.game.players[0].manaPool.C = 1;
    const so = await e.stack.castSpell(0, bow);
    expect(so.cardName).toBe('Orcish Bowmasters');
  });

  it('non-flash creature cannot be cast in response', async () => {
    const e = testEngine([
      [...ISLANDS, 'test-grizzly'],
      [...SWAMPS, 'dark-ritual'],
    ]);
    const ritual = await place(e, 1, 'dark-ritual', 'hand');
    e.game.players[1].manaPool.B = 1;
    await e.stack.castSpell(1, ritual);
    const g = await place(e, 0, 'test-grizzly', 'hand');
    e.game.players[0].manaPool.G = 2;
    e.game.players[0].manaPool.C = 1;
    await expect(e.stack.castSpell(0, g)).rejects.toThrow('timing restriction');
  });

  it('Thrasios activation pays {4} at activation, not resolution', async () => {
    const e = testEngine([[...ISLANDS, 'thrasios-triton-hero'], [...ISLANDS]]);
    const th = await place(e, 0, 'thrasios-triton-hero', 'battlefield');
    e.game.getObject(th).summoningSick = false;
    e.game.players[0].manaPool.C = 4;
    const before = e.game.players[0].manaPool.C;
    await e.activateAbility(0, th, 0); // engine.activateAbility -> stack (non-mana)
    // cost paid synchronously at activation, before anything resolves
    expect(e.game.players[0].manaPool.C).toBe(before - 4);
    expect(e.game.turn.stack.length).toBe(1);
  });

  it('Grim Monolith untap ability pays {4} at activation', async () => {
    const e = testEngine([[...ISLANDS, 'grim-monolith'], [...ISLANDS]]);
    const m = await place(e, 0, 'grim-monolith', 'battlefield');
    e.game.getObject(m).tapped = true;
    e.game.players[0].manaPool.C = 4;
    await e.activateAbility(0, m, 1);
    expect(e.game.players[0].manaPool.C).toBe(0);
    await e.resolveTop();
    expect(e.game.getObject(m).tapped).toBe(false);
  });

  it('Mana Vault does not untap during untap step', async () => {
    const e = testEngine([[...ISLANDS, 'mana-vault'], [...ISLANDS]]);
    const v = await place(e, 0, 'mana-vault', 'battlefield');
    const obj = e.game.getObject(v);
    expect(obj.skipUntap).toBe(true);
    obj.tapped = true;
    // control permanent untaps, vault does not
    const isl = await place(e, 0, 'island', 'battlefield');
    e.game.getObject(isl).tapped = true;
    e.game.turn.activePlayer = 0;
    await e.turns.enterPhase('untap');
    expect(e.game.getObject(v).tapped).toBe(true); // still tapped
    expect(e.game.getObject(isl).tapped).toBe(false); // control untapped
  });

  it('Mana Vault upkeep trigger: pay {4} untaps, else 1 damage', async () => {
    const e = testEngine([[...ISLANDS, 'mana-vault'], [...ISLANDS]]);
    const v = await place(e, 0, 'mana-vault', 'battlefield');
    const obj = e.game.getObject(v);
    obj.tapped = true;
    // drive to P0 upkeep with payment policy = pay
    e.paymentPolicy = () => true;
    e.game.players[0].manaPool.C = 4;
    const lifeBefore = e.game.players[0].life;
    await e.turns.enterPhase('upkeep');
    await passAll(e);
    expect(obj.tapped).toBe(false);
    expect(e.game.players[0].life).toBe(lifeBefore);
  });
});
