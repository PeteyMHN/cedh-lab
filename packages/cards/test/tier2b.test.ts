/** Tier-2B card tests: silence, grand-abolisher, drannith-magistrate,
 * cyclonic-rift, flusterstorm, swan-song, opposition-agent + token scripts.
 * Minimal local setup (engine test helper is owned by another workstream). */
import { describe, expect, it } from 'vitest';
import {
  Engine, defaultChoicePolicy,
  type CardDefinition, type CardScript, type PlayerConfig,
} from '@cedh-lab/engine';
import { Registry } from '@cedh-lab/cards';
import { TIER2B_DEFS, TIER2B_SCRIPTS, TOKEN_SCRIPTS } from '../src/tier2b.js';

class T2BRegistry extends Registry {
  private t2bDefs = new Map(TIER2B_DEFS.map((d) => [d.oracleId, d]));
  override get(oracleId: string): CardDefinition {
    return this.t2bDefs.get(oracleId) ?? super.get(oracleId);
  }
  override script(oracleId: string): CardScript {
    return TIER2B_SCRIPTS[oracleId] ?? super.script(oracleId);
  }
  override has(oracleId: string): boolean {
    return this.t2bDefs.has(oracleId) || super.has(oracleId);
  }
  override all(): CardDefinition[] {
    return [...super.all(), ...TIER2B_DEFS];
  }
}

const ISLANDS = Array(12).fill('island');
const deck = (extra: string[]): string[] => [...extra, ...ISLANDS];

function setup(decks: string[][], commanders: string[][] = []): Engine {
  const cfgs: PlayerConfig[] = decks.map((d, i) => ({
    name: `P${i}`, deckOracleIds: d, commanderOracleIds: commanders[i] ?? [],
  }));
  const e = new Engine(cfgs, new T2BRegistry(), { seed: 42 });
  e.paymentPolicy = () => false; // nobody ever pays
  e.turns.startGame(0);
  return e;
}

/** create an object directly into a player's hand (makeObject returns the object) */
function toHand(e: Engine, p: number, oracleId: string): string {
  const o = e.game.makeObject(oracleId, p, 'hand');
  e.game.players[p].hand.push(o.id);
  return o.id;
}

/** put a permanent onto the battlefield */
async function toBattlefield(e: Engine, p: number, oracleId: string): Promise<string> {
  const id = toHand(e, p, oracleId);
  await e.enterBattlefield(id, p);
  return id;
}

/** get a card from hand, pulling it out of the library if the draw missed it */
function handCard(e: Engine, p: number, oracleId: string): string {
  const g = e.game;
  const pl = g.players[p];
  const inHand = pl.hand.find((x) => g.getObject(x).oracleId === oracleId);
  if (inHand) return inHand;
  const i = pl.library.findIndex((x) => g.getObject(x).oracleId === oracleId);
  if (i < 0) throw new Error(`handCard: no ${oracleId} for P${p}`);
  const id = pl.library.splice(i, 1)[0];
  g.getObject(id).zone = 'hand';
  pl.hand.push(id);
  return id;
}

/** move a copy of a card from hand to the top of the library (deterministic search targets) */
function ensureInLibrary(e: Engine, p: number, oracleId: string): void {
  const g = e.game;
  const pl = g.players[p];
  const inHand = pl.hand.find((x) => g.getObject(x).oracleId === oracleId);
  if (!inHand) return;
  pl.hand = pl.hand.filter((x) => x !== inHand);
  g.getObject(inHand).zone = 'library';
  pl.library.unshift(inHand);
}

async function drainStack(e: Engine): Promise<void> {
  let guard = 0;
  while (guard++ < 40) {
    if (!(await e.stack.resolveTop())) return;
  }
  throw new Error('drainStack guard tripped');
}

