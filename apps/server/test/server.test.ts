/**
 * Server workstream tests:
 *  1. illegal action rejected, state unchanged
 *  2. hidden views contain no opponent hand cards
 *  3. reconnect catch-up (missed events + snapshot threshold)
 *  4. a 2-mocked-human + 2-AI pod completes a game
 *  5. choice timeout falls back to the default policy
 *  6. deck validation
 */
import { describe, expect, it } from 'vitest';
import { Registry } from '@cedh-lab/cards';
import type { ChoiceRequest, GameEvent } from '@cedh-lab/engine';
import type { ServerMsg } from '@cedh-lab/protocol';
import { GameRoom } from '../src/driver.js';
import { assertNoLeak } from '../src/views.js';
import { validateDeck } from '../src/validation.js';
import { InMemoryStore } from '../src/store.js';

const registry = new Registry();
const ISLANDS = Array(24).fill('island');
const AI_DECK = [...ISLANDS, 'brainstorm', 'brainstorm', 'counterspell', 'counterspell'];

interface Capture {
  sent: Map<number, ServerMsg[]>;
  broadcast: ServerMsg[];
  winners: number[] | null;
}

function capture(): Capture {
  return { sent: new Map(), broadcast: [], winners: null };
}

function makeRoom(cap: Capture, opts?: { aiSeats?: number[]; choiceTimeoutMs?: number }): GameRoom {
  const seats = [0, 1, 2, 3].map((i) => ({ name: `P${i}`, isAI: (opts?.aiSeats ?? [2, 3]).includes(i) }));
  return GameRoom.create({
    podId: 'test-pod',
    seats,
    decks: seats.map((s, i) => ({ seat: i, list: [...AI_DECK] })),
    seed: 4242,
    choiceTimeoutMs: opts?.choiceTimeoutMs,
    callbacks: {
      sendTo: (seat, msg) => {
        if (!cap.sent.has(seat)) cap.sent.set(seat, []);
        cap.sent.get(seat)!.push(msg);
      },
      broadcast: (msg) => cap.broadcast.push(msg),
      onGameOver: (winners) => { cap.winners = winners; },
    },
  }, registry);
}

function lastView(cap: Capture, seat: number) {
  const views = (cap.sent.get(seat) ?? []).filter((m) => m.t === 'view');
  return views[views.length - 1] as Extract<ServerMsg, { t: 'view' }>;
}

