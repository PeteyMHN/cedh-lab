/**
 * driver.ts — GameRoom: the authoritative game driver.
 *
 * Owns one Engine, runs the priority loop, consults AI seats, defers human
 * choices over WebSockets, and broadcasts filtered events + per-seat views
 * after every mutation.
 *
 * Wired directly to the v0.2 async engine (packages/engine). The driver only
 * orchestrates: it maps client intents, validates against `legalActionsFor`,
 * installs the choicePolicy that routes choices to AI policies or deferred
 * human resolvers, and runs the priority loop. Rules semantics stay in the
 * engine — nothing here reimplements them.
 */
import { Engine, defaultChoicePolicy } from '@cedh-lab/engine';
import type {
  ChoicePolicy, ChoiceRequest, ChoiceSelection, GameEvent, LegalAction,
} from '@cedh-lab/engine';
import type { Registry } from '@cedh-lab/cards';
import {
  observe,
  HeuristicPolicy,
  BeliefTracker,
  applyLegalAction,
  matchesLegal,
} from '@cedh-lab/ai';
import type { DeckModel, KnownCard, Observation, PolicyContext, DriverStats } from '@cedh-lab/ai';
import type { GameAction, ServerMsg } from '@cedh-lab/protocol';
import { buildSeatView, filterEventForSeat, toWireEvent } from './views.js';

export interface SeatCallbacks {
  sendTo(seat: number, msg: ServerMsg): void;
  broadcast(msg: ServerMsg): void;
  onGameOver(winners: number[]): void;
}

export interface RoomOptions {
  podId: string;
  seats: { name: string; isAI: boolean }[];
  decks: { seat: number; list: string[]; commander?: string[] }[];
  seed: number;
  callbacks: SeatCallbacks;
  /** Human choice timeout; contract default 120s. Timers are not decision code. */
  choiceTimeoutMs?: number;
}

export class GameRoom {
  readonly podId: string;
  readonly engine: Engine;
  private readonly registry: Registry;
  private readonly cb: SeatCallbacks;
  private readonly aiSeats: Set<number>;
  private readonly deckModels = new Map<number, DeckModel>();
  private readonly policies = new Map<number, HeuristicPolicy>();
  private readonly beliefs = new Map<number, BeliefTracker>();
  private readonly memories = new Map<number, Map<number, KnownCard[]>>();
  private readonly choiceTimeoutMs: number;
  private readonly choiceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly stats: DriverStats = {
    illegalProposals: 0, applyFailures: 0, abortedPlans: 0,
    unsupportedPauses: 0, perSeatIllegal: new Map(), log: [],
  };

  private lastBroadcastSeq = -1;
  private pumpActive = false;
  private pumpQueued = false;
  private started = false;
  private finished = false;

  private constructor(engine: Engine, registry: Registry, opts: RoomOptions) {
    this.podId = opts.podId;
    this.engine = engine;
    this.registry = registry;
    this.cb = opts.callbacks;
    this.aiSeats = new Set(opts.seats.map((s, i) => (s.isAI ? i : -1)).filter((i) => i >= 0));
    this.choiceTimeoutMs = opts.choiceTimeoutMs ?? 120_000;
    const seats = opts.seats.map((_, i) => i);
    for (const d of opts.decks) {
      const model = modelForDeck(d.list, registry);
      this.deckModels.set(d.seat, model);
      this.memories.set(d.seat, new Map());
      if (this.aiSeats.has(d.seat)) {
        this.policies.set(d.seat, new HeuristicPolicy(model));
        this.beliefs.set(d.seat, new BeliefTracker(d.seat, seats, this.deckModels));
      }
    }
    // The engine owns the choice flow: askChoice sets game.pendingChoice, then
    // awaits this policy. AI seats decide inline; human seats pend until the
    // client answers via applyAction({kind:'answerChoice'}) or the timeout fires.
    this.engine.choicePolicy = this.choicePolicy;
  }

  static create(opts: RoomOptions, registry: Registry): GameRoom {
    const decksBySeat = new Map(opts.decks.map((d) => [d.seat, d]));
    const engine = new Engine(
      opts.seats.map((s, i) => ({
        name: s.name,
        deckOracleIds: decksBySeat.get(i)?.list ?? [],
        commanderOracleIds: decksBySeat.get(i)?.commander ?? [],
      })),
      registry,
      { seed: opts.seed },
    );
    return new GameRoom(engine, registry, opts);
  }

  isAI(seat: number): boolean { return this.aiSeats.has(seat); }
  get lastSeq(): number { return this.engine.game.events.length - 1; }

