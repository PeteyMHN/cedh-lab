/**
 * SAMPLE GAME — "Stop the Oracle"
 * A deterministic 4-player cEDH scenario played ENTIRELY through engine-validated actions:
 *   P0 attempts Demonic Consultation -> Thassa's Oracle.
 *   P2's Mystic Remora taxes every noncreature spell.
 *   P1 fights back with Counterspell; P0 protects with Force of Will (alt cost).
 *   The Oracle resolves with an empty library and wins.
 *
 * Run: npm run demo:game --workspace apps/cli
 */
import { Engine } from '@cedh-lab/engine';
import { makeEngine, setupScenario, runPriority, printStack, printBoard, findInHand, findUntapped, stackTop, DecideResult } from './harness.js';

const D0 = ['island', 'island', 'island', 'swamp', 'sol-ring', 'dark-ritual', 'demonic-consultation',
  'thassas-oracle', 'force-of-will', 'brainstorm', 'counterspell', 'island', 'swamp', 'brainstorm', 'dark-ritual'];
const D1 = ['island', 'island', 'island', 'island', 'island', 'island', 'counterspell', 'swords-to-plowshares',
  'brainstorm', 'island', 'island', 'dark-ritual', 'island', 'island', 'island'];
const D2 = ['island', 'island', 'island', 'island', 'island', 'island', 'mystic-remora', 'rhystic-study',
  'brainstorm', 'island', 'island', 'island', 'counterspell', 'island', 'island'];
const D3 = ['island', 'island', 'island', 'island', 'swamp', 'island', 'brainstorm', 'dark-ritual',
  'island', 'island', 'island', 'island', 'swamp', 'island', 'island'];

const { engine } = await makeEngine(['OraclePilot', 'Interaction', 'FishTender', 'Seat4'], [D0, D1, D2, D3], 1337);

// Scenario Lab setup (labeled in the event log)
setupScenario(engine, [
  { player: 0, hand: ['dark-ritual', 'demonic-consultation', 'thassas-oracle', 'force-of-will', 'brainstorm'],
    battlefield: ['swamp', 'island', 'island', 'sol-ring'] },
  { player: 1, hand: ['counterspell'], battlefield: ['island', 'island'] },
  { player: 2, battlefield: ['mystic-remora'] },
]);

// Everyone declines to pay for fish (P0 needs mana for the combo; P1 is tapped out)
engine.paymentPolicy = () => false;

// Jump to P0's precombat main (turn 1)
await engine.turns.enterPhase('draw');
await engine.turns.enterPhase('precombatMain');

console.log('=== STOP THE ORACLE — deterministic 4-player scenario (seed 1337) ===');
printBoard(engine);

let p1Answered = false;

async function decide(e: Engine, p: number): Promise<DecideResult> {
  // --- P0: assemble BBBB+UU, cast Consultation naming Thassa's Oracle ---
  if (p === 0) {
    // 1. protection FIRST — never let a stale fish trigger block a response
    const fow = findInHand(e, 0, 'force-of-will');
    const cs = stackTop(e, 'Counterspell');
    if (process.env.FOW_DEBUG) console.log(`  [dbg P0] fow=${fow} cs=${cs?.cardName} stack=[${e.game.turn.stack.map((s) => s.cardName).join('|')}]`);
    if (fow && cs) {
      await e.stack.castSpell(0, fow, { alternativeCost: 'force-of-will', targets: [cs.id] });
      e.priority.actionTaken(0);
      console.log('  P0 pitches Brainstorm → Force of Will targeting Counterspell'); printStack(e); return 'acted';
    }
    // 2. mana assembly (wait while our own Ritual is still resolving)
    const ritual = findInHand(e, 0, 'dark-ritual');
    const ritualOnStack = stackTop(e, 'dark-ritual');
    const swamp = findUntapped(e, 0, 'swamp');
    if (ritualOnStack) return 'pass';
    if (ritual && swamp) { await e.activateAbility(0, swamp, 0); console.log('  P0 taps Swamp → {B}'); return 'acted'; }
    if (ritual && !swamp) {
      await e.stack.castSpell(0, ritual); e.priority.actionTaken(0);
      console.log('  P0 casts Dark Ritual → {B}{B}{B}'); printStack(e); return 'acted';
    }
    const ring = findUntapped(e, 0, 'sol-ring');
    const consult = findInHand(e, 0, 'demonic-consultation');
    if (ring && consult) { await e.activateAbility(0, ring, 0); console.log('  P0 taps Sol Ring → {C}{C}'); return 'acted'; }
    const isl = findUntapped(e, 0, 'island');
    if (isl && consult) { await e.activateAbility(0, isl, 0); console.log('  P0 taps Island → {U}'); return 'acted'; }
    if (consult && !isl) {
      await e.stack.castSpell(0, consult, { namedCard: "Thassa's Oracle" }); e.priority.actionTaken(0);
      console.log('  P0 casts Demonic Consultation naming "Thassa\'s Oracle"'); printStack(e); return 'acted';
    }
    // 3. win: cast Oracle once the coast is clear
    const oracle = findInHand(e, 0, 'thassas-oracle');
    const consultOnStack = stackTop(e, 'Demonic Consultation');
    if (oracle && !consultOnStack && e.game.turn.stack.length === 0) {
      await e.stack.castSpell(0, oracle); e.priority.actionTaken(0);
      console.log("  P0 casts Thassa's Oracle"); printStack(e); return 'acted';
    }
    return 'pass';
  }
  // --- P1: counter the Consultation ---
  if (p === 1 && !p1Answered) {
    const consult = stackTop(e, 'Demonic Consultation');
    const cs = findInHand(e, 1, 'counterspell');
    if (consult && cs) {
      const isl = findUntapped(e, 1, 'island');
      const poolU = e.game.players[1].manaPool.U;
      if (isl && poolU < 2) { await e.activateAbility(1, isl, 0); console.log('  P1 taps Island → {U}'); return 'acted'; }
      if (poolU >= 2) {
        await e.stack.castSpell(1, cs, { targets: [consult.id] }); e.priority.actionTaken(1);
        p1Answered = true;
        console.log('  P1 casts Counterspell targeting Demonic Consultation'); printStack(e); return 'acted';
      }
    }
    return 'pass';
  }
  return 'pass'; // P2, P3: no action (their fish already did the work)
}

await runPriority(engine, decide, "P0's precombat main — the attempt");

console.log('\n=== FINAL BOARD ===');
printBoard(engine);
console.log(`\nwinners: ${engine.game.winners.length ? engine.game.winners.map((w) => 'P' + w).join(', ') : 'none'}`);
console.log(`events: ${engine.game.events.length}, chain valid: ${engine.game.verifyChain()}`);
const fishDraws = engine.game.events.filter((ev) => ev.type === 'FISH_TRIGGER').length;
console.log(`Mystic Remora triggers resolved: ${fishDraws}`);
