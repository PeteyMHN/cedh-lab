# cEDH Lab — Database Schema Design

**Stack:** PostgreSQL 16 · Redis 7 (hot game state, pub/sub, rate limits) · Node/TypeScript backend
**Core principle:** `game_events` is the source of truth (event sourcing). Everything else — snapshots,
ratings, analytics — is derived. Snapshots exist only for fast rewind/branching, never as authority.

Conventions: all tables have `created_at timestamptz NOT NULL DEFAULT now()`. PKs are `uuid`
(`gen_random_uuid()`) unless noted. FKs `ON DELETE RESTRICT` for historical integrity
(games, events, versions are immutable history), `CASCADE` only for user-owned drafts.

---

## 1. Identity & Social

### users
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| handle | citext UNIQUE NOT NULL | login/display, case-insensitive |
| email | citext UNIQUE NOT NULL | |
| password_hash | text NOT NULL | argon2id only — never plaintext, never reversible |
| display_name | text | |
| avatar_url | text | |
| is_admin | boolean DEFAULT false | |
| preferences | jsonb DEFAULT '{}' | UI prefs, priority-stop config |
| deleted_at | timestamptz | soft delete; row retained for FK history |
| last_login_at | timestamptz | |

Indexes: `UNIQUE(handle)`, `UNIQUE(email)`, `(last_login_at)` for churn analytics.

### friends
| column | type | notes |
|---|---|---|
| user_id | uuid FK→users PK | composite PK `(user_id, friend_id)` |
| friend_id | uuid FK→users PK | check `user_id < friend_id` canonical ordering |
| status | text NOT NULL | `pending`/`accepted`/`blocked` |
| acted_by | uuid FK→users | who sent/accepted |

Index: `(friend_id, status)` for "who friended me" lookups.

---

## 2. Card Catalog (oracle identity separated from printings)

### cards — one row per Oracle card identity
| column | type | notes |
|---|---|---|
| oracle_id | uuid PK | stable internal id; maps to Scryfall `oracle_id` where known |
| name | text NOT NULL | |
| mana_cost | text | parsed symbols, e.g. `{2}{U}{B}` |
| cmc | numeric NOT NULL | |
| type_line | text NOT NULL | |
| oracle_text | text NOT NULL | |
| colors | text[] | `character varying[]`, e.g. `{U,B}` |
| color_identity | text[] NOT NULL | |
| power / toughness | text | nullable (non-creatures) |
| loyalty | text | nullable |
| keywords | text[] | normalized keyword list |
| layout | text | normal/split/adventure/mdfc… |
| legalities | jsonb | `{commander: "legal", vintage: "banned"}` per format snapshot overrides |
| rulings | jsonb DEFAULT '[]' | versioned with card text |
| card_db_version | text NOT NULL | which import produced this row |

Indexes: `name` trigram (`pg_trgm`) for deck-import fuzzy match; GIN `(keywords)`; `(color_identity)` via GIN for "all Simic commanders" queries; `(cmc)`.

### printings — physical/digital print identity
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| oracle_id | uuid FK→cards NOT NULL | |
| set_code | text NOT NULL | |
| collector_number | text NOT NULL | |
| rarity | text | |
| image_uris | jsonb | `{small, normal, large}` — URLs only, never blobs |
| prices_usd | jsonb | snapshot; not authoritative |
| released_at | date | |
| UNIQUE (oracle_id, set_code, collector_number) | | |

Index: `(set_code, collector_number)`.

### card_scripts — versioned behavior definitions for the rules DSL
| column | type | notes |
|---|---|---|
| oracle_id | uuid FK→cards NOT NULL | |
| version | integer NOT NULL | PK `(oracle_id, version)` |
| dsl_source | text NOT NULL | the card's scripted behavior |
| compiled_hash | text NOT NULL | sha256 of normalized source; engine caches on this |
| status | text NOT NULL | `draft`/`tested`/`production`/`deprecated` |
| test_coverage | jsonb | linked scenario/test ids |
| created_by | uuid FK→users | |
| change_note | text | |

