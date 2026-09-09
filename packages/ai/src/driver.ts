/**
 * driver.ts — the full autonomous game loop.
 *
 * playGame(engine, policies, opts) runs a complete game: mulligans, turn/phase
 * advancement, priority rounds (policy queried per decision), choice answering,
 * until the game ends or the turn cap is hit.
 *
 * Safety invariants:
 * - Every action is validated against `legalActionsFor(seat)` IMMEDIATELY
 *   before applying. A policy proposing an illegal action is logged, counted,
 *   and replaced with a pass. The engine never sees an illegal intent.
 * - Policies receive Observations only (never the Game). The driver itself
 *   touches public zones (stack ids for targeting) — that is public info.
 * - UnsupportedInteraction and any other throw inside a player's turn is
 *   caught: the player passes instead of crashing the game.
 * - Deterministic: no Math.random / Date.now anywhere in this file. The
 *   engine's seeded RNG is the only entropy source.
 * - Written against the v0.2 contract: all async engine calls are awaited
 *   (`resolveTop`, `castSpell`, `activateAbility`, `playLand`, `nextPhase`,
 *   `checkSbas`). In an async engine a synchronous throw inside an async
 *   method becomes a rejection — an un-awaited call would both miss the
 *   catch AND let `priority.actionTaken` run before the action happened.
 */
import { Engine } from '../../engine/src/engine.js';
import { ChoiceRequest, ChoiceSelection, UnsupportedInteraction } from '../../engine/src/choices.js';
import { LegalAction } from '../../engine/src/types.js';
import { applyLegalAction, matchesLegal } from './actions.js';
import { BeliefTracker } from './beliefs.js';
import { DeckModel, mulliganScore } from './eval.js';
import { chooseMainPhaseActionV2, chooseResponse, Decision } from './policy.js';
import { searchResponse } from './planner.js';
import { KnownCard, Observation, observe } from './view.js';

// ---------------------------------------------------------------------------
// Policy interface
// ---------------------------------------------------------------------------

export interface PolicyContext {
  seat: number;
  memory: Map<number, KnownCard[]>;
  beliefs: BeliefTracker;
  deckModels: Map<number, DeckModel>;
  stats: DriverStats;
}

export interface Policy {
  readonly model: DeckModel;
  decideMulligan(obs: Observation, mulligansTaken: number): boolean;
  decidePriority(obs: Observation, legal: LegalAction[], ctx: PolicyContext): Decision | null | Promise<Decision | null>;
  decideMainPhase(obs: Observation, legal: LegalAction[], ctx: PolicyContext): Decision | null | Promise<Decision | null>;
  decideChoice?(req: ChoiceRequest): ChoiceSelection;
}

export interface HeuristicPolicyOpts {
  /** Use 1-ply search for stack-war responses (default true). */
  useSearch?: boolean;
}

/** The default AI: heuristic policies + beliefs + optional 1-ply search. */
export class HeuristicPolicy implements Policy {
  constructor(readonly model: DeckModel, private opts: HeuristicPolicyOpts = {}) {}

  decideMulligan(obs: Observation, mulligansTaken: number): boolean {
    return mulliganScore(obs, this.model, mulligansTaken).keep;
  }

  decidePriority(obs: Observation, legal: LegalAction[], ctx: PolicyContext): Decision | null {
    return chooseResponse(ctx.beliefs.patch(obs), this.model, legal, ctx.deckModels);
  }

  decideMainPhase(obs: Observation, legal: LegalAction[], ctx: PolicyContext): Decision | null {
    return chooseMainPhaseActionV2(ctx.beliefs.patch(obs), this.model, legal);
  }

  decideChoice(req: ChoiceRequest): ChoiceSelection {
    return defaultChoice(req);
  }

  get useSearch(): boolean { return this.opts.useSearch ?? true; }
}