describe('tier-2b', () => {
  it('Silence stops opponents from casting but not its controller', async () => {
    const e = setup([deck(['silence', 'silence']), deck(['counterspell'])]);
    e.mana.add(0, 'W', 2);
    await e.stack.castSpell(0, handCard(e, 0, 'silence'));
    await e.stack.resolveTop();
    expect(e.game.turn.cantCastSpells).toEqual([1]);
    // opponent blocked
    e.mana.add(1, 'U', 2);
    await expect(e.stack.castSpell(1, handCard(e, 1, 'counterspell')))
      .rejects.toThrow(/cannot cast/);
    // controller unaffected
    await e.stack.castSpell(0, handCard(e, 0, 'silence'));
  });

  it("Grand Abolisher blocks opponent casts on its controller's turn", async () => {
    const e = setup([deck(['grand-abolisher']), deck(['counterspell'])]);
    await toBattlefield(e, 0, 'grand-abolisher');
    expect(e.game.turn.activePlayer).toBe(0);
    e.mana.add(1, 'U', 2);
    const cs = handCard(e, 1, 'counterspell');
    await expect(e.stack.castSpell(1, cs)).rejects.toThrow(/Grand Abolisher/);
    // on another player's turn the lock is off
    e.game.turn.activePlayer = 1;
    await e.stack.castSpell(1, cs);
  });

  it('Drannith Magistrate blocks commander casts by opponents', async () => {
    const e = setup([deck([]), deck(['drannith-magistrate'])], [['test-grizzly'], []]);
    await toBattlefield(e, 1, 'drannith-magistrate');
    const cmdId = e.game.players[0].commanderIds[0];
    expect(e.game.getObject(cmdId).zone).toBe('command');
    expect(() => e.commander.castFromCommandZone(0, cmdId, () => 'cast'))
      .toThrow(/Drannith Magistrate/);
  });

  it("Cyclonic Rift bounces a targeted nonland permanent you don't control", async () => {
    const e = setup([deck(['cyclonic-rift', 'cyclonic-rift']), deck(['test-grizzly'])]);
    const grizzly = await toBattlefield(e, 1, 'test-grizzly');
    e.mana.add(0, 'U', 1); e.mana.add(0, 'C', 1);
    await e.stack.castSpell(0, handCard(e, 0, 'cyclonic-rift'), { targets: [grizzly] });
    await e.stack.resolveTop();
    expect(e.game.getObject(grizzly).zone).toBe('hand');
    expect(e.game.players[1].hand).toContain(grizzly);
    // illegal targets: your own permanent, or a land
    const own = await toBattlefield(e, 0, 'test-grizzly');
    const foeLand = await toBattlefield(e, 1, 'island');
    e.mana.add(0, 'U', 2); e.mana.add(0, 'C', 2);
    await expect(e.stack.castSpell(0, handCard(e, 0, 'cyclonic-rift'), { targets: [own] }))
      .rejects.toThrow(/illegal target/);
    await expect(e.stack.castSpell(0, handCard(e, 0, 'cyclonic-rift'), { targets: [foeLand] }))
      .rejects.toThrow(/illegal target/);
  });

  it('Cyclonic Rift overload bounces every nonland permanent opponents control', async () => {
    const e = setup([deck(['cyclonic-rift']), deck(['test-grizzly']), deck(['test-eagle'])]);
    const g1 = await toBattlefield(e, 1, 'test-grizzly');
    const isl1 = await toBattlefield(e, 1, 'island');
    const e2 = await toBattlefield(e, 2, 'test-eagle');
    const isl0 = await toBattlefield(e, 0, 'island');
    e.mana.add(0, 'C', 6); e.mana.add(0, 'U', 1);
    await e.stack.castSpell(0, handCard(e, 0, 'cyclonic-rift'),
      { alternativeCost: 'overload', modes: [1] });
    await e.stack.resolveTop();
    expect(e.game.getObject(g1).zone).toBe('hand');
    expect(e.game.getObject(e2).zone).toBe('hand');
    expect(e.game.getObject(isl1).zone).toBe('battlefield'); // lands stay
    expect(e.game.getObject(isl0).zone).toBe('battlefield'); // own permanents stay
  });

  it('Flusterstorm storms: one copy per spell cast this turn, each countering unless paid', async () => {
    const e = setup([deck(['flusterstorm']), deck(['dark-ritual', 'dark-ritual'])]);
    e.mana.add(1, 'B', 2);
    const a = handCard(e, 1, 'dark-ritual');
    await e.stack.castSpell(1, a);
    const b = handCard(e, 1, 'dark-ritual');
    await e.stack.castSpell(1, b);
    expect(e.stack.stormCount()).toBe(2);
    e.mana.add(0, 'U', 1);
    await e.stack.castSpell(0, handCard(e, 0, 'flusterstorm'), { targets: [a] });
    expect(e.stack.stormCount()).toBe(3);
    await e.stack.resolveTop(); // flusterstorm resolves -> storm copies
    const copies = e.game.turn.stack.filter((s) => s.kind === 'copy');
    expect(copies).toHaveLength(3); // copies == stormCount
    expect(copies.every((c) => c.cardName === 'Flusterstorm')).toBe(true);
    expect(e.game.events.filter((ev) => ev.type === 'STACK_PUSH')).toHaveLength(3);
    await drainStack(e); // paymentPolicy never pays, so targets get countered
    expect(e.game.getObject(a).zone).toBe('graveyard');
    const countered = e.game.events.filter(
      (ev) => ev.type === 'COUNTERED' && ev.payload.object === a && ev.payload.by === 0);
    expect(countered.length).toBeGreaterThan(0);
  });

  it("Swan Song counters and gives the spell's controller a 2/2 flying Bird", async () => {
    const e = setup([deck(['swan-song']), deck(['dark-ritual'])]);
    e.tokenScripts.set('bird', TOKEN_SCRIPTS['bird']);
    e.mana.add(1, 'B', 1);
    const dr = handCard(e, 1, 'dark-ritual');
    await e.stack.castSpell(1, dr);
    e.mana.add(0, 'U', 1);
    await e.stack.castSpell(0, handCard(e, 0, 'swan-song'), { targets: [dr] });
    await e.stack.resolveTop();
    expect(e.game.getObject(dr).zone).toBe('graveyard');
    const birdId = e.game.players[1].battlefield
      .find((id) => e.game.getObject(id).cardName === 'Bird');
    expect(birdId).toBeDefined();
    const bird = e.game.getObject(birdId!);
    expect(bird.controller).toBe(1);
    expect(e.defFor(bird).keywords).toContain('flying');
    expect(e.defFor(bird).power).toBe('2');
    expect(e.defFor(bird).toughness).toBe('2');
  });

  it('Opposition Agent exiles the found card instead of letting the opponent search', async () => {
    const e = setup(
      [deck(['opposition-agent', 'demonic-tutor']), deck(['demonic-tutor', 'test-grizzly', 'test-eagle'])],
    );
    await toBattlefield(e, 0, 'opposition-agent');
    ensureInLibrary(e, 1, 'test-grizzly');
    // the agent's controller picks Test Grizzly to exile
    e.choicePolicy = async (req, game) => {
      if (req.prompt.includes('Opposition Agent')) {
        const opt = (req.options ?? []).find((o) => o.label === 'Test Grizzly') ?? req.options![0];
        return { kind: 'card', cardId: opt.id };
      }
      return defaultChoicePolicy(req, game);
    };
    e.mana.add(1, 'B', 1); e.mana.add(1, 'C', 1);
    await e.stack.castSpell(1, handCard(e, 1, 'demonic-tutor'));
    await e.stack.resolveTop();
    const g = e.game;
    const exiled = g.players[1].exile.find((id) => g.getObject(id).oracleId === 'test-grizzly');
    expect(exiled).toBeDefined();
    expect(g.players[1].hand.some((id) => g.getObject(id).oracleId === 'test-grizzly')).toBe(false);
    // the agent's controller searching is unaffected
    e.mana.add(0, 'B', 1); e.mana.add(0, 'C', 1);
    const tutor0 = handCard(e, 0, 'demonic-tutor');
    const handBefore = g.players[0].hand.length;
    await e.stack.castSpell(0, tutor0);
    await e.stack.resolveTop();
    expect(g.players[0].exile.length).toBe(0);
    expect(g.players[0].hand.length).toBe(handBefore); // tutored one card, tutor went to graveyard
  });

  it('Treasure taps and sacrifices for one mana of any color', async () => {
    const e = setup([deck([]), deck([])]);
    e.tokenScripts.set('treasure', TOKEN_SCRIPTS['treasure']);
    const tid = await e.createToken(0, {
      name: 'Treasure', types: ['artifact'], subtypes: ['Treasure'], colors: [], scriptKey: 'treasure',
    });
    await e.activateAbility(0, tid, 0);
    expect(e.game.players[0].manaPool.W).toBe(1); // default policy picks the first color
    expect(e.game.players[0].battlefield).not.toContain(tid);
    expect(e.game.getObject(tid).zone).toBe('graveyard'); // sacrificed
    await e.checkSbas(); // CR 111.7: token ceases to exist as an SBA
    expect(() => e.game.getObject(tid)).toThrow();
  });
});
