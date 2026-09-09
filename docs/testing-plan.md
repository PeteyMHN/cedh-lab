# cEDH Lab — Testing Plan

Owner: QA lead. Applies to every phase of the roadmap. Bar: no rules shortcut ships without a test proving it.

## 1. Test Pyramid

| Layer | Target | Examples | Tooling |
|---|---|---|---|
| **Unit** | Single card/ability in isolation | `Force of Will` alternative cost; `Basalt Monolith` untap cost; `Thassa's Oracle` ETB resolution with X≥N devotion check | Fixture harness: construct minimal game state, invoke one engine call, assert resulting state/event |
| **Integration** | Multi-card interactions, engine subsystems | Tutor + `Opposition Agent`; stack wars with priority passing; replacement-effect ordering choices; layer application with timestamps | Scenario runner (Given/When/Then, see §2) |
| **Property-based** | Rules invariants over randomized games | See §3 table | Hypothesis-style generators over deck archetypes × seeds; invariant assertions after every engine action |
| **Regression** | Every reported rules bug becomes a permanent test | Filed via replayable bug report (§6) | One scenario file per bug, tagged with bug ID |
| **Scenario** | Famous cEDH interactions, full games | Full pod games vs scripted opponents; matchup sims | Deterministic seeds, scripted player agents |
| **Soak / fuzz** | Random legal-move bots, 4-AI pods | 1,000-game nightly runs; crash/hang/illegal-state detection | Simulation workers, seed log on failure |

Ratios: ~60% unit, ~25% integration+scenario, ~10% property, regression grows monotonically. No "known failing" tests allowed to persist past a release boundary — either fixed or escalated.

## 2. Given/When/Then Fixture Format

All integration/scenario/regression tests use one YAML-ish fixture format (engine-agnostic, reviewable by judges):

```yaml
id: REG-0042-opposition-agent-tutor
rules_version: CR-2026-Q3
cards: [opposition-agent, vampiric-tutor, ...]   # oracle IDs, pinned version
given:
  players:
    - id: P1  life: 40  hand: [vampiric-tutor]  battlefield: [opposition-agent]
    - id: P2  life: 40  hand: []                battlefield: []
  turn: { active: P2, phase: main1, priority: P2 }
  stack: []
when:
  - { actor: P2, action: cast, card: vampiric-tutor }
  - { actor: P1, action: pass }                  # allow trigger/choices to resolve
  - { actor: P1, action: choose, for: opposition-agent-control, value: P1 }  # P2's search controlled by P1
then:
  assert:
    - "P2 hand does not contain the tutored card"
    - "P1 exiles exactly 1 card from P2's library face down"
    - "P2 library shuffled; P2 life == 39"        # Vampiric Tutor life loss
    - "event log contains SEARCH_CONTROLLED {controller: P1}"
  invariants: [stack-lifo, priority-apnap, zones-conserved]
```

- `given` is a full serialized game state (seeded RNG).
- `when` is a sequence of legal engine actions; any illegal action fails the test at load time (fixtures must be *valid* plays).
- `then` asserts on final state **and** on the event log (order matters).
- Every fixture runs under `deterministic_seed` and the resulting event-log hash is pinned.

## 3. Property-Based Rules Invariants

Checked after **every** engine action in fuzz/soak runs and after each `when` step in fixtures:

| Invariant | Statement |
|---|---|
| `zones-conserved` | Every card object exists in exactly one zone at all times (tokens excluded from library/hand) |
| `stack-lifo` | Stack resolves top-down; a resolving object was the top at resolution start |
| `priority-apnap` | After each resolution/trigger batch, priority passes in APNAP order starting from active player; no player is skipped while they hold a legal action |
| `mana-nonnegative` | No mana pool entry is negative; mana empties at each step/phase end |
| `sba-convergence` | State-based actions reach a fixed point (no infinite SBA loop); simultaneous SBAs applied as a batch |
| `layer-sanity` | Continuous effects applied in layer order 1–7; timestamps respected within a layer; dependency re-evaluated when effects change |
| `target-legality` | Every target on the stack is re-validated on resolution; illegal targets removed; spell fizzles only if *all* targets illegal |
| `life-monotone` | Life changes only via events in the log; no silent deltas |
| `hidden-info` | Player observation views never contain unrevealed opponent hand/library cards (enforced by serializer test) |
| `seed-determinism` | Same seed + same action script → identical event log (see §5) |
| `commander-tax` | Commander cast count from command zone is tracked per commander; tax = 2×(casts−1) generic |
| `replacement-choice` | When multiple replacement effects apply to one event, affected player/object controller is offered the ordering choice |