Rationale: card behavior is data, not engine code. The engine pins `card_db_version` +
`compiled_hash` per game so replays use historical scripts (see `games`).

---

## 3. Decks

### deck_archetypes
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| name | text UNIQUE NOT NULL | e.g. `Blue Farm`, `Rog/Si` |
| description | text | |
| strategy_tags | text[] | `turbo`/`midrange`/`stax`/`farm`… |
| example_commanders | uuid[] | FK→cards.oracle_id (array, denormalized for speed) |

### decks — mutable container; immutable content lives in versions
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| owner_id | uuid FK→users NOT NULL | |
| name | text NOT NULL | |
| format | text NOT NULL DEFAULT 'cedh' | |
| commander_oracle_ids | uuid[] NOT NULL | 1–2 commanders |
| archetype_id | uuid FK→deck_archetypes | curated or inferred |
| is_public | boolean DEFAULT false | |
| current_version_id | uuid FK→deck_versions | set after version insert |
| deleted_at | timestamptz | |

Indexes: `(owner_id, updated_at DESC)` for "my decks"; GIN `(commander_oracle_ids)` for "decks using Kinnan";
`(is_public)` partial where true for browsing.

### deck_versions — immutable; every game references a version
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| deck_id | uuid FK→decks NOT NULL | |
| version_number | integer NOT NULL | UNIQUE `(deck_id, version_number)` |
| mainboard | jsonb NOT NULL | `[{oracle_id, qty}]` — 99 entries for cEDH |
| sideboard | jsonb DEFAULT '[]' | maybeboard |
| content_hash | text NOT NULL UNIQUE | sha256 of canonical list; dedupes identical lists |
| validation | jsonb NOT NULL | `{singleton: true, color_identity_ok: true, legal: true, errors: []}` |
| analysis | jsonb | strategic model: `{archetype, win_packages[], tutors, interaction_count, fast_mana, engines[]}` |
| source | text | `manual`/`moxfield`/`archidekt`/`clipboard` |
| source_url | text | |

Rationale: JSONB for the card list (fixed shape, never partially queried — always loaded whole).
`analysis` is recomputed by a worker on version creation and powers AI deck models + matchup stats.
GIN index on `analysis` for `analysis->'win_packages'` containment queries.

---

## 4. Formats & Rules Versioning

### format_snapshots
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| name | text NOT NULL | `Current cEDH`, `Historical cEDH — Jan 2024`, `Custom` |
| effective_from | date NOT NULL | |
| effective_to | date | null = current |
| banlist | jsonb NOT NULL | `{banned_oracle_ids: [], notes}` |
| rules_version | text NOT NULL | Comprehensive Rules version, e.g. `2026-04` |
| commander_rules | jsonb | starting life, damage rule, mulligan policy |
| is_official | boolean DEFAULT false | |

Every `game` pins a `format_snapshot_id` — replays and historical analytics stay correct
even as the banlist moves.

---

## 5. Games (event-sourced)

### games
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| format_snapshot_id | uuid FK→format_snapshots NOT NULL | |
| rules_engine_version | text NOT NULL | |
| card_db_version | text NOT NULL | |
| seed | bigint NOT NULL | deterministic RNG seed |
| status | text NOT NULL | `lobby`/`mulligan`/`active`/`paused`/`finished`/`aborted`/`invalid` |
| ranked | boolean DEFAULT false | |
| turn_count | integer DEFAULT 0 | denormalized on finish |
| winner_seat | smallint | null for draws |
| win_condition | text | `combat`/`thassa-oracle`/`concession`… |
| invalid_reason | text | fail-safe engine halt explanation |
| visibility | text DEFAULT 'private' | `private`/`friends`/`public` |
| started_at / ended_at | timestamptz | |
| lobby_id | uuid FK→lobbies | nullable (ad-hoc pods) |

