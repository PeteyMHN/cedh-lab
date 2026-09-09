/**
 * Tier-2A card tests. Local engine scaffolding only (no imports from
 * packages/engine/test/helper.ts, which is being migrated).
 */
import { describe, expect, test } from 'vitest';
import { Engine } from '@cedh-lab/engine';
import { Registry, resolveTrigger } from '@cedh-lab/cards';
import { TIER2A_DEFS, TIER2A_SCRIPTS, Tier2aRegistry, resolveTier2aTrigger } from '../src/tier2a.js';
import type { CardRegistryLike, ChoiceRequest, ChoiceSelection, Game } from '@cedh-lab/engine';

class TestRegistry implements CardRegistryLike {
  private t2a = new Tier2aRegistry();
  private base = new Registry();
  get(oracleId: string) { return this.t2a.has(oracleId) ? this.t2a.get(oracleId) : this.base.get(oracleId); }
  script(oracleId: string) { return this.t2a.has(oracleId) ? this.t2a.script(oracleId) : this.base.script(oracleId); }
  has(oracleId: string): boolean { return this.t2a.has(oracleId) || this.base.has(oracleId); }
  all() { return [...this.t2a.all(), ...this.base.all()]; }
}

const ISLANDS = Array(24).fill('island');

function testEngine(decks: string[][], seed = 7): Engine {
  const engine = new Engine(
    decks.map((d, i) => ({ name: `P${i}`, deckOracleIds: d, commanderOracleIds: [] })),
    new TestRegistry(),
    { seed },
  );
  engine.triggerResolver = async (api, so) => {
    if (await resolveTier2aTrigger(api, so)) return;
    resolveTrigger(api, so);
  };
  engine.paymentPolicy = () => false;
  // stands in for the coordinator's wiring of the real Treasure token script
  engine.tokenScripts.set('treasure', { abilities: [] });
  engine.turns.startGame(0);
  return engine;
}

/** Move a card from library/hand to hand or battlefield (library first, so repeat placements get distinct copies). */
async function place(e: Engine, p: number, oracleId: string, where: 'hand' | 'battlefield'): Promise<string> {
  const g = e.game;
  const pl = g.players[p];
  let id: string;
  const li = pl.library.findIndex((x) => g.getObject(x).oracleId === oracleId);
  if (li >= 0) id = pl.library.splice(li, 1)[0];
  else {
    const hi = pl.hand.findIndex((x) => g.getObject(x).oracleId === oracleId);
    if (hi < 0) throw new Error(`place: no ${oracleId} for P${p}`);
    id = pl.hand.splice(hi, 1)[0];
  }
  const o = g.getObject(id);
  if (where === 'hand') { o.zone = 'hand'; pl.hand.push(id); }
  else await e.enterBattlefield(id, p);
  return id;
}

/** Set up sorcery timing for player p with an empty stack. */
function mainPhase(e: Engine, p: number): void {
  e.game.turn.activePlayer = p;
  e.game.turn.phase = 'precombatMain';
  e.game.turn.stack.length = 0;
}

type Policy = (req: ChoiceRequest, game: Game) => Promise<ChoiceSelection>;
function strictPolicy(fn: Policy): Policy { return fn; }
function unexpected(req: ChoiceRequest): never {
  throw new Error(`unexpected choice: kind=${req.kind} prompt=${req.prompt}`);
}

describe('tier2a registry', () => {
  test('16 defs, unique oracleIds, every def has a script', () => {
    expect(TIER2A_DEFS).toHaveLength(16);
    const ids = TIER2A_DEFS.map((d) => d.oracleId);
    expect(new Set(ids).size).toBe(16);
    for (const id of ids) expect(TIER2A_SCRIPTS[id]).toBeDefined();
  });
});

