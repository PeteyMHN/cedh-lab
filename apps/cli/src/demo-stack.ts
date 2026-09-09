/**
 * SAMPLE INTERACTION — "The Fish Bowl"
 * A complicated multiplayer stack interaction, fully engine-resolved:
 *   P2 controls Mystic Remora, P3 controls Rhystic Study.
 *   P0 (active player) casts Brainstorm → BOTH fish trigger.
 *   APNAP ordering: P2's trigger goes on the stack first, then P3's
 *   (turn order from the active player: P0, P1, P2, P3).
 *   P1 counters the Brainstorm — but the ALREADY-TRIGGERED fish still
 *   resolve and draw, because triggers are independent of their source.
 *
 * Run: npm run demo:stack --workspace apps/cli
 */
import { Engine } from '@cedh-lab/engine';
import { makeEngine, setupScenario, runPriority, printStack, printBoard, findInHand, findUntapped, stackTop, DecideResult } from './harness.js';

const D = (extra: string[]) => ['island', 'island', 'island', 'island', 'island', 'island',
  'brainstorm', 'counterspell', 'dark-ritual', 'swords-to-plowshares', 'island', 'island', ...extra];

const { engine: e } = makeEngine(
  ['Active', 'Counter', 'Remora', 'Study'],
  [D(['mystic-remora']), D(['rhystic-study']), D(['mystic-remora']), D(['rhystic-study'])],
  2024,
);
setupScenario(e, [
  { player: 0, hand: ['brainstorm'], battlefield: ['island'] },
  { player: 1, hand: ['counterspell'], battlefield: ['island', 'island'] },
  { player: 2, battlefield: ['mystic-remora'] },
  { player: 3, battlefield: ['rhystic-study'] },
]);
e.paymentPolicy = (player, amount, source) => {
  console.log(`  [payment] P${player} declines to pay {${amount}} for ${source}`);
  return false;
};
e.turns.enterPhase('draw');
e.turns.enterPhase('precombatMain');

console.log('=== THE FISH BOWL — APNAP triggers + trigger independence (seed 2024) ===');
printBoard(e);

let p1Done = false;
function decide(e: Engine, p: number): DecideResult {
  if (p === 0) {
    const bs = findInHand(e, 0, 'brainstorm');
    const isl = findUntapped(e, 0, 'island');
    if (bs && isl) { e.activateAbility(0, isl, 0); console.log('  P0 taps Island → {U}'); return 'acted'; }
    if (bs && !isl) {
      e.stack.castSpell(0, bs); e.priority.actionTaken(0);
      console.log('  P0 casts Brainstorm — both fish trigger!');
      printStack(e);
      const order = e.game.turn.stack.map((s) => `${s.cardName} (P${s.controller})`).join(' < ');
      console.log(`  APNAP order on the stack (bottom→top): ${order}`);
      return 'acted';
    }
    return 'pass';
  }
  if (p === 1 && !p1Done) {
    const bs = stackTop(e, 'Brainstorm');
    const cs = findInHand(e, 1, 'counterspell');
    if (bs && cs) {
      const isl = findUntapped(e, 1, 'island');
      if (isl && e.game.players[1].manaPool.U < 2) { e.activateAbility(1, isl, 0); console.log('  P1 taps Island → {U}'); return 'acted'; }
      if (e.game.players[1].manaPool.U >= 2) {
        e.stack.castSpell(1, cs, { targets: [bs.id] }); e.priority.actionTaken(1);
        p1Done = true;
        console.log('  P1 casts Counterspell targeting Brainstorm (the fish already triggered — they resolve anyway)');
        printStack(e); return 'acted';
      }
    }
    return 'pass';
  }
  return 'pass';
}

runPriority(e, decide, "P0's precombat main — the fish bowl");

console.log('\n=== RESULT ===');
printBoard(e);
const draws = e.game.events.filter((ev) => ev.type === 'DRAW').length;
console.log(`\ncard draws from fish triggers: P2 hand ${e.game.players[2].hand.length}, P3 hand ${e.game.players[3].hand.length}`);
console.log(`Brainstorm was countered: ${e.game.players[0].graveyard.some((id) => e.game.getObject(id).oracleId === 'brainstorm')}`);
console.log(`chain valid: ${e.game.verifyChain()} (${e.game.events.length} events)`);
