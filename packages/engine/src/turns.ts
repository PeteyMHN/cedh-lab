/** Turn structure: full phase/step machine with priority hooks. */
import { Game } from './game.js';
import { Phase } from './types.js';

export const PHASES: Phase[] = [
  'untap', 'upkeep', 'draw',
  'precombatMain',
  'beginCombat', 'declareAttackers', 'declareBlockers', 'combatDamage', 'endCombat',
  'postcombatMain',
  'endStep', 'cleanup',
];

const GRANTS_PRIORITY: Set<Phase> = new Set([
  'upkeep', 'draw', 'precombatMain',
  'beginCombat', 'declareAttackers', 'declareBlockers', 'combatDamage', 'endCombat',
  'postcombatMain', 'endStep',
]);

export class TurnMachine {
  constructor(private game: Game) {}

  startGame(firstPlayer = 0): void {
    const g = this.game;
    for (let p = 0; p < g.players.length; p++) {
      g.shuffleLibrary(p);
      g.draw(p, 7);
    }
    g.turn.number = 1;
    g.turn.activePlayer = firstPlayer;
    g.emit('TURN_STARTED', { turn: 1, activePlayer: firstPlayer });
    this.enterPhase('untap');
  }

  enterPhase(ph: Phase): void {
    const g = this.game;
    g.turn.phase = ph;
    g.turn.passedPriority = g.players.map(() => false);
    g.emit('PHASE_CHANGED', { turn: g.turn.number, phase: ph, activePlayer: g.turn.activePlayer });
    switch (ph) {
      case 'untap':
        for (const id of g.players[g.turn.activePlayer].battlefield) {
          const o = g.getObject(id);
          if (!o.tapped) continue;
          o.tapped = false;
          o.summoningSick = false;
        }
        g.emit('UNTAP_STEP', { player: g.turn.activePlayer });
        this.nextPhase(); // untap grants no priority
        break;
      case 'draw':
        if (!(g.turn.number === 1 && g.players.length > 2)) g.draw(g.turn.activePlayer, 1);
        else g.emit('DRAW_SKIPPED', { player: g.turn.activePlayer, reason: 'first turn multiplayer' });
        break;
      case 'cleanup':
        this.doCleanup();
        break;
    }
  }

  private doCleanup(): void {
    const g = this.game;
    const ap = g.turn.activePlayer;
    const pl = g.players[ap];
    // discard to hand size
    while (pl.hand.length > pl.maxHandSize) {
      const id = pl.hand.pop()!;
      pl.graveyard.push(id);
      g.getObject(id).zone = 'graveyard';
      g.emit('DISCARD', { player: ap, object: id, reason: 'cleanup' });
    }
    // damage wears off, until-end-of-turn effects end
    for (const [, o] of g.objects) o.damageMarked = 0;
    for (const p of g.players) p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    g.emit('CLEANUP', { player: ap });
  }

  nextPhase(): void {
    const g = this.game;
    const i = PHASES.indexOf(g.turn.phase);
    if (i === PHASES.length - 1) {
      g.turn.number += 1;
      const alive = g.alivePlayers;
      const cur = alive.indexOf(g.turn.activePlayer);
      g.turn.activePlayer = alive[(cur + 1) % alive.length];
      g.turn.landsPlayedThisTurn = {};
      g.turn.spellsCastThisTurn = {};
      g.emit('TURN_STARTED', { turn: g.turn.number, activePlayer: g.turn.activePlayer });
      this.enterPhase('untap');
    } else {
      this.enterPhase(PHASES[i + 1]);
    }
  }

  grantsPriority(ph: Phase): boolean { return GRANTS_PRIORITY.has(ph); }
}
