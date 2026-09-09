/**
 * Stack: cast spells/abilities, LIFO resolution, fizzle on illegal targets,
 * storm counting, split-second enforcement.
 */
import { Game } from './game.js';
import { GameObject, StackObject, CardDefinition } from './types.js';
import { CardRegistryLike, CardScript, CostOpts, ScriptApi } from './scripts.js';

export interface CastOptions extends CostOpts {
  holdPriority?: boolean;
}

export class StackSystem {
  /** Set by Engine after construction (breaks the api<->stack cycle). */
  api: ScriptApi | null = null;
  /** Token-aware lookups; Engine overrides to consult token scripts/defs. */
  defFor: (o: GameObject) => CardDefinition = (o) => this.cards.get(o.oracleId);
  scriptFor: (o: GameObject) => CardScript = (o) => this.cards.script(o.oracleId);
  constructor(private game: Game, private cards: CardRegistryLike) {}
  private requireApi(): ScriptApi {
    if (!this.api) throw new Error('stack system not bound to engine api');
    return this.api;
  }

  /** All spells cast this turn by anyone (storm). */
  stormCount(): number {
    return Object.values(this.game.turn.spellsCastThisTurn).flat().length;
  }

  /**
   * Is `targetId` a legal target for a spell/ability with source oracleId
   * controlled by `controller`? Checks (CR 601.2c, 608.2b):
   * - target exists in a public zone (or is a live player)
   * - shroud: cannot be targeted at all; hexproof: not by opponents
   * - protection from a source color (keyword format `protection:W`)
   * - card-specific predicate via script.isLegalTarget
   */
  targetIsLegal(sourceOracleId: string, controller: number, targetId: string): boolean {
    const g = this.game;
    const api = this.requireApi();
    if (targetId.startsWith('player:')) {
      const p = Number(targetId.split(':')[1]);
      return Number.isInteger(p) && p >= 0 && p < g.players.length && !g.players[p].hasLost;
    }
    const t = g.objects.get(targetId);
    if (!t) return false;
    if (t.zone !== 'battlefield' && t.zone !== 'stack') return false;
    const tDef = this.defFor(t);
    if (tDef.keywords.includes('shroud')) return false;
    if (tDef.keywords.includes('hexproof') && t.controller !== controller) return false;
    // protection: `protection:W` style keywords vs the source's colors
    const sDef = this.cards.get(sourceOracleId); // oracleId-based: source is a card
    for (const kw of tDef.keywords) {
      if (kw.startsWith('protection:')) {
        const from = kw.split(':')[1];
        if ((sDef.colors as string[]).includes(from)) return false;
      }
    }
    const script = this.cards.script(sourceOracleId); // oracleId-based: source is a card
    if (script.isLegalTarget && !script.isLegalTarget(api, controller, targetId)) return false;
    return true;
  }

  /** Silence / Grand Abolisher / Drannith Magistrate style "can't cast" checks. */
  private checkCanCast(player: number): void {
    const g = this.game;
    if (g.turn.cantCastSpells.includes(player)) {
      throw new Error('cannot cast: an effect prevents casting spells this turn (e.g. Silence)');
    }
    // Grand Abolisher: during its controller's turn, opponents can't cast
    for (const [, o] of g.objects) {
      if (o.zone !== 'battlefield' || o.oracleId !== 'grand-abolisher') continue;
      if (o.controller === g.turn.activePlayer && o.controller !== player) {
        throw new Error('cannot cast: Grand Abolisher');
      }
    }
  }

