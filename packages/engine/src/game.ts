/**
 * Game: authoritative, event-sourced game state.
 * Every mutation emits a hash-chained GameEvent (replay integrity).
 * All randomness flows through the seeded Rng.
 */
import { createHash } from 'crypto';
import { CardDefinition, GameEvent, GameObject, ManaPool, PlayerState, StackObject, TurnState, Zone } from './types.js';
import { Rng } from './rng.js';
import { TriggerSystem } from './triggers.js';
import { ChoiceRequest } from './choices.js';
import { ReplacementEffect } from './replacements.js';

export interface PlayerConfig { name: string; deckOracleIds: string[]; commanderOracleIds: string[] }

const emptyMana = (): ManaPool => ({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });

export class Game {
  players: PlayerState[] = [];
  objects = new Map<string, GameObject>();
  turn: TurnState;
  events: GameEvent[] = [];
  rng: Rng;
  seed: number | string;
  winners: number[] = [];
  turnCount = 0;
  private objSeq = 0;
  private choiceSeq = 0;
  readonly startingLife: number;
  readonly freeMulligans: number;
  /** Set by the app after construction; observes every event for triggers. */
  triggers: TriggerSystem | null = null;
  /** Set by the app: pushes a triggered ability onto the stack. */
  putTriggerOnStack: ((so: StackObject, sourceId: string) => void) | null = null;
  /** Set by Engine: card database for type/color lookups (triggers use this, never hidden zones). */
  cardDb: { get(oracleId: string): CardDefinition } | null = null;
  /** Outstanding human choice (server use). Set by Engine.askChoice while pending. */
  pendingChoice: ChoiceRequest | null = null;
  /** Active replacement effects (CR 614–616). */
  replacements: ReplacementEffect[] = [];

  constructor(playerConfigs: PlayerConfig[], opts: { seed: number | string; startingLife?: number; freeMulligans?: number } = { seed: 1 }) {
    this.seed = opts.seed;
    this.rng = new Rng(opts.seed);
    this.startingLife = opts.startingLife ?? 40;
    // Commander convention: the first mulligan is free (then London mulligan).
    this.freeMulligans = opts.freeMulligans ?? 1;
    playerConfigs.forEach((c, i) => {
      const lib = c.deckOracleIds.map((oracleId) => this.makeObject(oracleId, i, 'library'));
      const commanders = c.commanderOracleIds.map((oracleId) => this.makeObject(oracleId, i, 'command'));
      this.players.push({
        index: i, name: c.name, life: this.startingLife, poison: 0,
        hand: [], library: lib.map((o) => o.id), graveyard: [], exile: [],
        commandZone: commanders.map((o) => o.id), battlefield: [],
        manaPool: emptyMana(), restrictedMana: { commander: emptyMana() },
        commanderIds: commanders.map((o) => o.id),
        commanderDamage: {}, commanderCasts: {}, hasLost: false,
        mulligansTaken: 0, maxHandSize: 7,
      });
    });
    this.turn = {
      number: 0, activePlayer: 0, phase: 'untap', priorityPlayer: null,
      passedPriority: playerConfigs.map(() => false), stack: [],
      landsPlayedThisTurn: {}, spellsCastThisTurn: {},
      cantCastSpells: [], drawStepDraws: {}, combatDamageDealtTo: {},
      sentinelTaxed: {}, attackers: [], blockers: [], lastManaProduced: null,
    };
    this.emit('GAME_STARTED', { seed: opts.seed, players: playerConfigs.map((c) => c.name), startingLife: this.startingLife });
  }

  /** Deterministic choice id. */
  nextChoiceId(): string { return `c${++this.choiceSeq}`; }

  // ---------- objects ----------
  makeObject(oracleId: string, owner: number, zone: Zone, cardName?: string): GameObject {
    const id = `o${++this.objSeq}`;
    const obj: GameObject = {
      id, cardName: cardName ?? oracleId, oracleId, controller: owner, owner,
      zone, tapped: false, summoningSick: false, counters: {},
    };
    this.objects.set(id, obj);
    return obj;
  }
  getObject(id: string): GameObject {
    const o = this.objects.get(id);
    if (!o) throw new Error(`unknown object ${id}`);
    return o;
  }

