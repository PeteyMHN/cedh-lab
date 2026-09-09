# cEDH Lab

The definitive digital cEDH testing environment: Magic-Online-grade rules enforcement, four-player pods with humans and AI, deterministic replays, and a training lab for competitive Commander.

> **Status: v0.1.0 vertical slice.** The deterministic rules engine, 26 scripted cEDH staples, observation-only AI, and CLI demos work and are tested (18/18). The authoritative server, web table, and worker are designed (see `docs/`) and scaffolded next. Read `docs/quality-audit.md` for an honest accounting of what's real and what's roadmap.

## Quickstart

**Prerequisites:** Node ≥ 20, npm.

```bash
# install
npm install

# run the deterministic 4-player demo ("Stop the Oracle", seed 1337)
npm run demo:game --workspace apps/cli

# AI priority decision with hidden-information proof
npm run demo:ai --workspace apps/cli

# APNAP stack war: the fish bowl (Remora + Study trigger independence)
npm run demo:stack --workspace apps/cli

# tests + typecheck
npm test
npm run typecheck
```

**With Postgres + Redis (for the upcoming server):**

```bash
docker compose up -d   # postgres:16 + redis:7
```

## Repository layout

```
apps/
  cli/        # demos + scenario lab (working)
  server/     # authoritative Fastify server (scaffolded)
  web/        # Next.js table client (scaffolded)
  worker/     # matchup sims + analytics jobs (scaffolded)
packages/
  engine/     # deterministic rules engine (working, tested)
  cards/      # versioned card scripts: 26 cEDH staples + basics (working, tested)
  ai/         # observation-only AI policies + explanations (working, tested)
  protocol/   # shared WS/REST types (scaffolded)
docs/
  prd.md                # product requirements + user stories
  architecture.md        # system architecture + diagram
  engine-design.md       # rules engine design
  api-design.md          # REST + WebSocket API
  roadmap.md             # executable phased roadmap
  quality-audit.md       # honest audit of this slice
  database-schema.md     # PostgreSQL 16 + Redis 7 design
  network-protocol.md    # multiplayer protocol design
  security-model.md      # threat model + hidden-info guarantees
  card-scripting.md      # card script system design
  ai-architecture.md     # AI architecture (heuristics → MCTS)
  testing-plan.md        # testing strategy
  frontend-architecture.md # web client design
```

## Design principles

- **Deterministic by construction:** seeded RNG, no clock, no I/O in the engine. Same seed + same actions = same game, always.
- **Never silently wrong:** unsupported interactions raise `UnsupportedInteraction` and pause — the engine never guesses.
- **LLMs advise, never adjudicate:** AI strategy may use an LLM; rules legality is always the deterministic engine.
- **AI sees only its observation:** the same code path that builds hidden views for human clients. Leak-tested.
- **Server authoritative:** clients send intents; the server revalidates everything.

## Demos

| Demo | Command | What it proves |
|---|---|---|
| Stop the Oracle | `npm run demo:game --workspace apps/cli` | 4-player game: Ritual → Consultation (named Oracle) → Oracle win through a Counterspell/Force of Will fight; 217 events, hash chain valid |
| AI priority | `npm run demo:ai --workspace apps/cli` | AI counters a win attempt from observation only; proof it can't see the hidden Force of Will |
| Fish bowl | `npm run demo:stack --workspace apps/cli` | APNAP ordering (Remora under Study); triggers resolve independently after the spell is countered |

## Development

```bash
npm test        # vitest: engine, cards, AI
npm run typecheck
```

Card data: oracle text and rulings are factual game data (Scryfall-sourced by convention). No Wizards art or assets are bundled.

## License

TBD — source-available for now; do not redistribute card text corpora beyond fair use.
