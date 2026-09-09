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

/** Everything a card script may touch. Scripts must ONLY mutate via these. */
export interface ScriptApi {
  game: Game;
  mana: ManaSystem;
  stack: StackSystem;
  cards: CardRegistryLike;
  engine: Engine;
}

export interface CostOpts {
  targets?: string[];
  modes?: number[];
  xValue?: number;
  alternativeCost?: string;
  /** card name chosen for effects like Demonic Consultation / tutors */
  namedCard?: string;
}

export interface AbilityMeta { tapCost?: boolean; manaAbility?: boolean; }

export interface CardScript {
  abilities: AbilityMeta[];
  /** Pay all costs to cast/activate. Throw if unpayable. */
  payCosts?(api: ScriptApi, player: number, obj: GameObject, opts: CostOpts): void;
  /** Additional on-cast actions (e.g. "as an additional cost"). */
  onCast?(api: ScriptApi, player: number, obj: GameObject, so: StackObject): void;
  /** Resolution logic. Throw only for truly unsupported interactions (fail-safe). */
  onResolve?(api: ScriptApi, controller: number, src: GameObject, so: StackObject): void;
  /** Triggered abilities this permanent contributes while on the battlefield. */
  triggersFor?(api: ScriptApi, obj: GameObject): TriggerDef[];
  /** Static/layer effects contributed while on the battlefield. */
  layerEffectsFor?(api: ScriptApi, obj: GameObject): unknown[];
  /** Devotion contribution, e.g. { U: 2 } for Thassa's Oracle. */
  devotion?: Partial<Record<'W' | 'U' | 'B' | 'R' | 'G', number>>;
}

/** What the engine needs from the card database (implemented by packages/cards). */
export interface CardRegistryLike {
  get(oracleId: string): import('./types.js').CardDefinition;
  script(oracleId: string): CardScript;
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
