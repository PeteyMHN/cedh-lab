# Security Model — cEDH Lab

Version: 1.0 | Owner: Security Engineering | Status: Living document

This document threat-models the cEDH playtesting platform (authoritative game server, hidden information, AI opponents, replays, leagues). Rules-engine correctness is a safety property; this doc covers adversarial threats, not rules bugs.

## 1. Trust boundaries

```
[Browser client] --TLS1.3--> [API gateway / WS gateway] --> [Game server (authoritative)]
       |                              |                           |
   untrusted                     rate limit, authN          rules engine, hidden state
                                                          |
                                                    [Postgres + Redis]
```

**Core invariant:** the client is a rendering terminal. It never holds hidden opponent information, never decides legality, never generates randomness. Every state change the client displays originates from the server.

## 2. Authentication & authorization

- **AuthN:** OAuth2/OIDC (Google, GitHub) or email+password with Argon2id hashing. Short-lived access tokens (15 min JWT, `kid`-keyed rotation) + rotating refresh tokens (7 d, reuse detection: reuse of a consumed refresh token invalidates the whole token family).
- **Session hijacking mitigations:** tokens are `HttpOnly; Secure; SameSite=Lax` cookies for browser sessions; WS connections upgrade with a one-time ticket (see §8). Bind sessions to a device fingerprint hash (UA + IP /24, not strict IP — mobile roams); on mismatch, step up with re-auth rather than silent accept. Log and alert on concurrent-session geography impossibility.
- **Roles:**
  - `player` — seat in a game; may submit actions for own seat only.
  - `spectator` — receives public-information view only; cannot submit actions; cannot see hands even after game ends unless the game owner opts into "open replay hands".
  - `admin` — user management, banlists, feature flags. **Admins cannot join or observe private games invisibly**; any admin read of game state is audit-logged (§11).
  - `service` — internal (AI workers, replay indexer); mTLS between services.
- **AuthZ checks are per-action, server-side:** `can_act(user, game_id, seat, action)`. Seat assignment is immutable after game start; reconnect re-validates the seat token. A player may never address another seat's actions, and spectators' action endpoints return 403 (not 404 — avoid leaking game existence beyond lobby visibility rules).

## 3. Hidden information — server-side view filtering

- The server holds one **canonical game state**. Per connected principal it derives a **view**: public zones + own hidden zones + legally revealed cards. View derivation is a pure function `derive_view(state, principal)` executed on the server for every outbound message.
- **Never send hidden opponent cards to unauthorized clients.** This is enforced by construction: the serializer for WS frames takes `(view)`, not `(state)`. A code-review gate: any new field added to the wire protocol must be annotated `visibility: public | owner | judge`; CI runs a test that serializes a fixture game and asserts no `owner`-visibility bytes appear in other players' frames.
- **AI opponents** run in the service tier and receive only the same `derive_view` output as a human would. There is no "AI debug peek" code path in production; debug reveal exists only behind the `debug_mode` flag, which forces the game into `casual/manual` mode, marks all replays `invalid_for_ranking`, and requires all human players' explicit consent.
- **Timing side channels:** AI "thinking" time is padded to a fixed budget per decision class so response latency doesn't leak hand strength. Card-image fetches go through a server-side proxy so the image CDN never learns which cards a player is viewing.
- **Spectator delay:** competitive/league games stream to spectators with a configurable delay (default 60 s) to prevent ghosting via voice chat.

## 4. Action integrity — no client-side move injection

- Every client action is a **proposal**: `{game_id, seat, action_type, payload, nonce, client_seq}`. The server:
  1. Validates session → seat binding.
  2. Checks `nonce` uniqueness per game (replay of a captured packet is rejected; nonces stored in Redis with game TTL).
  3. Re-runs the **full rules-engine legality check** against canonical state (costs payable, targets legal, timing/priority correct, mode choices valid). Client-side "legal moves" hints are UI convenience only.
  4. Applies via the event-sourced engine; emits the resulting events.
- **Packet spoofing:** WS frames are only accepted on the authenticated connection that owns the seat. There is no "act as seat X" parameter the client can set — seat is derived from the session. Sequence numbers detect dropped/duplicated frames; gaps trigger a state resync from server snapshot, never client replay.
- Illegal-action attempts are logged with account ID (abuse signal) and rate-limited (§9). Repeated injection attempts escalate to temporary action lockout.

## 5. Deck manipulation & malformed decklists

- Decks are validated **server-side on import and again at game start** (the list that was validated is the list that is played — store a canonical hash; the game references `deck_version_id`, never a client-supplied list).
- Parser hardening: strict grammar, max 10,000 chars input, max 200 lines, recursion/expansion limits on set/collector-number lookups. Unknown card names → reject with the offending line number; no fuzzy auto-substitution (prevents "proxy confusion" exploits).
- Validation rules enforced: 100 cards, singleton (except basics), color identity ⊆ commander's, format legality against the selected **banlist snapshot** (pinned version, not "current" — replays stay reproducible).
- **Decklist privacy:** lists are private by default; sharing is explicit per-deck. Opponent decklists are never revealed beyond what the rules reveal (commander identity is public; the 99 are not).

## 6. Replay integrity — hash-chained event log

- Games are event-sourced. Each event: `{seq, game_id, type, payload, prev_hash, hash}` where `hash = SHA-256(prev_hash || canonical_json(event))`. Genesis event commits to `{rules_version, card_db_version, banlist_snapshot, seed, deck_version_hashes}`.
- Clients can verify the chain independently. Any tampering (insert/delete/reorder) breaks the chain at that point.
- Replays are content-addressed by the head hash. "Report rules bug" exports `{game_id, head_hash, event slice}` so developers replay deterministically.
- Ranking/league stats only accept games whose chain verifies and whose `debug_mode=false`.

