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
