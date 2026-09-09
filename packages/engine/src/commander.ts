/**
 * Commander-specific rules (CR 903):
 * - commander tax: {2} per previous cast from command zone
 * - casting from command zone follows normal timing + tax
 * - command-zone replacement: leaving battlefield -> owner chooses command zone
 * - 21 combat damage from a single commander -> loss (tracked in game.ts)
 */
import { Game } from './game.js';
import { ManaSystem } from './mana.js';

export class CommanderSystem {
  constructor(private game: Game, private mana: ManaSystem, private cardCost: (oracleId: string) => { generic: number; colored: Partial<Record<string, number>> }) {}

  taxOf(player: number, commanderId: string): number {
    return 2 * (this.game.players[player].commanderCasts[commanderId] ?? 0);
  }

  /** Cast commander from command zone. Returns stack object id. */
  castFromCommandZone(player: number, commanderId: string, castInto: (p: number, objId: string) => unknown): unknown {
    const g = this.game;
    const pl = g.players[player];
    const o = g.getObject(commanderId);
    if (o.zone !== 'command' || !pl.commanderIds.includes(commanderId)) throw new Error('not your commander in command zone');
    const tax = this.taxOf(player, commanderId);
    const base = this.cardCost(o.oracleId);
    this.mana.spend(player, base.generic + tax, base.colored as Partial<Record<'W' | 'U' | 'B' | 'R' | 'G', number>>);
    pl.commanderCasts[commanderId] = (pl.commanderCasts[commanderId] ?? 0) + 1;
    g.emit('COMMANDER_CAST', { player, commander: commanderId, card: o.cardName, tax });
    return castInto(player, commanderId);
  }

  /** 903.9a/b: if commander would go to graveyard/exile/library/hand, owner may put it in command zone instead. */
  maybeToCommandZone(player: number, commanderId: string, destination: 'graveyard' | 'exile' | 'library' | 'hand',
    chooser: (p: number) => 'command' | 'destination'): void {
    const g = this.game;
    const o = g.getObject(commanderId);
    const choice = chooser(player);
    g.emit('COMMANDER_REPLACEMENT_CHOICE', { player, commander: commanderId, destination, choice });
    if (choice === 'command') {
      // remove from wherever it was headed; place in command zone
      g.moveZone(commanderId, 'command', player);
    } else {
      g.moveZone(commanderId, destination, player);
    }
    void o;
  }
}