/** Deterministic default for a choice request: first legal option / falsy. */
export function defaultChoice(req: ChoiceRequest): ChoiceSelection {
  switch (req.kind) {
    case 'yesNo': return { kind: 'yesNo', value: false };
    case 'number': return { kind: 'number', value: req.min ?? 0 };
    case 'player': return { kind: 'player', player: req.player };
    case 'card': return { kind: 'card', cardId: req.options?.find((o) => !o.disabled)?.id ?? '' };
    case 'cards': {
      const ids = (req.options ?? []).filter((o) => !o.disabled).slice(0, Math.max(req.min ?? 1, 1)).map((o) => o.id);
      return { kind: 'cards', cardIds: ids };
    }
    case 'option': return { kind: 'option', index: 0 };
    case 'order':
    case 'color':
    default: return { kind: 'option', index: 0 };
  }
}

// ---------------------------------------------------------------------------
// Result + stats
// ---------------------------------------------------------------------------

export interface DriverStats {
  illegalProposals: number;   // policy proposed an action not in the legal list
  applyFailures: number;      // legal action rejected by the engine on apply
  abortedPlans: number;       // compound plan step stopped validating mid-plan
  unsupportedPauses: number;  // UnsupportedInteraction caught
  perSeatIllegal: Map<number, number>;
  log: string[];
}

export interface GameResult {
  winners: number[];
  draw: boolean;
  turns: number;
  events: number;
  chainValid: boolean;
  illegalActions: number;
  applyFailures: number;
  abortedPlans: number;
  log: string[];
}

export interface PlayGameOpts {
  turnCap?: number;      // default 60; exceeding ends the game as a draw
  mulliganCap?: number;  // default 4 free-ish mulligans evaluated
  useSearch?: boolean;   // default true
}

function newStats(): DriverStats {
  return {
    illegalProposals: 0, applyFailures: 0, abortedPlans: 0, unsupportedPauses: 0,
    perSeatIllegal: new Map(), log: [],
  };
}

// ---------------------------------------------------------------------------
// Choice answering (contract §1): the driver installs a choicePolicy that
// routes each request to the choosing seat's Policy. drainChoices remains as
// a safety net in case a choice is left pending (e.g. a custom policy that
// defers without registering a resolver the AI can answer).
// ---------------------------------------------------------------------------

function installChoicePolicy(engine: Engine, policies: Map<number, Policy>): () => void {
  const prev = engine.choicePolicy;
  engine.choicePolicy = async (req: ChoiceRequest) => {
    const policy = policies.get(req.player);
    try {
      return policy?.decideChoice ? policy.decideChoice(req) : defaultChoice(req);
    } catch {
      return defaultChoice(req); // a policy must never break resolution
    }
  };
  return () => { engine.choicePolicy = prev; };
}

function drainChoices(engine: Engine, policies: Map<number, Policy>): void {
  let guard = 0;
  while (engine.game.pendingChoice && guard++ < 12) {
    const req = engine.game.pendingChoice;
    const policy = policies.get(req.player);
    const sel = policy?.decideChoice ? policy.decideChoice(req) : defaultChoice(req);
    try {
      engine.answerChoice(req.player, req.id, sel);
    } catch {
      break; // not answerable (no deferred resolver) — leave it pending
    }
  }
}

// ---------------------------------------------------------------------------
// One player's priority turn
// ---------------------------------------------------------------------------

interface TurnCtx {
  policies: Map<number, Policy>;
  memories: Map<number, Map<number, KnownCard[]>>;
  beliefs: Map<number, BeliefTracker>;
  deckModels: Map<number, DeckModel>;
  stats: DriverStats;
  useSearch: boolean;
}

function policyContext(seat: number, t: TurnCtx): PolicyContext {
  return {
    seat, memory: t.memories.get(seat)!, beliefs: t.beliefs.get(seat)!,
    deckModels: t.deckModels, stats: t.stats,
  };
}

function noteIllegal(t: TurnCtx, seat: number, msg: string): void {
  t.stats.illegalProposals++;
  t.stats.perSeatIllegal.set(seat, (t.stats.perSeatIllegal.get(seat) ?? 0) + 1);
  if (t.stats.log.length < 200) t.stats.log.push(`[illegal] seat ${seat}: ${msg}`);
}

