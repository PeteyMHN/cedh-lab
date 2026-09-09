/**
 * Engine: facade wiring all subsystems + the card registry.
 * Apps construct ONE Engine per game; it owns the Game and every system.
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
import { CardRegistryLike, ScriptApi } from './scripts.js';
import { GameObject, LegalAction, StackObject } from './types.js';

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
  triggerResolver: ((api: ScriptApi, so: StackObject) => void) | null = null;

  constructor(playerConfigs: PlayerConfig[], cards: CardRegistryLike, opts: EngineOpts) {
    this.cards = cards;
    this.game = new Game(playerConfigs, opts);
    this.turns = new TurnMachine(this.game);
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
    this.api = { game: this.game, mana: this.mana, stack: this.stack, cards, engine: this };
    this.stack.api = this.api;
    this.game.triggers = this.triggers;
    this.game.putTriggerOnStack = (so: StackObject) => {
      this.game.turn.stack.push(so);
      this.game.emit('STACK_PUSH', { object: so.id, card: so.cardName, kind: so.kind, controller: so.controller });
    };
  }

  /** Register a permanent's triggers/static effects (call on ETB). */
  permanentEntered(objId: string): void {
    const o = this.game.getObject(objId);
    if (o.cardName === o.oracleId) o.cardName = this.cards.get(o.oracleId).name;
    const script = this.cards.script(o.oracleId);
    if (script.triggersFor && this.triggers) {
      this.triggers.registerFor(objId, script.triggersFor(this.api, o));
    }
    // ETB replacement: some scripts implement onEnter via triggersFor ON_ETB pseudo-event
    this.game.emit('ETB', { object: objId, card: o.cardName, controller: o.controller });
  }

  permanentLeft(objId: string): void {
    this.triggers.unregister(objId);
    this.layers.removeBySource(objId);
    this.game.emit('LTB', { object: objId });
  }

  /** Move a permanent from wherever it is onto the battlefield. */
  enterBattlefield(objId: string, controller?: number): void {
    const g = this.game;
    const o = g.getObject(objId);
    const c = controller ?? o.controller;
    // remove from current zone list
    if (o.zone === 'stack') {
      const i = g.turn.stack.findIndex((s) => s.id === objId || s.sourceId === objId);
      if (i >= 0) g.turn.stack.splice(i, 1);
    }
    g.moveZone(objId, 'battlefield', c);
    if (o.cardName === o.oracleId) o.cardName = this.cards.get(o.oracleId).name;
    o.tapped = false;
    // 302.6: only creatures are affected by summoning sickness
    o.summoningSick = this.cards.get(o.oracleId).types.includes('creature');
    o.damageMarked = 0;
    const def = this.cards.get(o.oracleId);
    if (def.power) o.power = parseInt(def.power);
    if (def.toughness) o.toughness = parseInt(def.toughness);
    this.permanentEntered(objId);
  }

  /** Activate an ability: mana abilities resolve immediately, others use the stack. */
  activateAbility(player: number, sourceId: string, abilityIndex: number, opts: CastOptions = {}): void {
    const o = this.game.getObject(sourceId);
    const script = this.cards.script(o.oracleId);
    const meta = script.abilities[abilityIndex];
    if (!meta) throw new Error('no such ability');
    if (o.tapped && meta.tapCost) throw new Error('cannot activate: tapped');
    if (meta.manaAbility) {
      script.payCosts?.(this.api, player, o, opts);
      // mana abilities resolve immediately, don't use the stack (CR 605)
      script.onResolve?.(this.api, player, o, {
        id: `m${sourceId}:${abilityIndex}`, kind: 'activated', sourceId,
        cardName: o.cardName, controller: player, targets: [], modes: [],
      });
      this.game.emit('MANA_ABILITY', { player, source: sourceId, card: o.cardName });
    } else {
      this.stack.activateAbility(player, sourceId, abilityIndex, opts);
    }
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
          const script = this.cards.script(o.oracleId);
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
  playLand(player: number, handObjectId: string): void {
    const g = this.game;
    const o = g.getObject(handObjectId);
    if (o.zone !== 'hand' || o.owner !== player) throw new Error('not in hand');
    if (g.turn.activePlayer !== player) throw new Error('not active player');
    if (g.turn.phase !== 'precombatMain' && g.turn.phase !== 'postcombatMain') throw new Error('timing');
    if ((g.turn.landsPlayedThisTurn[player] ?? 0) >= 1) throw new Error('land already played');
    g.turn.landsPlayedThisTurn[player] = 1;
    this.enterBattlefield(handObjectId, player);
    g.emit('LAND_PLAYED', { player, object: handObjectId, card: o.cardName });
  }

  /** Run state-based actions + return whether the game should advance phase. */
  checkSbas(): boolean {
    return this.sba.check();
  }

  /**
   * Resolve the top of the stack, then run trigger-specific game actions
   * and state-based actions. This is the app's main "advance the game" call.
   */
  resolveTop(): boolean {
    const stack = this.game.turn.stack;
    const top = stack[stack.length - 1];
    const wasTriggered = top?.kind === 'triggered';
    const ok = this.stack.resolveTop();
    if (ok && wasTriggered && top && this.triggerResolver) {
      this.triggerResolver(this.api, top);
    }
    this.sba.check();
    return ok;
  }

  /** Devotion to a color for a player (Thassa's Oracle etc.). */
  devotion(player: number, color: 'W' | 'U' | 'B' | 'R' | 'G'): number {
    let n = 0;
    for (const id of this.game.players[player].battlefield) {
      const o = this.game.getObject(id);
      const d = this.cards.script(o.oracleId).devotion;
      n += d?.[color] ?? 0;
    }
    return n;
  }

  getObject(id: string): GameObject { return this.game.getObject(id); }
}
