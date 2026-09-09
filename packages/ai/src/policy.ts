/**
 * Policy: chooses actions from the Observation ONLY (never the true Game).
 * Every decision returns an Explanation — no hidden information may leak
 * into it (asserted by tests: explanations reference only observable data).
 */
import { Observation } from './view.js';
import { DeckModel, Evaluation, evaluate } from './eval.js';
import { LegalAction } from '../../engine/src/types.js';
import { planManaThenCast } from './planner.js';

export interface ConsideredAction { label: string; delta: number; note: string }
export interface Explanation {
  action: string;
  reasons: string[];
  considered: ConsideredAction[];
  evaluationBefore: number;
  evaluationAfter: number;
}

/**
 * A decision is a single action, or a multi-step plan executed in order.
 * When `plan` is present, the driver executes every step, re-validating each
 * against the fresh legal list (the final cast is only legal after the taps).
 */
export interface Decision { action: LegalAction; plan?: LegalAction[]; explanation: Explanation }

/**
 * Which legal actions can answer a spell on the stack: instants/flash from
 * hand, non-mana activated abilities, or the Force of Will alternate-cost
 * synthetic action. Land drops and mana abilities are never responses.
 */
export function legalResponses(obs: Observation, legal: LegalAction[]): LegalAction[] {
  return legal.filter((a) => {
    if (a.kind === 'activate') {
      if (a.detail && (a.detail as Record<string, unknown>).mana) return false;
      return true;
    }
    if (a.kind !== 'cast' || !a.objectId) return false;
    const detail = (a.detail ?? {}) as Record<string, unknown>;
    if (detail.land) return false;
    if (detail.altCost === 'force-of-will') return true; // synthetic, pre-vetted by driver
    const card = obs.hand.find((c) => c.id === a.objectId);
    return !!card && (card.def.types.includes('instant') || card.def.keywords.includes('flash'));
  });
}

/**
 * Priority decision: which response (if any) to a spell on the stack.
 * cEDH policy highlights:
 * - don't waste interaction another player is incentivized to answer ("pass the buck")
 * - counter win attempts, not value, when resources are thin
 * - tapped-out opponents can't punish you for tapping out
 */
export function chooseResponse(
  obs: Observation, model: DeckModel, legal: LegalAction[],
  deckModels: Map<number, DeckModel>,
): Decision | null {
  const before = evaluate(obs, model);
  const top = obs.stack[obs.stack.length - 1];
  if (!top) return null;
  const responses = legalResponses(obs, legal);
  const pass: LegalAction = { kind: 'pass', label: 'Pass priority' };

  // Is the top of stack a win attempt? Check against the caster's known win conditions.
  const casterModel = deckModels.get(top.controller);
  const isWinCon = !!casterModel && (casterModel.winConditions.includes(top.cardName) || casterModel.comboPieces.includes(top.cardName));
  const winsGameOnResolve = isWinCon; // refined by board-state checks in full impl

  // Who else could answer? An opponent holding interaction AND incentivized (not the caster).
  const othersCanAnswer = obs.opponents.some((o) =>
    o.player !== top.controller && o.pInteraction > 0.45 && !o.tappedOut);

  const considered: ConsideredAction[] = [];
  let best: LegalAction = pass;
  let bestDelta = 0;
  const reasons: string[] = [];

  for (const r of responses) {
    // estimate: countering a win attempt is worth a lot; countering value is marginal
    let delta = winsGameOnResolve ? 0.35 : 0.04;
    if (othersCanAnswer && !winsGameOnResolve) delta -= 0.06; // let them spend it
    if (othersCanAnswer && winsGameOnResolve) delta -= 0.12; // chicken: someone else might still answer
    delta -= 0.03; // card disadvantage of spending interaction
    considered.push({ label: r.label, delta, note: winsGameOnResolve ? 'answers win attempt' : 'answers value' });
    if (delta > bestDelta) { bestDelta = delta; best = r; }
  }
  considered.push({ label: 'Pass priority', delta: 0, note: othersCanAnswer ? 'another player is incentivized to answer' : 'preserve resources' });

  if (winsGameOnResolve) reasons.push(`${top.cardName} is a win attempt for ${casterModel?.commander ?? 'opponent'}`);
  if (othersCanAnswer) reasons.push('another opponent is incentivized to answer — passing the buck');
  else reasons.push('no other opponent likely to answer');
  if (best.kind === 'pass') reasons.push('preserving interaction has higher expected value');

  const after = before.score + (best.kind === 'pass' ? 0 : bestDelta);
  return {
    action: best,
    explanation: {
      action: best.label,
      reasons,
      considered,
      evaluationBefore: before.score,
      evaluationAfter: Math.max(0, Math.min(1, after)),
    },
  };
}

