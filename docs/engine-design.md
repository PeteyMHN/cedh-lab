# Rules Engine Design

**Package:** `packages/engine` · **Status:** vertical slice implemented, 18 tests passing.

## 1. Philosophy

The engine implements the Comprehensive Rules as a deterministic state machine. Three principles:

1. **The engine owns the rules; cards own their text.** Anything derivable from card text lives in a card script; anything in the CR (priority, layers, SBAs, APNAP, replacement ordering) lives in the engine.
2. **Deterministic by construction.** Seeded RNG (`packages/engine/src/rng.ts`), no `Date.now()`, no `Math.random()`, no I/O. Same seed + same actions = same events, bit for bit.
3. **Never silently wrong.** Card scripts get a restricted `ScriptApi`; anything a script can't express raises `UnsupportedInteraction`, which pauses the game and explains itself.

## 2. Module map

| Module | Responsibility | CR anchors |
|---|---|---|
| `game.ts` | state, zones, event log (hash-chained), snapshots, commander damage | 400 (zones), 903 |
| `rng.ts` | seeded PRNG (mulberry32), shuffle | — |
| `mana.ts` | mana pool, payment, burn-less emptying | 106 |
| `priority.ts` | APNAP priority rounds, pass/action tracking | 117, 101.4 |
| `turns.ts` | phases/steps, turn structure, active player | 500–514 |
| `stack.ts` | cast/activate/trigger placement, LIFO resolution, fizzle (608.2b), counterspell removal | 601–608 |
| `combat.ts` | declare attackers/blockers, damage (scaffold) | 506–510 |
| `triggers.ts` | trigger condition matching, APNAP ordering, independence | 603, 101.4 |
| `sba.ts` | state-based actions: lethal damage, 0 toughness, player loss | 704 |
| `layers.ts` | continuous-effect layers framework (7 layers) | 613 |
| `choices.ts` | choice-request pipeline (scaffold) | — |
| `commander.ts` | tax {2}/cast, command-zone replacement, 21-damage loss | 903 |
| `legality.ts` | timing, targets, costs, zones → legal action generation | 601.2, 601.3 |
| `observe.ts` | per-seat observation builder (AI + hidden views) | 400.2 (hidden zones) |
| `engine.ts` | facade: wires everything, ScriptApi, trigger resolution | — |

## 3. Event sourcing

Every state change emits a typed event: `{ seq, type, payload, prevHash, hash }`. The chain is verifiable (`game.verifyChain()`), serialized for replays, and persisted by the server. Snapshots are full state copies (structured clone); restore re-verifies the chain.

## 4. Casting a spell (601)

1. Announce → choose modes/targets/distribution (choices pipeline).
2. Determine total cost (cost increasers/reducers — framework present).
3. Activate mana abilities (don't use the stack, CR 605).
4. Pay all costs in any order (payment policy pluggable; default "never pay" for taxes like Remora).
5. Spell becomes the top stack object (601.2a–i ordering).
6. Triggers watching the cast fire (603); placed APNAP, active player first.

## 5. Resolving the stack (608)

- Top object resolves; all players must pass in succession first.
- Check targets: if all illegal → **fizzle** (countered by rules, 608.2b), no part of the effect happens. Tested: two Swords to Plowshares, one Elf.
- Counterspell effects remove the target spell; it never resolves. Tested.
- Triggered abilities resolve independently of their source (603.7a): countering Brainstorm doesn't stop Remora/Study triggers. Tested in `demo-stack.ts`.

## 6. Replacement effects & layers (in progress)

- `layers.ts` implements the 7-layer framework; per-card continuous effects register through scripts.
- Full replacement-effect ordering (616: affected object's controller chooses order) is the next engine milestone — currently unsupported interactions raise `UnsupportedInteraction` rather than resolving incorrectly.

## 7. What the slice deliberately does not do yet

- Full combat (declare attackers exists; blockers/damage steps scaffolded).
- The general choice pipeline (card scripts currently make default choices for tutors).
- Replacement-effect ordering UI.
- Loops (deterministic loop detection per 729 is roadmap).

Each gap fails loudly, not silently. See `docs/roadmap.md` and `docs/quality-audit.md`.
