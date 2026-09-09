/**
 * SAMPLE AI DECISION — no hidden-information cheating.
 * The policy NEVER sees the Game; it only gets an Observation (counts, not
 * cards, for opponent hands). We prove it: P1 secretly holds Force of Will
 * and the AI's explanation must not mention it.
 *
 * Run: npm run demo:ai --workspace apps/cli
 */
import { Engine } from '@cedh-lab/engine';
import { makeEngine, setupScenario, findInHand, findUntapped } from './harness.js';
import { observe } from '@cedh-lab/ai';
import { DeckModel, mulliganScore } from '@cedh-lab/ai';
import { chooseResponse } from '@cedh-lab/ai';

const D0 = ['island', 'island', 'island', 'island', 'counterspell', 'force-of-will', 'brainstorm',
  'island', 'island', 'swamp', 'dark-ritual', 'island', 'island', 'island', 'island'];
const D1 = ['island', 'island', 'swamp', 'dark-ritual', 'demonic-consultation', 'thassas-oracle',
  'brainstorm', 'island', 'island', 'swamp', 'island', 'force-of-will', 'island', 'island', 'island'];

const oracleModel: DeckModel = {
  commander: 'Thassa\'s Oracle combo', archetype: 'turbo',
  winConditions: ["Thassa's Oracle", 'Demonic Consultation'],
  comboPieces: ['Demonic Consultation', 'Dark Ritual'],
  interaction: ['Counterspell', 'Force of Will'],
  fastMana: ['Sol Ring', 'Dark Ritual'],
  tutors: ['Demonic Tutor', 'Vampiric Tutor'],
  cardAdvantage: ['Mystic Remora', 'Rhystic Study'],
};
const p1Model: DeckModel = {
  ...oracleModel, commander: 'rival Oracle deck',
};

const { engine: e } = makeEngine(['AI_Pilot', 'Rival'], [D0, D1], 777);
setupScenario(e, [
  { player: 0, hand: ['counterspell'], battlefield: ['island', 'island'] },
  // P1's hand is SECRET: consultation + a hidden Force of Will the AI must not know about
  { player: 1, hand: ['demonic-consultation', 'force-of-will'], battlefield: ['swamp'] },
]);
e.turns.enterPhase('draw');
e.turns.enterPhase('precombatMain');

// ---------- 1. mulligan ----------
const obs0 = observe(e, 0);
const mull = mulliganScore(obs0, oracleModel, 0);
console.log('=== AI MULLIGAN DECISION (P0, 7 cards) ===');
console.log('hand:', obs0.hand.map((c) => c.name).join(', '));
console.log(`decision: ${mull.keep ? 'KEEP' : 'MULLIGAN'} (score ${mull.score.toFixed(2)})`);
mull.reasons.forEach((r) => console.log(`  - ${r}`));

// ---------- 2. priority response: P1 attempts Consultation ----------
e.priority.startRound();
e.priority.pass(0); // P0 passes; P1 gets priority
// P1 taps swamp, casts Demonic Consultation naming Thassa's Oracle
e.activateAbility(1, findUntapped(e, 1, 'swamp')!, 0);
e.stack.castSpell(1, findInHand(e, 1, 'demonic-consultation')!, { namedCard: "Thassa's Oracle" });
e.priority.actionTaken(1);
// now P0 has priority with Counterspell up — ask the AI
// P0 floats UU first (this is what "holding up Counterspell" means in-engine;
// compound tap-then-cast planning is on the AI roadmap)
for (const id of [...e.game.players[0].battlefield]) {
  const o = e.game.getObject(id);
  if (o.oracleId === 'island' && !o.tapped) { e.activateAbility(0, id, 0); break; }
}
for (const id of [...e.game.players[0].battlefield]) {
  const o = e.game.getObject(id);
  if (o.oracleId === 'island' && !o.tapped) { e.activateAbility(0, id, 0); break; }
}
const obs = observe(e, 0);
const legal = e.legalActionsFor(0).filter((a) => a.kind !== 'pass');
const models = new Map([[0, oracleModel], [1, p1Model]]);
const decision = chooseResponse(obs, oracleModel, legal, models);

console.log('\n=== AI PRIORITY DECISION (P0, facing Demonic Consultation) ===');
console.log('observation given to AI:');
console.log(`  stack top: ${obs.stack[obs.stack.length - 1].cardName} (P${obs.stack[obs.stack.length - 1].controller})`);
console.log(`  P1 hand: ${obs.opponents[0].handCount} cards (contents hidden: ${JSON.stringify(obs.opponents[0].knownCards)})`);
console.log(`  my hand: ${obs.hand.map((c) => c.name).join(', ')}`);
if (decision) {
  console.log(`\nAI action: ${decision.action.label}`);
  console.log(`eval before ${decision.explanation.evaluationBefore.toFixed(2)} → after ${decision.explanation.evaluationAfter.toFixed(2)}`);
  console.log('reasons:');
  decision.explanation.reasons.forEach((r) => console.log(`  - ${r}`));
  console.log('considered:');
  decision.explanation.considered.forEach((c) => console.log(`  - ${c.label} (Δ ${c.delta >= 0 ? '+' : ''}${c.delta.toFixed(2)}): ${c.note}`));
  // anti-cheat proof
  const leaked = decision.explanation.reasons.join(' ') + decision.explanation.considered.map((c) => c.label + c.note).join(' ');
  const secretInHand = e.game.players[1].hand.map((id) => e.game.getObject(id).cardName);
  const mentionsSecret = secretInHand.some((n) => n !== "Demonic Consultation" && leaked.includes(n));
  console.log(`\nP1's actual hand: ${secretInHand.join(', ')}`);
  console.log(`explanation leaks hidden cards: ${mentionsSecret ? 'YES — BUG' : 'no'}`);
  console.log(`observation exposes opponent cards: ${obs.opponents.some((o) => o.knownCards.length > 0 && o.knownCards.some((k) => secretInHand.includes(k.name))) ? 'YES — BUG' : 'no (counts only)'}`);
} else {
  console.log('AI passes (no response chosen)');
}
