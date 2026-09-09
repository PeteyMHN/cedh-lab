# cEDH Lab — Product Requirements Document

**Version:** 0.1.0 (vertical slice) · **Status:** living document
**Vision:** the definitive digital cEDH testing environment — Magic-Online-grade rules enforcement, four-player pods with humans and AI, and a training lab for competitive Commander.

## 1. Problem

cEDH players have no trustworthy digital testing ground. Existing options:

- **Paper + webcam (SpellTable):** no rules enforcement, slow, no analytics.
- **MTGO:** 1v1-focused, dated client, no cEDH community tooling, no AI opponents.
- **Untap.in / Tabletop sims:** no rules enforcement at all.
- **xMage/Cockatrice:** rules enforcement exists but clients are dated, multiplayer cEDH support is weak, no coaching/AI, no deterministic replays.

The gap: a modern, rules-rigorous, multiplayer-first platform where competitive players can test decks, practice stack wars, and train against AI that plays the format — not a script.

## 2. Goals (measurable)

1. **Rules fidelity:** the engine resolves every implemented interaction per the Comprehensive Rules; anything unsupported pauses safely rather than resolving wrong. Target: 100% of the cEDH staple card pool (see §7) scripted and property-tested.
2. **Determinism:** identical seed + identical action log ⇒ identical game state, always. Every game is a replayable, hash-chained artifact.
3. **AI quality:** AI opponents make decisions from their legal observation state only (provably no hidden-information leaks), play recognizable cEDH archetypes, and explain their reasoning on demand.
4. **Pod play:** authoritative server, 4-player pods, reconnects, spectators, in-game chat, leagues.

## 3. Non-goals (for now)

- Not a Wizards-licensed product; card data via community sources (Scryfall), no official card images bundled.
- Not a marketplace or card trader.
- Mobile-first UI comes after the desktop table slice.

## 4. Users

| Persona | Needs |
|---|---|
| **Spike (tournament grinder)** | goldfish + gauntlet testing, matchup sims, mulligan stats, replay review |
| **Brewer** | fast iteration on lists, "what beats this?" scenario lab |
| **Coach/Team** | shared replays, leagues, training scenarios |
| **Casual-competitive** | learn stack wars safely, AI pods at 2am |

## 5. User stories (vertical slice → full)

**Gameplay**
- As a player, I can start a 4-player pod with any mix of humans and AI so I can practice anytime.
- As a player, I get explicit priority prompts with full rules text for every choice, so I never wonder what I'm responding to.
- As a player, I can rewind to any decision point and branch the game, so I can explore "what if I'd forced here?"
- As a spectator, I can watch a pod with delayed hidden info and chat, so I can sweat my teammates.

**Rules trust**
- As a Spike, when the engine can't resolve an interaction it pauses and tells me exactly why, so I never get a silently wrong result.
- As a Spike, I can verify a game's event hash chain, so I trust the replay.

**AI & coaching**
- As a player, I can ask the AI why it made a play and get a strategic explanation grounded in its actual observation.
- As a Brewer, I can run 100-game matchup sims between two lists and get win rates + mulligan stats.
- As a player, I can drill specific scenarios (protecting the win, fighting through Remora) in Scenario Lab.

**Meta**
- As a team captain, I can run a league with standings and recorded games.

## 6. Current vertical slice (v0.1.0)

What works today, in this repo:

- Deterministic TypeScript rules engine: priority/APNAP, stack LIFO + fizzle, triggers, SBAs, commander tax/damage/replacement choice, 26 scripted cEDH staples + basic lands.
- Event-sourced state: hash-chained events, snapshots, rewind/branch.
- AI: observation-only (provable no-leak), heuristic priority/main-phase policies, mulligan scoring, explanations.
- CLI demos: 4-player deterministic game (Consultation→Oracle win through a Force of Will fight), AI priority decision, APNAP trigger-independence ("fish bowl").
- 18 automated tests, all passing.
- Design docs: database schema, network protocol, security model, card scripting, AI architecture, testing plan, frontend architecture.

## 7. Staple card pool (scripting priority, cEDH)

Tier 1 (scripted now): Dark Ritual, Demonic Consultation, Thassa's Oracle, Brainstorm, Counterspell, Force of Will, Mystic Remora, Rhystic Study, Swords to Plowshares, Demonic Tutor, Vampiric Tutor, Llanowar Elves, Command Tower, Sol Ring, Arcane Signet, Fellwar Stone, plus basics.

Tier 2 (next): Mana Crypt, Jeweled Lotus, Chrome Mox, Mox Diamond, Mana Vault, Grim Monolith, Dockside Extortionist, Opposition Agent, Orcish Bowmasters, Silence, Grand Abolisher, Drannith Magistrate, Esper Sentinel, Ragavan, Tymna, Kraum, Thrasios, Rograkh, Silas, Kinnan, Winota… (full cEDH staple list in `docs/card-scripting.md`).

## 8. Acceptance criteria for v1.0

- Full 4-player Commander game (all phases incl. combat) completable by 4 humans with no engine errors.
- Tier 1 + Tier 2 card pool scripted; property tests per card.
- Server authoritative pod play over WebSockets with reconnect.
- AI plays a full game autonomously at "competent FNM cEDH" level.
- Replays shareable via link with hash verification.

## 9. Risks

- **Rules completeness** is the long pole: Magic has ~300 pages of CR. Mitigation: unsupported-interaction pausing, card-by-card scripting with tests, community corpus.
- **AI quality:** heuristic AI plateaus. Mitigation: architecture supports MCTS + learned evaluation later (see `docs/ai-architecture.md`).
- **Legal:** no WotC assets bundled; card data from Scryfall under their terms; oracle text is factual game data.
