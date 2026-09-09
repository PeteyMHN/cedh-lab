# Interface Contract — v0.2.0 workstreams

This is the binding contract for the four parallel workstreams (engine, server, web, AI).
Read this before touching code. If the contract must change, update this file first.

## 1. Async engine

The engine's resolution path becomes async so human choices can round-trip over WebSockets.

- `Engine.resolveTop(): Promise<void>`
- `Engine.resolveTrigger(obj): Promise<void>`
- Card script `onResolve(api, player, obj, stackObj): Promise<void> | void`
- Card script `payCosts`: stays sync (costs are paid with available resources, no choices).
- `ScriptApi.askChoice(req: ChoiceRequestInit): Promise<ChoiceSelection>`
- `Engine.choicePolicy: (req: ChoiceRequest, game: Game) => Promise<ChoiceSelection>`
- Default policy (`defaultChoicePolicy`): picks the first legal option / sensible default. Used by tests and demos unless overridden. Must never throw on a well-formed request.
- All existing tests must be updated to async and keep passing. All three CLI demos must keep working.

`Game.pendingChoice: ChoiceRequest | null` — set while a human choice is outstanding (server use).

## 2. Choice types (live in packages/engine/src/choices.ts, re-exported by protocol)

```ts
type ChoiceKind = 'card' | 'cards' | 'option' | 'number' | 'yesNo' | 'player' | 'color' | 'order';
interface ChoiceRequest {
  id: string;               // engine-assigned, ulid-ish
  player: number;           // who must choose
  kind: ChoiceKind;
  prompt: string;           // human-readable, includes rule citation where relevant
  options?: ChoiceOption[]; // for card/cards/option/order kinds
  min?: number; max?: number; // for cards/number kinds
  zone?: Zone;              // for card/cards: where to choose from
}
interface ChoiceOption { id: string; label: string; detail?: string; disabled?: boolean }
type ChoiceSelection =
  | { kind: 'card'; cardId: string }
  | { kind: 'cards'; cardIds: string[] }
  | { kind: 'option'; index: number }
  | { kind: 'number'; value: number }
  | { kind: 'yesNo'; value: boolean }
  | { kind: 'player'; player: number };
```

Validation: `Engine.answerChoice(player, choiceId, selection)` validates the selection against the request's options/min/max; invalid → throw (server turns into an ERROR message, game state unchanged).

## 3. Replacement effects (engine workstream)

- `game.replacements: ReplacementEffect[]` registered by card scripts via `api.effects.addReplacement(fx)`.
- `interface ReplacementEffect { id: string; sourceId: string; controller: number; description: string;
    appliesTo(event: GameEventCandidate): boolean; replace(event, api): Promise<GameEventCandidate[]> }`
- Engine helper `applyReplacements(candidate, api)`: collect applicable, if >1 ask affected player to order via `askChoice` kind `order` (CR 616.1), apply sequentially.
- Minimum shipped behaviors: Opposition Agent (opponents can't search libraries), plus the ordering-choice path covered by a test with two stub replacements.

## 4. Combat (engine workstream)

- `Engine.declareAttackers(player, attackerIds: string[]): Promise<void>` — validates (untapped, no summoning sickness unless haste, etc.), taps, emits, fires attack triggers.
- `Engine.declareBlockers(player, blocks: {blocker: string, attacker: string}[]): Promise<void>` — validates (untapped, can block).
- Damage: first-strike step then regular; `game.dealCombatDamage(...)`; commander damage tracked.
- Turn structure: `turns.ts` gains `declareAttackers` / `declareBlockers` steps; priority after each (CR 507+).

## 5. Tokens

- `Engine.createToken(player, def: { name, types, power?, toughness?, colors? }): string` (object id). Tokens have `isToken: true`; leaving battlefield → cease to exist (CR 111.7).

## 6. Protocol (packages/protocol, written by Rumi — workstreams consume it)

- `ClientMsg = { t:'auth', token } | { t:'action', action: GameAction, nonce } | { t:'chat', text }`
- `GameAction = { kind:'pass' } | { kind:'cast', card, targets?, modes?, namedCard?, xValue? } | { kind:'activate', source, ability, targets? } | { kind:'playLand', card } | { kind:'declareAttackers', attackers } | { kind:'declareBlockers', blockers } | { kind:'answerChoice', choiceId, selection } | { kind:'concede' }`
- `ServerMsg = { t:'events', fromSeq, events } | { t:'view', seat, observation, legal, pendingChoice? } | { t:'priority', seat } | { t:'gameOver', winners } | { t:'chat', from, text } | { t:'error', code, message }`
- REST: `POST /api/pods`, `GET /api/pods/:id`, `POST /api/pods/:id/join`, `POST /api/pods/:id/start`, `GET /api/pods/:id/replay`, `GET /api/cards`, `POST /api/decks/validate`.

## 7. Server mapping (server workstream)

- `GameAction` → engine calls: cast → `engine.stack.castSpell` (+ `actionTaken`); activate → `engine.activateAbility`; playLand → `engine.playLand` (must exist on Engine); pass → `priority.pass`; answerChoice → `engine.answerChoice`.
- After every action: run `resolveTop` loop while all players passed (i.e., reuse the priority driver), then broadcast `events` + per-seat `view` (via `observe()` from `@cedh-lab/ai`).
- Priority prompt: when `priority.currentPlayer()` is a human seat, send `{ t:'priority', seat }`; the client responds with an action or pass.
- Reconnect: client sends last seen seq; server replies with snapshot (if >500 events behind) or missed events.

## 8. AI driver (AI workstream)

- `playGame(engine, policies: Map<seat, Policy>, opts): Promise<GameResult>` in `@cedh-lab/ai` (new file `driver.ts`): the full game loop — priority rounds, phase advancement, choice answering via policy, until game over. Must never issue an illegal action (validate against `legalActionsFor` first).
- Compound planning: `planManaThenCast` — tap lands/mana rocks to afford a spell, then cast, as one policy decision.
- Main-phase policy v2: play land, cast ramp/tutors/threats by heuristic priority.
- Belief updates: track revealed cards, probable interaction (from `observe()` beliefs).
- CLI demo: `demo-aigame.ts` — 4 AI seats play a full game; assert no illegal actions, game terminates, event chain valid.

## 9. Non-negotiables (all workstreams)

- No hidden-information leaks: AI and views use `observe()` only. Test it.
- Unsupported interactions → `UnsupportedInteraction` pause, never silent mis-resolution.
- Deterministic: no `Math.random`/`Date.now()` in engine/cards/AI-decision code. (Server may use them for tokens/timeouts only.)
- `npm test` and `npm run typecheck` green before handoff.