describe('mana crypt', () => {
  test('upkeep flip resolves; win keeps life, loss costs 3', async () => {
    let sawWin = false, sawLose = false;
    for (let seed = 1; seed <= 200 && !(sawWin && sawLose); seed++) {
      const e = testEngine([['mana-crypt', ...ISLANDS], [...ISLANDS]], seed);
      await place(e, 0, 'mana-crypt', 'battlefield');
      e.turns.enterPhase('upkeep');
      await e.resolveTop();
      const flip = e.game.events.find((ev) => ev.type === 'MANA_CRYPT_FLIP');
      expect(flip).toBeDefined();
      const won = (flip!.payload as { won: boolean }).won;
      if (won) { expect(e.game.players[0].life).toBe(40); sawWin = true; }
      else { expect(e.game.players[0].life).toBe(37); sawLose = true; }
    }
    expect(sawWin).toBe(true);
    expect(sawLose).toBe(true);
  });

  test('taps for CC', async () => {
    const e = testEngine([['mana-crypt', ...ISLANDS], [...ISLANDS]]);
    const id = await place(e, 0, 'mana-crypt', 'battlefield');
    await e.activateAbility(0, id, 0);
    expect(e.game.players[0].manaPool.C).toBe(2);
  });
});

describe('jeweled lotus', () => {
  test('commander-only mana cannot pay generic costs, can pay commander casts', async () => {
    const e = testEngine([['jeweled-lotus', ...ISLANDS], [...ISLANDS]]);
    e.choicePolicy = strictPolicy(async (req) => {
      if (req.kind === 'color') return { kind: 'color', color: 'G' };
      return unexpected(req);
    });
    const id = await place(e, 0, 'jeweled-lotus', 'battlefield');
    await e.activateAbility(0, id, 0);
    const pl = e.game.players[0];
    expect(pl.restrictedMana.commander.G).toBe(3);
    expect(pl.manaPool.G).toBe(0);
    expect(e.game.getObject(id).zone).toBe('graveyard'); // sacrificed as cost
    expect(() => e.mana.spendParsed(0, '{1}{G}')).toThrow(); // generic spell: unusable
    e.mana.spendParsed(0, '{1}{G}', 0, { commanderOk: true }); // commander cast: usable
    expect(pl.restrictedMana.commander.G).toBe(1);
  });
});

describe('chrome mox', () => {
  test('imprint a card, then tap for one of its colors; empty imprint adds nothing', async () => {
    const e = testEngine([['chrome-mox', 'chrome-mox', 'llanowar-elves', ...ISLANDS], [...ISLANDS]]);
    let imprintTarget: string | null = null;
    e.choicePolicy = strictPolicy(async (req) => {
      if (req.kind === 'cards') return { kind: 'cards', cardIds: imprintTarget ? [imprintTarget] : [] };
      if (req.kind === 'color') return { kind: 'color', color: 'G' };
      return unexpected(req);
    });
    const mox = await place(e, 0, 'chrome-mox', 'hand');
    const elves = await place(e, 0, 'llanowar-elves', 'hand');
    imprintTarget = elves;
    await e.enterBattlefield(mox, 0);
    expect(e.game.getObject(elves).zone).toBe('exile');
    expect(e.game.getObject(mox).imprinted).toEqual([elves]);
    await e.activateAbility(0, mox, 0);
    expect(e.game.players[0].manaPool.G).toBe(1);
    // second mox imprints nothing -> ability is a clean no-op
    const mox2 = await place(e, 0, 'chrome-mox', 'hand');
    imprintTarget = null;
    await e.enterBattlefield(mox2, 0);
    await e.activateAbility(0, mox2, 0);
    expect(e.game.players[0].manaPool.G).toBe(1);
    expect(e.game.events.some((ev) => ev.type === 'CHROME_MOX_EMPTY')).toBe(true);
  });
});

describe('mox diamond', () => {
  test('discards a land to enter; taps for any color', async () => {
    const e = testEngine([['mox-diamond', ...ISLANDS], [...ISLANDS]]);
    const mox = await place(e, 0, 'mox-diamond', 'hand');
    const landId = e.game.players[0].hand.find((id) => e.game.getObject(id).oracleId === 'island')!;
    e.choicePolicy = strictPolicy(async (req) => {
      if (req.kind === 'card') return { kind: 'card', cardId: landId };
      if (req.kind === 'color') return { kind: 'color', color: 'R' };
      return unexpected(req);
    });
    await e.enterBattlefield(mox, 0);
    expect(e.game.getObject(mox).zone).toBe('battlefield');
    expect(e.game.getObject(landId).zone).toBe('graveyard');
    await e.activateAbility(0, mox, 0);
    expect(e.game.players[0].manaPool.R).toBe(1);
  });

  test('sacrificed when no land in hand', async () => {
    const e = testEngine([['mox-diamond', ...Array(24).fill('dark-ritual')], [...ISLANDS]]);
    const mox = await place(e, 0, 'mox-diamond', 'hand');
    await e.enterBattlefield(mox, 0);
    expect(e.game.getObject(mox).zone).toBe('graveyard');
  });
});

