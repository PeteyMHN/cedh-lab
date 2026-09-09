/**
 * Policy: chooses actions from the Observation ONLY (never the true Game).
 * Every decision returns an Explanation — no hidden information may leak
 * into it (asserted by tests: explanations reference only observable data).
 */
import { Observation } from './view.js';
import { DeckModel, Evaluation, evaluate } from './eval.js';
import { LegalAction } from '../../engine/src/types.js';

export interface ConsideredAction { label: string; delta: number; note: string }
export interface Explanation {
  action: string;
  reasons: string[];
  considered: ConsideredAction[];
  evaluationBefore: number;
  evaluationAfter: number;
}

export interface Decision { action: LegalAction; explanation: Explanation }

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
  // Only instant-speed interaction can answer a spell: instants/flash from hand,
  // or activated abilities. Land drops and mana abilities are never responses.
  const responses = legal.filter((a) => {
    if (a.kind === 'activate') {
      if (a.detail && (a.detail as Record<string, unknown>).mana) return false;
      return true;
    }
    if (a.kind !== 'cast' || !a.objectId) return false;
    if (a.detail && (a.detail as Record<string, unknown>).land) return false;
    const card = obs.hand.find((c) => c.id === a.objectId);
    return !!card && (card.def.types.includes('instant') || card.def.keywords.includes('flash'));
  });
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
export function chooseMainPhaseAction(obs: Observation, model: DeckModel, legal: LegalAction[]): Decision | null {
  const before = evaluate(obs, model);
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
