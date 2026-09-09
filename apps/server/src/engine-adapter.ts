/**
 * engine-adapter.ts — async boundary between the server driver and the rules engine.
 *
 * The driver is written against the v0.2 interface contract (async resolution,
 * pendingChoice, answerChoice). The engine workstream is refactoring the engine
 * to async in parallel; until that lands, this adapter wraps the CURRENT SYNC
 * engine behind the async interface. When the async engine lands, replace
 * `adaptEngine` with a thin passthrough — the driver does not change.
 */
import type {
  ChoiceRequest,
  ChoiceSelection,
  Engine as SyncEngine,
  LegalAction,
} from '@cedh-lab/engine';

/**
 * Default choice policy per the v0.2 contract: picks the first legal option /
 * sensible default. Must never throw on a well-formed request. The engine
 * workstream will canonicalize this as `defaultChoicePolicy` in the engine;
 * when that lands, delegate to it.
 */
export async function defaultChoicePolicy(req: ChoiceRequest): Promise<ChoiceSelection> {
  switch (req.kind) {
    case 'card': {
      const first = req.options?.find((o) => !o.disabled) ?? req.options?.[0];
      if (!first) throw new Error('choice has no options');
      return { kind: 'card', cardId: first.id };
    }
    case 'cards': {
      const ids = (req.options ?? []).filter((o) => !o.disabled).map((o) => o.id);
      const n = Math.min(req.max ?? ids.length, ids.length);
      return { kind: 'cards', cardIds: ids.slice(0, Math.max(n, req.min ?? 0)) };
    }
    case 'option': {
      const idx = req.options?.findIndex((o) => !o.disabled) ?? -1;
      return { kind: 'option', index: idx >= 0 ? idx : 0 };
    }
    case 'number':
      return { kind: 'number', value: req.min ?? 0 };
    case 'yesNo':
      return { kind: 'yesNo', value: false };
    case 'player':
      return { kind: 'player', player: req.player };
    case 'color':
      return { kind: 'option', index: 0 };
    case 'order': {
      const ids = (req.options ?? []).map((o) => o.id);
      return { kind: 'cards', cardIds: ids };
    }
  }
}

export interface DriverEngine {
  /** The underlying engine (for game state reads, priority, etc.). */
  raw: SyncEngine;
  /** CR 608: resolve the top stack object. Async in the contract (choices round-trip). */
  resolveTop(): Promise<void>;
  /** Answer an outstanding choice. Validates; throws on invalid selection. */
  answerChoice(player: number, choiceId: string, selection: ChoiceSelection): Promise<void>;
  /** The choice currently awaiting a human answer, if any. */
  pendingChoice(): ChoiceRequest | null;
  /** Fallback policy: defaultChoicePolicy from the engine (never throws on well-formed req). */
  defaultChoice(req: ChoiceRequest): Promise<ChoiceSelection>;
  /** Engine-supported action entry points; throw UnsupportedEngineFeature if the
   *  current engine build lacks them (engine workstream will add). */
  declareAttackers(player: number, attackerIds: string[]): Promise<void>;
  declareBlockers(player: number, blocks: { blocker: string; attacker: string }[]): Promise<void>;
  createToken(player: number, def: { name: string; types: string[]; power?: number; toughness?: number; colors?: string[] }): Promise<string>;
}

export class UnsupportedEngineFeature extends Error {
  constructor(feature: string) {
    super(`engine feature not yet implemented: ${feature}`);
    this.name = 'UnsupportedEngineFeature';
  }
}

export function adaptEngine(engine: SyncEngine): DriverEngine {
  const raw = engine as SyncEngine & {
    pendingChoice?: ChoiceRequest | null;
    answerChoice?: (player: number, choiceId: string, sel: ChoiceSelection) => void | Promise<void>;
    declareAttackers?: (p: number, ids: string[]) => void | Promise<void>;
    declareBlockers?: (p: number, b: { blocker: string; attacker: string }[]) => void | Promise<void>;
    createToken?: (p: number, def: unknown) => string | Promise<string>;
  };

  return {
    raw: engine,

    async resolveTop(): Promise<void> {
      // Sync today; the async engine workstream will make this truly async.
      await Promise.resolve();
      const maybePromise = (engine as SyncEngine & { resolveTop(): boolean | Promise<boolean> }).resolveTop();
      if (maybePromise instanceof Promise) await maybePromise;
    },

    async answerChoice(player: number, choiceId: string, selection: ChoiceSelection): Promise<void> {
      if (typeof raw.answerChoice === 'function') {
        await raw.answerChoice(player, choiceId, selection);
        return;
      }
      throw new UnsupportedEngineFeature('answerChoice (engine workstream: choices.ts wiring)');
    },

    pendingChoice(): ChoiceRequest | null {
      return raw.pendingChoice ?? null;
    },

    async defaultChoice(req: ChoiceRequest): Promise<ChoiceSelection> {
      return defaultChoicePolicy(req);
    },

    async declareAttackers(player: number, attackerIds: string[]): Promise<void> {
      if (typeof raw.declareAttackers === 'function') { await raw.declareAttackers(player, attackerIds); return; }
      throw new UnsupportedEngineFeature('declareAttackers (engine workstream: combat)');
    },

    async declareBlockers(player: number, blocks: { blocker: string; attacker: string }[]): Promise<void> {
      if (typeof raw.declareBlockers === 'function') { await raw.declareBlockers(player, blocks); return; }
      throw new UnsupportedEngineFeature('declareBlockers (engine workstream: combat)');
    },

    async createToken(player: number, def: { name: string; types: string[]; power?: number; toughness?: number; colors?: string[] }): Promise<string> {
      if (typeof raw.createToken === 'function') return raw.createToken(player, def);
      throw new UnsupportedEngineFeature('createToken (engine workstream: tokens)');
    },
  };
}

/** Type-only helper so the driver never imports the sync signatures directly. */
export type { LegalAction };
