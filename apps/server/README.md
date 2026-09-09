# @cedh-lab/server — authoritative game server

Fastify REST + `ws` WebSocket server. The server is authoritative: clients send
intents, every action is revalidated against the deterministic rules engine, and
each seat receives only its own filtered view.

## Run

```bash
npm install            # from repo root
npm run dev --workspace apps/server   # REST+WS on :3001
```

No database required: the store is in-memory by default.

## Dev auth (NOT production auth)

There are no passwords in this slice. Mint a token for any display name:

```bash
curl -X POST localhost:3001/api/auth/dev-login -H 'Content-Type: application/json' \
  -d '{"name":"Alice"}'
# → {"token":"...","userId":"...","name":"Alice"}
```

Use `Authorization: Bearer <token>` on REST calls. The WS seat token comes from
`POST /api/pods/:id/join`. Seat identity is always derived server-side from the
token — clients never claim a seat.

## Minimal session

```bash
T=<token>
# create a pod: 2 humans + 2 AI (seats 2,3). Decks are lists of oracleIds (100 for real games).
curl -X POST localhost:3001/api/pods -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"name":"test","aiSeats":[2,3],"decks":[{"seat":0,"list":[...]},{"seat":1,"list":[...]},{"seat":2,"list":[...]},{"seat":3,"list":[...]}]}'
# → {"id":"<podId>",...}

# join seat 0
curl -X POST localhost:3001/api/pods/<podId>/join -H "Authorization: Bearer $T" \
  -H 'Content-Type: application/json' -d '{"seat":0}'
# → {"seat":0,"seatToken":"...","pod":{...}}

# start the game
curl -X POST localhost:3001/api/pods/<podId>/start -H "Authorization: Bearer $T"

# connect WS (node, or any WS client):
#   ws://localhost:3001/api/pods/<podId>/socket?fromSeq=-1
# then send: {"t":"auth","token":"<seatToken>"}
# server → {"t":"view",...}            (auth acknowledgement; the frozen protocol has no authOk type)
# then:      {"t":"action","nonce":"<unique>","action":{"kind":"pass"}}
# server → {"t":"events",...}, {"t":"view",...}, {"t":"priority",...}

# replay + verification
curl localhost:3001/api/pods/<podId>/replay/verify -H "Authorization: Bearer $T"
```

## Persistence

`src/store.ts` defines the `Store` interface; `InMemoryStore` is the default.
Set `CEDH_STORE=postgres` (and later implement the Postgres/Redis backend
against the same interface) to persist pods, tokens, and nonces. The driver
(`src/driver.ts`) only depends on the interface, so no driver changes are needed.

## Architecture

- `src/index.ts` — Fastify REST, WS upgrade/auth/routing, deck validation.
- `src/driver.ts` — `GameRoom`: authoritative game driver (priority loop, AI
  seats, human choices with timeout, filtered broadcasts). Written against the
  async v0.2 contract. AI turns delegate to the AI package's canonical entry
  points (`HeuristicPolicy.decideMainPhase/decidePriority`, `matchesLegal`,
  `applyLegalAction`) — the driver orchestrates but never invents policy or
  application logic. Human actions are mapped onto the engine's own
  `legalActionsFor` list, so the engine remains the sole legality authority.
- `src/engine-adapter.ts` — wraps the current sync engine behind the async
  contract. Swap for a passthrough when the engine workstream lands async.
- `src/views.ts` — per-seat views via `observe()` (leak-proof) + event
  sanitization (e.g. DRAW card names stripped for other seats).
- `src/store.ts` — persistence boundary (in-memory default).

## Reconnect

Connect with `?fromSeq=N` (N = last event seq you applied). If you're ≤500
events behind you get the missed `{t:'events'}`; if further behind you get
`{t:'events'}` with an empty list followed by a fresh full `{t:'view'}`
snapshot instead (the view carries the complete observation, so no extra
snapshot message type is needed).

## Known limitations of this slice

- AI seats use the AI package's heuristic policy (`HeuristicPolicy`), not
  full compound search; the AI workstream owns its quality.
- Force of Will's alternate cost is AI-driver-private in the AI package, so
  server AI seats only cast FoW when mana-affordable (same constraint the AI
  package documents).
- Dev auth only; no passwords, no production auth.
- `POST /api/pods/:id/start` has no host check in this slice.
- No ACK wire type exists in the frozen protocol, so per-seat delivery is
  tracked from sends, not client acknowledgements.

## Tests

```bash
npx vitest run --config ../../vitest.config.ts test/
# or from repo root: npm test
```