Indexes: `(status)` partial `WHERE status IN ('active','paused')` for live-game dashboards;
`(visibility)` partial `WHERE visibility='public'`; `(ended_at DESC)` for history feeds;
`(winner_seat)` not indexed (low cardinality) — analytics read from aggregates.

### game_players — one row per seat
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| game_id | uuid FK→games NOT NULL | |
| seat | smallint NOT NULL | 0–3, UNIQUE `(game_id, seat)` |
| user_id | uuid FK→users | null = AI-controlled seat |
| ai_profile_id | uuid FK→ai_profiles | null = human |
| deck_version_id | uuid FK→deck_versions NOT NULL | |
| commander_oracle_ids | uuid[] NOT NULL | denormalized for analytics (no join) |
| mulligan_count | smallint DEFAULT 0 | |
| kept_hand_size | smallint | |
| result | text | `win`/`loss`/`draw`/`conceded`, null until finished |
| commander_damage_dealt | jsonb DEFAULT '{}' | `{seat: damage}` per attacking commander |
| is_spectator | boolean DEFAULT false | spectators are rows too, no seat actions |
| connection_state | text DEFAULT 'connected' | for reconnect handling |

Indexes: UNIQUE `(game_id, seat)`; `(user_id, created_at DESC)` → via join to games — instead put
`(user_id)` and join; GIN `(commander_oracle_ids)` — **this is the win-rate-by-commander index**;
`(game_id, result)` for pod result rollups; `(ai_profile_id)` for AI performance.

### game_events — THE source of truth. Hash-partitioned.
| column | type | notes |
|---|---|---|
| game_id | uuid NOT NULL | partition key |
| seq | bigint NOT NULL | per-game sequence, gapless; PK `(game_id, seq)` |
| event_type | text NOT NULL | `GAME_START`/`SHUFFLE`/`DRAW`/`CAST`/`PAY_MANA`/`PASS_PRIORITY`/`TRIGGER`/`RESOLVE`/`SBA`/`CHOICE`/`MULLIGAN`… |
| actor_seat | smallint | null for system events |
| payload | jsonb NOT NULL | event-specific data; card refs by oracle_id + instance uuid |
| wall_clock | timestamptz NOT NULL DEFAULT now() | real time (timers, analytics) |
| turn | integer NOT NULL | game clock |
| phase | text NOT NULL | `untap`/`upkeep`/`draw`/`precombat_main`/… |
| step | text | combat sub-steps |
| priority_seat | smallint | who holds priority after this event |
| idempotency_key | uuid | client-generated; UNIQUE `(game_id, idempotency_key)` for retry-safe submits |

**Partitioning:** `PARTITION BY HASH (game_id)` into 64 partitions (`game_events_p00`…`p63`).
Rationale: the two hot query patterns are both `game_id`-scoped —
(1) "replay game N events in order" → single-partition range scan on PK `(game_id, seq)`;
(2) live append → single-partition insert. Hash partitioning gives even write distribution
across partitions (no hot monthly partition during tournament spikes) and enables
per-partition archival/detach for retention. Time-based partitioning was rejected because
almost no query filters events by wall-clock alone.

Indexes per partition: PK `(game_id, seq)`; `(game_id, event_type)` for analysis
("all CAST events in game N"); BRIN on `(wall_clock)` for ops/debugging scans.
Generated column `payload_turn integer GENERATED ALWAYS AS ((payload->>'turn')::int)` — not needed;
`turn` is already a real column.

**JSONB vs normalized:** event shapes vary wildly (`DAMAGE` vs `CHOICE` vs `SHUFFLE`);
normalizing would mean dozens of sparse tables. Payload stays JSONB; the columns the engine
and queries actually filter on (`game_id, seq, event_type, actor_seat, turn, phase,
priority_seat`) are real columns. Contract: every payload includes `v: 1` schema version.

