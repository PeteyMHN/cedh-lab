# System Architecture

**Status:** v0.1.0 vertical slice implemented for engine/cards/AI/CLI; server/web/worker are scaffolded next.

## 1. Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENTS (apps/web)                        │
│  Next.js 14 · React · Tailwind · Zustand · table UI · replay UI │
└───────────────┬─────────────────────────────────┬───────────────┘
                │ WebSocket (game)                │ HTTPS (REST)
┌───────────────▼─────────────────────────────────▼───────────────┐
│                      apps/server (Fastify)                       │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐  │
│  │ Session &   │  │ Game rooms   │  │ Hidden-view derivation  │  │
│  │ auth (JWT)  │  │ (authorita-  │  │ (per-seat observations) │  │
│  └─────────────┘  │ tive Engine) │  └─────────────────────────┘  │
│                   └──────────────┘                               │
│  Never trusts clients: every action revalidated vs engine rules. │
└───────┬──────────────────────────────┬──────────────────────────┘
        │                              │
┌───────▼──────────┐          ┌────────▼────────┐
│  PostgreSQL 16   │          │    Redis 7      │
│  users · decks   │          │  hot game state │
│  games · events  │          │  pub/sub rooms  │
│  replays · leagues│         │  rate limits    │
└──────────────────┘          └─────────────────┘
        │
┌───────▼──────────────────────────────────────────────────────────┐
│  packages/engine  — deterministic rules engine (TS, WASM-portable│
│  packages/cards   — versioned card scripts (26 staples + basics)  │
│  packages/ai      — observation-only policies + explanations      │
│  packages/protocol— shared message types (WS + REST)             │
│  apps/worker      — matchup sims, analytics, AI training jobs     │
│  apps/cli         — demos, scenario lab, test harness             │
└──────────────────────────────────────────────────────────────────┘
```

## 2. Key decisions

1. **Event sourcing is the source of truth.** The game is a hash-chained event log; state is a fold over events. Snapshots enable rewind/branch/reconnect. (Implemented.)
2. **Engine is pure and deterministic.** Seeded RNG, no I/O, no clock, no LLM in the legality path. LLMs may advise strategy; they never decide legality. (Implemented.)
3. **Cards are data + versioned scripts.** The engine knows the CR; cards declare triggers/costs/effects through a sandboxed API. A card's rules identity is separate from its printing. (Implemented: 26 scripts.)
4. **The server is authoritative.** Clients send intents; the server revalidates against the engine and broadcasts derived per-seat views. (Designed in `docs/network-protocol.md`; to build.)
5. **AI sees only its observation.** The observation builder is the same code path as the hidden-view derivation for human clients — one leak-proof funnel. Proven by tests. (Implemented.)
6. **Fail safe, never silent.** Unsupported interactions raise typed `UnsupportedInteraction` pauses instead of guessing. (Partially implemented; full choice pipeline is roadmap.)

## 3. Data flow: one action

```
client intent ──WS──▶ server: validate session → seat → engine.legalActionsFor(seat)
                                    │
                                    ▼
                        Engine applies → events appended (hashed)
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              view for P0     view for P1…    public/spectator
              (P0's hand)     (their hands)   (delayed, no hands)
                    └───────────────┼───────────────┘
                                    ▼
                        broadcast + persist (PG) + cache (Redis)
```

## 4. Deployment topology (target)

- `web`: Next.js on Vercel (or self-hosted Node).
- `server`: Fastify + `ws` on a stateful host (sticky sessions for game rooms) or Redis-backed horizontal rooms.
- `worker`: BullMQ/Redis job queue for sims and analytics.
- `postgres`: managed PG16 (event log is append-mostly — partition by month).
- `redis`: managed Redis 7 (room pub/sub, hot snapshots, rate limits).

Local dev: `docker-compose.yml` (Postgres 16 + Redis 7).

## 5. Repository layout

```
cedh-lab/
  apps/
    web/        # Next.js table client (scaffolded)
    server/     # Fastify authoritative server (scaffolded)
    worker/     # sims & analytics jobs (scaffolded)
    cli/        # demos + scenario lab (working)
  packages/
    engine/     # rules engine (working, tested)
    cards/      # card scripts (working, tested)
    ai/         # AI policies (working, tested)
    protocol/   # shared types (scaffolded)
  docs/         # PRD, architecture, specialist designs
  docker-compose.yml
```

## 6. Continuation boundary (no rework needed)

The vertical slice ends at: CLI-driven games, scripted opponents, heuristic AI. The architecture already supports what comes next without redesign: the engine's event log is the server's persistence model; the AI observation builder is the server's hidden-view derivation; card scripts run unchanged on the server. Building `apps/server` is new code against stable interfaces — not a rewrite.
