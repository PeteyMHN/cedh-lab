# Network Protocol — cEDH Lab

Stack: Fastify + TypeScript, native WebSockets (`ws`), Redis 7 (pub/sub + streams), PostgreSQL.
Shared types live in `packages/protocol` (TypeScript). All JSON is UTF-8, numbers are IEEE-754 doubles unless noted as `int64` (serialized as string where > 2^53).

Base URL: `https://api.cedh-lab.example` · WS: `wss://api.cedh-lab.example/ws`
Protocol version: `1`. Clients send `X-Protocol-Version: 1`; server rejects mismatched majors with `426 Upgrade Required`.

---

## 1. REST Endpoints

All REST calls (except auth) require `Authorization: Bearer <access_token>`.

### Auth
| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register` | Create account. Body: `{username, email, password}` → `{user_id, access_token, refresh_token}` |
| POST | `/auth/login` | Body: `{email|username, password}` → tokens |
| POST | `/auth/refresh` | Body: `{refresh_token}` → rotated `{access_token, refresh_token}` (old refresh revoked) |
| POST | `/auth/logout` | Revokes refresh token family |
| GET | `/auth/me` | Current user profile + ratings |

### Decks
| Method | Path | Purpose |
|---|---|---|
| GET | `/decks` | List user's decks (paginated, `?limit=&cursor=`) |
| POST | `/decks` | Create deck. Body: `{name, format_snapshot_id, mainboard:[{name, qty}], commander:[...], sideboard?}` → validates, returns `deck_id` + validation report |
| GET | `/decks/:id` | Deck + archetype analysis (`include=analysis`) |
| PATCH | `/decks/:id` | Update (creates new `DeckVersion`) |
| DELETE | `/decks/:id` | Soft-delete |
| POST | `/decks/import` | Body: `{source: "text"\|"moxfield"\|"archidekt"\|"deckstats", payload}` → parsed deck |
| POST | `/decks/:id/validate` | Re-run legality vs a format snapshot |

### Lobbies & Matchmaking
| Method | Path | Purpose |
|---|---|---|
| GET | `/lobbies` | Browse open lobbies (`?mode=casual|ranked|private&has_ai=`) |
| POST | `/lobbies` | Create lobby. Body: `{name, mode, seats: 4, seats_config: [{kind: human|ai, ai_profile?}], password?, format_snapshot_id, scenario_id?}` → `{lobby_id, join_code}` |
| GET | `/lobbies/:id` | Lobby state (seats, ready flags, settings) |
| POST | `/lobbies/:id/join` | Join (body: `{seat, password?}`) → `{seat_token}` (single-use WS auth grant) |
| POST | `/lobbies/:id/leave` | Leave lobby |
| POST | `/lobbies/:id/ready` | Toggle ready `{ready: bool}` |
| POST | `/lobbies/:id/start` | Host starts → creates game, returns `game_id` |
| POST | `/matchmaking/queue` | Body: `{mode, deck_id, ai_fill: bool}` → joins queue; server matches 4 seats |
| DELETE | `/matchmaking/queue` | Leave queue |

### Games & History
| Method | Path | Purpose |
|---|---|---|
| GET | `/games` | User's games (`?commander=&seat=&result=&limit=&cursor=`) |
| GET | `/games/:id` | Game metadata (players, commanders, winner, turns, duration, seed) |
| GET | `/games/:id/events` | Event log (`?from_seq=&limit=`; streams NDJSON for large logs) |
| GET | `/games/:id/snapshot?seq=` | Full filtered game snapshot at seq (for replay/branching) |
| POST | `/games/:id/branch` | Body: `{from_seq, label}` → creates branched game for what-if analysis |
| POST | `/games/:id/report` | Submit rules-bug report `{description, client_version}` → server attaches seed+event log |
| GET | `/games/:id/replay` | Replay bundle (metadata + event stream URL) |

### Scenarios
| Method | Path | Purpose |
|---|---|---|
| GET | `/scenarios` | List public + owned scenarios (`?difficulty=&tag=`) |
| POST | `/scenarios` | Create scenario `{name, description, initial_state, expected_lines, difficulty, tags}` |
| GET | `/scenarios/:id` | Scenario detail |
| PATCH | `/scenarios/:id` | Update own scenario |
| DELETE | `/scenarios/:id` | Delete own scenario |
| POST | `/scenarios/:id/attempt` | Start game from scenario state → `{game_id}` |

### Analytics
| Method | Path | Purpose |
|---|---|---|
| GET | `/analytics/me` | Win rate by commander/seat/matchup/mulligans |
| GET | `/analytics/decks/:id` | Deck performance: win rate, avg win turn, common win lines |
| GET | `/analytics/matchups` | Matrix: `?commander_a=&commander_b=` |
| POST | `/analytics/simulate` | Launch batch sim `{deck_id, opponents:[deck_id...], games, ai_level}` → `{job_id}` |
| GET | `/analytics/simulate/:job_id` | Job status + results when done |

Standard errors: `400` validation, `401` auth, `403` forbidden, `404` not found, `409` conflict (e.g. seat taken), `422` deck invalid (body has `violations[]`), `429` rate-limited.

---

## 2. WebSocket Message Catalog

One WS connection per client. Envelope for every message:

```json
{ "v": 1, "type": "MESSAGE_NAME", "msg_id": "uuid", "payload": { ... } }
```

`msg_id` is required on client→server messages for idempotency (server dedupes by `(connection, msg_id)` for 60s). Server→client messages carry `seq` (per-game event sequence, see §3) where applicable.

### Client → Server

| Type | Required payload fields | Notes |
|---|---|---|
| `AUTH` | `{ access_token, game_id?, resume_token? }` | First message after connect. `resume_token` for reconnect (§4). |
| `JOIN_GAME` | `{ game_id, seat_token, as: "player"\|"spectator" }` | seat_token from `POST /lobbies/:id/join` |
| `GAME_ACTION` | `{ action: <ActionObject> }` | Any rules action. See schema below. |
| `PASS_PRIORITY` | `{ }` | Pass priority. Shortcut of GAME_ACTION but first-class for UI/analytics. |
| `SET_PRIORITY_STOP` | `{ stops: [{ when: "precombat"\|"endstep_before_turn"\|"spell_cast"\|"opponent_tutor"\|"commander_cast"\|"stack_nonempty", enabled: bool }] }` | MTGO-style stops. Server stores per player. |
| `PROPOSE_SHORTCUT` | `{ description, loop: { iterations?: int, arbitrary?: bool }, break_conditions: [...] }` | Propose loop/shortcut; server broadcasts `SHORTCUT_OFFER` to others. |
| `RESPOND_SHORTCUT` | `{ shortcut_id, accept: bool, interrupt_at?: { seq_or_step } }` | Accept or name interruption point. |
| `CHAT` | `{ channel: "table"\|"team"?, text }` | Table chat. AI statements arrive as server `CHAT`. |
| `REQUEST_UNDO` | `{ to_seq }` | Testing/casual mode only; requires all humans' consent (`UNDO_OFFER`). |
| `CONCEDE` | `{ }` | Leave game as loss. |
| `PING` | `{ client_time_ms }` | Keepalive/latency. Server replies `PONG`. |
| `SUBSCRIBE_ANALYSIS` | `{ enabled: bool }` | Opt into AI coach stream (`COACH_NOTE`). |

`GAME_ACTION` — the action object (validated server-side against the rules engine's legal-action list):

```json
{
  "kind": "CAST_SPELL" | "ACTIVATE_ABILITY" | "PLAY_LAND" | "DECLARE_ATTACKERS" |
          "DECLARE_BLOCKERS" | "CHOOSE" | "MULLIGAN" | "PAY_COST" | "ORDER_TRIGGERS" |
          "DEMONSTRATE_LOOP" | "MANUAL_OVERRIDE",
  "source_id": "obj_9f2",          // card/permanent/ability id, when applicable
  "zone": "hand",                  // origin zone, when applicable
  "targets": [{ "object_id": "obj_31" }],   // or {"player": 2}
  "modes": [1],                    // modal spells
  "x_value": 3,                    // X spells
  "payments": { "mana": {"R":1,"generic":2}, "life": 2, "sacrifice": ["obj_12"] },
  "choices": { "card_name": "Thassa's Oracle", "number": 2 },
  "hold_priority": false
}
```

Only fields relevant to the kind are accepted; unknown fields → `ERROR INVALID_ACTION`.

### Server → Client

| Type | Payload | Notes |
|---|---|---|
| `AUTH_OK` | `{ user_id, server_time_ms, resume_token }` | resume_token for reconnect (§4) |
| `GAME_JOINED` | `{ game_id, your_seat: 0-3, role: player\|spectator, config }` | |
| `GAME_EVENT` | `{ seq, event: <GameEvent>, caused_by: msg_id? }` | The authoritative event log stream (§3) |
| `LEGAL_ACTIONS` | `{ seq, actions: [<ActionObject...>], priority_seat, deadline_ms? }` | Full legal set for the player with priority; recomputed after every event |
| `PRIORITY_UPDATE` | `{ seq, priority_seat, phase, step, stack_depth }` | Lightweight; sent even when no legal actions (auto-pass paths) |
| `HIDDEN_VIEW` | `{ seq, view: <FilteredState> }` | Per-player filtered full state; sent on join/resync and every N events (see §5) |
| `SNAPSHOT_RESYNC` | `{ seq, snapshot: <FilteredState>, events_since: [...] }` | Recovery path (§3) |
| `ERROR` | `{ code, message, ref_msg_id? }` | See error codes below |
| `CHAT` | `{ from: "ai:seat_2"\|user_id, seat?, text, ts }` | |
| `SHORTCUT_OFFER` | `{ shortcut_id, from_seat, description, loop }` | |
| `UNDO_OFFER` | `{ from_seat, to_seq }` / `UNDO_RESULT` | |
| `TIMER_UPDATE` | `{ seat, remaining_ms, total_ms }` | When chess-clock timers enabled |
| `GAME_OVER` | `{ winner_seat?, reason, stats }` | |
| `COACH_NOTE` | `{ seq, category, text, alternatives? }` | Coaching mode only |
| `PONG` | `{ client_time_ms, server_time_ms }` | |
| `PLAYER_STATUS` | `{ seat, status: connected\|disconnected\|ai_takeover, user_id? }` | Presence |

Error codes (`ERROR.code`): `UNAUTHENTICATED`, `BAD_TOKEN`, `GAME_NOT_FOUND`, `SEAT_TAKEN`, `NOT_YOUR_PRIORITY`, `ILLEGAL_ACTION` (with `detail` from rules engine), `INVALID_ACTION` (schema), `STALE_SEQ`, `RATE_LIMITED`, `SHORTCUT_REJECTED`, `UNDO_DENIED`, `MANUAL_MODE_ONLY`, `VERSION_MISMATCH`, `INTERNAL`.

### Example: priority pass

Client → server:
```json
{ "v": 1, "type": "PASS_PRIORITY", "msg_id": "a3f1c9e0-1b2c-4d5e-8f6a-7b8c9d0e1f2a", "payload": {} }
```

Server → all clients (each receives their own filtered copy):
```json
{ "v": 1, "type": "GAME_EVENT", "msg_id": "srv-8812",
  "payload": { "seq": 1042,
    "event": { "kind": "PRIORITY_PASSED", "player": 2, "phase": "precombat_main", "next_priority": 3 },
    "caused_by": "a3f1c9e0-1b2c-4d5e-8f6a-7b8c9d0e1f2a" } }
