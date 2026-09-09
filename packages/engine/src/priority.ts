/**
 * Priority system: explicit APNAP-order priority rounds.
 * - Active player gets priority first each round.
 * - A player may PASS or take an action (cast/activate/etc.).
 * - If ALL players pass in succession with empty stack and it's a phase that
 *   grants priority, the phase ends. With a non-empty stack, the top object resolves.
 * - `holdPriority` lets a player respond to their own spell.
 */
import { Game } from './game.js';
import { LegalAction } from './types.js';

export class PrioritySystem {
  /** players may register stops; engine asks `wantsPriority` before auto-passing */
  wantsPriority: (player: number, game: Game) => boolean = () => false;

  constructor(private game: Game) {}

  /** Begin a priority round; active player first (APNAP). */
  startRound(): void {
    const g = this.game;
    g.turn.priorityPlayer = g.turn.activePlayer;
    g.turn.passedPriority = g.players.map(() => false);
    g.emit('PRIORITY_ROUND_START', { first: g.turn.priorityPlayer, stackSize: g.turn.stack.length });
  }

  currentPlayer(): number | null { return this.game.turn.priorityPlayer; }

  /** Returns legal actions for the player who currently has priority. */
  legalActionsFor(p: number, gen: (p: number, g: Game) => LegalAction[]): LegalAction[] {
    if (this.game.turn.priorityPlayer !== p) return [];
    return [...gen(p, this.game), { kind: 'pass', label: 'Pass priority' }];
  }

  pass(p: number): void {
    const g = this.game;
    this.requirePriority(p);
    g.turn.passedPriority[p] = true;
    g.emit('PRIORITY_PASSED', { player: p });
    this.advance();
  }

  /** A player took an action: everyone un-passes, priority returns to active player... */
  actionTaken(by: number, holdPriority = false): void {
    const g = this.game;
    this.requirePriority(by);
    g.turn.passedPriority = g.players.map(() => false);
    g.emit('PRIORITY_ACTION', { player: by, holdPriority });
    if (holdPriority) {
      g.turn.priorityPlayer = by; // respond to own spell
    } else {
      g.turn.priorityPlayer = g.turn.activePlayer;
    }
  }

  private requirePriority(p: number): void {
    if (this.game.turn.priorityPlayer !== p) throw new Error(`player ${p} does not have priority`);
  }

  private advance(): void {
    const g = this.game;
    const alive = g.alivePlayers;
    if (alive.length <= 1) return;
    const order = alive.slice(alive.indexOf(g.turn.activePlayer)).concat(alive.slice(0, alive.indexOf(g.turn.activePlayer)));
    // find next player who hasn't passed
    const cur = g.turn.priorityPlayer!;
    const idx = order.indexOf(cur);
    for (let k = 1; k <= order.length; k++) {
      const nxt = order[(idx + k) % order.length];
      if (!g.turn.passedPriority[nxt]) {
        g.turn.priorityPlayer = nxt;
        g.emit('PRIORITY_GAINED', { player: nxt });
        return;
      }
    }
    // everyone passed
    g.turn.priorityPlayer = null;
    if (g.turn.stack.length > 0) {
      g.emit('PRIORITY_ALL_PASSED', { willResolve: true });
    } else {
      g.emit('PRIORITY_ALL_PASSED', { willResolve: false });
    }
  }
}
