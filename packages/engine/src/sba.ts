/**
 * State-based actions (CR 704, essentials): checked whenever a player would
 * get priority, and after every resolution. All applicable SBAs happen
 * simultaneously as a single event batch.
 */
import { Game } from './game.js';

export class SbaSystem {
  constructor(private game: Game) {}

  /** Run SBA loop until no more apply. Returns true if anything happened. */
  check(): boolean {
    const g = this.game;
    let changed = false, again = true;
    while (again) {
      again = false;
      for (const [, o] of g.objects) {
        if (o.zone !== 'battlefield') continue;
        // 704.5f: 0 toughness -> graveyard
        if (o.toughness !== undefined && o.toughness <= 0) {
          g.moveZone(o.id, 'graveyard', o.owner);
          g.emit('SBA', { action: 'zeroToughness', object: o.id, card: o.cardName });
          again = changed = true;
        }
        // 704.5g: lethal damage -> destroy
        if (o.damageMarked && o.toughness !== undefined && o.damageMarked >= o.toughness) {
          g.moveZone(o.id, 'graveyard', o.owner);
          g.emit('SBA', { action: 'lethalDamage', object: o.id, card: o.cardName });
          again = changed = true;
        }
      }
      // 704.5j legend rule (per player, per legendary name)
      for (const p of g.players) {
        const seen = new Map<string, string>();
        for (const id of [...p.battlefield]) {
          const o = g.getObject(id);
          const def = (g as unknown as { cardDefs?: Map<string, { supertypes: string[] }> }).cardDefs?.get(o.oracleId);
          void def;
          // legend rule needs supertype info; card scripts expose `legendaryNames`
        }
        void seen;
      }
      // 704.5k: aura illegally attached -> graveyard (handled via attachedTo validation)
      for (const [, o] of g.objects) {
        if (o.zone === 'battlefield' && o.attachedTo && !g.objects.has(o.attachedTo)) {
          g.moveZone(o.id, 'graveyard', o.owner);
          g.emit('SBA', { action: 'illegalAttachment', object: o.id });
          again = changed = true;
        }
      }
      // tokens in non-battlefield zones cease to exist
      for (const [id, o] of [...g.objects]) {
        if (o.cardName.startsWith('Token:') && o.zone !== 'battlefield') {
          g.objects.delete(id);
          g.emit('SBA', { action: 'tokenCeased', object: id });
          again = changed = true;
        }
      }
      // 0-life / 21 commander damage handled in changeLife/dealCommanderDamage
    }
    return changed;
  }

  /** Legend rule with explicit legendary name registry (populated by card scripts). */
  legendRule(legendaryByName: Map<string, string[]>): void {
    const g = this.game;
    for (const p of g.players) {
      const byName = new Map<string, string[]>();
      for (const id of p.battlefield) {
        const o = g.getObject(id);
        for (const [name, ids] of legendaryByName) {
          if (ids.includes(id)) {
            const arr = byName.get(name) ?? [];
            arr.push(id);
            byName.set(name, arr);
          }
        }
      }
      for (const [, ids] of byName) {
        if (ids.length > 1) {
          // active player chooses; default: keep oldest (timestamp order)
          const keep = ids[0];
          for (const id of ids.slice(1)) {
            g.moveZone(id, 'graveyard', g.getObject(id).owner);
            g.emit('SBA', { action: 'legendRule', object: id, kept: keep });
          }
        }
      }
    }
  }
}