### game_snapshots — rewind/branch accelerators
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| game_id | uuid NOT NULL | (no FK — must survive game row archival) |
| at_seq | bigint NOT NULL | event seq this snapshot reflects; UNIQUE `(game_id, at_seq)` |
| kind | text NOT NULL | `periodic`/`manual`/`branch_point`/`scenario_start` |
| state | jsonb NOT NULL | full engine state **including hidden zones** |
| state_hash | text NOT NULL | integrity check on load |
| engine_version | text NOT NULL | refuse to load across engine versions |

Policy: engine writes `periodic` every 25 events; `branch_point` on user "explore another line".
Snapshots are **server-side only** — the API layer must never serialize `state` to a client.
Client views are built by projecting events through a per-seat visibility filter.

---

## 6. AI

### ai_profiles
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| name | text UNIQUE NOT NULL | `Tournament`, `Solver`, `Bluff-heavy`… |
| skill_tier | text NOT NULL | `beginner`/`intermediate`/`advanced`/`tournament`/`solver` |
| tendencies | jsonb | `{aggression: 0.7, bluff: 0.3, interaction_ bias: …}` |
| model_version | text NOT NULL | policy/value net checkpoint id |
| description | text | |
| is_active | boolean DEFAULT true | |

### ratings — Glicko-2 for humans and AI alike
| column | type | notes |
|---|---|---|
| entity_type | text NOT NULL | `user`/`ai` — PK `(entity_type, entity_id, format)` |
| entity_id | uuid NOT NULL | |
| format | text NOT NULL | |
| rating | numeric DEFAULT 1500 | |
| rd | numeric DEFAULT 350 | rating deviation |
| volatility | numeric DEFAULT 0.06 | |
| games_played | integer DEFAULT 0 | |
| updated_at | timestamptz | |

Rationale: one table for both, so human-vs-AI and AI-vs-AI games update the same pool.
4-player pods use multiplayer Elo adjustment (placement-based) recorded in `rating_deltas` JSONB
on `game_players` (add column `rating_delta numeric`).

---

## 7. Scenarios & Coaching

### scenarios
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| name | text NOT NULL | `Stop the Oracle`, `Should you feed the Fish?` |
| description | text | |
| difficulty | smallint | 1–5 |
| setup | jsonb NOT NULL | `game_snapshot`-compatible state or declarative setup script |
| par_lines | jsonb | accepted solution sketches `[{name, key_events[]}]` |
| author_id | uuid FK→users | |
| is_public | boolean DEFAULT false | |
| tags | text[] | `stack-war`/`mulligan`/`ad-nauseam`… |

### scenario_attempts
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| scenario_id | uuid FK→scenarios NOT NULL | |
| user_id | uuid FK→users NOT NULL | |
| game_id | uuid NOT NULL | the practice game (FK omitted — games may be pruned) |
| completed_at | timestamptz | null = abandoned |
| score | numeric | |
| evaluation | jsonb | `{mistakes: [{category, turn, detail}], grade}` |
| UNIQUE (scenario_id, user_id, game_id) | | |

Index: `(user_id, scenario_id, completed_at DESC)` for progress tracking.

---

## 8. Multiplayer infra

### lobbies
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| code | text UNIQUE NOT NULL | 6-char join code |
| host_id | uuid FK→users NOT NULL | |
| config | jsonb NOT NULL | `{seats: [{type: human/ai, ai_profile_id}], format_snapshot_id, ranked, timers}` |
| status | text DEFAULT 'open' | `open`/`starting`/`in_game`/`closed` |
| expires_at | timestamptz NOT NULL | auto-close idle lobbies |

### (Redis, not Postgres)
Live game authority state, per-seat visibility projections, WebSocket pub/sub channels
(`game:{id}`), reconnect tokens, and action rate-limit buckets live in Redis with TTLs.
Postgres is the durable log; Redis is the hot cache. On server restart, authoritative state
is rebuilt by replaying `game_events` from the last snapshot.

---

## 9. Analytics (derived, never authoritative)

