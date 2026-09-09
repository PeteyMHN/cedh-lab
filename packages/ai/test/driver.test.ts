import { describe, expect, it } from 'vitest';
import { Engine } from '@cedh-lab/engine';
import { Registry, resolveTrigger } from '@cedh-lab/cards';
import { DeckModel, HeuristicPolicy, playGame } from '@cedh-lab/ai';

const model: DeckModel = {
  commander: 'Fuzz', archetype: 'turbo',
  winConditions: ["Thassa's Oracle"], comboPieces: ['Demonic Consultation', 'Dark Ritual'],
  interaction: ['Counterspell', 'Force of Will'], fastMana: ['Dark Ritual'],
  tutors: ['Demonic Tutor'], cardAdvantage: ['Mystic Remora', 'Brainstorm'],
};

function decks(): string[][] {
  const base = (lands: string[], spells: string[]) => [...lands, ...spells];
  return [
    base(Array(6).fill('island'), ['dark-ritual', 'demonic-consultation', "thassas-oracle", 'brainstorm', 'counterspell', 'demonic-tutor']),
    base(Array(6).fill('island'), ['mystic-remora', 'rhystic-study', 'counterspell', 'brainstorm', 'force-of-will', 'vampiric-tutor']),
    base([...Array(3).fill('plains'), ...Array(3).fill('forest')], ['llanowar-elves', 'swords-to-plowshares', 'sol-ring', 'brainstorm', 'counterspell', 'dark-ritual']),
    base([...Array(3).fill('island'), ...Array(3).fill('swamp')], ['demonic-tutor', 'demonic-consultation', "thassas-oracle", 'counterspell', 'brainstorm', 'vampiric-tutor']),
  ];
}

async function runGame(seed: number, turnCap = 25) {
  const engine = new Engine(
    decks().map((d, i) => ({ name: `P${i}`, deckOracleIds: d, commanderOracleIds: [] })),
    new Registry(), { seed },
  );
  engine.triggerResolver = resolveTrigger;
  await engine.turns.startGame(0);
  const policies = new Map([0, 1, 2, 3].map((s) => [s, new HeuristicPolicy(model)] as [number, HeuristicPolicy]));
  return playGame(engine, policies, { turnCap });
}

describe('driver', () => {
  it('never proposes an illegal action across fuzz seeds', async () => {
    for (const seed of [101, 202, 303, 404]) {
      const r = await runGame(seed);
      expect(r.illegalActions).toBe(0);
      expect(r.chainValid).toBe(true);
      // terminated one way or another (win or turn-cap draw)
      expect(r.draw || r.winners.length > 0 || r.turns > 25).toBe(true);
    }
  }, 120000);

  it('is deterministic: same seed, same result', async () => {
    const a = await runGame(777);
    const b = await runGame(777);
    expect(a.winners).toEqual(b.winners);
    expect(a.turns).toBe(b.turns);
    expect(a.events).toBe(b.events);
    expect(a.illegalActions).toBe(0);
  }, 120000);

  it('handles UnsupportedInteraction without crashing', async () => {
    // A policy that always throws the engine's fail-safe error: the driver
    // must convert it into a pass, not a crash.
    const { UnsupportedInteraction } = await import('@cedh-lab/engine');
    const bad = new HeuristicPolicy(model);
    bad.decidePriority = () => { throw new UnsupportedInteraction('synthetic gap'); };
    const engine = new Engine(
      decks().map((d, i) => ({ name: `P${i}`, deckOracleIds: d, commanderOracleIds: [] })),
      new Registry(), { seed: 55 },
    );
    engine.triggerResolver = resolveTrigger;
    await engine.turns.startGame(0);
    const policies = new Map<number, HeuristicPolicy>([[0, bad], [1, new HeuristicPolicy(model)], [2, new HeuristicPolicy(model)], [3, new HeuristicPolicy(model)]]);
    const r = await playGame(engine, policies, { turnCap: 12 });
    expect(r.chainValid).toBe(true);
  }, 120000);
}, 180000);
