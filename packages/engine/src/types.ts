/**
 * Core domain types for the cEDH rules engine.
 * The engine is deterministic, event-sourced, and pure: no I/O in core.
 * Port path: this package is designed to be compilable to Rust/WASM later.
 */

export type Zone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'stack' | 'command';

export type Phase =
  | 'untap' | 'upkeep' | 'draw'
  | 'precombatMain'
  | 'beginCombat' | 'declareAttackers' | 'declareBlockers' | 'combatDamage' | 'endCombat'
  | 'postcombatMain'
  | 'endStep' | 'cleanup';

export type Color = 'W' | 'U' | 'B' | 'R' | 'G';
export type ManaSymbol = Color | 'C' | 'X' | string; // string covers generic numerals

export interface ManaCost { generic: number; colored: Partial<Record<Color, number>>; x?: boolean }

export type CardType = 'creature' | 'instant' | 'sorcery' | 'artifact' | 'enchantment' | 'planeswalker' | 'land' | 'battle';

export interface AbilityDef {
  kind: 'activated' | 'triggered' | 'static' | 'mana';
  /** machine-readable hook name, e.g. ON_ETB, ON_UPKEEP, ON_CAST */
  hook?: string;
  text: string;
}

/** Oracle-level card identity (NOT a printing). */
export interface CardDefinition {
  oracleId: string;
  name: string;
  manaCost?: string;
  cmc: number;
  types: CardType[];
  subtypes: string[];
  supertypes: string[];
  colors: Color[];
  colorIdentity: Color[];
  power?: string;
  toughness?: string;
  oracleText: string;
  keywords: string[];
  abilities: AbilityDef[];
  legalities: Record<string, 'legal' | 'not_legal' | 'banned' | 'restricted'>;
}

/** A concrete game object (card instance, token, or copy). */
export interface GameObject {
  id: string;
  cardName: string;
  oracleId: string;
  controller: number; // player index
  owner: number;
  zone: Zone;
  tapped: boolean;
  summoningSick: boolean;
  counters: Record<string, number>;
  attachedTo?: string;
  faceDown?: boolean;
  /** for copies of spells on the stack */
  copyOf?: string;
  power?: number;
  toughness?: number;
  damageMarked?: number;
  /** CR 111: token marker. Tokens cease to exist when leaving the battlefield. */
  isToken?: boolean;
  /** token blueprint key (e.g. 'treasure'), used to find its script */
  tokenKey?: string;
  /** token blueprint (types/power/toughness/colors) for engine-created tokens */
  tokenDef?: TokenDef;
  /** cards imprinted (Chrome Mox etc.): object ids in exile */
  imprinted?: string[];
  /** doesn't untap during its controller's untap step (Mana Vault) */
  skipUntap?: boolean;
}

export interface ManaPool { W: number; U: number; B: number; R: number; G: number; C: number }

export interface PlayerState {
  index: number;
  name: string;
  life: number;
  poison: number;
  hand: string[];      // object ids
  library: string[];   // object ids, [0] = top
  graveyard: string[];
  exile: string[];
  commandZone: string[];
  battlefield: string[];
  manaPool: ManaPool;
  /** restricted mana, e.g. Jeweled Lotus commander-only mana */
  restrictedMana: { commander: ManaPool };
  commanderIds: string[];
  commanderDamage: Record<string, number>; // dealt BY commander object id -> amount
  commanderCasts: Record<string, number>;  // object id -> times cast from command zone
  hasLost: boolean;
  mulligansTaken: number;
  maxHandSize: number;
}

export type StepOrPhase = Phase;

/** An attack declaration: which creature attacks which player. */
export interface AttackDeclaration { attacker: string; defender: number; }

export interface TurnState {
  number: number;
  activePlayer: number;
  phase: Phase;
  priorityPlayer: number | null;
  passedPriority: boolean[]; // per player, reset each priority round
  stack: StackObject[];
  landsPlayedThisTurn: Record<number, number>;
  spellsCastThisTurn: Record<number, string[]>;
  /** players who cannot cast spells this turn (Silence etc.) */
  cantCastSpells: number[];
  /** draws made during the current draw step, per player (Orcish Bowmasters) */
  drawStepDraws: Record<number, number>;
  /** opponents dealt combat damage this turn (Tymna): attacker-player -> defender-player -> total */
  combatDamageDealtTo: Record<number, Record<number, number>>;
  /** Esper Sentinel: opponents already taxed this turn */
  sentinelTaxed: Record<number, boolean>;
  /** combat declarations for the current combat phase */
  attackers: AttackDeclaration[];
  /** block assignments for the current combat phase */
  blockers: { blocker: string; attacker: string }[];
  /** colors produced by the most recent mana ability resolution (Kinnan) */
  lastManaProduced: { player: number; colors: Color[] } | null;
}

/** Blueprint for Engine.createToken. */
export interface TokenDef {
  name: string;
  types: CardType[];
  subtypes?: string[];
  power?: string;
  toughness?: string;
  colors?: Color[];
  keywords?: string[];
  /** key into the engine's token script registry (abilities like Treasure's) */
  scriptKey?: string;
}

export interface StackObject {
  id: string;
  kind: 'spell' | 'triggered' | 'activated' | 'copy';
  sourceId: string;      // object id of card/ability source
  cardName: string;
  controller: number;
  targets: string[];     // object ids or `player:<n>`
  modes: number[];
  xValue?: number;
  stormCount?: number;
  namedCard?: string;    // e.g. Demonic Consultation
  detail?: Record<string, unknown>; // trigger-specific data (e.g. { caster })
  abilityIndex?: number; // for kind 'activated': index into the source's abilities
}

/** Every mutation of game state is a GameEvent. Hash-chained for replay integrity. */
export interface GameEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface LegalAction {
  kind: 'cast' | 'activate' | 'pass' | 'choice' | 'special' | 'attack' | 'block' | 'mulligan' | 'shortcut';
  label: string;
  objectId?: string;
  abilityIndex?: number;
  choiceId?: string;
  detail?: Record<string, unknown>;
}
