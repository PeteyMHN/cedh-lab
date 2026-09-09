/**
 * State-based actions (CR 704, essentials): checked whenever a player would
 * get priority, and after every resolution. All applicable SBAs happen
 * simultaneously as a single event batch. Now async: the legend rule (704.5j)
 * is a real choice.
 */
import { Game } from './game.js';
import { ChoiceRequestInit } from './choices.js';

export class SbaSystem {
  constructor(private game: Game) {}

  /** Run SBA loop until no more apply. Returns true if anything happened. */
  async check(askChoice?: (req: ChoiceRequestInit) => Promise<import('./choices.js').ChoiceSelection>): Promise<boolean> {
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
      // 704.5j: legend rule — controller chooses one to keep, rest to graveyard
      if (await this.legendRule(askChoice)) { again = changed = true; }
      // 704.5k: aura illegally attached -> graveyard (handled via attachedTo validation)
      for (const [, o] of g.objects) {
        if (o.zone === 'battlefield' && o.attachedTo && !g.objects.has(o.attachedTo)) {
          g.moveZone(o.id, 'graveyard', o.owner);
          g.emit('SBA', { action: 'illegalAttachment', object: o.id });
          again = changed = true;
        }
      }
      // CR 111.7: tokens in zones other than the battlefield cease to exist.
      // They entered the zone normally first (dies triggers saw them leave).
      const ceased: string[] = [];
      for (const [id, o] of g.objects) {
        if (o.isToken && o.zone !== 'battlefield') ceased.push(id);
      }
      for (const id of ceased) {
        const o = g.objects.get(id)!;
        const zone = o.zone;
        if (zone !== 'stack') {
          const list = g.zoneListFor(o.owner, zone);
          const i = list.indexOf(id);
          if (i >= 0) list.splice(i, 1);
        }
        g.objects.delete(id);
        g.emit('TOKEN_CEASED', { object: id, card: o.cardName, from: zone });
        again = changed = true;
      }
      // 0-life / 21 commander damage handled in changeLife/dealCommanderDamage
    }
    return changed;
  }

  /**
   * 704.5j legend rule: if a player controls two or more legendary permanents
   * with the same name, that player chooses one to keep; the rest go to the
   * graveyard. Returns true if anything moved.
   */
  private async legendRule(
    askChoice?: (req: ChoiceRequestInit) => Promise<import('./choices.js').ChoiceSelection>,
  ): Promise<boolean> {
    const g = this.game;
    let moved = false;
    for (const p of g.players) {
      const byName = new Map<string, string[]>();
      for (const id of [...p.battlefield]) {
        const o = g.getObject(id);
        if (o.isToken) continue;
        const def = g.cardDb?.get(o.oracleId);
        if (!def || !def.supertypes.includes('Legendary')) continue;
        const arr = byName.get(def.name) ?? [];
        arr.push(id);
        byName.set(def.name, arr);
      }
      for (const [name, ids] of byName) {
        if (ids.length < 2) continue;
        let keep = ids[0];
        if (askChoice) {
          const sel = await askChoice({
            player: p.index,
            kind: 'card',
            prompt: `Legend rule (CR 704.5j): choose which ${name} to keep; the rest go to the graveyard.`,
            options: ids.map((id) => ({ id, label: g.getObject(id).cardName, detail: `controlled by ${p.name}` })),
          });
          if (sel.kind === 'card') keep = sel.cardId;
        }
        for (const id of ids) {
          if (id === keep) continue;
          g.moveZone(id, 'graveyard', g.getObject(id).owner);
          g.emit('SBA', { action: 'legendRule', object: id, kept: keep, card: name });
          moved = true;
        }
      }
    }
    return moved;
  }
}