async function playerTurn(engine: Engine, seat: number, t: TurnCtx): Promise<void> {
  const policy = t.policies.get(seat);
  const mem = t.memories.get(seat)!;
  const tracker = t.beliefs.get(seat)!;
  const ctx = policyContext(seat, t);

  try {
    // Beliefs go live before the decision: update from the fresh observation,
    // then patch it into the observation the policy sees.
    const fresh = observe(engine, seat, mem);
    tracker.update(fresh);
    const obs = tracker.patch(fresh);

    const legal = engine.legalActionsFor(seat);
    const phase = engine.game.turn.phase;
    const isMainPhaseTurn = (phase === 'precombatMain' || phase === 'postcombatMain') &&
      engine.game.turn.activePlayer === seat && engine.game.turn.stack.length === 0;

    let decision: Decision | null;
    if (!policy) {
      decision = null;
    } else if (isMainPhaseTurn) {
      decision = await policy.decideMainPhase(obs, legal, ctx);
    } else {
      decision = await policy.decidePriority(obs, legal, ctx);
      // 1-ply search upgrade for stack wars: bounded, snapshot-safe.
      if (t.useSearch && decision && obs.stack.length > 0 && policy instanceof HeuristicPolicy && policy.useSearch) {
        const searched = await searchResponse(engine, seat, obs, policy.model, legal, {
          model: policy.model, obs, memory: mem, deckModels: t.deckModels,
        });
        if (searched && searched.action.kind !== 'pass') decision = searched;
      }
    }

    if (!decision) {
      engine.priority.pass(seat);
      return;
    }

    // Validate the proposal, then execute plan steps in order, re-validating
    // each against the CURRENT legal list (taps change what's castable).
    const steps = decision.plan && decision.plan.length > 0 ? decision.plan : [decision.action];
    const first = matchesLegal(steps[0], legal);
    if (!first) {
      noteIllegal(t, seat, `proposed ${steps[0].label} not in legal list`);
      engine.priority.pass(seat);
      return;
    }
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const now = engine.legalActionsFor(seat);
      // Compound-plan optimization: after tapping some mana, the final cast
      // may already be affordable — skip the remaining taps (don't tap out
      // for no reason) and go straight to it.
      const last = steps[steps.length - 1];
      if (i < steps.length - 1 && last.kind === 'cast' && matchesLegal(last, now)) {
        i = steps.length - 2; // next iteration handles the final step
        continue;
      }
      const match = matchesLegal(step, now);
      if (!match) {
        t.stats.abortedPlans++;
        if (t.stats.log.length < 200) t.stats.log.push(`[plan-abort] seat ${seat}: ${step.label} no longer legal`);
        break;
      }
      try {
        await applyLegalAction(engine, seat, match, ctxBeliefModel(t, seat));
      } catch (e) {
        if (e instanceof UnsupportedInteraction) {
          t.stats.unsupportedPauses++;
          if (t.stats.log.length < 200) t.stats.log.push(`[unsupported] seat ${seat}: ${(e as Error).message}`);
        } else {
          t.stats.applyFailures++;
          if (t.stats.log.length < 200) t.stats.log.push(`[apply-fail] seat ${seat}: ${step.label}: ${(e as Error).message}`);
        }
        break;
      }
      drainChoices(engine, t.policies);
      if (engine.game.isOver) return;
    }
  } catch (e) {
    // Never crash the game on a player-turn error: log and pass.
    if (e instanceof UnsupportedInteraction) t.stats.unsupportedPauses++;
    else noteIllegal(t, seat, `turn error: ${(e as Error).message}`);
    if (t.stats.log.length < 200) t.stats.log.push(`[turn-error] seat ${seat}: ${(e as Error).message}`);
  }

  // If priority is still this player's (e.g. only mana abilities were used),
  // the turn's decision is complete: pass.
  if (engine.priority.currentPlayer() === seat && !engine.game.isOver) {
    try { engine.priority.pass(seat); } catch { /* already moved on */ }
  }
}