  // ---------- events (hash-chained) ----------
  emit(type: string, payload: Record<string, unknown>): GameEvent {
    const seq = this.events.length;
    const prevHash = seq === 0 ? 'GENESIS' : this.events[seq - 1].hash;
    const hash = createHash('sha256')
      .update(prevHash + '|' + seq + '|' + type + '|' + JSON.stringify(payload)).digest('hex');
    const ev: GameEvent = { seq, type, payload, prevHash, hash };
    this.events.push(ev);
    if (this.triggers && this.putTriggerOnStack && type !== 'TRIGGER') {
      this.triggers.notify(ev, this.putTriggerOnStack);
    }
    return ev;
  }
  verifyChain(): boolean {
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i];
      const wantPrev = i === 0 ? 'GENESIS' : this.events[i - 1].hash;
      if (e.prevHash !== wantPrev || e.seq !== i) return false;
      const want = createHash('sha256')
        .update(e.prevHash + '|' + e.seq + '|' + e.type + '|' + JSON.stringify(e.payload)).digest('hex');
      if (want !== e.hash) return false;
    }
    return true;
  }

  // ---------- zones ----------
  /** Public zone-list accessor for subsystems (SBA token ceasing etc.). */
  zoneListFor(p: number, z: Zone): string[] {
    return this.zoneList(p, z);
  }
  private zoneList(p: number, z: Zone): string[] {
    const pl = this.players[p];
    switch (z) {
      case 'hand': return pl.hand;
      case 'library': return pl.library;
      case 'graveyard': return pl.graveyard;
      case 'exile': return pl.exile;
      case 'command': return pl.commandZone;
      case 'battlefield': return pl.battlefield;
      case 'stack': throw new Error('stack is not a player zone');
    }
  }

  moveZone(objId: string, to: Zone, toPlayer?: number): void {
    const o = this.getObject(objId);
    const from = o.zone;
    if (from === 'stack') {
      // Prefer the exact stack-object id; fall back to sourceId (activated
      // abilities have stack ids like `a<source>:<n>`). Never let a card's own
      // burial sweep an unrelated stack object (e.g. storm copies share sourceId).
      let i = this.turn.stack.findIndex((s) => s.id === objId);
      if (i < 0) i = this.turn.stack.findIndex((s) => s.sourceId === objId);
      if (i >= 0) this.turn.stack.splice(i, 1);
    } else {
      const list = this.zoneList(o.controller === undefined ? o.owner : this.locateController(o, from), from);
      const i = list.indexOf(objId);
      if (i >= 0) list.splice(i, 1);
    }
    const dest = toPlayer ?? o.owner;
    if (to !== 'stack') this.zoneList(dest, to).push(objId);
    o.zone = to;
    if (to === 'battlefield') o.controller = dest;
    this.emit('ZONE_CHANGE', { object: objId, card: o.cardName, from, to, player: dest });
    // CR 111.7: tokens in zones other than the battlefield cease to exist as an
    // SBA (sba.check). They DO briefly enter the destination zone, so "dies"
    // triggers observe them leaving the battlefield first.
  }

  private locateController(o: GameObject, from: Zone): number {
    if (from === 'battlefield') return o.controller;
    return o.owner;
  }

  shuffleLibrary(p: number): void {
    const pl = this.players[p];
    pl.library = this.rng.shuffle(pl.library);
    this.emit('SHUFFLE', { player: p, count: pl.library.length });
  }

  draw(p: number, n = 1): void {
    const pl = this.players[p];
    for (let i = 0; i < n; i++) {
      if (pl.library.length === 0) {
        this.emit('DRAW_EMPTY', { player: p });
        this.lose(p, 'drew from empty library');
        return;
      }
      const id = pl.library.shift()!;
      pl.hand.push(id);
      this.getObject(id).zone = 'hand';
      const turnDraw = this.turn.phase === 'draw' && this.turn.activePlayer === p;
      if (turnDraw) this.turn.drawStepDraws[p] = (this.turn.drawStepDraws[p] ?? 0) + 1;
      this.emit('DRAW', { player: p, object: id, turnDraw });
    }
  }

  /**
   * Commander mulligan: London mulligan, first one free.
   * Draw 7 - max(0, n - freeMulligans) on the nth mulligan.
   */
  mulligan(p: number): void {
    const pl = this.players[p];
    if (pl.mulligansTaken >= 7) throw new Error('no more mulligans');
    const n = pl.mulligansTaken + 1;
    for (const id of pl.hand) { pl.library.push(id); this.getObject(id).zone = 'library'; }
    pl.hand = [];
    this.shuffleLibrary(p);
    const free = Math.min(n, this.freeMulligans);
    const handSize = 7 - (n - free);
    this.draw(p, handSize);
    pl.mulligansTaken = n;
    this.emit('MULLIGAN', { player: p, count: n, handSize, free: n <= this.freeMulligans });
  }

  // ---------- life / loss ----------
  changeLife(p: number, delta: number, source?: string): void {
    const pl = this.players[p];
    if (pl.hasLost) return;
    pl.life += delta;
    this.emit('LIFE_CHANGED', { player: p, delta, life: pl.life, source });
    if (pl.life <= 0) this.lose(p, 'life <= 0');
  }

  dealCommanderDamage(byObjectId: string, toPlayer: number, amount: number): void {
    const src = this.getObject(byObjectId);
    const pl = this.players[toPlayer];
    pl.commanderDamage[src.id] = (pl.commanderDamage[src.id] ?? 0) + amount;
    this.emit('COMMANDER_DAMAGE', { by: src.id, card: src.cardName, to: toPlayer, amount, total: pl.commanderDamage[src.id] });
    this.changeLife(toPlayer, -amount, src.cardName);
    if ((pl.commanderDamage[src.id] ?? 0) >= 21) this.lose(toPlayer, `21 commander damage from ${src.cardName}`);
  }

  lose(p: number, reason: string): void {
    const pl = this.players[p];
    if (pl.hasLost) return;
    pl.hasLost = true;
    this.emit('PLAYER_LOST', { player: p, reason });
    const alive = this.players.filter((x) => !x.hasLost);
    if (alive.length === 1) {
      this.winners = [alive[0].index];
      this.emit('GAME_ENDED', { winners: this.winners });
    } else if (alive.length === 0) {
      this.emit('GAME_ENDED', { winners: [], draw: true });
    }
  }

  get alivePlayers(): number[] { return this.players.filter((p) => !p.hasLost).map((p) => p.index); }
  get isOver(): boolean { return this.winners.length > 0 || this.alivePlayers.length <= 1; }

  // ---------- snapshots (rewind / branching) ----------
  snapshot(): string {
    return JSON.stringify({
      players: this.players, turn: this.turn, objSeq: this.objSeq,
      objects: [...this.objects.entries()], events: this.events.length,
      rngState: this.rng.state, winners: this.winners,
    });
  }
  restore(snap: string): void {
    const s = JSON.parse(snap);
    this.players = s.players; this.turn = s.turn; this.objSeq = s.objSeq;
    this.objects = new Map(s.objects); this.rng.state = s.rngState; this.winners = s.winners;
    this.events.length = s.events; // truncate log to snapshot point
    this.emit('RESTORED', { toEvent: s.events });
  }
}