  /**
   * The room's choice policy (installed on the engine in the constructor).
   * AI seats answer inline via their HeuristicPolicy; human seats register a
   * deferred resolver answered later by `engine.answerChoice` (or the
   * deterministic timeout fallback). Never throws on a well-formed request.
   */
  private readonly choicePolicy: ChoicePolicy = async (req, game) => {
    if (this.isAI(req.player)) {
      const policy = this.policies.get(req.player);
      try {
        if (policy?.decideChoice) return policy.decideChoice(req);
      } catch {
        // A policy must never break resolution — fall through to the default.
      }
      return defaultChoicePolicy(req, game);
    }
    return this.deferHumanChoice(req);
  };

  /**
   * Pend a human choice: broadcast views (so the choosing seat sees
   * `pendingChoice`), register the engine resolver, and resolve on
   * `engine.answerChoice` — or on the deterministic default policy when
   * `choiceTimeoutMs` elapses.
   */
  private deferHumanChoice(req: ChoiceRequest): Promise<ChoiceSelection> {
    // game.pendingChoice is already set by askChoice; this broadcast carries it.
    this.broadcastViews();
    return new Promise<ChoiceSelection>((resolve) => {
      const timer = setTimeout(() => {
        this.choiceTimers.delete(req.id);
        // Fallback is the engine's default policy: deterministic, never throws
        // on a well-formed request. (Timers are orchestration, not decision code.)
        void defaultChoicePolicy(req, this.engine.game).then(resolve);
      }, this.choiceTimeoutMs);
      this.choiceTimers.set(req.id, timer);
      this.engine.registerChoiceResolver(req.id, (sel) => {
        const t = this.choiceTimers.get(req.id);
        if (t !== undefined) { clearTimeout(t); this.choiceTimers.delete(req.id); }
        resolve(sel);
      });
    });
  }