describe('mana vault', () => {
  test('upkeep: pay {4} to untap, otherwise 1 damage', async () => {
    const e = testEngine([['mana-vault', ...ISLANDS], [...ISLANDS]]);
    e.paymentPolicy = () => true;
    const id = await place(e, 0, 'mana-vault', 'battlefield');
    e.game.getObject(id).tapped = true;
    e.mana.add(0, 'C', 4);
    e.turns.enterPhase('upkeep');
    await e.resolveTop();
    expect(e.game.getObject(id).tapped).toBe(false);
    expect(e.game.players[0].manaPool.C).toBe(0);
    expect(e.game.players[0].life).toBe(40);

    const e2 = testEngine([['mana-vault', ...ISLANDS], [...ISLANDS]]);
    e2.paymentPolicy = () => false;
    const id2 = await place(e2, 0, 'mana-vault', 'battlefield');
    e2.game.getObject(id2).tapped = true;
    e2.turns.enterPhase('upkeep');
    await e2.resolveTop();
    expect(e2.game.players[0].life).toBe(39);
    expect(e2.game.getObject(id2).tapped).toBe(true);
  });

  test('taps for CCC', async () => {
    const e = testEngine([['mana-vault', ...ISLANDS], [...ISLANDS]]);
    const id = await place(e, 0, 'mana-vault', 'battlefield');
    await e.activateAbility(0, id, 0);
    expect(e.game.players[0].manaPool.C).toBe(3);
  });
});

describe('grim monolith', () => {
  test('taps for CCC; {4} untaps it', async () => {
    const e = testEngine([['grim-monolith', ...ISLANDS], [...ISLANDS]]);
    const id = await place(e, 0, 'grim-monolith', 'battlefield');
    await e.activateAbility(0, id, 0);
    expect(e.game.players[0].manaPool.C).toBe(3);
    e.mana.add(0, 'C', 4);
    await e.activateAbility(0, id, 1);
    await e.resolveTop();
    expect(e.game.getObject(id).tapped).toBe(false);
    expect(e.game.players[0].manaPool.C).toBe(3); // 3 + 4 - 4
  });
});

describe('lotus petal', () => {
  test('sac for one mana of any color', async () => {
    const e = testEngine([['lotus-petal', ...ISLANDS], [...ISLANDS]]);
    e.choicePolicy = strictPolicy(async (req) => {
      if (req.kind === 'color') return { kind: 'color', color: 'U' };
      return unexpected(req);
    });
    const id = await place(e, 0, 'lotus-petal', 'battlefield');
    await e.activateAbility(0, id, 0);
    expect(e.game.players[0].manaPool.U).toBe(1);
    expect(e.game.getObject(id).zone).toBe('graveyard');
  });
});

describe('mountain', () => {
  test('taps for R', async () => {
    const e = testEngine([['mountain', ...ISLANDS], [...ISLANDS]]);
    const id = await place(e, 0, 'mountain', 'battlefield');
    await e.activateAbility(0, id, 0);
    expect(e.game.players[0].manaPool.R).toBe(1);
  });
});