```
followed by `PRIORITY_UPDATE { seq: 1042, priority_seat: 3, phase: "precombat_main", step: "main", stack_depth: 0 }`
and `LEGAL_ACTIONS` (seat 3's client only).

### Example: stack push (cast spell)

Client → server:
```json
{ "v": 1, "type": "GAME_ACTION", "msg_id": "c7d2…",
  "payload": { "action": {
    "kind": "CAST_SPELL", "source_id": "card_77", "zone": "hand",
    "targets": [{ "object_id": "perm_12" }],
    "payments": { "mana": { "U": 1, "generic": 1 } },
    "hold_priority": false } } }
```

Server → all (filtered per recipient):
```json
{ "v": 1, "type": "GAME_EVENT", "msg_id": "srv-8819",
  "payload": { "seq": 1047,
    "event": { "kind": "SPELL_CAST", "controller": 0, "card": "card_77",
      "stack_id": "stack_5", "targets": ["perm_12"], "modes": [], "x_value": null,
      "paid": { "mana": {"U":1,"generic":1} } },
    "caused_by": "c7d2…" } }
```
then `PRIORITY_UPDATE { seq: 1047, priority_seat: 0, stack_depth: 1 }` — caster gets priority first (holding not requested → rules engine advances), then `LEGAL_ACTIONS` for the priority holder, and triggered abilities (if any) arrive as further `GAME_EVENT`s (`TRIGGERED_ABILITY_QUEUED`) before priority passes.

---

## 3. Sequencing, Ack, Recovery

- **Per-game sequence numbers.** Every `GAME_EVENT` in a game carries a monotonically increasing `seq` starting at 1 (`GAME_START` is seq 1). `seq` is assigned by the game server process (single writer per game), persisted to Redis stream `game:{id}:events` and Postgres `game_events`.
- **Client ack.** Clients MUST send `{ "type": "ACK", "payload": { "game_id", "seq": <highest contiguous seq applied> } }` after applying events. Server tracks per-connection `last_acked_seq`.
- **Missed-event recovery.** If server sees a gap (`last_acked_seq < current_seq - 1` on reconnect, or client sends `REQUEST_RESYNC { game_id, last_seq }`):
  1. If `current_seq - last_seq <= 500` and the Redis stream still holds them: server replays the missing `GAME_EVENT`s in order, then sends `HIDDEN_VIEW`.
  2. Otherwise: server sends `SNAPSHOT_RESYNC { seq: current, snapshot: <filtered>, events_since: [] }` — client discards local state and adopts the snapshot.
- **Snapshots.** Server materializes a snapshot every 200 events (Redis, TTL 24h) and on game end (Postgres). Snapshots are per-player filtered at send time, never stored unfiltered per player — the canonical snapshot is full state; filtering happens at send (§5).
- **Idempotency.** Client `msg_id` dedupe window 60s: duplicate `GAME_ACTION` with the same `msg_id` returns the original result (`GAME_EVENT` with same `caused_by`) instead of re-executing.

---

## 4. Reconnect Flow & Token Rotation

1. On `AUTH_OK`, server issues `resume_token` (opaque, 128-bit, single-connection binding, TTL 15 min, refreshed on every `AUTH_OK`).
2. On disconnect, the seat is marked `disconnected`; game continues (timers run; if human has priority > 60s and `ai_takeover_on_disconnect` is set, an AI of the lobby's configured level takes the seat temporarily).
3. Reconnect: open new WS → send `AUTH { access_token, resume_token, game_id }` within 30s.
   - Valid: server binds the new connection to the seat, replays missed events per §3, sends `AUTH_OK` with a **new** `resume_token` (old one revoked — rotation).
   - `resume_token` expired/invalid but `access_token` valid: treated as fresh join — must present `seat_token` again via `JOIN_GAME`; missed events recovered via `REQUEST_RESYNC`.
   - Neither valid: `ERROR BAD_TOKEN`, connection closed after 5s.
4. Access tokens are short-lived (15 min). Clients refresh via REST `POST /auth/refresh` (rotates both tokens; refresh-token reuse → whole family revoked, all sessions killed — theft detection). WS `AUTH` accepts a token expired < 5 min ago to avoid mid-game churn, flagged `token_stale: true` in `AUTH_OK` so the client refreshes.

---

## 5. Hidden-Information Filtering (server-side, before send)

**Rule: the server NEVER sends a client any card identity or zone content that the corresponding player could not legally know. Filtering is applied at serialization time, in the game server process, for every `GAME_EVENT`, `HIDDEN_VIEW`, `LEGAL_ACTIONS`, and `SNAPSHOT_RESYNC` — per recipient seat.**

Zone visibility matrix (for a message addressed to seat S):

| Zone | Owner = S | Other player P | Spectator |
|---|---|---|---|
| Hand | Full cards (id, oracle id, all fields) | Count only (`{count: n}`); revealed cards (e.g. by Thoughtseize) sent as full card with `revealed_to: [S]` + expiry | Count only |
| Library | Count + known ordering info the player legally has (usually none; top card only if an effect reveals it) | Count only | Count only |
| Battlefield | Full | Full (tapped, counters, attachments, targets — all public) | Full |
| Graveyard | Full (order optional; engine tracks order) | Full | Full |
| Exile | Full, including face-down cards **owned by S** | Face-up full; face-down owned by others → `{count, face_down: true}` | Same as other players |
| Stack | Full (spell, controller, targets, modes, X, copies, source) | Full | Full |
| Command zone | Full (own commanders: tax count, castable) | Commanders public; tax count public | Full |
| Sideboard / outside game | Own: full (companion/lexicon lookups logged) | Hidden entirely | Hidden |

Additional rules:
- `LEGAL_ACTIONS` for seat S contains only S's legal actions. It never contains opponent action options. (Prevents leaking "opponent can cast X".)
- Random hidden choices (e.g. "opponent chooses a card") are resolved server-side; the chooser receives card identities, others receive only counts/zone deltas.
- AI players are server-side actors: they consume the same filtered `HIDDEN_VIEW` as a human in that seat. There is no privileged channel. (Enforced by constructing the AI's observation from the filtered serializer output.)
- Chat text from AI is generated from the AI's filtered observation only.
- Replays served via REST are filtered the same way unless the requester was a player in that game (then they get their own seat's view) or the game is marked `public_replay` (tournament showcase), in which case full information is released.
- Logging: any server log line containing a card identity is tagged with the seat(s) allowed to know it; full-state debug dumps require `debug_mode` game flag and are never sent to clients.

---

## 6. Lobby / Matchmaking / Spectator / Chat Flows

### Lobby flow
1. Host `POST /lobbies` → lobby in `open` state, Redis key `lobby:{id}` (TTL, refreshed by heartbeats).
2. Clients `POST /lobbies/:id/join {seat}` → assigned seat, receive `seat_token`.
3. Lobby events (`LOBBY_UPDATE`: seats, ready, chat) go over WS after `AUTH` + `{type: SUBSCRIBE_LOBBY, payload:{lobby_id}}` — or via SSE `GET /lobbies/:id/stream`. (WS preferred; one connection.)
4. All seats ready → host `POST /lobbies/:id/start` → server validates decks (422 on failure), creates game row, seeds RNG, seats AI actors, returns `game_id`. Clients `JOIN_GAME`.
5. AI seats: no human needed; server spawns AI worker subscribed to the game's Redis stream with that seat's filtered view.

### Matchmaking flow
1. `POST /matchmaking/queue {mode, deck_id, ai_fill}` → ticket in Redis sorted set `mm:{mode}`.
2. Matcher (every 2s) forms pods of 4 by rating (±150 Elo band, widening after 30s). If `ai_fill` and queue > 45s, fills remaining seats with AI of requested level.
3. Matched ticket holders receive WS `MATCH_FOUND {lobby_id, seat_token}` (or push notification if offline; ticket expires in 60s).
4. Auto-start when all 4 seats ack (or AI-filled seats need no ack).

### Spectator flow
1. `POST /lobbies/:id/join` with `{as: "spectator"}` (or join live game via `GET /games/:id` → `spectate_token` if game allows spectators).
2. `JOIN_GAME {as: "spectator"}` → receives spectator-filtered stream (§5, spectator column), `PLAYER_STATUS` updates, 30s-delayed stream if game is `ranked` with `delay_spectators: true`.
3. Spectators may `CHAT` (flagged `from: spectator`), never send game actions (`ERROR FORBIDDEN`).

### Chat flow
- `CHAT {channel: "table", text}` → server profanity/scam filter → broadcast `CHAT {from, seat?, text, ts}` to game members (spectators included per game settings).
- AI chat: AI worker emits `CHAT` through the same server path; tagged `from: "ai:seat_N"`. Rate-limited (§7). AI messages are generated from filtered observations only.
- Lobby chat uses the same message types on the lobby channel.

---

## 7. Backpressure & Rate Limits (per WS connection)

| Limit | Value | Behavior on exceed |
|---|---|---|
| Game actions (`GAME_ACTION`/`PASS_PRIORITY`) | 10 / 10s rolling | `ERROR RATE_LIMITED {retry_after_ms}`; action dropped |
| Chat messages | 5 / 10s | Dropped + `ERROR RATE_LIMITED` |
| `PING` | 1 / 5s | Ignored silently |
| `REQUEST_RESYNC` | 3 / min | `ERROR RATE_LIMITED` |
| Outbound queue per connection | 1,000 messages | Oldest non-critical messages dropped (`PRIORITY_UPDATE`/`TIMER_UPDATE` coalesced to latest); `GAME_EVENT`/`HIDDEN_VIEW` never dropped — if queue still full after 5s, connection closed with `ERROR BACKPRESSURE` and client must reconnect/resync |
| Max message size | 256 KB | Connection closed `ERROR MESSAGE_TOO_LARGE` |
| Idle timeout | 120s without `PING`/`ACK` | `PING` probe; close after +30s |

Global guards: per-IP 20 concurrent WS connections; per-game 6 connections (4 players + 2 spectators soft cap, configurable); Redis stream consumer lag alerts > 2,000 pending events. AI workers are exempt from action rate limits but share the outbound-queue policy.

---

## Appendix: `packages/protocol` layout

```
packages/protocol/
  src/
    envelope.ts        # WsEnvelope, MsgId, V
    client.ts          # ClientMessage union (AUTH, JOIN_GAME, GAME_ACTION, ...)
    server.ts          # ServerMessage union (GAME_EVENT, LEGAL_ACTIONS, ...)
    actions.ts         # ActionObject schema + per-kind payloads
    events.ts          # GameEvent union (all engine event kinds)
    views.ts           # FilteredState, zone view types per §5 matrix
    lobby.ts           # Lobby/matchmaking messages
    errors.ts          # ErrorCode enum + ERROR payload
    rest.ts            # REST request/response DTOs
  README.md
```

All message types are versioned: adding a field is minor; renaming/removing bumps `v`. The server keeps serializers for `v` and `v-1` during rollout.
