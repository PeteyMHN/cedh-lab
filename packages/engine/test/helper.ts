/** Shared test scaffolding: deterministic engines with scenario-placed cards. */
import { Engine } from '@cedh-lab/engine';
import { Registry, resolveTrigger, wireTokens } from '@cedh-lab/cards';

export function testEngine(decks: string[][], seed = 1, names?: string[]): Engine {
  const registry = new Registry();
  const engine = new Engine(
    decks.map((d, i) => ({ name: names?.[i] ?? `P${i}`, deckOracleIds: d, commanderOracleIds: [] })),
    registry,
    { seed },
  );
  engine.triggerResolver = resolveTrigger;
  engine.paymentPolicy = () => false;
  wireTokens(engine);
  engine.turns.startGame(0);
  return engine;
}

export function handHas(e: Engine, p: number, oracleId: string): string | null {
  const id = e.game.players[p].hand.find((id) => e.game.getObject(id).oracleId === oracleId);
  return id ?? null;
}

/** Move a card from library/hand to hand or battlefield. */
export async function place(e: Engine, p: number, oracleId: string, where: 'hand' | 'battlefield'): Promise<string> {
  const g = e.game;
  const pl = g.players[p];
  let id = pl.hand.find((x) => g.getObject(x).oracleId === oracleId) ?? null;
  if (id) pl.hand = pl.hand.filter((x) => x !== id);
  else {
    const i = pl.library.findIndex((x) => g.getObject(x).oracleId === oracleId);
    if (i < 0) throw new Error(`place: no ${oracleId} for P${p}`);
    id = pl.library.splice(i, 1)[0];
  }
  const o = g.getObject(id);
  if (where === 'hand') { o.zone = 'hand'; pl.hand.push(id); }
  else { await e.enterBattlefield(id, p); }
  return id;
}

/** Pass priority around until the stack empties (all players pass). */
export async function passAll(e: Engine): Promise<void> {
  e.priority.startRound();
  let guard = 0;
  while (guard++ < 300) {
    if (e.game.isOver) return;
    const p = e.priority.currentPlayer();
    if (p === null) {
      if (e.game.turn.stack.length === 0) return;
      await e.resolveTop();
      e.priority.startRound();
      continue;
    }
    e.priority.pass(p);
  }
  throw new Error('passAll guard tripped');
}

export const ISLANDS = Array(10).fill('island');