describe('dockside extortionist', () => {
  test('creates one treasure per artifact/enchantment opponents control', async () => {
    const e = testEngine(
      [['dockside-extortionist', ...ISLANDS], ['sol-ring', 'sol-ring', 'mystic-remora', ...ISLANDS]],
    );
    await place(e, 1, 'sol-ring', 'battlefield');
    await place(e, 1, 'sol-ring', 'battlefield');
    await place(e, 1, 'mystic-remora', 'battlefield');
    const dock = await place(e, 0, 'dockside-extortionist', 'hand');
    mainPhase(e, 0);
    e.mana.add(0, 'R', 1);
    e.mana.add(0, 'C', 1);
    await e.stack.castSpell(0, dock);
    await e.resolveTop(); // spell resolves -> ETB -> trigger queued
    await e.resolveTop(); // trigger resolves -> tokens
    const treasures = e.game.players[0].battlefield.filter((id) => {
      const o = e.game.getObject(id);
      return o.isToken && o.cardName === 'Treasure';
    });
    expect(treasures).toHaveLength(3);
  });
});

describe('orcish bowmasters', () => {
  test('ETB pings an opponent; each later opponent draw pings the drawer', async () => {
    const e = testEngine([['orcish-bowmasters', ...ISLANDS], [...ISLANDS]]);
    const bow = await place(e, 0, 'orcish-bowmasters', 'hand');
    mainPhase(e, 0);
    e.mana.add(0, 'B', 1);
    e.mana.add(0, 'C', 1);
    await e.stack.castSpell(0, bow);
    await e.resolveTop(); // spell -> ETB -> trigger
    await e.resolveTop(); // trigger -> 1 damage
    expect(e.game.players[1].life).toBe(39);
    e.game.draw(1, 2); // two non-draw-step draws -> two triggers
    expect(e.game.turn.stack.length).toBe(2);
    await e.resolveTop();
    await e.resolveTop();
    expect(e.game.players[1].life).toBe(37);
  });

  test('no trigger on the first draw-step draw', async () => {
    const e = testEngine([['orcish-bowmasters', ...ISLANDS], [...ISLANDS]]);
    await place(e, 0, 'orcish-bowmasters', 'battlefield');
    await e.resolveTop(); // resolve the ETB trigger first (P1 -> 39)
    expect(e.game.players[1].life).toBe(39);
    e.game.turn.phase = 'draw';
    e.game.turn.activePlayer = 1;
    e.game.draw(1, 1);
    expect(e.game.turn.stack.length).toBe(0);
    expect(e.game.players[1].life).toBe(39);
  });
});

describe('esper sentinel', () => {
  test("taxes opponent's first noncreature spell each turn, once per turn; creatures exempt", async () => {
    const e = testEngine(
      [['esper-sentinel', ...ISLANDS], ['dark-ritual', 'dark-ritual', 'llanowar-elves', ...ISLANDS]],
    );
    await place(e, 0, 'esper-sentinel', 'battlefield');
    const r1 = await place(e, 1, 'dark-ritual', 'hand');
    const r2 = await place(e, 1, 'dark-ritual', 'hand');
    const elves = await place(e, 1, 'llanowar-elves', 'hand');
    const handBefore = e.game.players[0].hand.length;
    mainPhase(e, 1);
    e.mana.add(1, 'B', 3);
    e.mana.add(1, 'G', 1);
    await e.stack.castSpell(1, r1); // first noncreature spell -> trigger
    expect(e.game.turn.stack.length).toBe(2);
    await e.resolveTop(); // trigger resolves: paymentPolicy false -> P0 draws
    expect(e.game.players[0].hand.length).toBe(handBefore + 1);
    await e.resolveTop(); // dark ritual resolves
    await e.stack.castSpell(1, r2); // second noncreature spell -> no trigger
    expect(e.game.turn.stack.length).toBe(1);
    await e.resolveTop();
    await e.stack.castSpell(1, elves); // creature -> no trigger
    expect(e.game.turn.stack.length).toBe(1);
    await e.resolveTop();
    expect(e.game.players[0].hand.length).toBe(handBefore + 1);
  });

  test('no draw when the tax is paid', async () => {
    const e = testEngine([['esper-sentinel', ...ISLANDS], ['dark-ritual', ...ISLANDS]]);
    e.paymentPolicy = () => true;
    await place(e, 0, 'esper-sentinel', 'battlefield');
    const r1 = await place(e, 1, 'dark-ritual', 'hand');
    const handBefore = e.game.players[0].hand.length;
    mainPhase(e, 1);
    e.mana.add(1, 'B', 1);
    await e.stack.castSpell(1, r1);
    await e.resolveTop();
    expect(e.game.players[0].hand.length).toBe(handBefore);
  });
});

