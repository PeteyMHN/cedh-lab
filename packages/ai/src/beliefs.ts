/**
 * beliefs.ts — per-opponent belief state, updated from observations only.
 *
 * The AI never sees hidden cards. Instead it maintains probabilistic beliefs:
 * does this opponent likely hold interaction? Are they threatening a win?
 * Updates are deterministic heuristics over public information (board, counts,
 * legally revealed cards). v1; the architecture supports learned models later.
 */
import { DeckModel } from './eval.js';
import { KnownCard, Observation, OpponentBelief } from './view.js';

export interface OpponentBeliefs {
  player: number;
  likelyInteraction: number; // P(opponent holds interaction)
  likelyWinAttempt: number;  // P(opponent can attempt a win soon)
  revealedCards: string[];   // legally seen card names, plausibly still in hand
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export class BeliefTracker {
  private beliefs = new Map<number, OpponentBeliefs>();
  private models: Map<number, DeckModel>;

  constructor(self: number, players: number[], models: Map<number, DeckModel>) {
    this.models = models;
    for (const p of players) {
      if (p === self) continue;
      this.beliefs.set(p, { player: p, likelyInteraction: 0.25, likelyWinAttempt: 0.1, revealedCards: [] });
    }
  }

  /** Fold a fresh observation into beliefs. Deterministic; no RNG. */
  update(obs: Observation): void {
    for (const o of obs.opponents) {
      const b = this.beliefs.get(o.player);
      if (!b) continue;
      const model = this.models.get(o.player);
      b.revealedCards = o.knownCards.map((k: KnownCard) => k.name);

      // --- interaction belief ---
      let p: number;
      if (o.tappedOut) {
        p = 0.05; // tapped out: can't cast most interaction
      } else {
        p = 0.25;
        if (o.handCount >= 4) p += 0.10;                    // deep hand
        if (o.manaAvailable >= 2) p += 0.10;               // open mana
        if (model) {
          const known = o.knownCards.filter((k) => model.interaction.includes(k.name)).length;
          p += 0.30 * Math.min(known, 2);                  // we have SEEN their interaction
        }
      }
      b.likelyInteraction = clamp01(p);

      // --- win-attempt belief ---
      let w = 0.10;
      if (model) {
        const knownWin = o.knownCards.filter((k) =>
          model.winConditions.includes(k.name) || model.comboPieces.includes(k.name)).length;
        w += 0.25 * Math.min(knownWin, 2);
      }
      if (o.manaAvailable >= 5 && o.handCount >= 4) w += 0.15; // resources for a window
      if (o.tappedOut) w -= 0.05;
      b.likelyWinAttempt = clamp01(w);
    }
  }

  forOpponent(player: number): OpponentBeliefs | undefined {
    return this.beliefs.get(player);
  }

  /**
   * Return a copy of the observation with the live beliefs patched into the
   * opponents' pInteraction / pWinAttemptNextTurn fields, so policies consume
   * live beliefs without changing their shape.
   */
  patch(obs: Observation): Observation {
    const opponents: OpponentBelief[] = obs.opponents.map((o) => {
      const b = this.beliefs.get(o.player);
      if (!b) return o;
      return { ...o, pInteraction: b.likelyInteraction, pWinAttemptNextTurn: b.likelyWinAttempt };
    });
    return { ...obs, opponents };
  }
}
