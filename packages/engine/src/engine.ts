/**
 * Engine: facade wiring all subsystems + the card registry.
 * Apps construct ONE Engine per game; it owns the Game and every system.
 *
 * Async throughout the resolution path (contract §1): choices can round-trip
 * to human clients over WebSockets. `choicePolicy` decides; the default picks
 * the first legal/sensible option and never throws on a well-formed request.
 */
import { Game, PlayerConfig } from './game.js';
import { TurnMachine } from './turns.js';
import { PrioritySystem } from './priority.js';
import { StackSystem, CastOptions } from './stack.js';
import { ManaSystem } from './mana.js';
import { SbaSystem } from './sba.js';
import { LayerSystem } from './layers.js';
import { CommanderSystem } from './commander.js';
import { TriggerSystem } from './triggers.js';
import { CardRegistryLike, CardScript, ScriptApi } from './scripts.js';
import {
  ChoicePolicy, ChoiceRequestInit, ChoiceSelection, defaultChoicePolicy,
  validateChoiceRequest, validateChoiceSelection,
} from './choices.js';
import { addReplacement, applyReplacements, GameEventCandidate, removeBySource } from './replacements.js';
import { combatPhaseHook } from './combat.js';
import { CardDefinition, Color, GameObject, LegalAction, StackObject, TokenDef } from './types.js';

export interface EngineOpts { seed: number | string; startingLife?: number; freeMulligans?: number }

export class Engine {
  game: Game;
  turns: TurnMachine;
  priority: PrioritySystem;
  stack: StackSystem;
  mana: ManaSystem;
  sba: SbaSystem;
  layers = new LayerSystem();
  commander: CommanderSystem;
  triggers: TriggerSystem;
  cards: CardRegistryLike;
  api: ScriptApi;
  /**
   * Decides "pay or not" for triggers like Rhystic Study / Mystic Remora.
   * (player, genericAmount, sourceName) => pay?
   * Apps/AI override this; default: never pay.
   */
  paymentPolicy: (player: number, genericAmount: number, source: string) => boolean = () => false;
  /**
   * Resolves triggered abilities' game actions. Set by the app (lives in the
   * cards package to keep the engine generic). Called after a triggered
   * ability finishes its stack resolution.
   */
  triggerResolver: ((api: ScriptApi, so: StackObject) => Promise<void> | void) | null = null;
  /**
   * Async choice policy (contract §1). Servers install a policy that pends on
   * the human client; tests/demos use the default.
   */
  choicePolicy: ChoicePolicy = defaultChoicePolicy;
  private choiceResolvers = new Map<string, (sel: ChoiceSelection) => void>();
  /** Token ability scripts, keyed by tokenKey (wired by the cards package). */
  tokenScripts = new Map<string, CardScript>();

  constructor(playerConfigs: PlayerConfig[], cards: CardRegistryLike, opts: EngineOpts) {
    this.cards = cards;
    this.game = new Game(playerConfigs, opts);
    this.turns = new TurnMachine(this.game);
    // Combat declarations + damage run at combat phase entry (turns.ts must not import Engine).
    this.turns.phaseHook = (ph) => combatPhaseHook(this.api, ph);
    this.priority = new PrioritySystem(this.game);
    this.mana = new ManaSystem(this.game);
    this.stack = new StackSystem(this.game, cards);
    this.sba = new SbaSystem(this.game);
    this.game.cardDb = cards;
    this.triggers = new TriggerSystem(this.game);
    this.commander = new CommanderSystem(this.game, this.mana,
      (oracleId) => {
        const def = cards.get(oracleId);
        const p = ManaSystem.parseCost(def.manaCost ?? '');
        return { generic: p.generic, colored: p.colored };
      });
    const engine = this;
    this.api = {
      game: this.game, mana: this.mana, stack: this.stack, cards, engine,
      askChoice: (req: ChoiceRequestInit) => engine.askChoice(req.player, req),
      effects: {
        addReplacement: (fx) => {
          const s = engine.effectSource;
          if (!s) throw new Error('addReplacement called outside permanent registration');
          return addReplacement(this.game, fx, s.sourceId, s.controller);
        },
        removeReplacement: (id) => {
          const i = this.game.replacements.findIndex((r) => r.id === id);
          if (i >= 0) this.game.replacements.splice(i, 1);
        },
        removeBySource: (sourceId) => removeBySource(this.game, sourceId),
      },
    };
    // addReplacement needs the registering permanent; capture via a stack discipline:
    // card scripts call api.effects.addReplacement during permanentEntered, where
    // Engine sets `currentEffectSource` first. Fallback: controller = -1 (never matches ordering).
    this.stack.api = this.api;
    this.stack.defFor = (o) => this.defFor(o);
    this.stack.scriptFor = (o) => this.scriptFor(o);
    this.game.triggers = this.triggers;
    this.game.putTriggerOnStack = (so: StackObject) => {
      this.game.turn.stack.push(so);
      this.game.emit('STACK_PUSH', { object: so.id, card: so.cardName, kind: so.kind, controller: so.controller });
    };
  }