describe('tymna the weaver', () => {
  test('postcombat main: pay X life to draw X', async () => {
    const e = testEngine([['tymna-the-weaver', ...ISLANDS], [...ISLANDS]]);
    await place(e, 0, 'tymna-the-weaver', 'battlefield');
    e.game.turn.combatDamageDealtTo = { 0: { 1: 2 } };
    const handBefore = e.game.players[0].hand.length;
    e.choicePolicy = strictPolicy(async (req) => {
      if (req.kind === 'yesNo') return { kind: 'yesNo', value: true };
      return unexpected(req);
    });
    e.turns.enterPhase('postcombatMain');
    expect(e.game.turn.stack.length).toBe(1);
    await e.resolveTop();
    expect(e.game.players[0].life).toBe(39);
    expect(e.game.players[0].hand.length).toBe(handBefore + 1);
  });

  test('declining pays nothing and draws nothing; no trigger without combat damage', async () => {
    const e = testEngine([['tymna-the-weaver', ...ISLANDS], [...ISLANDS]]);
    await place(e, 0, 'tymna-the-weaver', 'battlefield');
    e.game.turn.combatDamageDealtTo = { 0: { 1: 2 } };
    const handBefore = e.game.players[0].hand.length;
    e.choicePolicy = strictPolicy(async (req) => {
      if (req.kind === 'yesNo') return { kind: 'yesNo', value: false };
      return unexpected(req);
    });
    e.turns.enterPhase('postcombatMain');
    await e.resolveTop();
    expect(e.game.players[0].life).toBe(40);
    expect(e.game.players[0].hand.length).toBe(handBefore);

    const e2 = testEngine([['tymna-the-weaver', ...ISLANDS], [...ISLANDS]]);
    await place(e2, 0, 'tymna-the-weaver', 'battlefield');
    e2.game.turn.combatDamageDealtTo = {};
    e2.turns.enterPhase('postcombatMain');
    expect(e2.game.turn.stack.length).toBe(0);
  });
});

describe("kraum, ludevic's opus", () => {
  test('second spell each turn draws a card', async () => {
    const e = testEngine([["kraum-ludevic-s-opus", 'dark-ritual', 'dark-ritual', ...ISLANDS], [...ISLANDS]]);
    await place(e, 0, "kraum-ludevic-s-opus", 'battlefield');
    const r1 = await place(e, 0, 'dark-ritual', 'hand');
    const r2 = await place(e, 0, 'dark-ritual', 'hand');
    const handBefore = e.game.players[0].hand.length;
    mainPhase(e, 0);
    e.mana.add(0, 'B', 2);
    await e.stack.castSpell(0, r1);
    expect(e.game.turn.stack.length).toBe(1); // first spell: no trigger
    await e.stack.castSpell(0, r2);
    expect(e.game.turn.stack.length).toBe(3); // both spells + kraum trigger
    await e.resolveTop(); // kraum trigger -> draw
    expect(e.game.players[0].hand.length).toBe(handBefore - 2 + 1);
    await e.resolveTop();
    await e.resolveTop();
  });
});

