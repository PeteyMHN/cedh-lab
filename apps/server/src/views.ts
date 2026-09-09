/**
 * views.ts — per-seat hidden-information filtering.
 *
 * Two channels:
 *  1. `observe()` from @cedh-lab/ai — the strong guarantee. Opponent hands are
 *     counts only; the AI consumes exactly this. Leak-tested.
 *  2. Event sanitization — engine events like DRAW carry card names; we strip
 *     any card identity the recipient could not legally know before broadcast.
 */
import { observe } from '@cedh-lab/ai';
import type { Observation, KnownCard } from '@cedh-lab/ai';
import type { ChoiceRequest, Engine, GameEvent, LegalAction } from '@cedh-lab/engine';
import type { WireEvent } from '@cedh-lab/protocol';

const PUBLIC_ZONES = new Set(['battlefield', 'stack', 'graveyard', 'exile', 'command']);

/** Events whose card identity is inherently public (spell on stack, permanent on battlefield, etc.). */
const PUBLIC_CARD_EVENTS = new Set([
  'CAST', 'ACTIVATE', 'RESOLVE_START', 'RESOLVE_END', 'FIZZLE', 'COUNTERED',
  'TRIGGERED', 'GAME_STARTED', 'PHASE_CHANGED', 'TURN_STARTED', 'LIFE_CHANGED',
  'COMMANDER_DAMAGE', 'PLAYER_LOST', 'GAME_ENDED', 'SBA', 'SHUFFLE',
]);

export function toWireEvent(e: GameEvent): WireEvent {
  return { seq: e.seq, type: e.type, payload: e.payload as Record<string, unknown>, hash: e.hash };
}

/**
 * Strip card identities the recipient seat could not legally know.
 * Conservative: when in doubt, strip.
 */
export function filterEventForSeat(ev: WireEvent, seat: number, game: Engine['game']): WireEvent {
  const p = { ...ev.payload };
  const actor = p.player as number | undefined;

  if (ev.type === 'DRAW') {
    // The drawn card's identity is known only to the drawing player.
    if (actor !== seat) { delete p.card; }
    return { ...ev, payload: p };
  }
  if (ev.type === 'ZONE_CHANGE') {
    const to = p.to as string;
    if (to === 'hand' && actor !== seat) {
      delete p.card; // a card entering someone else's hand: identity hidden
    } else if (!PUBLIC_ZONES.has(to) && actor !== seat) {
      delete p.card;
    }
    return { ...ev, payload: p };
  }
  if (ev.type === 'MULLIGAN' || ev.type === 'DISCARD') {
    // object ids are opaque; card names would leak — engine doesn't send them here.
    return ev;
  }
  if (!PUBLIC_CARD_EVENTS.has(ev.type) && 'card' in p) {
    // Unknown event kind carrying a card name: strip unless it's the actor's own.
    if (actor !== seat) delete p.card;
  }
  void game;
  return { ...ev, payload: p };
}

export interface SeatView {
  observation: Observation;
  legal: LegalAction[];
  pendingChoice: ChoiceRequest | null;
}

/** Build the full per-seat view: observation (leak-proof) + legal actions + pending choice. */
export function buildSeatView(
  engine: Engine,
  seat: number,
  memory: Map<number, KnownCard[]>,
  pendingChoice: ChoiceRequest | null,
): SeatView {
  const observation = observe(engine, seat, memory);
  const legal = engine.legalActionsFor(seat);
  const pc = pendingChoice && pendingChoice.player === seat ? pendingChoice : null;
  return { observation, legal, pendingChoice: pc };
}

/** Assert (in dev/test) that a serialized view contains no opponent card identities. */
/**
 * Backstop leak check for tests: an opponent's hidden hand card name must not
 * appear in `seat`'s observation unless the seat legitimately knows that name
 * already (own hand, legally-known cards, or a public zone). A name that is
 * public/known carries no information, so it is not a leak.
 */
export function assertNoLeak(
  view: SeatView, seat: number, engine: Engine, memory?: Map<number, KnownCard[]>,
): string[] {
  const g = engine.game;
  const allowed = new Set<string>();
  for (const id of g.players[seat].hand) allowed.add(g.getObject(id).cardName);
  for (const kcs of (memory ?? new Map()).values()) for (const kc of kcs) allowed.add(kc.name);
  for (const o of g.objects.values()) {
    if (o.zone !== 'hand' && o.zone !== 'library') allowed.add(o.cardName);
  }
  const leaks: string[] = [];
  const hay = JSON.stringify(view.observation);
  const reported = new Set<string>();
  g.players.forEach((pl, i) => {
    if (i === seat) return;
    for (const id of pl.hand) {
      const name = g.getObject(id).cardName;
      const key = `${i}:${name}`;
      if (name && !allowed.has(name) && !reported.has(key) && hay.includes(JSON.stringify(name))) {
        leaks.push(`seat ${i} hidden hand card leaked into seat ${seat}'s view: ${name}`);
        reported.add(key);
      }
    }
  });
  return leaks;
}