  // ---------------- lifecycle ----------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.engine.turns.startGame(0);
    if (this.engine.turns.grantsPriority(this.engine.game.turn.phase)) {
      this.engine.priority.startRound();
    }
    this.afterMutation();
    await this.pump();
  }

  // ---------------- human actions ----------------

  /** Apply one validated human action, then run the priority loop. Throws on illegal actions (state unchanged). */
  async applyAction(seat: number, action: GameAction): Promise<void> {
    const g = this.engine.game;
    if (g.isOver) throw new Error('game is over');
    if (g.players[seat]?.hasLost) throw new Error('you have lost this game');

    switch (action.kind) {
      case 'concede':
        g.lose(seat, 'conceded');
        break;
      case 'answerChoice': {
        // The engine validates against the pending request; invalid → throw,
        // game state unchanged. index.ts converts this to {t:'error'}.
        try {
          this.engine.answerChoice(seat, action.choiceId, action.selection);
        } catch (err) {
          throw new Error(`invalid choice: ${(err as Error).message}`);
        }
        break;
      }
      case 'pass':
        this.requirePriority(seat);
        this.engine.priority.pass(seat);
        break;
      case 'cast':
      case 'playLand':
      case 'activate': {
        this.requirePriority(seat);
        const legalAction = this.matchClientAction(seat, action);
        await this.applyEngineAction(seat, action, legalAction);
        break;
      }
      case 'declareAttackers':
      case 'declareBlockers':
        // Combat declarations are engine-driven: during the declare-attackers /
        // declare-blockers steps the engine asks for choices (arriving as
        // pendingChoice); the client answers with answerChoice. There is no
        // direct engine entry point to invoke.
        throw new Error('combat declarations are made by answering the pending choice during combat steps');
      default:
        throw new Error(`unknown action kind: ${(action as { kind: string }).kind}`);
    }
    this.afterMutation();
    await this.pump();
  }

  private requirePriority(seat: number): void {
    if (this.engine.priority.currentPlayer() !== seat) {
      throw new Error(`not your priority (CR 117) — priority is with seat ${this.engine.priority.currentPlayer()}`);
    }
  }

  /**
   * Map a client action onto the engine's own legal-action list. The client only
   * names intent (object id, ability index); legality comes from the engine.
   * Throws — without mutating — when the intent isn't currently legal.
   */
  private matchClientAction(seat: number, action: GameAction): LegalAction {
    const legal = this.engine.legalActionsFor(seat);
    const detail = (a: LegalAction): Record<string, unknown> => (a.detail ?? {}) as Record<string, unknown>;
    if (action.kind === 'cast') {
      const m = legal.find((a) => a.kind === 'cast' && a.objectId === action.card && !detail(a).land);
      if (!m) throw new Error(`illegal: ${action.card} is not legally castable right now`);
      return m;
    }
    if (action.kind === 'playLand') {
      const m = legal.find((a) => a.kind === 'cast' && a.objectId === action.card && !!detail(a).land);
      if (!m) throw new Error(`illegal: ${action.card} cannot be played as your land drop now`);
      return m;
    }
    if (action.kind === 'activate') {
      const m = legal.find(
        (a) => a.kind === 'activate' && a.objectId === action.source && (a.abilityIndex ?? 0) === action.ability,
      );
      if (!m) throw new Error(`illegal: that ability cannot be activated right now`);
      return m;
    }
    throw new Error(`unmappable action kind: ${(action as { kind: string }).kind}`);
  }

  /** Apply an already-validated human action. Client-supplied targets/modes are honored. */
  private async applyEngineAction(seat: number, action: GameAction, legalAction: LegalAction): Promise<void> {
    const id = legalAction.objectId!;
    if (action.kind === 'cast') {
      await this.engine.stack.castSpell(seat, id, {
        targets: action.targets,
        modes: action.modes,
        namedCard: action.namedCard,
        xValue: action.xValue,
      });
      this.engine.priority.actionTaken(seat);
      return;
    }
    if (action.kind === 'playLand') {
      await this.engine.playLand(seat, id);
      return;
    }
    if (action.kind === 'activate') {
      await this.engine.activateAbility(seat, id, legalAction.abilityIndex ?? 0, { targets: action.targets });
      const isMana = !!((legalAction.detail ?? {}) as Record<string, unknown>).mana;
      if (!isMana) this.engine.priority.actionTaken(seat);
      return;
    }
    throw new Error('unreachable');
  }

  // ---------------- the priority loop ----------------

  /**
   * Run priority/AI/resolution until a human must act or the game ends.
   * Re-entrancy safe. Choices are not polled here: they block inside
   * `resolveTop` via the installed choicePolicy, which pends the pump until
   * the human answers (answerChoice) or the timeout fires — the engine owns
   * the choice flow.
   */
  async pump(): Promise<void> {
    if (this.finished) return;
    if (this.pumpActive) { this.pumpQueued = true; return; }
    this.pumpActive = true;
    try {
      let guard = 0;
      while (!this.engine.game.isOver && guard++ < 20_000) {
        // 1. Priority round state
        const p = this.engine.priority.currentPlayer();
        if (p === null) {
          if (this.engine.game.turn.stack.length === 0) {
            if (!(await this.advancePhase())) break;
            continue;
          }
          await this.engine.resolveTop();
          this.afterMutation();
          continue;
        }
        if (this.engine.game.players[p].hasLost) {
          this.engine.priority.pass(p);
          continue;
        }
        if (this.isAI(p)) {
          await this.aiTakeTurn(p);
          continue;
        }
        // 2. Human must act: prompt + views, then wait.
        this.sendPrompt(p);
        break;
      }
      if (guard >= 20_000) {
        throw new Error('pump guard tripped — possible infinite loop; game paused for inspection');
      }
    } finally {
      this.pumpActive = false;
      if (this.pumpQueued && !this.finished) {
        this.pumpQueued = false;
        void this.pump();
      }
    }
  }

  private async advancePhase(): Promise<boolean> {
    const g = this.engine.game;
    if (g.isOver) return false;
    await this.engine.turns.nextPhase();
    this.afterMutation();
    if (this.engine.turns.grantsPriority(g.turn.phase)) {
      this.engine.priority.startRound();
    }
    return true;
  }

  // ---------------- AI ----------------

  /**
   * One AI priority instance. Delegates entirely to the AI package:
   * HeuristicPolicy decides (beliefs-patched observation), then each plan step
   * is re-validated with matchesLegal and applied with applyLegalAction.
   */
  private async aiTakeTurn(p: number): Promise<void> {
    const policy = this.policies.get(p);
    const tracker = this.beliefs.get(p);
    const mem = this.memories.get(p)!;
    const model = this.deckModels.get(p)!;
    if (!policy || !tracker) { this.engine.priority.pass(p); return; }

    const fresh = observe(this.engine, p, mem);
    tracker.update(fresh);
    const obs = tracker.patch(fresh);

    const g = this.engine.game;
    const isMain = g.turn.activePlayer === p &&
      (g.turn.phase === 'precombatMain' || g.turn.phase === 'postcombatMain') &&
      g.turn.stack.length === 0;
    const ctx: PolicyContext = {
      seat: p, memory: mem, beliefs: tracker, deckModels: this.deckModels, stats: this.stats,
    };
    const legal = this.engine.legalActionsFor(p);
    const decision = isMain
      ? await policy.decideMainPhase(obs, legal, ctx)
      : await policy.decidePriority(obs, legal, ctx);

    if (!decision || decision.action.kind === 'pass') {
      this.engine.priority.pass(p);
    } else {
      await this.applyAiPlan(p, model, decision.plan?.length ? decision.plan : [decision.action]);
    }
    this.afterMutation();
  }

  /** Execute an AI plan step by step; stop at the first invalidated step (never crash the loop). */
  private async applyAiPlan(p: number, model: DeckModel, steps: LegalAction[]): Promise<void> {
    for (const step of steps) {
      const match = matchesLegal(step, this.engine.legalActionsFor(p));
      if (!match) break;
      try {
        await applyLegalAction(this.engine, p, match, model);
      } catch {
        break; // engine rejected — stop the plan, keep the game moving
      }
    }
    // A plan of only mana abilities / land drops leaves priority with the AI: pass.
    if (this.engine.priority.currentPlayer() === p && !this.engine.game.isOver) {
      this.engine.priority.pass(p);
    }
  }

  // ---------------- broadcast ----------------

  /** Events since the last broadcast, per seat, sanitized. */
  eventsForSeat(seat: number, fromSeq = this.lastBroadcastSeq): ReturnType<typeof toWireEvent>[] {
    const g = this.engine.game;
    return g.events
      .filter((e) => e.seq > fromSeq)
      .map(toWireEvent)
      .map((e) => filterEventForSeat(e, seat, g));
  }

  /** Reconnect support: events the client missed. Empty if already caught up. */
  missedEvents(fromSeq: number): GameEvent[] {
    return this.engine.game.events.filter((e) => e.seq > fromSeq);
  }

  needsSnapshot(fromSeq: number): boolean {
    return this.lastSeq - fromSeq > 500;
  }

  private afterMutation(): void {
    const g = this.engine.game;
    if (this.lastBroadcastSeq < this.lastSeq) {
      for (let s = 0; s < g.players.length; s++) {
        const events = this.eventsForSeat(s);
        if (events.length > 0) {
          this.cb.sendTo(s, { t: 'events', fromSeq: this.lastBroadcastSeq, events });
        }
      }
      this.lastBroadcastSeq = this.lastSeq;
    }
    this.broadcastViews();
    if (g.isOver && !this.finished) {
      this.finished = true;
      const winners = g.winners;
      this.cb.broadcast({ t: 'gameOver', winners });
      this.cb.onGameOver(winners);
    }
  }

  private broadcastViews(): void {
    const g = this.engine.game;
    for (let s = 0; s < g.players.length; s++) {
      const view = buildSeatView(this.engine, s, this.memories.get(s)!);
      this.cb.sendTo(s, {
        t: 'view', seat: s, observation: view.observation, legal: view.legal,
        pendingChoice: view.pendingChoice,
      });
    }
  }

  /**
   * Re-send the priority prompt to a seat if the game is currently parked
   * waiting on that human seat's action (e.g. they connected after /start, or
   * reconnected and missed the prompt). Safe to call any time: no-ops unless
   * the room is genuinely awaiting this seat.
   */
  nudge(seat: number): void {
    const g = this.engine.game;
    if (g.isOver) return;
    if (this.isAI(seat)) return;
    if (g.pendingChoice) return; // choice flow prompts separately
    if (this.engine.priority.currentPlayer() !== seat) return;
    if (g.players[seat]?.hasLost) return;
    this.sendPrompt(seat);
  }

  private sendPrompt(seat: number): void {
    this.cb.sendTo(seat, { t: 'priority', seat });
    // Refresh that seat's view so the prompt carries fresh legal actions.
    const view = buildSeatView(this.engine, seat, this.memories.get(seat)!);
    this.cb.sendTo(seat, {
      t: 'view', seat, observation: view.observation, legal: view.legal,
      pendingChoice: view.pendingChoice,
    });
  }

  /** Per-seat snapshot for reconnect when >500 events behind. */
  snapshotFor(seat: number): { seq: number; view: ReturnType<typeof buildSeatView> } {
    return { seq: this.lastSeq, view: buildSeatView(this.engine, seat, this.memories.get(seat)!) };
  }
}