describe('thrasios, triton hero', () => {
  test('scry 1, reveal land -> battlefield tapped', async () => {
    const e = testEngine([['thrasios-triton-hero', ...ISLANDS], [...ISLANDS]]);
    const th = await place(e, 0, 'thrasios-triton-hero', 'battlefield');
    const pl = e.game.players[0];
    const li = pl.library.findIndex((id) => e.game.getObject(id).oracleId === 'island');
    const islandId = pl.library.splice(li, 1)[0];
    pl.library.unshift(islandId); // island on top
    e.choicePolicy = strictPolicy(async (req) => {
      if (req.kind === 'option') return { kind: 'option', index: 0 }; // keep on top
      return unexpected(req);
    });
    e.mana.add(0, 'C', 4);
    await e.activateAbility(0, th, 0);
    await e.resolveTop();
    const landed = e.game.getObject(islandId);
    expect(landed.zone).toBe('battlefield');
    expect(landed.tapped).toBe(true);
    expect(e.game.players[0].manaPool.C).toBe(0); // {4} paid
    expect(e.game.events.some((ev) => ev.type === 'CARD_REVEALED')).toBe(true);
  });

  test('scry to bottom, reveal nonland -> draw it', async () => {
    const e = testEngine([['thrasios-triton-hero', 'dark-ritual', ...ISLANDS], [...ISLANDS]]);
    const th = await place(e, 0, 'thrasios-triton-hero', 'battlefield');
    const pl = e.game.players[0];
    const li = pl.library.findIndex((id) => e.game.getObject(id).oracleId === 'island');
    const islandId = pl.library.splice(li, 1)[0];
    pl.library.unshift(islandId);
    const ri = pl.library.findIndex((id) => e.game.getObject(id).oracleId === 'dark-ritual');
    const ritualId = pl.library.splice(ri, 1)[0];
    pl.library.splice(1, 0, ritualId); // ritual second from top
    e.choicePolicy = strictPolicy(async (req) => {
      if (req.kind === 'option') return { kind: 'option', index: 1 }; // bottom the island
      return unexpected(req);
    });
    e.mana.add(0, 'C', 4);
    const handBefore = pl.hand.length;
    await e.activateAbility(0, th, 0);
    await e.resolveTop();
    expect(pl.library[pl.library.length - 1]).toBe(islandId); // scried to bottom
    expect(pl.hand.length).toBe(handBefore + 1); // ritual drawn
    expect(pl.hand).toContain(ritualId);
  });
});

describe('rograkh, son of rohgahh', () => {
  test('carries first strike, menace, trample as a 0/1', () => {
    const reg = new TestRegistry();
    const d = reg.get('rograkh-son-of-rohgahh');
    expect(d.keywords).toEqual(expect.arrayContaining(['first-strike', 'menace', 'trample']));
    expect(d.power).toBe('0');
    expect(d.toughness).toBe('1');
  });
});

describe('kinnan, bonder prodigy', () => {
  test('tapping a nonland permanent for mana adds one more of a produced color', async () => {
    const e = testEngine([['kinnan-bonder-prodigy', 'llanowar-elves', ...ISLANDS], [...ISLANDS]]);
    await place(e, 0, 'kinnan-bonder-prodigy', 'battlefield');
    const elves = await place(e, 0, 'llanowar-elves', 'battlefield');
    e.game.getObject(elves).summoningSick = false;
    e.choicePolicy = strictPolicy(async (req) => {
      if (req.kind === 'color') return { kind: 'color', color: 'G' };
      return unexpected(req);
    });
    await e.activateAbility(0, elves, 0);
    expect(e.game.players[0].manaPool.G).toBe(2);
  });

  test('{5}{G}{U}: non-Human creature from top five to battlefield, rest to bottom', async () => {
    const e = testEngine([['kinnan-bonder-prodigy', 'test-grizzly', ...ISLANDS], [...ISLANDS]]);
    const kin = await place(e, 0, 'kinnan-bonder-prodigy', 'battlefield');
    const pl = e.game.players[0];
    const gi = pl.library.findIndex((id) => e.game.getObject(id).oracleId === 'test-grizzly');
    const grizzlyId = pl.library.splice(gi, 1)[0];
    pl.library.unshift(grizzlyId); // grizzly in the top five
    const libBefore = pl.library.length;
    e.choicePolicy = strictPolicy(async (req) => {
      if (req.kind === 'cards') {
        expect(req.options).toHaveLength(1);
        return { kind: 'cards', cardIds: [req.options![0].id] };
      }
      return unexpected(req);
    });
    e.mana.add(0, 'C', 5);
    e.mana.add(0, 'G', 1);
    e.mana.add(0, 'U', 1);
    await e.activateAbility(0, kin, 0);
    await e.resolveTop();
    expect(e.game.getObject(grizzlyId).zone).toBe('battlefield');
    expect(pl.library.length).toBe(libBefore - 1); // 5 seen, 1 kept, 4 to the bottom
    const pool = e.game.players[0].manaPool;
    expect(pool.C).toBe(0);
    expect(pool.G).toBe(0);
    expect(pool.U).toBe(0);
  });
});
