/**
 * FULL AI GAME — four AI seats play a complete game autonomously.
 *
 * Each seat runs HeuristicPolicy (beliefs + compound planning + 1-ply search)
 * through playGame(): mulligans, priority rounds, phase advancement, until
 * the game ends or the turn cap hits (draw fallback).
 *
 * Assertions: zero illegal actions proposed, game terminates, event chain
 * verifies. The AI only ever sees Observations — never true hidden state.
 *
 * Run: npm run demo:aigame --workspace apps/cli
 */
import { makeEngine } from './harness.js';
import { DeckModel, HeuristicPolicy, playGame } from '@cedh-lab/ai';

// 20-card decks from the v0.1 scripted pool (short games, winnable boards).
const D_TURBO = [
  ...Array(8).fill('island'), ...Array(3).fill('swamp'),
  'dark-ritual', 'dark-ritual', 'demonic-consultation', 'demonic-consultation',
  'thassas-oracle', 'thassas-oracle', 'brainstorm', 'counterspell', 'demonic-tutor',
];
const D_FISH = [
  ...Array(10).fill('island'),
  'mystic-remora', 'mystic-remora', 'rhystic-study', 'rhystic-study',
  'counterspell', 'counterspell', 'brainstorm', 'brainstorm',
  'force-of-will', 'vampiric-tutor',
];
const D_AGGRO = [
  ...Array(7).fill('plains'), ...Array(6).fill('forest'),
  'llanowar-elves', 'llanowar-elves', 'llanowar-elves',
  'swords-to-plowshares', 'swords-to-plowshares', 'sol-ring', 'brainstorm',
];
const D_MID = [
  ...Array(6).fill('island'), ...Array(6).fill('swamp'),
  'demonic-tutor', 'demonic-tutor', 'vampiric-tutor',
  'demonic-consultation', 'thassas-oracle', 'counterspell', 'dark-ritual', 'brainstorm',
];

const turboModel: DeckModel = {
  commander: 'Turbo Oracle', archetype: 'turbo',
  winConditions: ["Thassa's Oracle"], comboPieces: ['Demonic Consultation', 'Dark Ritual'],
  interaction: ['Counterspell', 'Force of Will'], fastMana: ['Dark Ritual'],
  tutors: ['Demonic Tutor'], cardAdvantage: ['Brainstorm'],
};
const fishModel: DeckModel = {
  commander: 'Fish Control', archetype: 'control',
  winConditions: ["Thassa's Oracle"], comboPieces: ['Demonic Consultation'],
  interaction: ['Counterspell', 'Force of Will'], fastMana: [],
  tutors: ['Vampiric Tutor'], cardAdvantage: ['Mystic Remora', 'Rhystic Study', 'Brainstorm'],
};
const aggroModel: DeckModel = {
  commander: 'Swords Aggro', archetype: 'midrange',
  winConditions: [], comboPieces: [],
  interaction: ['Swords to Plowshares'], fastMana: ['Sol Ring', 'Llanowar Elves'],
  tutors: [], cardAdvantage: ['Brainstorm'],
};
const midModel: DeckModel = {
  commander: 'Tutor Midrange', archetype: 'midrange',
  winConditions: ["Thassa's Oracle"], comboPieces: ['Demonic Consultation', 'Dark Ritual'],
  interaction: ['Counterspell'], fastMana: ['Dark Ritual'],
  tutors: ['Demonic Tutor', 'Vampiric Tutor'], cardAdvantage: ['Brainstorm'],
};

const { engine } = await makeEngine(
  ['Turbo', 'Fish', 'Aggro', 'Mid'],
  [D_TURBO, D_FISH, D_AGGRO, D_MID],
  20240613,
);

const policies = new Map([
  [0, new HeuristicPolicy(turboModel)],
  [1, new HeuristicPolicy(fishModel)],
  [2, new HeuristicPolicy(aggroModel)],
  [3, new HeuristicPolicy(midModel)],
]);

console.log('=== FULL AI GAME — 4 seats, HeuristicPolicy (seed 20240613) ===\n');
const result = await playGame(engine, policies, { turnCap: 60 });

console.log('--- result ---');
console.log(`winners: ${result.draw ? '(draw — turn cap)' : result.winners.map((w) => `P${w}`).join(', ')}`);
console.log(`turns: ${result.turns}, events: ${result.events}`);
console.log(`illegal actions proposed: ${result.illegalActions}`);
console.log(`engine apply failures: ${result.applyFailures}`);
console.log(`aborted compound plans: ${result.abortedPlans}`);
console.log(`event chain valid: ${result.chainValid}`);
for (let p = 0; p < 4; p++) {
  const pl = engine.game.players[p];
  console.log(`P${p}: life ${pl.life}, hand ${pl.hand.length}, battlefield ${pl.battlefield.length}, lost: ${pl.hasLost}`);
}
if (result.log.length > 0) {
  console.log('\ndriver notes (first 15):');
  result.log.slice(0, 15).forEach((l) => console.log(`  ${l}`));
}

// ---- assertions ----
const failures: string[] = [];
if (result.illegalActions !== 0) failures.push(`illegal actions proposed: ${result.illegalActions}`);
if (!result.chainValid) failures.push('event chain INVALID');
if (!result.draw && result.winners.length === 0 && engine.game.alivePlayers.length > 1) {
  failures.push('game did not terminate and was not declared a draw');
}
if (failures.length > 0) {
  console.error('\nASSERTION FAILURES:');
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('\nAll assertions passed: game terminated, chain valid, zero illegal actions.');
