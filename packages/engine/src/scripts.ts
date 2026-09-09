/**
 * CardScript: behavior contract every card implementation satisfies.
 * The engine core is generic; ALL card-specific logic lives in scripts.
 * Scripts are pure w.r.t. legality: they receive the ScriptApi and may only
 * mutate through engine methods (which validate + emit events).
 * Type-only imports: no runtime cycle with the cards package.
 */
import type { Game } from './game.js';
import type { GameObject, StackObject } from './types.js';
import type { ManaSystem } from './mana.js';
import type { StackSystem } from './stack.js';
import type { Engine } from './engine.js';
import type { ChoiceRequestInit, ChoiceSelection } from './choices.js';
import type { ReplacementEffect } from './replacements.js';

/** Everything a card script may touch. Scripts must ONLY mutate via these. */
export interface ScriptApi {
  game: Game;
  mana: ManaSystem;
  stack: StackSystem;
  cards: CardRegistryLike;
  engine: Engine;
  /** Request a decision from a player (async; routes through Engine.choicePolicy). */
  askChoice(req: ChoiceRequestInit): Promise<ChoiceSelection>;
  /** Continuous/replacement effect registration. */
  effects: {
    addReplacement(fx: Omit<ReplacementEffect, 'id' | 'sourceId' | 'controller'>): string;
    removeReplacement(id: string): void;
    removeBySource(sourceId: string): void;
  };
}

export interface CostOpts {
  targets?: string[];
  modes?: number[];
  xValue?: number;
  alternativeCost?: string;
  /** card name chosen for effects like Demonic Consultation / tutors */
  namedCard?: string;
  /** which ability is being activated (index into script.abilities) */
  abilityIndex?: number;
}

export interface AbilityMeta { tapCost?: boolean; manaAbility?: boolean; }

export interface CardScript {
  abilities: AbilityMeta[];
  /** Pay all costs to cast/activate. May be async (choices like FoW pitch). Throw if unpayable. */
  payCosts?(api: ScriptApi, player: number, obj: GameObject, opts: CostOpts): Promise<void> | void;
  /** Additional on-cast actions (e.g. "as an additional cost"). */
  onCast?(api: ScriptApi, player: number, obj: GameObject, so: StackObject): void;
  /**
   * Resolution logic. May be async (choices). Throw only for truly
   * unsupported interactions (fail-safe: engine catches and pauses).
   */
  onResolve?(api: ScriptApi, controller: number, src: GameObject, so: StackObject): Promise<void> | void;
  /** Triggered abilities this permanent contributes while on the battlefield. */
  triggersFor?(api: ScriptApi, obj: GameObject): TriggerDef[];
  /** Replacement effects this permanent contributes while on the battlefield. */
  replacementsFor?(api: ScriptApi, obj: GameObject): Omit<ReplacementEffect, 'id' | 'sourceId' | 'controller'>[];
  /** Static/layer effects contributed while on the battlefield. */
  layerEffectsFor?(api: ScriptApi, obj: GameObject): unknown[];
  /**
   * "As this enters the battlefield" replacement-style setup (Mox Diamond,
   * Chrome Mox imprint). Runs after the permanent is on the battlefield;
   * may move it elsewhere (e.g. sacrifice). Not an ETB trigger.
   */
  onEnterBattlefield?(api: ScriptApi, controller: number, obj: GameObject): Promise<void> | void;
  /** Is this target legal for a spell/ability from `controller`? (hexproof etc. handled by engine first) */
  isLegalTarget?(api: ScriptApi, controller: number, targetId: string): boolean;
  /** Devotion contribution, e.g. { U: 2 } for Thassa's Oracle. */
  devotion?: Partial<Record<'W' | 'U' | 'B' | 'R' | 'G', number>>;
}

/** What the engine needs from the card database (implemented by packages/cards). */
export interface CardRegistryLike {
  get(oracleId: string): import('./types.js').CardDefinition;
  script(oracleId: string): CardScript;
  has(oracleId: string): boolean;
  all(): import('./types.js').CardDefinition[];
}

export interface TriggerDef {
  /** event type that may cause this trigger, e.g. 'CAST' */
  on: string;
  /** does this event cause the trigger for this object? (api is only { game } — no hidden info) */
  condition: (api: { game: Game }, obj: GameObject, payload: Record<string, unknown>) => boolean;
  /** build the stack object (targets chosen here; UI may need a choice prompt first).
   *  `id` and `sourceId` are injected by the trigger system. */
  make: (api: { game: Game }, obj: GameObject, payload: Record<string, unknown>) => Omit<StackObject, 'id' | 'kind' | 'sourceId'> & { kind: 'triggered' };
  /** human-readable description for the stack UI */
  describe: (api: { game: Game }, obj: GameObject) => string;
}