function ctxBeliefModel(t: TurnCtx, seat: number): DeckModel {
  const p = t.policies.get(seat);
  if (!p) throw new Error(`no policy for seat ${seat}`);
  return p.model;
}

// ---------------------------------------------------------------------------
// Priority round + phase machine
// ---------------------------------------------------------------------------

async function priorityRound(engine: Engine, t: TurnCtx): Promise<void> {
  engine.priority.startRound();
  let guard = 0;
  while (guard++ < 600) {
    if (engine.game.isOver) return;
    const p = engine.priority.currentPlayer();
    if (p === null) {
      if (engine.game.turn.stack.length === 0) return; // phase ends
      try {
        await engine.resolveTop();
      } catch (e) {
        t.stats.unsupportedPauses++;
        if (t.stats.log.length < 200) t.stats.log.push(`[resolve-error] ${(e as Error).message}`);
      }
      drainChoices(engine, t.policies);
      await engine.checkSbas();
      if (engine.game.isOver) return;
      engine.priority.startRound();
      continue;
    }
    await playerTurn(engine, p, t);
  }
  throw new Error('priority round guard tripped (600 iterations)');
}

// ---------------------------------------------------------------------------
// playGame
// ---------------------------------------------------------------------------

/**
 * Run a full game with one policy per seat. The engine must already exist
 * (constructed + triggerResolver wired); startGame must already have run
 * (hands drawn) — mulligans are handled here.
 */
export async function playGame(
  engine: Engine, policies: Map<number, Policy>, opts: PlayGameOpts = {},
): Promise<GameResult> {
  const turnCap = opts.turnCap ?? 60;
  const mulliganCap = opts.mulliganCap ?? 4;
  const useSearch = opts.useSearch ?? true;
  const stats = newStats();
  const seats = engine.game.players.map((p) => p.index);
  const deckModels = new Map<number, DeckModel>();
  for (const s of seats) {
    const pol = policies.get(s);
    if (pol) deckModels.set(s, pol.model);
  }
  const t: TurnCtx = {
    policies,
    memories: new Map(seats.map((s) => [s, new Map<number, KnownCard[]>()])),
    beliefs: new Map(seats.map((s) => [s, new BeliefTracker(s, seats, deckModels)])),
    deckModels, stats, useSearch,
  };
  const restoreChoicePolicy = installChoicePolicy(engine, policies);

  // ---- mulligans (sequential seat order; Paris) ----
  for (const seat of seats) {
    const policy = policies.get(seat);
    if (!policy) continue;
    let taken = 0;
    while (taken < mulliganCap) {
      const obs = observe(engine, seat, t.memories.get(seat)!);
      if (policy.decideMulligan(obs, taken)) break;
      engine.game.mulligan(seat);
      taken++;
      if (stats.log.length < 200) stats.log.push(`[mulligan] seat ${seat} takes mulligan ${taken}`);
    }
  }

  // ---- main loop ----
  try {
    let guard = 0;
    while (!engine.game.isOver) {
      if (engine.game.turn.number > turnCap) break;
      if (guard++ > 20000) throw new Error('game loop guard tripped');
      const phase = engine.game.turn.phase;
      if (engine.turns.grantsPriority(phase)) {
        await priorityRound(engine, t);
        if (engine.game.isOver) break;
      }
      await engine.turns.nextPhase();
    }
  } finally {
    restoreChoicePolicy();
  }

  const draw = !engine.game.isOver;
  return {
    winners: draw ? [] : [...engine.game.winners],
    draw,
    turns: engine.game.turn.number,
    events: engine.game.events.length,
    chainValid: engine.game.verifyChain(),
    illegalActions: stats.illegalProposals,
    applyFailures: stats.applyFailures,
    abortedPlans: stats.abortedPlans,
    log: stats.log,
  };
}