  // ---------- script/def/token lookup (token-aware) ----------
  scriptFor(o: GameObject): CardScript {
    if (o.isToken && o.tokenKey) {
      const s = this.tokenScripts.get(o.tokenKey);
      if (!s) throw new Error(`no token script registered for key ${o.tokenKey}`);
      return s;
    }
    return this.cards.script(o.oracleId);
  }
  defFor(o: GameObject): CardDefinition {
    if (o.isToken && o.tokenDef) {
      const t = o.tokenDef;
      return {
        oracleId: o.oracleId, name: o.cardName, cmc: 0, types: t.types,
        subtypes: t.subtypes ?? [], supertypes: [], colors: t.colors ?? [],
        colorIdentity: [], power: t.power, toughness: t.toughness,
        oracleText: '', keywords: t.keywords ?? [], abilities: [], legalities: {},
      };
    }
    return this.cards.get(o.oracleId);
  }

  // ---------- choices (contract §1-2) ----------
  /**
   * Request a decision from a player. Sets game.pendingChoice while the
   * policy is thinking (server: the human client sees it). Validates the
   * policy's answer; invalid → throw, state unchanged.
   */
  async askChoice(player: number, init: ChoiceRequestInit): Promise<ChoiceSelection> {
    const g = this.game;
    if (init.player !== player) throw new Error('choice request player mismatch');
    const req = { ...init, id: g.nextChoiceId(), player };
    validateChoiceRequest(req, g.players.length);
    g.pendingChoice = req;
    // NOTE: options/labels are NOT emitted into the event log (hidden info).
    // The server sends the full pendingChoice only to the choosing seat.
    g.emit('CHOICE_REQUESTED', { id: req.id, player, kind: req.kind, prompt: req.prompt, optionCount: req.options?.length ?? 0 });
    let sel: ChoiceSelection;
    try {
      sel = await this.choicePolicy(req, g);
    } catch (e) {
      g.pendingChoice = null;
      throw e;
    }
    validateChoiceSelection(req, sel, g);
    g.pendingChoice = null;
    g.emit('CHOICE_MADE', { id: req.id, player, kind: sel.kind });
    return sel;
  }

  /**
   * Complete a pending human choice (server path). Validates first;
   * invalid → throw, game state unchanged.
   */
  answerChoice(player: number, choiceId: string, selection: ChoiceSelection): void {
    const req = this.game.pendingChoice;
    if (!req || req.id !== choiceId) throw new Error('no such pending choice');
    if (req.player !== player) throw new Error(`choice ${choiceId} belongs to player ${req.player}`);
    validateChoiceSelection(req, selection, this.game);
    const resolve = this.choiceResolvers.get(choiceId);
    if (!resolve) throw new Error('choice is not answerable (no deferred resolver registered)');
    this.choiceResolvers.delete(choiceId);
    resolve(selection);
  }

  /** Register a deferred resolver for a choice id (used by human-client policies). */
  registerChoiceResolver(choiceId: string, resolve: (sel: ChoiceSelection) => void): void {
    this.choiceResolvers.set(choiceId, resolve);
  }

  /** source/controller tracking for api.effects.addReplacement (set during permanentEntered) */
  effectSource: { sourceId: string; controller: number } | null = null;