## 4. Named Interaction Test Cases (from spec)

Each becomes a fixture file under `tests/interactions/`. What each asserts:

1. **Thassa's Oracle + Demonic Consultation** (`oracle-consultation.yaml`) — Oracle ETB trigger with devotion ≥ library size wins the game; Consult exiles named card then all cards with that name; win check happens on trigger resolution, not on empty draw.
2. **Opposition Agent + tutor** (`opposition-agent.yaml`) — controller of Agent controls the searching player; exiles found card face down; may cast it while exiled; library still shuffles; life loss from Vampiric Tutor still paid.
3. **Drannith Magistrate + commander cast** (`drannith-magistrate.yaml`) — spells can't be cast from command zone while Magistrate is on battlefield; commander tax still accrues for attempts? (no — cast never initiated); removing Magistrate mid-turn re-enables casting.
4. **Grafdigger's Cage** (`grafdiggers-cage.yaml`) — creature cards can't enter from graveyard/library; players can't cast from graveyard/library; noncreature reanimation still works; ETB triggers of already-on-battlefield creatures unaffected.
5. **Rule of Law** (`rule-of-law.yaml`) — each player max 1 spell/turn; copies aren't cast (storm copies OK); second cast attempt is an illegal action rejected by engine.
6. **Silence / Grand Abolisher** (`silence-abolisher.yaml`) — Silence: no spells cast rest of turn, abilities still activatable; Abolisher: opponents can't cast or activate *during your turn*; priority still passes normally.
7. **Deflecting Swat** (`deflecting-swat.yaml`) — free if commander on battlefield; retargets spell with single target; illegal if target has no legal alternative (choice offered among legal targets only).
8. **Flusterstorm storm count** (`flusterstorm.yaml`) — copies = spells cast before it this turn (including opponents'); each copy independently targetable; original countered → copies remain.
9. **Pact of Negation upkeep trigger** (`pact-upkeep.yaml`) — delayed trigger at next upkeep: pay 3UU or lose; can't be "responded to" by paying early; trigger exists even if Pact was countered? (no — only on resolution).
10. **Chain of Vapor** (`chain-of-vapor.yaml`) — each player may copy for each nonland permanent; sacrifice-a-land cost is *not* optional on copies; copies target independently.
11. **Dress Down** (`dress-down.yaml`) — creatures lose all abilities (layer 6) including ETB triggers that would trigger while it's on battlefield; ETB triggers already on stack still resolve.
12. **Phantasmal Image copying** (`phantasmal-image.yaml`) — enters as copy (layer 1) except it's an Illusion + sacrifice-on-target; copyable values locked at ETB; legend rule applies if copying legendary.
13. **Underworld Breach** (`underworld-breach.yaml`) — escape requires exiling 3 other graveyard cards as additional cost; each card escapable once per turn; Breach self-exile on leaving battlefield.
14. **Dauthi Voidwalker** (`dauthi-voidwalker.yaml`) — cards that would hit opponent graveyards exiled with void counters instead (replacement); sacrifice ability casts exiled card without paying mana cost.
15. **Necropotence** (`necropotence.yaml`) — "if you would draw, exile top instead, put in hand at end step" (replacement + delayed trigger); pay life as cost; skip-draw vs replacement ordering with other effects.
16. **Ad Nauseam** (`ad-nauseam.yaml`) — reveal until you stop; lose life = CMC each reveal; lands revealed cost 0; may stop any time; revealed cards go to hand all at once at end.
17. **Mystic Remora upkeep** (`remora-upkeep.yaml`) — cumulative upkeep 1 generic per age counter; non-payment sacrifices; "draw when opponent casts noncreature" trigger with APNAP ordering vs other upkeep triggers.
18. **Rhystic Study** (`rhystic-study.yaml`) — trigger per opponent spell; "unless they pay 1" is part of trigger resolution, not a cost; multiple Studies stack independently; AI tests hook here (see §5 of AI section… §4b).

**AI behavior tests (no hidden-info cheating):**
- `ai/no-cheat-hand-knowledge.rs`: AI decision function receives only its `ObservationView`; test feeds two true-states differing *only* in opponent hand contents with identical observation views → assert AI returns the **same** action distribution seed-for-seed. Any divergence = fail.
- `ai/opponent-model-uses-legal-info.rs`: opponent model inputs restricted to public log + revealed cards + decklist knowledge flag; unit test asserts model never reads `true_state.hands`.
- `ai/bluff-consistency.rs`: AI's own communication ("I have interaction") must be generatable from observation state alone — property test over game states.
- Instrumentation: debug builds tag every AI data access with `visibility: public|private[owner]`; CI runs a taint check that fails if a private tag crosses into an AI for a non-owner.

## 5. Determinism Tests

- `engine/determinism.rs`: for seeds S in a fixed corpus (≥200) and scripted 4-AI pods, run each twice; assert `sha256(event_log_json)` identical. Covers shuffle, random discard, coin flips, "random opponent" selections.
- Fixture pinning: every Given/When/Then fixture records `expected_log_hash`; CI fails on mismatch (catches accidental engine behavior change).
- Version stamping: event log header includes `engine_version`, `rules_version`, `cards_db_version`, `seed`. Replay of an old log under a new engine version must either reproduce the hash or be explicitly flagged as version-divergent (never silently "close enough").
- RNG discipline: single `GameRng` per game, forked substreams for shuffle vs AI sampling so AI Monte Carlo draws never perturb game randomness.

## 6. CI Pipeline Stages

```
1. lint + fmt + typecheck            (blocking)
2. unit tests                        (blocking, <5 min)
3. fixture suite (all Given/When/Then) (blocking; pinned hashes)
4. property-based invariants (nightly: 10k cases; PR: 500-case smoke)
5. AI no-cheat taint checks           (blocking)
6. determinism corpus                 (blocking)
7. card-script coverage gate          (% of cEDH staples with unit tests; ratchets up, never down)
8. soak: 4-AI pods, crash/hang/illegal-state watch (nightly)
9. benchmark guard: sim games/sec, AI ms/decision (alert on >10% regression)
10. build artifacts + replay-schema compatibility check
```

**Replayable bug report** (generated in-client via "Report Rules Bug"):

```json
{
  "game_id": "uuid", "engine_version": "…", "rules_version": "…",
  "cards_db_version": "…", "seed": 824027,
  "events": [ … ],               // full log up to report point
  "state_snapshot": { … },        // minimal relevant state
  "reporter_note": "…",
  "client_version": "…"
}
```

Triage SLA: reproduce from seed+events in CI (`replay --report <id>`); confirmed rules bug → new regression fixture named `REG-<id>-<slug>.yaml` before the fix merges; fix PR must include the fixture and a note on which invariant (§3) was violated or added.

## 7. What "Done" Means Per Card

A card is *supported* only when: oracle text parsed to the rules DSL, unit test(s) for each ability, at least one interaction fixture if it's a cEDH staple, and no `UNIMPLEMENTED` fallback reachable in its script paths. `UNIMPLEMENTED` effects trigger the fail-safe pause (§ spec) and are counted in the coverage gate — the count must trend to zero for staples.

## 8. Manual/Debug Mode Testing

Debug commands (reveal zones, set life, stack manipulation) are tested against a separate `debug` feature flag; production builds assert the flag is off. Manual-override resolutions are logged as `MANUAL_RESOLUTION` events so replays stay reproducible and testing sims can exclude them.
