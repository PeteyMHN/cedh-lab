# Roadmap (executable)

Each phase is a checklist with a definition of done. Phases are sequential; within a phase, items are parallelizable.

## Phase 0 — Vertical slice ✅ DONE (v0.1.0)

- [x] Deterministic engine core (priority/APNAP, stack, triggers, SBAs, commander basics)
- [x] 26 card scripts (cEDH staples + basics)
- [x] Event-sourced log, hash chain, snapshots, rewind
- [x] Observation-only AI + heuristic policies + explanations
- [x] 3 CLI demos (4-player game, AI decision, APNAP stack war)
- [x] 18 automated tests passing
- [x] Specialist design docs (DB, protocol, security, scripting, AI, testing, frontend)

## Phase 1 — Rules hardening (next)

- [ ] General choice-request pipeline (modal choices for tutors, modal spells, X costs)
- [ ] Replacement-effect ordering (CR 616: affected controller chooses)
- [ ] Full combat (blockers, first strike, damage steps, planeswalker redirection removal per current CR)
- [ ] Layer system: implement common continuous effects (anthems, type changes)
- [ ] Deterministic loop detection (CR 729)
- [ ] Demonic Consultation exact sequencing (exile 6 first, then reveal)
- [ ] Fix: Command Tower color choice, Force of Will self-pitch exclusion, legend rule
- [ ] Target validation: protection/hexproof/shroud in `validateTarget`
- [ ] **Done when:** 50-card staple pool, each with property tests; full test suite green; audit clean

## Phase 2 — Authoritative server

- [ ] `packages/protocol` shared types
- [ ] Fastify + `ws` game rooms; session-derived seats
- [ ] Server-side action validation; per-seat hidden views (reuse AI `observe()`)
- [ ] Reconnect with snapshot catch-up; spectator delay
- [ ] Chat, concede, chess-clock/round timer
- [ ] Postgres persistence (schema in `docs/database-schema.md`); Redis hot state
- [ ] **Done when:** 4 humans complete a full game through the server; replay verifiable via API

## Phase 3 — Web table (desktop-first)

- [ ] Next.js table UI per `docs/frontend-architecture.md`: battlefield, stack visualizer, priority prompts, card inspector
- [ ] Replay viewer with scrub + branch exploration
- [ ] Scenario Lab UI
- [ ] Accessibility pass (keyboard play, screen-reader labels, colorblind-safe)
- [ ] **Done when:** a pod can be played start-to-finish in the browser

## Phase 4 — AI 2.0

- [ ] Full-game autonomous play (compound planning: tap-then-cast)
- [ ] Opponent modeling + belief updates over observations
- [ ] MCTS over the legal action space with the heuristic evaluator
- [ ] Matchup sim worker (`apps/worker`): 100-game batches, mulligan stats
- [ ] Coaching: "why" explanations, mistake detection in replays
- [ ] **Done when:** AI completes full games without illegal actions; beats heuristic v1 in sims

## Phase 5 — Community

- [ ] Leagues, standings, scheduled events
- [ ] Deck sharing, metagame analytics
- [ ] Training scenario marketplace

## Effort honesty

Phase 1 is the long pole (rules completeness is unbounded in principle; we bound it by the cEDH staple pool). Phases 2–3 are engineering with known shapes. Phase 4 is research-grade and ships incrementally behind the v1 heuristic.
