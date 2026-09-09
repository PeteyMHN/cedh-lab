# cEDH Lab — Frontend Architecture

Stack: **Next.js 14 (App Router) + TypeScript**, **Zustand** (client state), **Tailwind CSS**, **native WebSockets** (custom hook, no socket.io), **DOM-first rendering** (canvas added later for animation layers). All game logic lives server-side; the client renders and submits intents.

## 1. Route structure & component tree

```
app/
  layout.tsx                      # root: theme, fonts, toasts, websocket provider
  page.tsx                        # lobby / dashboard
  decks/page.tsx                  # deck library
  decks/import/page.tsx           # deck import wizard
  decks/[id]/page.tsx             # deck detail + strategic model
  lab/page.tsx                    # scenario lab browser
  lab/[scenarioId]/page.tsx       # scenario detail + leaderboard
  games/[gameId]/page.tsx         # live game table
  games/[gameId]/replay/page.tsx  # replay viewer
  review/[gameId]/page.tsx        # coaching review
  settings/page.tsx               # priority stops, accessibility, account
```

Component tree for the live game:

```
GamePage
└── WebSocketProvider
    └── GameTable
        ├── TableTop            # felt background, turn-order arrows, seating
        │   ├── PlayerPanel(seat=0)   # opponent — top
        │   ├── PlayerPanel(seat=1)   # opponent — left
        │   ├── PlayerPanel(seat=2)   # opponent — right
        │   ├── PlayerPanel(seat=3)   # local user — bottom
        │   └── CenterColumn
        │       ├── TurnPhaseTrack     # phase pips: untap→upkeep→…→cleanup
        │       ├── CombatPanel        # attackers/blockers/damage assignment
        │       ├── StackPanel         # vertical stack + priority indicator
        │       └── ActionBar          # PASS / RESPOND / ACTIVATE MANA / UNDO-stop
        ├── HandView            # local player's hand (bottom, fanned)
        ├── CardDetail          # inspector drawer (oracle text, rulings, zone history)
        ├── ChoiceModal         # targets, modes, X, ordering, card-name entry
        ├── PriorityStopsDrawer # MTGO-style stop config (also in settings)
        ├── ChatPanel           # table chat + AI table-talk
        ├── GameMenu            # concede, pause, debug mode, report rules bug
        └── Toasts / AnnounceLog# event feed ("P3 casts Demonic Consultation")
```