  /** Register a permanent's triggers/static/replacement effects (call on ETB). */
  permanentEntered(objId: string): void {
    const o = this.game.getObject(objId);
    if (!o.isToken && o.cardName === o.oracleId) o.cardName = this.cards.get(o.oracleId).name;
    const script = this.scriptFor(o);
    if (script.triggersFor && this.triggers) {
      this.triggers.registerFor(objId, script.triggersFor(this.api, o));
    }
    if (script.replacementsFor) {
      this.effectSource = { sourceId: objId, controller: o.controller };
      try {
        for (const fx of script.replacementsFor(this.api, o)) {
          addReplacement(this.game, fx, objId, o.controller);
        }
      } finally {
        this.effectSource = null;
      }
    }
    this.game.emit('ETB', { object: objId, card: o.cardName, controller: o.controller });
  }

  permanentLeft(objId: string): void {
    this.triggers.unregister(objId);
    this.layers.removeBySource(objId);
    removeBySource(this.game, objId);
    this.game.emit('LTB', { object: objId });
  }

  /** Move a permanent from wherever it is onto the battlefield. */
  async enterBattlefield(objId: string, controller?: number): Promise<void> {
    const g = this.game;
    const o = g.getObject(objId);
    const c = controller ?? o.controller;
    // remove from current zone list
    if (o.zone === 'stack') {
      const i = g.turn.stack.findIndex((s) => s.id === objId || s.sourceId === objId);
      if (i >= 0) g.turn.stack.splice(i, 1);
    }
    g.moveZone(objId, 'battlefield', c);
    if (o.isToken) {
      const t = o.tokenDef;
      o.summoningSick = t?.types.includes('creature') ?? false;
      if (t?.power) o.power = parseInt(t.power);
      if (t?.toughness) o.toughness = parseInt(t.toughness);
    } else {
      if (o.cardName === o.oracleId) o.cardName = this.cards.get(o.oracleId).name;
      const def = this.cards.get(o.oracleId);
      if (def.power) o.power = parseInt(def.power);
      if (def.toughness) o.toughness = parseInt(def.toughness);
      o.summoningSick = def.types.includes('creature');
    }
    o.tapped = false;
    o.damageMarked = 0;
    this.permanentEntered(objId);
    // "as enters the battlefield" setup (Mox Diamond, Chrome Mox)
    await this.scriptFor(o).onEnterBattlefield?.(this.api, o.controller, o);
  }

  /** Create a token (CR 111) directly onto the battlefield. Returns object id. */
  async createToken(player: number, def: TokenDef): Promise<string> {
    const g = this.game;
    const key = def.scriptKey ?? def.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const o = g.makeObject(`token:${key}`, player, 'battlefield');
    o.isToken = true;
    o.tokenKey = def.scriptKey;
    o.tokenDef = def;
    o.cardName = def.name;
    o.controller = player;
    o.owner = player;
    g.players[player].battlefield.push(o.id);
    g.emit('TOKEN_CREATED', { player, object: o.id, name: def.name });
    await this.enterBattlefield(o.id, player);
    return o.id;
  }

  /** Activate an ability: mana abilities resolve immediately, others use the stack. */
  async activateAbility(player: number, sourceId: string, abilityIndex: number, opts: CastOptions = {}): Promise<void> {
    const o = this.game.getObject(sourceId);
    const script = this.scriptFor(o);
    const meta = script.abilities[abilityIndex];
    if (!meta) throw new Error('no such ability');
    if (o.tapped && meta.tapCost) throw new Error('cannot activate: tapped');
    if (meta.manaAbility) {
      const before = { ...this.game.players[player].manaPool };
      await script.payCosts?.(this.api, player, o, { ...opts, abilityIndex });
      // mana abilities resolve immediately, don't use the stack (CR 605)
      await script.onResolve?.(this.api, player, o, {
        id: `m${sourceId}:${abilityIndex}`, kind: 'activated', sourceId,
        cardName: o.cardName, controller: player, targets: [], modes: [],
      });
      this.game.emit('MANA_ABILITY', { player, source: sourceId, card: o.cardName });
      await this.maybeKinnan(player, sourceId, before);
    } else {
      await this.stack.activateAbility(player, sourceId, abilityIndex, opts);
    }
  }

