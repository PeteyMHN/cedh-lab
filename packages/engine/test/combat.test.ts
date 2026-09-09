/**
 * Combat step tests: declarations, damage assignment, keywords, commander
 * damage, and turn-structure wiring. Uses a scripted choice policy so every
 * decision is deterministic.
 */
import { describe, expect, it } from 'vitest';
import {
  Engine,
  ChoicePolicy, ChoiceRequest, ChoiceSelection,
  dealCombatDamage, declareAttackers,
} from '@cedh-lab/engine';
import { Registry } from '@cedh-lab/cards';

const GRIZZLY = 'test-grizzly'; // 2/2 vanilla
const FENCER = 'test-fencer';   // 1/1 first strike
const EAGLE = 'test-eagle';     // 2/2 flying
const MENACE = 'test-menace';   // 3/3 menace

function makeEngine(decks: string[][]): Engine {
  const registry = new Registry();
  return new Engine(
    decks.map((d, i) => ({ name: `P${i}`, deckOracleIds: d, commanderOracleIds: [] })),
    registry,
    { seed: 42 },
  );
}

/** Start a game and put the named creatures onto the battlefield, ready to fight. */
async function setup(p0: string[], p1: string[]): Promise<{ e: Engine; p0: string[]; p1: string[] }> {
  const e = makeEngine([
    [...p0, ...Array(12).fill('island')],
    [...p1, ...Array(12).fill('island')],
  ]);
  await e.turns.startGame(0);
  const out: { e: Engine; p0: string[]; p1: string[] } = { e, p0: [], p1: [] };
  for (const [p, cards, key] of [[0, p0, 'p0'], [1, p1, 'p1']] as const) {
    for (const oracleId of cards) {
      const pl = e.game.players[p];
      const id = [...pl.library, ...pl.hand].map((x) => x)
        .find((x) => e.game.getObject(x).oracleId === oracleId);
      if (!id) throw new Error(`setup: no ${oracleId} for P${p}`);
      await e.enterBattlefield(id, p);
      const o = e.game.getObject(id);
      o.summoningSick = false; // has been on the battlefield since before combat
      (out[key] as string[]).push(id);
    }
  }
  return out;
}

/** Deterministic policy: pick everything offered for 'cards', P1 for 'player', keep order. */
function attackP1(): ChoicePolicy {
  return async (req: ChoiceRequest): Promise<ChoiceSelection> => {
    switch (req.kind) {
      case 'cards':
        return { kind: 'cards', cardIds: (req.options ?? []).map((o) => o.id) };
      case 'player':
        return { kind: 'player', player: 1 };
      case 'order':
        return { kind: 'order', order: (req.options ?? []).map((o) => o.id) };
      default:
        throw new Error(`unexpected choice kind ${req.kind}`);
    }
  };
}

function combatDamageEvents(e: Engine) {
  return e.game.events.filter((ev) => ev.type === 'COMBAT_DAMAGE');
}

