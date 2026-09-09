/**
 * Strategic evaluator: heuristic win-probability features for cEDH.
 * Heuristic now; the same feature vector trains the value network later.
 */
import { Observation } from './view.js';

export interface DeckModel {
  commander: string;
  archetype: 'turbo' | 'midrange' | 'stax' | 'control' | 'farm';
  winConditions: string[];   // card names that win the game
  comboPieces: string[];     // cards that assemble wins
  interaction: string[];     // counterspells + removal names
  fastMana: string[];        // crypt, sol ring, rituals...
  tutors: string[];
  cardAdvantage: string[];   // remora, study, necro...
}

export interface Evaluation {
  score: number; // ~ win probability 0..1 for the observer
  features: Record<string, number>;
  notes: string[];
}

const inHand = (obs: Observation, names: string[]) =>
  obs.hand.filter((c) => names.includes(c.name)).length;

export function evaluate(obs: Observation, model: DeckModel): Evaluation {
  const f: Record<string, number> = {};
  const notes: string[] = [];
  f.manaAvailable = Object.values(obs.manaPool).reduce((a, b) => a + b, 0)
    + obs.battlefield.filter((b) => b.controller === obs.self && !b.tapped).length;
  f.handSize = obs.hand.length;
  f.life = obs.life[obs.self];
  f.comboPiecesInHand = inHand(obs, model.comboPieces);
  f.winConInHand = inHand(obs, model.winConditions);
  f.interactionInHand = inHand(obs, model.interaction);
  f.fastManaInHand = inHand(obs, model.fastMana);
  f.tutorsInHand = inHand(obs, model.tutors);
  f.enginesOnBoard = obs.battlefield.filter((b) =>
    b.controller === obs.self && model.cardAdvantage.includes(b.name)).length;
  f.opponentEngines = obs.battlefield.filter((b) =>
    b.controller !== obs.self && model.cardAdvantage.includes(b.name)).length;
  f.maxOpponentHand = Math.max(...obs.opponents.map((o) => o.handCount), 0);
  f.tappedOutOpponents = obs.opponents.filter((o) => o.tappedOut).length;

  // logistic-ish blend into 0..1
  let z = -1.2
    + 0.35 * f.manaAvailable
    + 0.30 * f.handSize
    + 0.9 * f.comboPiecesInHand
    + 1.4 * f.winConInHand
    + 0.5 * f.interactionInHand
    + 0.4 * f.fastManaInHand
    + 0.6 * f.tutorsInHand
    + 0.8 * f.enginesOnBoard
    - 0.9 * f.opponentEngines
    - 0.15 * f.maxOpponentHand
    + 0.3 * f.tappedOutOpponents
    + (f.life >= 30 ? 0.3 : f.life >= 15 ? 0 : -0.6);
  const score = 1 / (1 + Math.exp(-z));
  if (f.winConInHand > 0 && f.comboPiecesInHand > 0) notes.push('holding win condition + enabler');
  if (f.opponentEngines > 0) notes.push('opponent card-advantage engine online');
  if (f.tappedOutOpponents === obs.opponents.length && obs.opponents.length > 0) notes.push('all opponents tapped out — window open');
  return { score, features: f, notes };
}

/** Mulligan scoring: keep if score above threshold (adjusted by mulligans taken). */
export function mulliganScore(obs: Observation, model: DeckModel, mulligansTaken: number): { keep: boolean; score: number; reasons: string[] } {
  const ev = evaluate(obs, model);
  const reasons: string[] = [];
  let score = ev.score;
  // cEDH heuristics
  const lands = obs.hand.filter((c) => c.def.types.includes('land')).length;
  const accel = ev.features.fastManaInHand;
  if (lands + accel === 0) { score -= 0.5; reasons.push('no mana sources'); }
  if (lands >= 2 && accel >= 1) { score += 0.15; reasons.push('land + acceleration'); }
  if (ev.features.interactionInHand > 0) { score += 0.1; reasons.push('has interaction'); }
  if (ev.features.tutorsInHand > 0) { score += 0.12; reasons.push('has tutor'); }
  if (ev.features.comboPiecesInHand >= 2) { score += 0.2; reasons.push('combo assembled'); }
  const threshold = 0.42 + mulligansTaken * 0.06; // mulligan more aggressively when deep... (Paris: lower bar as you go down cards)
  const keep = score >= threshold - mulligansTaken * 0.02;
  reasons.unshift(`score ${score.toFixed(2)} vs threshold ${threshold.toFixed(2)}`);
  return { keep, score, reasons };
}
