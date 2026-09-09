/**
 * Demo harness: scripted-but-legal play through the engine.
 * EVERY action goes through engine validation (castSpell, activateAbility,
 * playLand, priority.pass). Nothing is hand-waved: if the engine rejects an
 * action, the demo fails loudly.
 */
import { Engine } from '@cedh-lab/engine';
import { PlayerConfig } from '@cedh-lab/engine';
import { Registry, resolveTrigger } from '@cedh-lab/cards';

export function findInHand(e: Engine, p: number, oracleId: string): string | null {
  const id = e.game.players[p].hand.find((id) => e.game.getObject(id).oracleId === oracleId);
  return id ?? null;
}
export function findUntapped(e: Engine, p: number, oracleId: string): string | null {
  const id = e.game.players[p].battlefield.find((id) => {
    const o = e.game.getObject(id);
    return o.oracleId === oracleId && !o.tapped;
  });
  return id ?? null;
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
export function stackTop(e: Engine, cardName: string) {
  const s = e.game.turn.stack;
  const want = norm(cardName);
  return [...s].reverse().find((x) => norm(x.cardName) === want) ?? null;
}

export function printStack(e: Engine): void {
  const s = e.game.turn.stack;
  console.log('  ┌─ STACK ' + (s.length === 0 ? '(empty)' : ''));
  [...s].reverse().forEach((o, i) => {
    const tag = i === 0 ? 'TOP' : '   ';
    const tgt = o.targets.length ? ` → targets: ${o.targets.map((t) => t.startsWith('player:') ? 'P' + t.slice(7) : e.game.getObject(t).cardName).join(', ')}` : '';
    console.log(`  │ ${tag} [${o.kind}] ${o.cardName} (P${o.controller})${tgt}${o.namedCard ? ` named "${o.namedCard}"` : ''}`);
  });
  console.log('  └─ BOTTOM');
}

export function printBoard(e: Engine): void {
  for (const p of e.game.players) {
    const bf = p.battlefield.map((id) => {
      const o = e.game.getObject(id);
      return `${o.cardName}${o.tapped ? ' (tapped)' : ''}`;
    });
    const pool = Object.entries(p.manaPool).filter(([, v]) => v > 0).map(([k, v]) => `${v}${k}`).join(' ') || '—';
    console.log(`  P${p.index} ${p.name}: life ${p.life} | hand ${p.hand.length} | lib ${p.library.length} | pool [${pool}]`);
    console.log(`      battlefield: ${bf.join(', ') || '—'}`);
  }
}

/** Scenario setup: move exact cards to hand/battlefield (labeled, like Scenario Lab). */
export function setupScenario(e: Engine, setup: { player: number; hand?: string[]; battlefield?: string[] }[]): void {
  const g = e.game;
  const take = (player: number, oracleId: string): string => {
    const pl = g.players[player];
    // already in hand?
    const inHand = pl.hand.find((id) => g.getObject(id).oracleId === oracleId);
    if (inHand) { pl.hand = pl.hand.filter((id) => id !== inHand); return inHand; }
    const idx = pl.library.findIndex((id) => g.getObject(id).oracleId === oracleId);
    if (idx < 0) throw new Error(`setup: ${oracleId} not in P${player} library/hand`);
    const [id] = pl.library.splice(idx, 1);
    return id;
  };
  for (const s of setup) {
    for (const oracleId of s.hand ?? []) {
      const id = take(s.player, oracleId);
      g.players[s.player].hand.push(id);
      g.getObject(id).zone = 'hand';
    }
    for (const oracleId of s.battlefield ?? []) {
      const id = take(s.player, oracleId);
      g.getObject(id).zone = 'battlefield';
      g.getObject(id).controller = s.player;
      g.players[s.player].battlefield.push(id);
      e.permanentEntered(id);
    }
  }
  g.emit('SCENARIO_SETUP', { note: 'cards placed by Scenario Lab (not drawn)' });
}

export type DecideResult = 'acted' | 'pass' | 'stop' | void;
export type DecideFn = (e: Engine, player: number) => DecideResult | Promise<DecideResult>;

/**
 * Run priority rounds until the stack is empty and everyone passes.
 * `decide` is called each time a player gains priority and returns:
 *   'acted' — it took an action and handled priority itself
 *   'pass' | void — pass priority
 *   'stop' — end the loop (scenario complete)
 */
export async function runPriority(e: Engine, decide: DecideFn, label = ''): Promise<void> {
  if (label) console.log(`\n── priority: ${label} ──`);
  e.priority.startRound();
  let guard = 0;
  while (guard++ < 500) {
    if (e.game.isOver) return;
    const p = e.priority.currentPlayer();
    if (p === null) {
      if (e.game.turn.stack.length > 0) {
        const top = e.game.turn.stack[e.game.turn.stack.length - 1];
        console.log(`  …all passed, resolving: ${top.cardName}`);
        await e.resolveTop();
        printStack(e);
        e.priority.startRound();
        continue;
      }
      console.log('  …all passed, stack empty.');
      return;
    }
    const r = await decide(e, p);
    if (r === 'stop') return;
    if (r !== 'acted') e.priority.pass(p);
  }
  throw new Error('priority loop guard tripped');
}

export async function makeEngine(names: string[], decks: string[][], seed = 42): Promise<{ engine: Engine; cfgs: PlayerConfig[] }> {
  const registry = new Registry();
  const cfgs: PlayerConfig[] = names.map((name, i) => ({
    name, deckOracleIds: decks[i], commanderOracleIds: [],
  }));
  const engine = new Engine(cfgs, registry, { seed });
  engine.triggerResolver = resolveTrigger;
  await engine.turns.startGame(0);
  return { engine, cfgs };
}