describe('combat', () => {
  it('(a) unblocked 2/2 deals 2 to the defending player', async () => {
    const { e, p0 } = await setup([GRIZZLY], []);
    const grizzly = p0[0];
    e.choicePolicy = attackP1();

    await e.turns.enterPhase('declareAttackers');
    expect(e.game.turn.attackers).toEqual([{ attacker: grizzly, defender: 1 }]);
    expect(e.game.getObject(grizzly).tapped).toBe(true); // tapped to attack (no vigilance)

    await e.turns.enterPhase('declareBlockers');
    expect(e.game.turn.blockers).toEqual([]);

    await e.turns.enterPhase('combatDamage');
    expect(e.game.players[1].life).toBe(38);
    expect(e.game.turn.combatDamageDealtTo).toEqual({ 0: { 1: 2 } });
    const dmg = combatDamageEvents(e);
    expect(dmg).toHaveLength(1);
    expect(dmg[0].payload).toMatchObject({
      attacker: grizzly, target: 'player:1', amount: 2, toPlayer: 1, commander: false,
    });
  });

  it('(b) 2/2 blocked by 2/2: both die via SBA', async () => {
    const { e, p0, p1 } = await setup([GRIZZLY], [GRIZZLY]);
    const atk = p0[0], blk = p1[0];
    e.choicePolicy = attackP1();

    await e.turns.enterPhase('declareAttackers');
    await e.turns.enterPhase('declareBlockers');
    expect(e.game.turn.blockers).toEqual([{ blocker: blk, attacker: atk }]);

    await e.turns.enterPhase('combatDamage');
    expect(e.game.getObject(atk).zone).toBe('graveyard');
    expect(e.game.getObject(blk).zone).toBe('graveyard');
    const dmg = combatDamageEvents(e);
    expect(dmg.map((d) => d.payload)).toMatchObject([
      { attacker: atk, target: blk, amount: 2 },
      { attacker: blk, target: atk, amount: 2 },
    ]);
  });

  it('(c) first-strike 1/1 attacks into 2/2: attacker dies in the regular step, blocker lives', async () => {
    const { e, p0, p1 } = await setup([FENCER], [GRIZZLY]);
    const fencer = p0[0], grizzly = p1[0];
    e.choicePolicy = attackP1();

    await e.turns.enterPhase('declareAttackers');
    await e.turns.enterPhase('declareBlockers');
    await e.turns.enterPhase('combatDamage');

    // First-strike step: fencer dealt 1 to grizzly (survives with 1 marked).
    // Regular step: grizzly dealt 2 back; fencer dies via SBA.
    expect(e.game.getObject(fencer).zone).toBe('graveyard');
    expect(e.game.getObject(grizzly).zone).toBe('battlefield');
    expect(e.game.getObject(grizzly).damageMarked).toBe(1);
    expect(e.game.players[1].life).toBe(40); // blocked: nothing tramples through
  });

  it('(d) menace cannot be blocked by a single creature: declareBlockers throws', async () => {
    const { e } = await setup([MENACE], [GRIZZLY]);
    e.choicePolicy = attackP1(); // P1 "blocks" the 3/3 menace with one 2/2
    await e.turns.enterPhase('declareAttackers');
    await expect(e.turns.enterPhase('declareBlockers')).rejects.toThrow(/menace/);
  });

  it('(e) commander combat damage is tracked via dealCommanderDamage', async () => {
    const { e, p0 } = await setup([GRIZZLY], []);
    const cmd = p0[0];
    e.game.players[0].commanderIds = [cmd]; // plant the attacker as P0's commander
    e.choicePolicy = attackP1();

    await declareAttackers(e.api, 0);
    await dealCombatDamage(e.api, true);  // no first strike: nothing happens
    await dealCombatDamage(e.api, false); // regular step: 2 commander damage

    expect(e.game.players[1].commanderDamage[cmd]).toBe(2);
    expect(e.game.players[1].life).toBe(38);
    const cd = e.game.events.find((ev) => ev.type === 'COMMANDER_DAMAGE');
    expect(cd?.payload).toMatchObject({ by: cmd, to: 1, amount: 2, total: 2 });
    const dmg = combatDamageEvents(e);
    expect(dmg).toHaveLength(1);
    expect(dmg[0].payload).toMatchObject({ attacker: cmd, toPlayer: 1, amount: 2, commander: true });
  });

  it('(f) combat steps grant priority', async () => {
    const { e } = await setup([], []);
    expect(e.turns.grantsPriority('declareAttackers')).toBe(true);
    expect(e.turns.grantsPriority('declareBlockers')).toBe(true);
    expect(e.turns.grantsPriority('combatDamage')).toBe(true);
  });

  it('(g) flying attacker cannot be blocked by a ground creature', async () => {
    const { e, p0 } = await setup([EAGLE], [GRIZZLY]);
    const eagle = p0[0];
    e.choicePolicy = attackP1();

    await e.turns.enterPhase('declareAttackers');
    await e.turns.enterPhase('declareBlockers');
    // The 2/2 ground creature is not a legal blocker vs flying → unblocked.
    expect(e.game.turn.blockers).toEqual([]);
    await e.turns.enterPhase('combatDamage');
    expect(e.game.players[1].life).toBe(38);
    expect(e.game.turn.attackers).toEqual([{ attacker: eagle, defender: 1 }]);
  });
});
