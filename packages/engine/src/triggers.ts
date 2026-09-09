/**
 * TriggerSystem: watches the event log; when an event matches a registered
 * trigger, puts triggered abilities on the stack in APNAP order, then the
 * active player gets priority (CR 603).
 */
import type { Game } from './game.js';
import { GameEvent, StackObject } from './types.js';
import { TriggerDef } from './scripts.js';

interface Registration { objId: string; controller: number; def: TriggerDef }

export class TriggerSystem {
  private regs: Registration[] = [];
  constructor(private game: Game) {}

  /** (Re)register all triggers for a permanent entering / state changing. */
  registerFor(objId: string, defs: TriggerDef[]): void {
    this.regs = this.regs.filter((r) => r.objId !== objId);
    const o = this.game.objects.get(objId);
    if (!o) return;
    for (const def of defs) this.regs.push({ objId, controller: o.controller, def });
  }
  unregister(objId: string): void {
    this.regs = this.regs.filter((r) => r.objId !== objId);
  }

  /** Called by Game.emit for every event. Queues matching triggers. */
  notify(ev: GameEvent, putOnStack: (so: StackObject, sourceId: string) => void): void {
    const g = this.game;
    const matching = this.regs.filter((r) => {
      if (r.def.on !== ev.type) return false;
      const o = g.objects.get(r.objId);
      if (!o || o.zone !== 'battlefield') return false;
      try { return r.def.condition({ game: g }, o, ev.payload); } catch { return false; }
    });
    if (matching.length === 0) return;
    // APNAP: active player first, then turn order
    const alive = g.alivePlayers;
    const start = alive.indexOf(g.turn.activePlayer);
    const order = alive.slice(start).concat(alive.slice(0, start));
    const rank = (r: Registration) => order.indexOf(r.controller);
    matching.sort((a, b) => rank(a) - rank(b) || (a.controller === g.turn.activePlayer ? -1 : 0));
    for (const r of matching) {
      const o = g.getObject(r.objId);
      const partial = r.def.make({ game: g }, o, ev.payload);
      const so: StackObject = { ...partial, id: `t${o.id}:${ev.seq}`, kind: 'triggered', sourceId: o.id };
      putOnStack(so, o.id);
      g.emit('TRIGGER', { source: o.id, card: o.cardName, controller: o.controller, text: r.def.describe({ game: g }, o) });
    }
  }
}