### analytics_aggregates — incrementally maintained rollups
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| scope | text NOT NULL | `commander_seat`/`matchup`/`archetype`/`ai_tier`… |
| dimensions | jsonb NOT NULL | e.g. `{commander: <oracle_id>, seat: 2, format: 'cedh'}` |
| games | bigint DEFAULT 0 | |
| wins | bigint DEFAULT 0 | |
| avg_win_turn | numeric | |
| avg_mulligans | numeric | |
| common_win_lines | jsonb | top-k win conditions |
| computed_at | timestamptz | |
| UNIQUE (scope, dimensions) | with hash index on dimensions | |

Maintained by a worker consuming a `game_finished` outbox (see §11), not by triggers on the
write path. Answers "win rate by commander+seat" as a single indexed row lookup.
Raw per-game facts remain queryable in `game_players` for ad-hoc analysis.

---

## 10. Quality & Safety

### bug_reports — replayable by construction
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| reporter_id | uuid FK→users | |
| game_id | uuid NOT NULL | |
| from_seq / to_seq | bigint | minimal event window |
| rules_engine_version | text NOT NULL | denormalized — must reproduce exactly |
| card_db_version | text NOT NULL | |
| seed | bigint NOT NULL | |
| minimal_state | jsonb | reduced snapshot if isolatable |
| description | text NOT NULL | |
| status | text DEFAULT 'open' | `open`/`reproduced`/`fixed`/`wontfix` |
| fixed_in_engine_version | text | |

Because games are deterministic from `(seed, events, engine_version, card_db_version)`,
a bug report is a complete reproduction — no separate repro steps needed.

---

## 11. Cross-cutting concerns

**Outbox pattern.** All side effects (analytics updates, rating changes, replay notifications)
go through an `outbox` table (`id, aggregate_type, aggregate_id, event_type, payload, published_at`)
written in the same transaction as the game mutation; a relay publishes to Redis Streams.
No dual-writes.

**Retention.**
- `game_events`: ranked games, bug-linked games, and public replays — retained indefinitely
  (they're the product's training data). Unranked private games older than 24 months:
  compact to `(game_id, seed, final snapshot, event count)` and move raw partitions to
  cold storage (Parquet in S3); restorable on request.
- `game_snapshots`: keep `branch_point`/`manual`; prune `periodic` older than the retention
  window unless the game is flagged for training.
- Detach/archive per hash partition is operationally simple: one partition holds a stable
  subset of games, so archival never scans the whole table.

**Connection hygiene.** Every client-submitted action carries `idempotency_key`; the engine
validates legality against the authoritative state and appends exactly one event.
`CHECK` constraints enforce enums (`status`, `result`, `event_type` families) — add new event
types via migration, never free text.

**Migrations.** Versioned SQL migrations (e.g. `db/migrate/0001_init.sql`…), zero-downtime:
expand (add nullable column) → backfill → contract. Partition count changes need a
maintenance window; 64 partitions is sized for ~10⁹ events before revisiting.

---

## 12. What must NEVER be stored or transmitted

1. **Hidden information in client-reachable rows.** Hands, library order, face-down cards exist
   only in `game_snapshots.state` (server-only) and the Redis authority cache. They must never
   appear in `game_events.payload` in recoverable form for unauthorized seats — private events
   (e.g. `DRAW`) record *that* a draw happened and the card's identity is stored **encrypted
   with a per-game key** or referenced by an opaque instance id resolved server-side only.
   The API projection layer strips these fields per seat; defense in depth, not just the view.
2. **Plaintext credentials or reversible secrets.** `password_hash` only; reset tokens hashed.
3. **Full card images as blobs** — URLs to a licensed/configurable image provider.
4. **PII in analytics.** Aggregates carry no user ids; k-anonymity threshold (n≥20 games)
   before a slice is served publicly.
5. **Client-submitted game state.** Clients submit *intents* (`{game_id, idempotency_key, action}`),
   never state. The server re-derives legality; any mismatch is logged as a security event.
6. **Unversioned card behavior.** No game may reference "latest" scripts — always pinned
   `(card_db_version, compiled_hash)`.
