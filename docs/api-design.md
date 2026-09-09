# API Design

**Status:** design; `packages/protocol` will carry the shared types. The WebSocket message shapes below mirror `docs/network-protocol.md`.

## 1. Conventions

- Base: `https://api.cedh-lab.gg/v1` (REST) + `wss://api.cedh-lab.gg/v1/games/:id/socket` (WS).
- Auth: short-lived JWT (15 min) + rotating refresh token. Seat identity is derived server-side from the session — clients never claim a seat.
- All timestamps ISO 8601 UTC. All IDs ULID strings.
- Errors: `{ "error": { "code": "ILLEGAL_ACTION", "message": "...", "details": {...} } }`.

## 2. REST

### Auth
- `POST /auth/register` `{ email, password, displayName }` → `{ user }`
- `POST /auth/login` → `{ accessToken, refreshToken }`
- `POST /auth/refresh` → `{ accessToken }`

### Pods (game rooms)
- `POST /pods` `{ format: "cedh", seats: 4, aiSeats?: [1,3], deckIds: [...] }` → `{ pod }`
- `GET /pods/:id` → pod state + seat list (no hidden info)
- `POST /pods/:id/join` `{ seat, deckId }` → `{ seatToken }`
- `POST /pods/:id/start` → begins the game (all seats filled)
- `GET /pods/:id/replay` → `{ events: [...], hashChainValid: true }`
- `GET /pods/:id/replay/verify` → `{ valid: true, eventCount }`

### Decks
- `POST /decks` `{ name, format, commander, mainboard: [{ oracleId, qty }] }` → validated (100 cards, color identity, singleton)
- `GET /decks/:id` / `PUT /decks/:id` / `DELETE /decks/:id`

### Scenarios & sims
- `POST /scenarios` `{ name, setup }` → scenario lab definition
- `POST /sims` `{ deckA, deckB, games: 100, seed }` → `{ jobId }` (worker)
- `GET /sims/:jobId` → `{ status, results?: { winsA, winsB, draws, mulliganStats } }`

### Leagues
- `POST /leagues` / `GET /leagues/:id/standings`

## 3. WebSocket (game channel)

Client → server:
```json
{ "t": "action", "nonce": "…", "action": { "kind": "cast", "card": "obj_…", "targets": ["obj_…"] } }
{ "t": "choice", "choiceId": "…", "selection": "…" }
{ "t": "chat", "text": "…" }
{ "t": "concede" }
```

Server → client:
```json
{ "t": "events", "fromSeq": 120, "events": [ … ] }          // authoritative log
{ "t": "view", "seat": 1, "snapshot": { … }, "legal": [ … ] } // per-seat hidden view
{ "t": "priority", "seat": 2, "prompt": "…", "timeoutMs": 60000 }
{ "t": "choiceRequest", "choiceId": "…", "options": [ … ] }
{ "t": "paused", "reason": "UNSUPPORTED_INTERACTION", "detail": "…" }
{ "t": "gameOver", "winners": [0], "replayId": "…" }
```

## 4. Views (hidden information)

The server builds each seat's view with the same `observe()` code path the AI uses — one funnel, no divergence. Opponent hands arrive as counts; known cards (revealed) are tracked per seat; spectators get a 2-minute-delayed public view.

## 5. Rate limits & safety

- 60 intents/min/seat; chat 10/min; sim jobs 5/day (free tier).
- Every intent revalidated against the engine; illegal intents are rejected with the rule citation, never applied.
- Nonces prevent replay; hash-chained events prevent history tampering.