describe('game room', () => {
  it('rejects an illegal action with state unchanged', async () => {
    const cap = capture();
    const room = makeRoom(cap);
    await room.start();
    const eventsBefore = room.engine.game.events.length;
    const hashBefore = room.engine.game.verifyChain();
    expect(hashBefore).toBe(true);

    // Seat 1 tries to act while seat 0 (or an AI) has priority — illegal.
    const p = room.engine.priority.currentPlayer();
    const offender = p === 0 ? 1 : 0;
    if (!room.isAI(offender)) {
      await expect(room.applyAction(offender, { kind: 'pass' })).rejects.toThrow(/priority/i);
      expect(room.engine.game.events.length).toBe(eventsBefore);
      expect(room.engine.game.verifyChain()).toBe(true);
    }

    // Casting a card that isn't in hand is illegal and changes nothing.
    const holder = room.engine.priority.currentPlayer();
    if (holder !== null && !room.isAI(holder)) {
      await expect(room.applyAction(holder, { kind: 'cast', card: 'obj_nonexistent' })).rejects.toThrow();
      expect(room.engine.game.events.length).toBe(eventsBefore);
    }
  });

  it('hidden views never contain opponent hand cards', async () => {
    const cap = capture();
    const room = makeRoom(cap);
    await room.start();
    // Drive a few human passes so draws/hands evolve.
    for (let i = 0; i < 12 && !room.engine.game.isOver; i++) {
      const p = room.engine.priority.currentPlayer();
      if (p === null) break;
      if (!room.isAI(p)) await room.applyAction(p, { kind: 'pass' });
      else break; // pump already ran AI turns
    }
    for (const seat of [0, 1]) {
      const v = lastView(cap, seat);
      expect(v).toBeTruthy();
      const leaks = assertNoLeak(
        { observation: v.observation, legal: v.legal, pendingChoice: v.pendingChoice ?? null },
        seat, room.engine,
      );
      expect(leaks).toEqual([]);
      // opponents are counts-only in the observation
      for (const o of v.observation.opponents) {
        expect(o.handCount).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('reconnect: missed events and snapshot threshold', async () => {
    const cap = capture();
    const room = makeRoom(cap);
    await room.start();
    for (let i = 0; i < 8 && !room.engine.game.isOver; i++) {
      const p = room.engine.priority.currentPlayer();
      if (p === null || room.isAI(p)) break;
      await room.applyAction(p, { kind: 'pass' });
    }
    const lastSeq = room.lastSeq;
    expect(lastSeq).toBeGreaterThan(0);
    // Caught-up client: nothing missed.
    expect(room.missedEvents(lastSeq)).toEqual([]);
    // Slightly behind: gets exactly the missed events, in order.
    const from = Math.max(-1, lastSeq - 5);
    const missed: GameEvent[] = room.missedEvents(from);
    expect(missed.length).toBe(lastSeq - from);
    expect(missed.map((e) => e.seq)).toEqual(missed.map((e) => e.seq).sort((a, b) => a - b));
    expect(room.needsSnapshot(from)).toBe(false);
    // Far behind: snapshot path.
    expect(room.needsSnapshot(lastSeq - 501)).toBe(true);
    const snap = room.snapshotFor(0);
    expect(snap.seq).toBe(lastSeq);
    expect(snap.view.observation).toBeTruthy();
  });

  it('a 2-human-mocked + 2-AI pod completes a game', async () => {
    const cap = capture();
    const room = makeRoom(cap);
    await room.start();
    let actions = 0;
    const MAX_ACTIONS = 4000;
    while (!room.engine.game.isOver && actions < MAX_ACTIONS) {
      const p = room.engine.priority.currentPlayer();
      if (p === null) break; // pump handles null internally; shouldn't surface
      if (room.isAI(p)) {
        throw new Error('AI seat awaiting human input — driver bug');
      }
      await room.applyAction(p, { kind: 'pass' });
      actions++;
    }
    // If the AIs haven't won by decking yet, remaining humans concede in turn order.
    while (!room.engine.game.isOver) {
      const p = room.engine.priority.currentPlayer();
      const humans = [0, 1].filter((s) => !room.engine.game.players[s].hasLost);
      if (humans.length === 0) break;
      const seat = p !== null && humans.includes(p) ? p : humans[0];
      await room.applyAction(seat, { kind: 'concede' });
    }
    expect(room.engine.game.isOver).toBe(true);
    expect(cap.winners).not.toBeNull();
    expect(room.engine.game.verifyChain()).toBe(true);
    const gameOvers = cap.broadcast.filter((m) => m.t === 'gameOver');
    expect(gameOvers.length).toBe(1);
    // every seat got events and views throughout
    for (const seat of [0, 1, 2, 3]) {
      const msgs = cap.sent.get(seat) ?? [];
      expect(msgs.some((m) => m.t === 'events')).toBe(true);
      expect(msgs.some((m) => m.t === 'view')).toBe(true);
    }
  }, 120_000);

  it('choice request times out to the default policy', async () => {
    const cap = capture();
    const room = makeRoom(cap, { choiceTimeoutMs: 50 });
    const req: ChoiceRequest = {
      id: 'choice_test_1', player: 0, kind: 'yesNo', prompt: 'test prompt',
    };
    const sel = await room.requestChoice(req);
    expect(sel).toEqual({ kind: 'yesNo', value: false });
  });

  it('choice answer resolves the waiter', async () => {
    const cap = capture();
    const room = makeRoom(cap, { choiceTimeoutMs: 5000 });
    const req: ChoiceRequest = {
      id: 'choice_test_2', player: 1, kind: 'option', prompt: 'pick',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    };
    const pending = room.requestChoice(req);
    await room.answerChoice(1, 'choice_test_2', { kind: 'option', index: 1 });
    const sel = await pending;
    expect(sel).toEqual({ kind: 'option', index: 1 });
  });
});

describe('deck validation', () => {
  it('rejects unknown cards and wrong size', () => {
    const v = validateDeck(['island', 'not-a-card'], undefined, registry);
    expect(v.valid).toBe(false);
    expect(v.violations.some((x) => x.includes('not-a-card'))).toBe(true);
    expect(v.violations.some((x) => x.includes('100'))).toBe(true);
  });
  it('rejects singleton violations but allows basic lands', () => {
    const v = validateDeck([...Array(50).fill('island'), ...Array(50).fill('brainstorm')], undefined, registry);
    expect(v.valid).toBe(false);
    expect(v.violations.some((x) => x.includes('Brainstorm'))).toBe(true);
  });
  it('accepts a 100-card singleton list', () => {
    const others = ['brainstorm', 'counterspell', 'swords-to-plowshares', 'dark-ritual', 'sol-ring', 'command-tower', 'llanowar-elves', 'demonic-tutor', 'vampiric-tutor', 'mystic-remora', 'rhystic-study', 'force-of-will', 'demonic-consultation', 'thassas-oracle', 'plains', 'forest', 'swamp', 'test-grizzly', 'test-fencer'];
    const list = [...Array(81).fill('island'), ...others];
    expect(list.length).toBe(100);
    const v = validateDeck(list, undefined, registry);
    expect(v.violations).toEqual([]);
    expect(v.valid).toBe(true);
  });
});

describe('nonce store', () => {
  it('dedupes (pod, seat, nonce)', () => {
    const s = new InMemoryStore();
    expect(s.seenNonce('p', 0, 'n1')).toBe(false);
    s.recordNonce('p', 0, 'n1');
    expect(s.seenNonce('p', 0, 'n1')).toBe(true);
    expect(s.seenNonce('p', 1, 'n1')).toBe(false);
  });
});