/** Heuristic deck model for an AI seat, derived from its list. Good enough for the slice policies. */
function modelForDeck(list: string[], registry: Registry): DeckModel {
  const names = new Set(list.map((id) => { try { return registry.get(id).name; } catch { return id; } }));
  const has = (...ns: string[]) => ns.some((n) => names.has(n));
  return {
    commander: 'Unknown',
    archetype: has("Thassa's Oracle", 'Demonic Consultation') ? 'turbo' : 'midrange',
    winConditions: ["Thassa's Oracle"].filter((n) => names.has(n)),
    comboPieces: ['Demonic Consultation', 'Tainted Pact'].filter((n) => names.has(n)),
    interaction: ['Counterspell', 'Force of Will', 'Swords to Plowshares', 'Flusterstorm', 'Mental Misstep'].filter((n) => names.has(n)),
    fastMana: ['Dark Ritual', 'Sol Ring', 'Mana Crypt', 'Chrome Mox', 'Mox Diamond'].filter((n) => names.has(n)),
    tutors: ['Demonic Tutor', 'Vampiric Tutor', 'Mystical Tutor'].filter((n) => names.has(n)),
    cardAdvantage: ['Mystic Remora', 'Rhystic Study', 'Brainstorm'].filter((n) => names.has(n)),
  };
}