/** Opening sequencing: play land, then the highest-EV spell. Kept simple; MCTS plugs in here. */
export function chooseMainPhaseAction(obs: Observation, model: DeckModel, legal: LegalAction[]): Decision | null {  const before = evaluate(obs, model);
  const nonPass = legal.filter((a) => a.kind !== 'pass');
  if (nonPass.length === 0) return null;
  // priority: land > fast mana > engine > tutor > hold interaction
  const rank = (a: LegalAction): number => {
    if (a.detail && (a.detail as Record<string, unknown>).land) return 100;
    const name = a.label;
    if (model.fastMana.some((f) => name.includes(f))) return 80;
    if (model.cardAdvantage.some((f) => name.includes(f))) return 70;
    if (model.tutors.some((f) => name.includes(f))) return 60;
    if (model.interaction.some((f) => name.includes(f))) return 10; // hold it
    return 50;
  };
  const sorted = [...nonPass].sort((a, b) => rank(b) - rank(a));
  const best = sorted[0];
  return {
    action: best,
    explanation: {
      action: best.label,
      reasons: [`highest sequencing priority (rank ${rank(best)})`, 'interaction held for opponent windows'],
      considered: sorted.slice(0, 3).map((a) => ({ label: a.label, delta: 0, note: `rank ${rank(a)}` })),
      evaluationBefore: before.score,
      evaluationAfter: before.score,
    },
  };
}

/**
 * Main-phase policy v2: sequencing with compound planning.
 *
 * Priority: land > win condition > fast mana > combo piece > card advantage >
 * tutor (only with a real target in mind) > anything else > hold interaction.
 *
 * Spells that are timing-legal but not yet affordable are considered via
 * planManaThenCast: the decision carries the full tap-then-cast plan and the
 * driver executes it step by step. Interaction is held for opponent windows
 * unless casting it wins the game now.
 */
export function chooseMainPhaseActionV2(
  obs: Observation, model: DeckModel, legal: LegalAction[],
): Decision | null {
  const before = evaluate(obs, model);
  const isMainPhase = obs.phase === 'precombatMain' || obs.phase === 'postcombatMain';
  if (!isMainPhase) return null;

  const inHandNames = new Set(obs.hand.map((c) => c.name));
  const comboInHand = model.comboPieces.filter((n) => inHandNames.has(n)).length;
  const winInHand = model.winConditions.filter((n) => inHandNames.has(n)).length;

  interface Candidate { steps: LegalAction[]; rank: number; note: string }
  const candidates: Candidate[] = [];

  const rankByName = (name: string): number => {
    if (model.winConditions.some((w) => name.includes(w))) return 95;  // go for the win
    if (model.fastMana.some((f) => name.includes(f))) return 80;
    if (model.comboPieces.some((c) => name.includes(c))) return 75;
    if (model.cardAdvantage.some((f) => name.includes(f))) return 70;
    if (model.tutors.some((f) => name.includes(f))) {
      // only tutor with a real target: something missing that we actually want
      const missing = [...model.winConditions, ...model.comboPieces].some((n) => !inHandNames.has(n));
      return missing && comboInHand + winInHand < 2 ? 60 : 5;
    }
    if (model.interaction.some((f) => name.includes(f))) return 10; // hold it
    return 50;
  };

  const mainPhaseTiming = (oracleId: string, types: string[], keywords: string[]): boolean => {
    if (types.includes('land')) return true;
    if (types.includes('instant') || keywords.includes('flash')) return true;
    // sorcery speed: active player, main phase, empty stack
    return obs.activePlayer === obs.self && obs.stack.length === 0;
  };

  for (const card of obs.hand) {
    if (!mainPhaseTiming(card.oracleId, card.def.types, card.def.keywords)) continue;
    const name = card.name;
    if (card.def.types.includes('land')) {
      const landAction = legal.find((a) => a.kind === 'cast' && a.objectId === card.id &&
        (a.detail as Record<string, unknown> | undefined)?.land === true);
      if (landAction) candidates.push({ steps: [landAction], rank: 100, note: 'land drop' });
      continue;
    }
    const rank = rankByName(name);
    if (rank <= 10) continue; // held interaction / pointless tutor
    const direct = legal.find((a) => a.kind === 'cast' && a.objectId === card.id &&
      !(a.detail as Record<string, unknown> | undefined)?.land);
    if (direct) {
      candidates.push({ steps: [direct], rank, note: 'cast from pool' });
    } else {
      // Not affordable yet: can we tap into it? One compound decision.
      const plan = planManaThenCast(obs, legal, card.id);
      if (plan) candidates.push({ steps: plan, rank: rank - 5, note: 'tap-then-cast plan' });
    }
  }

  // Non-mana activated abilities at sorcery-ish timing (rare in v1 pool; skip).

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.rank - a.rank);
  const best = candidates[0];
  const action = best.steps[0];
  const plan = best.steps.length > 1 ? best.steps : undefined;
  return {
    action,
    plan,
    explanation: {
      action: best.steps[best.steps.length - 1].label,
      reasons: [`highest sequencing priority (rank ${best.rank})`, best.note, 'interaction held for opponent windows'],
      considered: candidates.slice(0, 3).map((c) => ({
        label: c.steps[c.steps.length - 1].label, delta: 0, note: `rank ${c.rank} — ${c.note}`,
      })),
      evaluationBefore: before.score,
      evaluationAfter: before.score,
    },
  };
}