  async castSpell(player: number, handObjectId: string, opts: CastOptions = {}): Promise<StackObject> {
    const g = this.game;
    const obj = g.getObject(handObjectId);
    if (obj.zone !== 'hand' || obj.owner !== player) throw new Error('cannot cast: not in hand');
    this.checkCanCast(player);
    const def = this.defFor(obj);
    // flash (Orcish Bowmasters, Opposition Agent) casts at instant speed
    const instantSpeed = def.types.includes('instant') || def.keywords.includes('flash');
    if (!instantSpeed && !def.types.includes('sorcery')) {
      // lands handled elsewhere; creatures etc. need sorcery timing
      const sorceryOK = g.turn.activePlayer === player &&
        (g.turn.phase === 'precombatMain' || g.turn.phase === 'postcombatMain') &&
        g.turn.stack.length === 0;
      if (!sorceryOK) throw new Error('cannot cast: timing restriction (sorcery speed)');
    }
    // split second: nobody may cast while a split-second spell is on the stack
    if (g.turn.stack.some((s) => this.defFor(g.getObject(s.sourceId)).keywords.includes('split-second'))) {
      throw new Error('cannot cast: split second');
    }
    // 601.2c: targets must be legal as the spell is cast
    for (const t of opts.targets ?? []) {
      if (!this.targetIsLegal(obj.oracleId, player, t)) {
        throw new Error(`cannot cast: illegal target ${t}`);
      }
    }
    // pay costs via card script (may throw on insufficient payment; may ask choices, e.g. FoW pitch)
    const api = this.requireApi();
    const script = this.scriptFor(obj);
    await script.payCosts?.(api, player, obj, opts);

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

  async activateAbility(player: number, sourceId: string, abilityIndex: number, opts: CastOptions = {}): Promise<StackObject> {
    const g = this.game;
    const obj = g.getObject(sourceId);
    if (obj.zone !== 'battlefield' || obj.controller !== player) throw new Error('cannot activate');
    if (obj.tapped && this.scriptFor(obj).abilities[abilityIndex]?.tapCost) throw new Error('tapped');
    // Grand Abolisher: opponents can't activate abilities of artifacts/creatures/enchantments on its controller's turn
    const srcDef = this.defFor(obj);
    if (srcDef.types.some((t) => t === 'artifact' || t === 'creature' || t === 'enchantment')) {
      for (const [, o] of g.objects) {
        if (o.zone !== 'battlefield' || o.oracleId !== 'grand-abolisher') continue;
        if (o.controller === g.turn.activePlayer && o.controller !== player) {
          throw new Error('cannot activate: Grand Abolisher');
        }
      }
    }
    for (const t of opts.targets ?? []) {
      if (!this.targetIsLegal(obj.oracleId, player, t)) {
        throw new Error(`cannot activate: illegal target ${t}`);
      }
    }
    // 602.2: pay activation costs (may be async; may ask choices)
    await this.scriptFor(obj).payCosts?.(this.requireApi(), player, obj, { ...opts, abilityIndex });
    const so: StackObject = {
      id: `a${sourceId}:${abilityIndex}:${g.turn.stack.length}`, kind: 'activated',
      sourceId, cardName: obj.cardName, controller: player,
      targets: opts.targets ?? [], modes: opts.modes ?? [],
      abilityIndex,
    };
    g.turn.stack.push(so);
    g.emit('ACTIVATE', { player, source: sourceId, card: obj.cardName, abilityIndex });
    return so;
  }

  /** Resolve the top object of the stack. Returns false if stack was empty. */
  async resolveTop(): Promise<boolean> {
    const g = this.game;
    const so = g.turn.stack.pop();
    if (!so) return false;
    const src = g.getObject(so.sourceId);
    // fizzle check: re-validate all targets (CR 608.2b)
    if (so.targets.length > 0) {
      const legal = so.targets.filter((t) => {
        try { return this.targetIsLegal(src.oracleId, so.controller, t); }
        catch { return false; }
      });
      if (legal.length === 0) {
        g.emit('FIZZLE', { object: so.id, card: so.cardName, reason: 'all targets illegal' });
        this.putInGraveyard(so);
        return true;
      }
      so.targets = legal;
    }
    g.emit('RESOLVE_START', { object: so.id, card: so.cardName, kind: so.kind });
    try {
      await this.scriptFor(src).onResolve?.(this.requireApi(), so.controller, src, so);
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

  private putInGraveyard(so: StackObject): void {
    const g = this.game;
    // copies (e.g. storm) aren't cards: countered/resolved copies simply cease to exist
    if (so.kind === 'copy') return;
    // The stack object was already popped; relocate the card itself WITHOUT
    // touching the stack array (copies may share this sourceId).
    const o = g.getObject(so.sourceId);
    if (o.zone === 'stack') {
      o.zone = 'graveyard';
      g.players[o.owner].graveyard.push(so.sourceId);
      g.emit('ZONE_CHANGE', { object: so.sourceId, card: o.cardName, from: 'stack', to: 'graveyard', player: o.owner });
    }
  }

  counterSpell(stackId: string, byPlayer: number): void {
    const g = this.game;
    // copies of spells (e.g. storm) are spells on the stack and can be countered (CR 706.10a)
    const i = g.turn.stack.findIndex((s) => s.id === stackId && (s.kind === 'spell' || s.kind === 'copy'));
    if (i < 0) throw new Error('no such spell on stack');
    const [so] = g.turn.stack.splice(i, 1);
    g.emit('COUNTERED', { object: so.id, card: so.cardName, by: byPlayer });
    this.putInGraveyard(so);
  }
}
