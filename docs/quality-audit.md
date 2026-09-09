# Quality Audit — v0.1.0 vertical slice

**Date:** 2026-09-09 · **Auditor:** Rumi (self-audit of the working tree)
**Method:** ran the full test suite, all three demos, `tsc --noEmit` on all packages; reviewed each engine module for the gaps the user explicitly forbade papering over.

## Results

- **Tests:** 18/18 passing (`npm test`).
- **Typecheck:** clean on engine, cards, AI, CLI.
- **Demos:** all three run green; event chains verify.

## Fixes applied during this audit

1. **Summoning sickness blocked land mana abilities.** `enterBattlefield` set `summoningSick = true` on everything, and the tap guard enforced it for lands. Per CR 302.6 this only restricts creatures. Fixed in both places; lands tap the turn they enter, creatures still can't.
2. **Creatures placed directly on the battlefield skipped P/T init** (only the cast path set it). Now `enterBattlefield` is the single path and initializes from the def; the test helper uses it too.
3. **Duplicate `def` declaration** introduced during the fix — removed (the init already existed lower in the function).
4. **Added Forest + Plains** to complete the basic land cycle (mountain still missing — noted below).

## Known gaps (honest, no hand-waving)

| Area | Status |
|---|---|
| Replacement/prevention effects | Not implemented; unsupported interactions raise `UnsupportedInteraction` |
| General choice pipeline | Scaffolded; tutors use default choices |
| Demonic Consultation exact sequencing | Exiles 6 first, then reveal — needs correction |
| Full combat | Attackers exist; blockers/damage steps scaffolded |
| Layers | Framework only; per-card continuous effects mostly unimplemented |
| Deterministic loops (CR 729) | Not implemented |
| Command Tower | Hardcoded blue; needs color choice |
| Force of Will self-pitch | Not explicitly verified fixed |
| Legend rule | Incomplete |
| Swords targeting | No protection/hexproof/shroud validation |
| Free mulligan | Commander free-mulligan behavior incorrect |
| Mountain | Missing from basics |
| AI | Heuristic, no compound planning (tap-then-cast), no search |
| Server/web/worker | Scaffolded, not built |
| Commander cast from command zone | Tax math tested; full cast path conflicts with hand-only `castSpell` |

## Security posture (per `docs/security-model.md`)

- AI hidden-info isolation: **tested and passing** (observation contains counts only; explanation leak test green).
- Server authority, per-seat views, nonces, hash chains: **designed, not yet built** — no network attack surface exists in the slice (CLI only), which bounds the risk.

## Verdict

The slice is what it claims to be: a deterministic engine core with real rules enforcement for the scripted card pool, honest failure modes for everything else, and no fake AI. It is **not** full Magic coverage and **not** tournament-grade AI. The roadmap phases are ordered so each one hardens the claim before the next one widens the surface.

---

# Quality Audit — v0.2.0 (four workstreams + integration)

**Date:** 2026-09-09 · **Auditor:** Rumi (self-audit of the working tree at `0b0e742`)
**Method:** ran the full test suite, typecheck, web production build, all four CLI demos, and a live server smoke test (boot, dev-login, REST validation).

## Results

- **Tests:** 87/87 passing across 12 files (`npm test`).
- **Typecheck:** clean on engine, cards, AI, CLI, server.
- **Web:** `npm run build` passes (Next.js production build).
- **Demos:** `demo-game` (224 events, chain valid), `demo-stack`, `demo-ai` all green; new `demo-aigame` — full 4-AI game, terminated, chain valid, **zero illegal actions attempted**.
- **Server smoke:** boots on :3001, dev-login issues tokens, pod creation validates input (rejects empty decks with a rule-cited error).

## What v0.2 added

- **Async engine**: `resolveTop`/`askChoice`/`answerChoice` fully async; validated choice pipeline with `Game.pendingChoice`; `defaultChoicePolicy` for tests/AI fallback.
- **Replacement effects**: framework + CR 616.1 ordering via choice; Opposition Agent shipped.
- **Combat**: attackers/blockers with validation, first-strike + normal damage steps, commander damage, turn steps + priority.
- **Tokens**: `createToken`, cease-to-exist on zone change (CR 111.7).
- **Card pool**: 52 scripts — full fast-mana suite (Mana Crypt, Jeweled Lotus, Chrome Mox, Mox Diamond, Mana Vault, Grim Monolith, Lotus Petal), interaction (Silence, Grand Abolisher, Drannith Magistrate, Esper Sentinel, Orcish Bowmasters, Flusterstorm, Swan Song, Cyclonic Rift, Dockside Extortionist), commanders (Tymna, Kraum, Thrasios, Rograkh, Kinnan), all 5 basic lands.
- **Real choices**: Demonic/Vampiric Tutor via `askChoice`; Demonic Consultation exact sequencing; Command Tower color choice; Force of Will cannot pitch itself; legend rule; protection/hexproof/shroud target validation; Commander free mulligan.
- **Server**: authoritative Fastify+ws, per-seat filtered views via `observe()`, nonce dedup, reconnect with `?fromSeq=`, in-memory store behind a Postgres/Redis plug boundary.
- **Web**: lobby + 4-player table, stack visualizer, priority bar, choice modals, Zustand store, WS hook.
- **AI 2.0**: `playGame` full-game driver (never issues illegal actions — validated pre-apply), compound mana-then-cast planner, live belief tracking, 1-ply stack-war search, main-phase policy v2.

## Real bugs caught by tests during v0.2

1. Un-awaited async engine calls caused an infinite priority loop (passes reset every round, stack never resolved) — fixed by awaiting everywhere.
2. FoW alternate-cost synthesis partially applied then rejected by `payCosts` — removed; FoW casts only when the engine lists it legal.
3. Missing `await` on `castSpell` in new flash tests — fixed in the test.

## Known gaps (honest, no hand-waving)

| Area | Status |
|---|---|
| Card coverage | 52 scripts vs ~30k printings; unsupported cards raise `UnsupportedInteraction`, never silently mis-resolve |
| Layers | Framework only; per-card continuous effects mostly unimplemented |
| Deterministic loops (CR 729) | Not implemented |
| AI depth | Heuristic policy + 1-ply search; no MCTS/PIMC yet; no combat AI; beliefs heuristic |
| AI card pool | 18-card demo decks; wins often by decking — bounded by pool, not engine |
| Persistence | In-memory store; Postgres/Redis are a documented plug boundary, not wired |
| Auth | Dev-only token login; real auth is future work |
| Replay UI | Replay REST exists; web replay viewer not built |
| `policy.ts` ↔ `planner.ts` circular import | Call-time only, harmless in ESM, worth splitting later |

## Security posture update

- AI hidden-info isolation: still tested and passing (observation counts-only; no-leak tests green).
- Server now has real attack surface: seat identity derived server-side from tokens, all actions revalidated against `legalActionsFor`, views filtered per seat, nonce dedup. Dev-auth only — must not be exposed publicly as-is.

## Verdict

v0.2 is what it claims to be: a playable four-player cEDH platform for its 52-card pool with real rules enforcement, honest failure modes for everything else, an authoritative server, a working web table, and AI that plays full games without cheating or illegal moves. It is **not** full Magic coverage and **not** tournament-grade AI. The roadmap phases are ordered so each one hardens the claim before the next one widens the surface.