## 7. Script injection (XSS / stored injection via card text, chat, deck names)

- **Threat:** card Oracle text, rulings, deck names, chat messages, and scenario descriptions are attacker-influenced strings rendered in other users' browsers.
- Mitigations:
  - Store raw, render encoded: all user/card text goes through context-aware output encoding (HTML entity encoding in DOM text nodes; never `innerHTML` for untrusted strings — use a strict allowlist sanitizer for the small subset of rich text in scenario descriptions).
  - **Content-Security-Policy:** `default-src 'self'; script-src 'self'; object-src 'none'; img-src 'self' https://cards.proxy.internal; connect-src 'self' wss:`. No inline scripts; nonces for the SPA bundle.
  - Chat: length-limited (500 chars), no markdown, rate-limited (§9), server-side profanity/scam-link heuristics for public lobbies. Links not auto-linked in game chat.
  - Card data pipeline: Scryfall/Oracle ingest is treated as untrusted input — validate schema, strip unexpected fields, and never `eval` anything from it. The card scripting DSL (§card-scripting) runs in a sandbox with no I/O, no network, CPU-step limits.

## 8. Network protocol specifics

- WSS only (TLS 1.3). WS upgrade requires a single-use ticket issued over HTTPS (`POST /games/:id/connect` → `{ticket, expires: 30s}`); the ticket binds `{user, game, seat|role}`.
- Authoritative snapshots: server sends full snapshot on join/reconnect + delta events after. Client state is disposable.
- Reconnect: seat reservation held 120 s; on reconnect the server replays events since the client's last acked `seq` — the client never uploads state.

## 9. DoS & resource abuse

- **Per-connection:** 60 WS messages/min (bursts to 120); exceeding → server drops with `RATE_LIMITED` close code and 30 s cool-down.
- **Per-game:** max 600 actions/game-hour per seat; games auto-pause on flood and flag for review.
- **AI compute quotas:** each AI decision has a wall-clock budget by difficulty (e.g., Beginner 2 s, Tournament 20 s, Solver 120 s, queued). MCTS rollouts run in a worker pool with cgroup CPU/memory limits; a runaway worker is killed and the AI falls back to the heuristic policy (logged). Per-user concurrent AI-game cap (default 4) prevents one user from monopolizing the GPU/CPU pool.
- **Simulation/matchup testing:** 10k-game batches go to the job queue with per-user daily compute budgets; no synchronous 10k-game endpoint.
- Standard edge protections: SYN flood via cloud LB, L7 WAF rules for the API, request size caps (1 MB API, 64 KB WS frame).

## 10. Secrets & supply chain

- Secrets (DB creds, JWT signing keys, OIDC client secrets, Redis auth) live in a managed secret store (e.g., AWS Secrets Manager / Vault), injected as env vars at container start — never in git, never in images, never in logs (log redaction filter for `token|secret|key|password`).
- JWT signing keys rotate every 90 days with a 7-day overlap (`kid` header selects key).
- Container hygiene: minimal base images (distroless/slim), non-root user, read-only filesystem, no package manager in prod image. Dependabot/Renovate with auto-patch for CVEs; `npm audit`/`cargo audit` in CI, blocking on critical. SBOM generated per release; images signed (cosign) and verified at deploy.
- Card-image proxy allowlists upstream hosts; fetched images are re-encoded server-side (strips malicious EXIF/SVG payloads — SVG card art is rasterized, never served as SVG).

## 11. Audit logging

- Append-only audit log (WORM storage, e.g., S3 Object Lock) for: admin game-state reads, debug-mode activations, manual overrides, banlist changes, role grants, token-family invalidations, export/delete requests.
- Game events themselves are the gameplay audit trail (hash-chained, §6). Security events (auth failures, injection attempts, rate-limit trips) go to a SIEM-indexed stream with 1-year retention.

## 12. Privacy (GDPR-style)

- **Data inventory:** account PII, decklists, game events, chat logs, analytics. Minimization: chat retained 90 days; raw game events retained per user setting (default 1 year); aggregated analytics anonymized.
- **Export:** self-service full export (JSON) of account data, decks, games.
- **Delete:** right-to-erasure deletes PII and decklists; game events are anonymized (player IDs → one-way hash) rather than deleted where they anchor other players' replays/league integrity — disclosed in the privacy policy.
- **Training-data consent:** game logs used for AI training only with explicit opt-in (default off). Opt-in is per-account, revocable; revocation stops future ingestion (already-trained models are versioned so consent scope is auditable). Tournament/league games require organizer-level consent disclosure. No chat content is ever used for training.
- Under-16 accounts: no public chat, no public deck sharing.

## 13. Security invariants — the NEVER list

1. **Never** trust the client for legality, hidden information, or randomness.
2. **Never** serialize canonical state to the wire — only per-principal views.
3. **Never** let AI see more than the player it replaces could legally see.
4. **Never** resolve an unimplemented card effect silently — fail closed (pause + flag).
5. **Never** put secrets in code, images, logs, or URLs.
6. **Never** run card scripts or imported data with ambient authority (no I/O, no net, step-limited).
7. **Never** accept a game action without re-validating it against current canonical state.
8. **Never** allow invisible admin observation of private games without an audit record.
9. **Never** train on a user's games without their explicit opt-in.
10. **Never** expose stack traces, internal IDs, or DB errors to clients — mapped error codes only.
