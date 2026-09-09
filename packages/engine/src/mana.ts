/** Mana pool: add, spend with color rules, empty at phase/step boundaries. */
import { Game } from './game.js';
import { Color, ManaPool } from './types.js';

const COLORS: Color[] = ['W', 'U', 'B', 'R', 'G'];

export class ManaSystem {
  constructor(private game: Game) {}

  add(p: number, color: Color | 'C', n = 1): void {
    const pool = this.game.players[p].manaPool;
    pool[color] += n;
    this.game.emit('MANA_ADDED', { player: p, color, amount: n, pool: { ...pool } });
  }

  /** Spend mana: colored first from matching, then generic from anything. */
  spend(p: number, generic: number, colored: Partial<Record<Color, number>>): void {
    const pool = this.game.players[p].manaPool;
    for (const c of COLORS) {
      const need = colored[c] ?? 0;
      if ((pool[c] ?? 0) < need) throw new Error(`insufficient ${c} mana`);
    }
    for (const c of COLORS) pool[c] -= colored[c] ?? 0;
    let g = generic;
    // generic payable with any mana; use colorless first, then colored
    const take = Math.min(pool.C, g); pool.C -= take; g -= take;
    for (const c of COLORS) {
      if (g <= 0) break;
      const t = Math.min(pool[c], g); pool[c] -= t; g -= t;
    }
    if (g > 0) throw new Error('insufficient mana for generic cost');
    this.game.emit('MANA_SPENT', { player: p, generic, colored, pool: { ...pool } });
  }

  /** Parse "{2}{U}{B}" style costs and spend. X must be declared via xValue. */
  spendParsed(p: number, cost: string, xValue = 0): void {
    const parsed = ManaSystem.parseCost(cost);
    this.spend(p, parsed.generic + (parsed.x ? xValue : 0), parsed.colored);
  }
  static parseCost(cost: string): { generic: number; colored: Partial<Record<Color, number>>; x: boolean } {
    const colored: Partial<Record<Color, number>> = {};
    let generic = 0, x = false;
    for (const m of cost.matchAll(/\{([^}]+)\}/g)) {
      const s = m[1];
      if (/^\d+$/.test(s)) generic += Number(s);
      else if (s === 'X') x = true;
      else if (['W', 'U', 'B', 'R', 'G'].includes(s)) colored[s as Color] = (colored[s as Color] ?? 0) + 1;
      else if (s === 'C') generic += 0; // colorless handled as generic-equivalent here
    }
    return { generic, colored, x };
  }

  emptyAll(): void {
    for (const p of this.game.players) {
      const had = Object.values(p.manaPool).some((v) => v > 0);
      p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
      if (had) this.game.emit('MANA_EMPTIED', { player: p.index });
    }
  }
}