  /**
   * Kinnan, Bonder Prodigy: whenever you tap a nonland permanent for mana,
   * add one mana of any type that permanent produced (triggered mana ability).
   */
  private async maybeKinnan(player: number, sourceId: string, before: Record<string, number>): Promise<void> {
    const g = this.game;
    const hasKinnan = g.players[player].battlefield.some((id) => g.getObject(id).oracleId === 'kinnan-bonder-prodigy');
    if (!hasKinnan) return;
    const src = g.getObject(sourceId);
    if (this.defFor(src).types.includes('land')) return;
    const after = g.players[player].manaPool;
    const produced: Color[] = [];
    for (const c of ['W', 'U', 'B', 'R', 'G'] as Color[]) {
      if (after[c] > (before[c] ?? 0)) produced.push(c);
    }
    if (produced.length === 0) return;
    const sel = await this.askChoice(player, {
      player,
      kind: 'color',
      prompt: 'Kinnan, Bonder Prodigy: add one mana of any type that permanent produced.',
      options: produced.map((c) => ({ id: c, label: c })),
    });
    if (sel.kind === 'color') {
      this.mana.add(player, sel.color, 1);
      g.emit('KINNAN_TRIGGER', { player, color: sel.color, source: sourceId });
    }
  }

  /** Search a library through replacement effects (Opposition Agent etc.). */
  async searchLibrary(player: number, toZone: 'hand' | 'top', opts: { chooser?: number; prompt?: string } = {}): Promise<string | null> {
    const g = this.game;
    const pl = g.players[player];
    const candidates: GameEventCandidate[] = await applyReplacements(g, this.api, {
      kind: 'search', affectedPlayer: player, player, toZone,
    });
    for (const c of candidates) {
      if (c.kind === 'search-exile' && typeof c.cardId === 'string') {
        const id = c.cardId;
        const i = pl.library.indexOf(id);
        if (i < 0) throw new Error('search: card not in library');
        pl.library.splice(i, 1);
        g.getObject(id).zone = 'exile';
        pl.exile.push(id);
        g.emit('TUTOR', { player, card: g.getObject(id).cardName, to: 'exile', note: 'controlled search' });
        g.shuffleLibrary(player);
        return id;
      }
      if (c.kind === 'search') {
        const who = opts.chooser ?? player;
        const sel = await this.askChoice(who, {
          player: who,
          kind: 'cards', min: 0, max: 1,
          prompt: opts.prompt ?? 'Search your library for a card (you may fail to find).',
          zone: 'library',
          options: pl.library.map((id) => ({ id, label: this.defFor(g.getObject(id)).name })),
        });
        if (sel.kind !== 'cards' || sel.cardIds.length === 0) {
          g.emit('TUTOR', { player, card: null, to: toZone, note: 'failed to find' });
          g.shuffleLibrary(player);
          return null;
        }
        const id = sel.cardIds[0];
        const i = pl.library.indexOf(id);
        if (i < 0) throw new Error('search: card not in library');
        pl.library.splice(i, 1);
        if (toZone === 'hand') { pl.hand.push(id); g.getObject(id).zone = 'hand'; }
        else { pl.library.unshift(id); g.getObject(id).zone = 'library'; }
        // hidden info: object id only — the server resolves names per viewer
        g.emit('TUTOR', { player, object: id, to: toZone });
        g.shuffleLibrary(player);
        return id;
      }
      // 'search-none' or unrecognized kinds: shuffle, find nothing
      g.shuffleLibrary(player);
      return null;
    }
    return null;
  }

