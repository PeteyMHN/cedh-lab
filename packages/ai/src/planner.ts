/**
 * planner.ts — compound planning and shallow search.
 *
 * 1. planManaThenCast: produce [tap mana sources..., cast spell] as ONE policy
 *    decision, so the AI no longer needs pre-floated mana. The driver executes
 *    the steps in order, re-validating each against the fresh legal list; the
 *    final cast is validated only after the taps resolve.
 *
 * 2. searchResponse: 1-ply search for stack wars. Each legal response is
 *    applied to the live engine under snapshot/restore (RNG-neutral: the
 *    snapshot captures rng state), the resulting observation is evaluated,
 *    and the max-delta action wins. Limited to <= 8 candidates; falls back to
 *    the heuristic policy when wider.
 *
 * Search is used for priority responses (instants / activated abilities),
 * which never change trigger registrations, so snapshot/restore is exact.
 */
import { Engine } from '../../engine/src/engine.js';
import { LegalAction } from '../../engine/src/types.js';
import { ManaSystem } from '../../engine/src/mana.js';
import { applyLegalAction } from './actions.js';
import { DeckModel, evaluate } from './eval.js';
import { chooseResponse, ConsideredAction, Decision, Explanation, legalResponses } from './policy.js';
import { KnownCard, Observation, observe } from './view.js';

/**
 * Public rules knowledge: what mana well-known sources produce. This is card
 * text (public), not hidden information. Basics are CR 305.6; the rest are
 * the literal oracle text of scripted cards.
 */
const SOURCE_COLORS: Record<string, string[]> = {
  Island: ['U'], Plains: ['W'], Swamp: ['B'], Forest: ['G'],
  'Sol Ring': ['C', 'C'], 'Llanowar Elves': ['G'], 'Command Tower': ['U'],
};

/** Can the untapped mana sources + current pool plausibly pay `cost`? */
function colorFeasible(obs: Observation, taps: LegalAction[], cost: string): boolean {
  let parsed;
  try { parsed = ManaSystem.parseCost(cost); } catch { return true; } // unknown: don't block
  const pool: Record<string, number> = {};
  for (const [c, n] of Object.entries(obs.manaPool)) pool[c] = (pool[c] ?? 0) + (n as number);
  const byId = new Map(obs.battlefield.map((b) => [b.id, b]));
  for (const tap of taps) {
    const src = tap.objectId ? byId.get(tap.objectId) : undefined;
    const colors = (src && SOURCE_COLORS[src.name]) ?? ['C']; // unknown source: assume colorless
    for (const c of colors) pool[c] = (pool[c] ?? 0) + 1;
  }
  for (const c of ['W', 'U', 'B', 'R', 'G'] as const) {
    if ((pool[c] ?? 0) < (parsed.colored[c] ?? 0)) return false;
  }
  const total = (pool.W ?? 0) + (pool.U ?? 0) + (pool.B ?? 0) + (pool.R ?? 0) + (pool.G ?? 0) + (pool.C ?? 0);
  const coloredNeed = (['W', 'U', 'B', 'R', 'G'] as const).reduce((a, c) => a + (parsed.colored[c] ?? 0), 0);
  return total - coloredNeed >= parsed.generic;
}

/**
 * Build a tap-then-cast plan for a spell in hand. Returns null when there is
 * nothing to tap (caller should treat the spell as uncastable this turn).
 * The final cast step is synthetic: it is NOT in the current legal list and
 * must be re-validated by the driver after the taps.
 */
export function planManaThenCast(
  obs: Observation, legal: LegalAction[], spellObjectId: string,
): LegalAction[] | null {
  const spell = obs.hand.find((c) => c.id === spellObjectId);
  if (!spell) return null;
  // All currently-legal mana activations (engine already filters tapped /
  // summoning-sick sources).
  const taps = legal.filter((a) =>
    a.kind === 'activate' && ((a.detail ?? {}) as Record<string, unknown>).mana === true);
  if (taps.length === 0) return null;
  // Don't tap out for a spell we can't even color-feasibly pay.
  if (!colorFeasible(obs, taps, spell.def.manaCost ?? '')) return null;
  return [...taps, { kind: 'cast', label: `Cast ${spell.name}`, objectId: spellObjectId }];
}

export interface SearchContext {
  model: DeckModel;
  obs: Observation;
  memory: Map<number, KnownCard[]>;
  deckModels: Map<number, DeckModel>;
}

/**
 * 1-ply: try every legal response on a snapshot-clone, evaluate, pick max.
 * Returns null when there is nothing worth doing (caller passes).
 * The engine is always restored to the pre-search snapshot — even on throw.
 */
export async function searchResponse(
  engine: Engine, seat: number, obs: Observation, model: DeckModel,
  legal: LegalAction[], ctx: SearchContext,
): Promise<Decision | null> {
  const responses = legalResponses(obs, legal).filter((r) => r.kind !== 'pass');
  if (responses.length === 0) return null;
  // Too wide for 1-ply: fall back to the heuristic estimator.
  if (responses.length > 8) return chooseResponse(obs, model, legal, ctx.deckModels);

  const snap = engine.game.snapshot();
  try {
    const base = evaluate(observe(engine, seat, ctx.memory), model).score;
    let best: LegalAction | null = null;
    let bestDelta = 0.02; // must beat passing by a margin (card spent otherwise)
    const considered: ConsideredAction[] = [];
    for (const r of responses) {
      engine.game.restore(snap);
      try {
        await applyLegalAction(engine, seat, r, ctx.model);
        const after = evaluate(observe(engine, seat, ctx.memory), model).score;
        const delta = after - base;
        considered.push({ label: r.label, delta, note: '1-ply search over snapshot' });
        if (delta > bestDelta) { bestDelta = delta; best = r; }
      } catch {
        considered.push({ label: r.label, delta: -1, note: 'rejected on clone' });
      }
    }
    const pass: LegalAction = { kind: 'pass', label: 'Pass priority' };
    const action = best ?? pass;
    const explanation: Explanation = {
      action: action.label,
      reasons: best
        ? [`1-ply search: ${best.label} improves evaluation by +${bestDelta.toFixed(2)}`]
        : ['1-ply search: no response beats passing'],
      considered: [...considered, { label: pass.label, delta: 0, note: 'preserve resources' }],
      evaluationBefore: base,
      evaluationAfter: base + (best ? bestDelta : 0),
    };
    return { action, explanation };
  } finally {
    engine.game.restore(snap);
  }
}
