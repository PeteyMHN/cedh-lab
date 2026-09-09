/**
 * Stack: cast spells/abilities, LIFO resolution, fizzle on illegal targets,
 * storm counting, split-second enforcement.
 */
import { Game } from './game.js';
import { StackObject } from './types.js';
import { CardRegistryLike, CostOpts, ScriptApi } from './scripts.js';

export interface CastOptions extends CostOpts {
  holdPriority?: boolean;
}

export class StackSystem {
  /** Set by Engine after construction (breaks the api<->stack cycle). */
  api: ScriptApi | null = null;
  constructor(private game: Game, private cards: CardRegistryLike) {}
  private requireApi(): ScriptApi {
    if (!this.api) throw new Error('stack system not bound to engine api');
    return this.api;
  }

  /** All spells cast this turn by anyone (storm). */
  stormCount(): number {
    return Object.values(this.game.turn.spellsCastThisTurn).flat().length;
  }

  castSpell(player: number, handObjectId: string, opts: CastOptions = {}): StackObject {
    const g = this.game;
    const obj = g.getObject(handObjectId);
    if (obj.zone !== 'hand' || obj.owner !== player) throw new Error('cannot cast: not in hand');
    const def = this.cards.get(obj.oracleId);
    if (!def.types.includes('instant') && !def.types.includes('sorcery')) {
      // lands handled elsewhere; creatures etc. need sorcery timing
      const sorceryOK = g.turn.activePlayer === player &&
        (g.turn.phase === 'precombatMain' || g.turn.phase === 'postcombatMain') &&
        g.turn.stack.length === 0;
      if (!sorceryOK) throw new Error('cannot cast: timing restriction (sorcery speed)');
    }
    // split second: nobody may cast while a split-second spell is on the stack
    if (g.turn.stack.some((s) => this.cards.get(g.getObject(s.sourceId).oracleId).keywords.includes('split-second'))) {
      throw new Error('cannot cast: split second');
    }
    // pay costs via card script (may throw on insufficient payment)
    const api = this.requireApi();
    const script = this.cards.script(obj.oracleId);
    script.payCosts?.(api, player, obj, opts);

    g.moveZone(handObjectId, 'stack');
    obj.cardName = def.name; // display name from here on (stack, graveyard, exile)
    const so: StackObject = {
      id: handObjectId, kind: 'spell', sourceId: handObjectId,
      cardName: obj.cardName, controller: player,
      targets: opts.targets ?? [], modes: opts.modes ?? [],
      xValue: opts.xValue, stormCount: this.stormCount(),
      namedCard: opts.namedCard,
    };
    g.turn.stack.push(so);
    const arr = g.turn.spellsCastThisTurn[player] ?? [];
    arr.push(obj.oracleId);
    g.turn.spellsCastThisTurn[player] = arr;
    g.emit('CAST', { player, object: handObjectId, card: obj.cardName, targets: so.targets, modes: so.modes, x: opts.xValue });
    script.onCast?.(api, player, obj, so);
    return so;
  }

  activateAbility(player: number, sourceId: string, abilityIndex: number, opts: CastOptions = {}): StackObject {
    const g = this.game;
    const obj = g.getObject(sourceId);
    if (obj.zone !== 'battlefield' || obj.controller !== player) throw new Error('cannot activate');
    if (obj.tapped && this.cards.script(obj.oracleId).abilities[abilityIndex]?.tapCost) throw new Error('tapped');
    const so: StackObject = {
      id: `a${sourceId}:${abilityIndex}:${g.turn.stack.length}`, kind: 'activated',
      sourceId, cardName: obj.cardName, controller: player,
      targets: opts.targets ?? [], modes: opts.modes ?? [],
    };
    g.turn.stack.push(so);
    g.emit('ACTIVATE', { player, source: sourceId, card: obj.cardName, abilityIndex });
    return so;
  }

  /** Resolve the top object of the stack. Returns false if stack was empty. */
  resolveTop(): boolean {
    const g = this.game;
    const so = g.turn.stack.pop();
    if (!so) return false;
    const src = g.getObject(so.sourceId);
    // fizzle check: all targets illegal -> countered on resolution (no effect)
    if (so.targets.length > 0) {
      const legal = so.targets.filter((t) => this.targetStillLegal(t, so.controller));
      if (legal.length === 0) {
        g.emit('FIZZLE', { object: so.id, card: so.cardName, reason: 'all targets illegal' });
        this.putInGraveyard(so);
        return true;
      }
      so.targets = legal;
    }
    g.emit('RESOLVE_START', { object: so.id, card: so.cardName, kind: so.kind });
    try {
      this.cards.script(src.oracleId).onResolve?.(this.requireApi(), so.controller, src, so);
    } catch (e) {
      // fail-safe: never silently misresolve
      g.emit('RULES_ENGINE_FAILURE', {
        object: so.id, card: so.cardName, error: String(e),
        note: 'unsupported interaction; manual resolution required in casual mode',
      });
      if (so.kind === 'spell') this.putInGraveyard(so);
      return true;
    }
    g.emit('RESOLVE_END', { object: so.id, card: so.cardName });
    if (so.kind === 'spell') this.putInGraveyard(so);
    return true;
  }

  private targetStillLegal(t: string, controller: number): boolean {
    if (t.startsWith('player:')) {
      const p = Number(t.split(':')[1]);
      return !this.game.players[p].hasLost;
    }
    const o = this.game.objects.get(t);
    if (!o) return false;
    return o.zone === 'battlefield' || o.zone === 'stack';
    // NOTE: hexproof/shroud/protection checks plug in here per card script
  }

  private putInGraveyard(so: StackObject): void {
    const g = this.game;
    const o = g.getObject(so.sourceId);
    if (o.zone === 'stack') {
      g.moveZone(so.sourceId, 'graveyard', o.owner);
    }
  }

  counterSpell(stackId: string, byPlayer: number): void {
    const g = this.game;
    const i = g.turn.stack.findIndex((s) => s.id === stackId && s.kind === 'spell');
    if (i < 0) throw new Error('no such spell on stack');
    const [so] = g.turn.stack.splice(i, 1);
    g.emit('COUNTERED', { object: so.id, card: so.cardName, by: byPlayer });
    this.putInGraveyard(so);
  }
}
