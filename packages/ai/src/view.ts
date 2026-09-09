/**
 * Observation state: EVERYTHING the AI may legally know.
 * The AI NEVER sees opponent hands, library order, or face-down cards
 * except through legal reveals tracked here. Policies that need hidden
 * info must go through the belief model (probabilities), never the Game.
 */
import { Engine } from '../../engine/src/engine.js';
import { CardDefinition } from '../../engine/src/types.js';

export interface KnownCard { name: string; oracleId: string; how: 'revealed' | 'played' | 'tutored' }

export interface OpponentBelief {
  player: number;
  handCount: number;
  knownCards: KnownCard[];          // legally seen, still plausibly in hand
  manaAvailable: number;            // approximate untapped mana value
  openManaColors: string[];
  pInteraction: number;             // belief: holds interaction
  pWinAttemptNextTurn: number;      // belief: can attempt win soon
  tappedOut: boolean;
}

export interface Observation {
  self: number;
  turn: number;
  phase: string;
  activePlayer: number;
  priorityPlayer: number | null;
  life: number[];
  hand: { id: string; name: string; oracleId: string; def: CardDefinition }[];
  battlefield: { id: string; name: string; controller: number; tapped: boolean; power?: number; toughness?: number }[];
  graveyards: { player: number; name: string }[][];
  stack: { cardName: string; controller: number; kind: string; targets: string[] }[];
  opponents: OpponentBelief[];
  libraryCount: number;
  manaPool: Record<string, number>;
  decklist: string[];               // own deck oracleIds (known)
  commanders: { player: number; name: string }[];
}

/**
 * Build the observation for `viewer`. Opponent hands are counts only.
 * `memory` carries legally-known cards across turns (reveals, tutors seen).
 */
export function observe(engine: Engine, viewer: number,
  memory: Map<number, KnownCard[]> = new Map()): Observation {
  const g = engine.game;
  const pl = g.players[viewer];
  const defOf = (oracleId: string) => engine.cards.get(oracleId);
  const hand = pl.hand.map((id) => {
    const o = g.getObject(id);
    return { id, name: o.cardName, oracleId: o.oracleId, def: defOf(o.oracleId) };
  });
  const battlefield = [...g.objects.values()]
    .filter((o) => o.zone === 'battlefield')
    .map((o) => ({ id: o.id, name: o.cardName, controller: o.controller, tapped: o.tapped, power: o.power, toughness: o.toughness }));
  const opponents: OpponentBelief[] = g.players
    .filter((p) => p.index !== viewer && !p.hasLost)
    .map((p) => {
      const untapped = [...g.objects.values()].filter((o) =>
        o.zone === 'battlefield' && o.controller === p.index && !o.tapped).length;
      return {
        player: p.index, handCount: p.hand.length,
        knownCards: memory.get(p.index) ?? [],
        manaAvailable: untapped, openManaColors: [], // refined by land types in full impl
        pInteraction: 0.25, pWinAttemptNextTurn: 0.1, tappedOut: untapped === 0,
      };
    });
  return {
    self: viewer, turn: g.turn.number, phase: g.turn.phase, activePlayer: g.turn.activePlayer,
    priorityPlayer: g.turn.priorityPlayer, life: g.players.map((p) => p.life),
    hand, battlefield,
    graveyards: g.players.map((p) => p.graveyard.map((id) => ({ player: p.index, name: g.getObject(id).cardName }))),
    stack: g.turn.stack.map((s) => ({ cardName: s.cardName, controller: s.controller, kind: s.kind, targets: s.targets })),
    opponents, libraryCount: pl.library.length, manaPool: { ...pl.manaPool },
    decklist: [], // filled by app from deck registry
    commanders: g.players.flatMap((p) => p.commanderIds.map((id) => ({ player: p.index, name: g.getObject(id).cardName }))),
  };
}