`PlayerPanel` contains: `CommanderBadge`, `LifeCounter`, `CommanderDamageList`, `ZoneCounts` (hand/library/graveyard/exile), `ManaPool`, `PriorityRing`, `Battlefield` (that player's permanents, grouped: lands / creatures / artifacts-enchantments / misc), `Avatar` (human/AI badge, connection status, timer).

`Battlefield` contains `PermanentCard[]` — each renders tap state (rotated 90° via CSS transform), counters (badges), attachments (stacked mini-cards), status icons (summoning sickness, "can't attack", stax lock).

## 2. Four-player layout spec

Desktop-first, min supported viewport 1280×800. CSS grid, 12-col × 8-row:

```
┌──────────────────────────────────────────────┐
│ row 0-1:        Opponent 0 (top)              │  cols 4-9
│ col 0-2: Opponent 1 (left) │ CENTER │ Opp 2   │  rows 2-5
│ row 6-7:        You (bottom)                  │  cols 4-9
└──────────────────────────────────────────────┘
```

Exact placement:

- **Top opponent** (`grid-area: 1 / 4 / 3 / 10`): horizontal panel. Battlefield rows collapse to compact strips (max 2 rows, horizontal scroll if more). Hand shown as card-backs count + fanned mini-backs.
- **Left opponent** (`2 / 1 / 6 / 4`): vertical panel, permanents in vertical columns grouped by type.
- **Right opponent** (`2 / 10 / 6 / 13`): mirror of left.
- **Local player** (`6 / 4 / 9 / 10`): own battlefield above `HandView` (fixed bottom strip, full-width, cards fan with hover-raise).
- **Center** (`3 / 5 / 6 / 9`): `TurnPhaseTrack` (top), `CombatPanel` (collapsible), `StackPanel` (fills), `PriorityBar` (bottom, always visible).

Zone placement rules (consistent across all four panels):

1. Commander: pinned top-left of each panel, always visible, tax badge overlay.
2. Life total: large numeral top-right of panel; commander damage as small per-opponent pips beneath it.
3. Hand/library/graveyard/exile: icon + count strip along panel edge nearest table center (clickable → zone viewer drawer).
4. Mana pool: floating pips row under life; "available mana ≈" computed client-side from untapped lands/rocks the local player can see (marked *estimated*).
5. Battlefield grouping order: lands → mana artifacts → creatures → other artifacts/enchantments → planeswalkers. Tapped permanents rotate; do not reorder on tap (stable layout = less misclick).

Responsive behavior:

- ≥1600px: full layout, card width 96px battlefield / 128px hand.
- 1280–1600: battlefield cards 72px, opponent panels collapse battlefield to one scrollable row each.
- <1280: switch to "focus mode": one selected opponent panel visible at a time via tabs (Top/Left/Right), local panel + center always visible. Never hide stack or priority.
- Hand strip: horizontal scroll with snap; on narrow screens becomes 2-row paginated fan.

## 3. Stack visualization (`StackPanel`)

Vertical list, **top of list = top of stack** (resolves first). Each `StackObject`:

```
┌─────────────────────────────────┐
│ ▲ Flusterstorm            [P2]  │  ← card name + controller seat badge
│ Target: Ad Nauseam              │  ← targets (clickable → highlight target)
│ Storm count: 3                  │  ← X / copies / storm count
│ "Counter target instant/sorcery │  ← chosen modes (modal spells)
│  spell unless its controller…"  │
└─────────────────────────────────┘
```

- Triggered abilities render with source card thumbnail + ability text snippet; delayed triggers get a ⏳ badge.
- Copies get a ⧉ badge and "copy of X" link.
- New objects animate in from top (translateY, 200ms); resolving objects flash then collapse.
- **Priority indicator**: banner above stack — `Priority: P2 (Renz)` with pulsing ring on that player's panel; also a "holding priority" tag when active player retains it.
- **Action bar** (contextual by game state):
  - `PASS` (primary, Space), `RESPOND` (opens legal-response picker), `ACTIVATE MANA ABILITY` (R), `HOLD PRIORITY` toggle.
  - When it's your priority and you have no legal actions: bar shows "No actions — passing" auto-state, never silently auto-passes without the configured stop permitting it.
- Clicking a stack object selects it → `CardDetail` shows full oracle text, controller, all targets/modes, and "respond" shortcut.

## 4. Client state management

### Store shape (Zustand)

```ts
type GameStore = {
  gameId: string;
  seed: number; rulesVersion: string;
  me: SeatId;
  seats: SeatState[];            // life, cmdDamage, zoneCounts, manaPool, timers
  permanents: Record<ObjId, PermanentView>;
  stack: StackObjectView[];
  hand: CardView[];              // only local player's real cards
  knownInfo: KnownCards;         // revealed / legally-known cards
  turn: { number, activePlayer, phase, step };
  priority: { holder: SeatId | null, holdingPriority: boolean };
  combat: CombatView | null;
  pendingChoice: ChoiceRequest | null;   // modal choices from server
  stops: PriorityStops;          // local config, synced to server
  log: LogEntry[];               // capped at 500
  connection: 'live'|'reconnecting'|'offline';
  // actions
  applyEvent(e: GameEvent): void;
  sendIntent(i: PlayerIntent): void;
}
```

### Event sourcing on the client

- Server is authoritative. Every mutation arrives as a `GAME_EVENT` over WebSocket: `{ seq, type, payload }`.
- Client keeps `lastSeq`; `applyEvent` is a pure reducer `state = reduce(state, event)`. Out-of-order events are buffered; gaps trigger resync.
- Full snapshot (`GAME_SNAPSHOT`) on join/rejoin; events applied on top.

### Optimistic UI rules

- **Allowed optimistically**: selecting targets, choosing modes, typing X, reordering triggers, chat, camera/panel UI (zone viewer open/close).
- **Never optimistic**: anything that changes game state or reveals hidden info — casting, activating, passing priority, drawing. These send `PlayerIntent` and wait for the confirming `GAME_EVENT`. UI shows a subtle "waiting" shimmer on the acted card until confirmed (timeout 5s → error toast, state unchanged).
- **Hidden info invariant**: the store shape physically cannot hold opponents' hands — server only sends counts + `knownInfo` (cards revealed by effects). AI table-talk and opponent models run server-side.

### Reconnect & resync

- Heartbeat every 15s; missed 2 → `reconnecting` banner, input locked except chat.
- On reconnect: send `RESYNC { gameId, lastSeq }` → server replies `GAME_SNAPSHOT` (if `lastSeq` too old) or missed `GAME_EVENT`s.
- Snapshot includes a hash; client verifies hash of its reduced state matches — mismatch → full snapshot + log warning (also feeds the "Report Rules Bug" payload).

## 5. Priority-stops configuration UI

MTGO-style, per-phase matrix + smart rules. Location: in-game drawer (gear icon on `PriorityBar`) and `settings/page.tsx`; stored server-side per user, pushed to game on join.

UI:

- **Phase grid**: rows = phases/steps (Untap, Upkeep, Draw, Precombat Main, Beginning of Combat, Declare Attackers, Declare Blockers, Combat Damage, End of Combat, Postcombat Main, End Step, Cleanup); columns = "My turn" / "Opponents' turns". Click toggles stop. Shift-click a row = stop on all opponents' turns.
- **Event stops** (checkbox list): ☐ Opponent casts a spell ☐ Opponent activates ability ☐ Opponent tutors ☐ Commander cast ☐ Trigger goes on stack ☐ Opponent draws 2+ cards ☐ My end step (always).
- **Smart pass presets** (radio): "Manual (stop everywhere)" / "Tournament defaults" / "Speed (auto-pass blanks)".
- **Yield-until** quick buttons on the ActionBar during play: "Yield until opponent acts", "Yield until end step", "Yield through combat" — these are temporary overrides, shown as chips that can be cancelled; any new trigger/spell matching event stops breaks the yield.
- Guardrail: enabling "auto-pass if no legal action" never suppresses a stop the user explicitly set; the UI warns when a preset would skip a configured stop.

Server receives the stop table and only requests priority when a stop matches or the player has a legal action the engine flags as "strategically non-trivial" (per spec §PRIORITY AUTOMATION).

## 6. Secondary flows

### Deck import (`decks/import`)

3-step wizard: **Paste/URL** → **Parse & validate** → **Strategic model**.

1. Textarea (plain text, `1 Card Name` per line; `*CMDR*` / `Commander:` markers) + URL field (Moxfield/Archidekt auto-detected, fetched server-side).
2. Server parses → returns card-by-card resolution with images; unresolved names highlighted for manual fix (fuzzy-match suggestions). Validation panel: 100 cards ✓, singleton ✓, color identity vs commander ✓, banlist (selectable snapshot) ✓ — each a row with pass/fail.
3. Strategic model card: archetype, primary/secondary plan, combo packages (clickable → shows pieces owned/missing), interaction density meter, fast-mana count, stax profile. "Save deck" → deck library.

### Scenario lab (`lab`)

- Card grid of scenarios: title, difficulty badge, archetype tags, best-line par, community solve rate.
- Scenario page: briefing ("You are seat 3. Stop the Oracle."), starting-state diagram, "Attempt" → loads `games/[gameId]` in scenario mode (fixed seed, AI opponents scripted to the scenario), "Solution" reveal (expected line + alternates), your attempts history.
- Creator: "New scenario" → debug-mode board builder (reuse `GameMenu` debug tools: set life, add to hand/battlefield, set mana) → save with expected solution text.

### Replay viewer (`games/[gameId]/replay`)

- Timeline scrubber over the event log (event-sourced → deterministic re-render at any seq).
- Branch panel: "Explore another line" at any point → creates `branchId`, local fork rendered with branch badge; branches listed in a tree; "simulate to end (AI vs AI)" button per branch; outcome comparison table (winner, win turn, key decision).
- Speed control, event filter (show only: casts / triggers / priority passes / combat), click event → jump state + highlight involved cards.

### Coaching review (`review/[gameId]`)

- Decision list: every point where the human had >1 legal action, ranked by estimated win-probability delta (server-computed).
- Each row: turn/phase, board thumbnail, "You did X / Suggested Y", reason paragraph, mistake category tag (Sequencing, Threat assessment, Mulligan, Interaction, Tutor target, Mana efficiency, Missed win, Missed protection, Political error, Priority, Rules).
- "What-if" button per decision → opens replay branched at that event.
- Summary header: grade, top-3 recurring mistake categories, link to matching scenarios ("Practice: Should you feed the Fish?").

## 7. Accessibility

- **Keyboard**: full game playable without mouse. `Tab` cycles zones → cards; `Enter` select/inspect; `Space` pass priority; `R` respond; `1-9` hand shortcuts; `?` opens shortcut cheat-sheet. Visible focus ring (2px, high-contrast) on everything.
- **Screen reader**: every card a labeled element — `aria-label="Sol Ring, artifact, untapped, controlled by you"`. Live region announces priority changes, stack pushes/resolutions, phase changes, life changes ("Priority to you", "Ad Nauseam resolves"). Zone counts as definition lists.
- **Never color-alone**: tapped = rotation + "tapped" text badge; priority = pulsing ring + "PRIORITY" text label; controller identity = seat number badge (P0–P3) + name, not just color; life loss = numeral + ↓ arrow + text in log; summoning sickness = 💤 icon + "sick" tag.
- **Colorblind-safe palette**: seat colors chosen from Okabe-Ito (blue/orange/bluish-green/yellow); red/green never paired for meaning. Mana symbols use official letter/shape conventions plus text fallback.
- **Motion**: `prefers-reduced-motion` disables card fly animations, stack slide-ins, pulsing rings (replaced with static highlights). All animations ≤250ms otherwise.
- **Contrast**: dark theme base `#0d1117`-ish; text ≥ 4.5:1; card text on parchment-tinted panels, never white-on-yellow.

## 8. Performance

- **Rendering budget**: 60fps during animations; game-state updates are discrete events (no per-frame sim on client).
- **Memoization**: `PermanentCard`, `StackObject`, `PlayerPanel` wrapped in `React.memo` with stable IDs; Zustand selectors per component (`useGame(s => s.permanents[id])`) so a life-total change doesn't re-render 40 permanents.
- **Virtualized lists**: graveyard/exile/library viewers and log use `@tanstack/react-virtual` (lists can reach 100+ entries).
- **Battlefield cap**: DOM nodes per permanent kept < 15; attachments render as collapsed stack (expand on hover/click). Beyond ~60 permanents per player, non-creature non-interactive permanents collapse into a "lands (12)" group chip.
- **Images**: Scryfall CDN images lazy-loaded (`loading="lazy"`), `next/image` with fixed sizes; text-only card mode toggle (renders oracle text card, zero images) for low-bandwidth.
- **WebSocket**: single connection per game; events batched per animation frame (`requestAnimationFrame` flush) so a 20-trigger cascade doesn't cause 20 re-renders; log capped at 500 entries (older paged from server).
- **Bundle**: route-level code splitting (deck import, replay, review are separate chunks); target < 250KB initial JS for `games/[gameId]`.
- **Animation layer**: DOM transforms only (translate/rotate/scale, GPU-composited); canvas overlay reserved for future: drag-attack arrows, damage numbers, storm-count effects.