  /** All legal actions for the player who has priority (plus mulligan out-of-game). */
  legalActionsFor(p: number): LegalAction[] {
    const g = this.game;
    if (g.isOver) return [];
    const actions: LegalAction[] = [];
    if (g.turn.priorityPlayer === p) {
      const gen = (pl: number): LegalAction[] => {
        const out: LegalAction[] = [];
        const player = g.players[pl];
        // castable cards in hand (timing pre-checked loosely; stack.castSpell re-validates)
        for (const id of player.hand) {
          const o = g.getObject(id);
          const def = this.cards.get(o.oracleId);
          if (def.types.includes('land')) {
            if (g.turn.activePlayer === pl &&
              (g.turn.phase === 'precombatMain' || g.turn.phase === 'postcombatMain') &&
              (g.turn.landsPlayedThisTurn[pl] ?? 0) < 1) {
              out.push({ kind: 'cast', label: `Play ${def.name}`, objectId: id, detail: { land: true } });
            }
            continue;
          }
          const instant = def.types.includes('instant') || def.keywords.includes('flash');
          const sorceryTiming = g.turn.activePlayer === pl &&
            (g.turn.phase === 'precombatMain' || g.turn.phase === 'postcombatMain') && g.turn.stack.length === 0;
          if (instant || sorceryTiming) {
            // affordability pre-check
            try {
              const cost = def.manaCost ?? '';
              const parsed = ManaSystem.parseCost(cost);
              const pool = player.manaPool;
              let ok = true;
              for (const c of ['W', 'U', 'B', 'R', 'G'] as const) {
                if ((pool[c] ?? 0) < (parsed.colored[c] ?? 0)) ok = false;
              }
              const total = pool.W + pool.U + pool.B + pool.R + pool.G + pool.C;
              const coloredNeed = Object.values(parsed.colored).reduce((a, b) => a + (b ?? 0), 0);
              if (total - coloredNeed < parsed.generic) ok = false;
              if (ok) out.push({ kind: 'cast', label: `Cast ${def.name}`, objectId: id });
            } catch { /* skip */ }
          }
        }
        // activatable abilities
        for (const id of player.battlefield) {
          const o = g.getObject(id);
          if (o.controller !== pl) continue;
          const script = this.scriptFor(o);
          script.abilities.forEach((meta, i) => {
            if (meta.tapCost && o.tapped) return;
            if (o.summoningSick && meta.tapCost) return;
            out.push({ kind: 'activate', label: `${o.cardName} ability ${i + 1}`, objectId: id, abilityIndex: i, detail: { mana: !!meta.manaAbility } });
          });
        }
        return out;
      };
      return this.priority.legalActionsFor(p, gen);
    }
    return actions;
  }

  /** Play a land (special action, sorcery timing, once per turn). */
  async playLand(player: number, handObjectId: string): Promise<void> {
    const g = this.game;
    const o = g.getObject(handObjectId);
    if (o.zone !== 'hand' || o.owner !== player) throw new Error('not in hand');
    if (g.turn.activePlayer !== player) throw new Error('not active player');
    if (g.turn.phase !== 'precombatMain' && g.turn.phase !== 'postcombatMain') throw new Error('timing');
    if ((g.turn.landsPlayedThisTurn[player] ?? 0) >= 1) throw new Error('land already played');
    g.turn.landsPlayedThisTurn[player] = 1;
    await this.enterBattlefield(handObjectId, player);
    g.emit('LAND_PLAYED', { player, object: handObjectId, card: o.cardName });
  }

  /** Run state-based actions (async: legend rule is a choice). */
  async checkSbas(): Promise<boolean> {
    return this.sba.check((req) => this.askChoice(req.player, req));
  }

  /**
   * Resolve the top of the stack, then run trigger-specific game actions
   * and state-based actions. This is the app's main "advance the game" call.
   */
  async resolveTop(): Promise<void> {
    const stack = this.game.turn.stack;
    const top = stack[stack.length - 1];
    const wasTriggered = top?.kind === 'triggered';
    await this.stack.resolveTop();
    if (wasTriggered && top) await this.resolveTrigger(top);
    await this.checkSbas();
  }

  /** Resolve one triggered ability's game actions (via the app's triggerResolver). */
  async resolveTrigger(so: StackObject): Promise<void> {
    if (this.triggerResolver) await this.triggerResolver(this.api, so);
  }

  /** Devotion to a color for a player (Thassa's Oracle etc.). */
  devotion(player: number, color: 'W' | 'U' | 'B' | 'R' | 'G'): number {
    let n = 0;
    for (const id of this.game.players[player].battlefield) {
      const o = this.game.getObject(id);
      const d = this.scriptFor(o).devotion;
      n += d?.[color] ?? 0;
    }
    return n;
  }

  getObject(id: string): GameObject { return this.game.getObject(id); }
}

/** A choice policy that pends on an external (human) answer via answerChoice. */
export function deferredChoicePolicy(engine: Engine): ChoicePolicy {
  return (req) => new Promise<ChoiceSelection>((resolve) => {
    engine.registerChoiceResolver(req.id, resolve);
  });
}
