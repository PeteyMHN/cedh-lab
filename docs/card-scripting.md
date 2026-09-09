# Card Scripting System

Design for the cEDH platform's card behavior layer. Governing principle: **the
rules engine is general; cards are data.** No card logic lives in engine source.
A card is a declarative `CardDefinition` (JSON) compiled to event hooks and an
effect graph. Anything not expressible declaratively falls back to a sandboxed
script with a capability-limited API. Every definition ships with unit-test
fixtures and is versioned against its Oracle text.

## 1. Design principles

1. **Oracle identity vs. printing identity.** The engine operates on the Oracle
   card (name, Oracle text, types, costs). Printings (set, collector number,
   art) are metadata for display only.
2. **Declarative first.** ~90% of cEDH-relevant cards are expressible as
   hooks + composable effects. Declarative definitions are serializable,
   diffable, testable, and analyzable (the AI's combo detector reads them).
3. **Effects are a graph, not a string.** Resolution instructions are a DAG of
   typed effect nodes with explicit sequencing, branching, and choices — never
   parsed English.
4. **Fail closed.** If an effect node is unimplemented, the engine pauses with
   a `RULES_GAP` diagnostic instead of resolving incorrectly (see §5 for the
   manual-override path).
5. **Determinism.** All randomness flows through the engine's seeded RNG;
   definitions are pure data.

## 2. CardDefinition schema

TypeScript interfaces (JSON-serializable; Zod-validated at load):

```ts
type ZoneId = "library"|"hand"|"battlefield"|"graveyard"|"exile"|"stack"|"command";
type PlayerRef = "you"|"controller"|"opponent"|"eachOpponent"|"eachPlayer"|"targetPlayer";

interface ManaCost {           // parsed cost AST, e.g. {1}{W}
  generic: number;
  colored: Partial<Record<"W"|"U"|"B"|"R"|"G"|"C", number>>;
  x?: number;                  // {X}
  // hybrid/phyrexian as structured variants when needed
}

interface CardFace {
  name: string;
  manaCost: ManaCost | null;
  typeLine: string;            // "Artifact", "Instant", "Legendary Creature — Human Advisor"
  supertypes: string[]; supertypesIncl: never;
  types: string[];             // ["Creature"], ["Instant"]
  subtypes: string[];
  colors: ("W"|"U"|"B"|"R"|"G")[];
  colorIdentity: ("W"|"U"|"B"|"R"|"G")[];
  power?: string; toughness?: string;   // strings: "3", "*", "1+*"
  loyalty?: number;
  oracleText: string;          // canonical, for hashing/display
  keywords: Keyword[];         // ["flash","deathtouch", ...] — engine implements keyword semantics once
}

interface OracleCard {
  oracleId: string;            // stable id, e.g. scryfall oracle_id
  oracleHash: string;          // sha256 of canonical oracleText — versioning anchor
  faces: CardFace[];           // 1 for normal, 2 for MDFC/adventure/split
  abilities: Ability[];        // parsed from oracleText at authoring time
  rulings: string[];
}

interface Printing {
  printingId: string;
  oracleId: string;
  set: string; collectorNumber: string;
  imageUris?: { small: string; normal: string };
  artist?: string;
}

interface CardDefinition {
  schemaVersion: number;       // definition-format version
  defVersion: number;          // increments on any authoring change
  engineMinVersion: string;    // semver floor
  oracle: OracleCard;
  printings: Printing[];
  scripts?: SandboxScript[];   // §5 fallback, ideally empty
  tests: CardTest[];           // §6 — required before merge
}
```

**Keywords** are not per-card logic: `flash`, `deathtouch`, `haste`,
`firstStrike`, `lifelink`, `vigilance`, `hexproof`, `shroud`, `ward`,
`protection`, `splitSecond`, etc. are implemented once in the engine and
referenced by name. Anything keyword-like that needs parameters (e.g.
`ward {2}`) is a `Keyword` object `{ name: "ward", cost: ManaCost }`.

## 3. Ability model

```ts
type Ability =
  | SpellAbility      // resolution instructions for spells on the stack
  | TriggeredAbility
  | ActivatedAbility
  | StaticAbility
  | ReplacementAbility;
```

### 3.1 Common building blocks

**Selectors** — who/what an effect touches:

```ts
type Selector =
  | { kind: "target"; id: TargetId }            // chosen at cast/activation
  | PlayerRef
  | { kind: "each"; filter: CardFilter; controller: PlayerRef }
  | { kind: "self" }                             // the source object
  | { kind: "chosen"; id: ChoiceId };             // chosen during resolution

interface CardFilter {
  types?: string[]; subtypes?: string[]; colors?: string[];
  controller?: PlayerRef | "any";
  zone?: ZoneId; tapped?: boolean; power?: NumCmp; ...
}
```

**Targets** (declared on cast/activation, validated twice — on announcement
and on resolution):

```ts
interface TargetDef {
  id: string;
  filter: CardFilter;             // legal target characteristics
  count: { min: number; max: number };  // "up to two", "any number"
  divided?: boolean;              // damage/counter division
  restrictions?: string[];        // e.g. "controlledByOpponent"
}
```

Target legality recheck on resolution follows CR 608.2b: if all targets are
illegal the spell fizzles (no partial effects); otherwise it resolves doing as
much as possible with remaining legal targets.

**Costs**:

```ts
type Cost =
  | { kind: "mana"; cost: ManaCost }
  | { kind: "tap"; selector: Selector }
  | { kind: "untap"; selector: Selector }
  | { kind: "sacrifice"; filter: CardFilter; count: number }
  | { kind: "discard"; count: number; random?: boolean }
  | { kind: "payLife"; amount: number }
  | { kind: "exileFromHand"; filter: CardFilter }
  | { kind: "removeCounters"; counter: string; count: number }
  | { kind: "additional"; text: string };  // kicker etc., structured where possible
```

### 3.2 Effect graph

Every ability resolves to an ordered graph of typed effect nodes:

```ts
type Effect =
  | { op: "seq"; steps: Effect[] }
  | { op: "if"; cond: Condition; then: Effect; else?: Effect }
  | { op: "choose"; id: string; prompt: string; options: ChoiceOption[]; chooser: PlayerRef }
  | { op: "addMana"; to: PlayerRef; mana: string }            // "CC", "WUBRG"
  | { op: "draw"; who: PlayerRef; count: NumExpr }
  | { op: "destroy"; target: Selector }
  | { op: "exile"; target: Selector; faceDown?: boolean }
  | { op: "changeZone"; target: Selector; to: ZoneId; ... }
  | { op: "gainLife"; who: PlayerRef; amount: NumExpr }
  | { op: "loseLife"; who: PlayerRef; amount: NumExpr }
  | { op: "damage"; target: Selector; amount: NumExpr }
  | { op: "counter"; target: Selector }                        // counter a spell
  | { op: "tap"; target: Selector } | { op: "untap"; target: Selector }
  | { op: "createToken"; token: TokenDef; count: NumExpr; controller: PlayerRef }
  | { op: "putCounters"; target: Selector; counter: string; count: NumExpr }
  | { op: "searchLibrary"; who: PlayerRef; filter: CardFilter; count: NumExpr; toZone: ZoneId; shuffle: boolean }
  | { op: "reveal"; target: Selector }
  | { op: "applyContinuous"; effect: ContinuousEffect }        // until EOT / while on battlefield
  | { op: "registerDelayedTrigger"; trigger: TriggeredAbility; expiry: Duration }
  | { op: "repeatLoop"; maxIterations: number | "arbitrary"; body: Effect }  // §loops
  | { op: "custom"; scriptId: string; params: Record<string, unknown> };     // §5

type NumExpr = number | { ref: "targetPower"|"targetToughness"|"xPaid"|"cardsInGraveyard"|... };
```

`ContinuousEffect` carries a **layer** (1–7), timestamp, and dependency hints so
the engine's layer system applies it correctly:

```ts
interface ContinuousEffect {
  layer: 1|2|3|4|5|6|7;
  sublayer?: "7a"|"7b"|"7c"|"7d";
  applyTo: CardFilter;             // which objects
  set?: { types?: string[]; colors?: string[]; power?: string; toughness?: string };
  addAbilities?: Ability[]; removeAbilities?: string[];
  grantKeyword?: Keyword[];
  duration: "untilEOT"|"whileSourceOnBattlefield"|"indefinite"|"untilLeaves";
}
```

### 3.3 Hook catalog

Triggered and replacement abilities subscribe to engine events. The catalog is
fixed and versioned; each hook declares its event payload.

| Hook | Fires when | Payload highlights |
|---|---|---|
| `ON_CAST` | its controller casts the spell (cast triggers) | spell, costs paid |
| `ON_SPELL_CAST` | any player casts a spell matching filter | spell, caster |
| `ON_ETB` | source enters battlefield | — |
| `ON_ANY_ETB` | permanent matching filter ETBs | permanent, controller |
| `ON_LTB` | source leaves battlefield | destination zone |
| `ON_DIES` | creature matching filter dies | creature, cause |
| `ON_UPKEEP` | upkeep of player matching filter | player |
| `ON_DRAW_STEP` | draw step begins | player |
| `ON_DRAW` | player draws (replacement-aware) | player, count |
| `ON_COMBAT_BEGIN` | beginning of combat | — |
| `ON_ATTACK` | creature attacks | attacker, defending player |
| `ON_BLOCK` | creature blocks | blocker |
| `ON_COMBAT_DAMAGE` | combat damage dealt | source, recipient, amount |
| `ON_DAMAGE_DEALT` | any damage by matching source | source, recipient, amount |
| `ON_LIFE_GAINED` / `ON_LIFE_LOST` | life total change | player, amount |
| `ON_ACTIVATED` | ability matching filter activated | ability, activator |
| `ON_TRIGGER` | triggered ability goes on stack | ability |
| `ON_SACRIFICE` | permanent sacrificed | permanent |
| `ON_TUTOR` | player searches library | player, cards found |
| `ON_MANA_ADDED` | mana added to pool | player, mana |
| `ON_COUNTERS_PLACED` | counters placed | object, kind, count |
| `ON_PHASE_CHANGE` | phase/step boundary | from, to |
| `ON_WOULD_CHANGE_ZONE` | **replacement hook**: object would move zones | object, from, to — may substitute |
| `ON_WOULD_DRAW` | **replacement hook**: player would draw | player, count — may substitute |
| `ON_WOULD_SEARCH` | **replacement hook**: player would search library | player — may substitute controller |
| `ON_WOULD_DEAL_DAMAGE` | **replacement hook**: damage event | event — may modify/prevent |
| `ON_WOULD_GAIN_LIFE` | **replacement hook**: life gain event | event — may modify |

Replacement hooks return an event substitution; when several apply to one
event, the **affected player** (or controller of the affected object) chooses
their order per CR 616.1 — the engine must surface that choice explicitly,
including to AI as a decision node.

Intervening-if clauses, reflexive triggers, and delayed triggers are
first-class: `TriggeredAbility.condition` supports
`{ interveningIf: Condition }`, and effects can `registerDelayedTrigger`.

```ts
interface TriggeredAbility {
  kind: "triggered";
  hook: HookName;
  filter?: CardFilter;                 // e.g. ON_ANY_ETB of a creature you control
  condition?: Condition;               // includes interveningIf
  optional?: boolean;                  // "you may" — explicit choice node
  targets?: TargetDef[];               // chosen when trigger goes on stack
  effect: Effect;
  reflexive?: TriggeredAbility;        // "when you do,"
}
```

Activated abilities declare timing explicitly (this is what makes Sol Ring a
*mana ability* — no stack, no priority pass):

```ts
interface ActivatedAbility {
  kind: "activated";
  costs: Cost[];
  targets?: TargetDef[];
  effect: Effect;
  timing: "mana" | "sorcery" | "instant" | "any";  // "mana" ⇒ resolves immediately, not a spell
  loyaltyCost?: number;
}
```

## 4. Worked examples

### 4.1 Sol Ring — simple (mana ability)

Oracle: "{T}: Add {C}{C}."

```json
{
  "oracleId": "sol-ring-oracle-id",
  "oracleHash": "sha256:…",
  "faces": [{
    "name": "Sol Ring",
    "manaCost": { "generic": 1, "colored": {} },
    "typeLine": "Artifact",
    "types": ["Artifact"], "subtypes": [],
    "colors": [], "colorIdentity": [],
    "oracleText": "{T}: Add {C}{C}.",
    "keywords": []
  }],
  "abilities": [{
    "kind": "activated",
    "timing": "mana",
    "costs": [{ "kind": "tap", "selector": { "kind": "self" } }],
    "effect": { "op": "addMana", "to": "controller", "mana": "CC" }
  }]
}
```

Engine notes: `timing: "mana"` ⇒ activated as a mana ability (CR 605) —
resolves immediately, doesn't use the stack, can't be responded to. The `{T}`
cost enforces summoning-sickness-equivalent tapping rules for artifacts via
the engine's generic cost legality, not per-card code.

### 4.2 Swords to Plowshares — targeted spell with resolution-time math

Oracle: "Exile target creature. Its controller gains life equal to its power."

```json
{
  "faces": [{
    "name": "Swords to Plowshares",
    "manaCost": { "generic": 0, "colored": { "W": 1 } },
    "typeLine": "Instant",
    "types": ["Instant"], "subtypes": [],
    "colors": ["W"], "colorIdentity": ["W"],
    "oracleText": "Exile target creature. Its controller gains life equal to its power.",
    "keywords": []
  }],
  "abilities": [{
    "kind": "spell",
    "targets": [{
      "id": "creature",
      "filter": { "types": ["Creature"], "zone": "battlefield" },
      "count": { "min": 1, "max": 1 }
    }],
    "effect": { "op": "seq", "steps": [
      { "op": "exile", "target": { "kind": "target", "id": "creature" } },
      { "op": "gainLife",
        "who": { "kind": "chosen", "id": "creatureController" },
        "amount": { "ref": "targetPower", "target": "creature" } }
    ]}
  }]
}
```

Engine notes:
- Target chosen on cast; legality rechecked on resolution (hexproof/shroud/
  protection/fizzle handled generically by CR 608.2b — **not** by this card).
- `targetPower` uses **last known information** if the creature left the
  battlefield (CR 608.2h) — the engine's LKI snapshot supplies it; the card
  just references it.
- Exile here is a one-shot zone change, not a replacement effect — no
  `ON_WOULD_CHANGE_ZONE` involvement beyond normal event dispatch (so
  Dauthi Voidwalker-style replacements still see the event and can apply).

### 4.3 Opposition Agent — complex (replacement effect + control change + cast permission)

Oracle: "Flash. You control your opponents while they're searching their
libraries. While an opponent is searching their library, they exile each card
they find. You may play those cards for as long as they remain exiled, and you
may spend mana as though it were mana of any type to cast them."

This decomposes into **three** abilities sharing one definition:

```json
{
  "faces": [{
    "name": "Opposition Agent",
    "manaCost": { "generic": 1, "colored": { "B": 2 } },
    "typeLine": "Creature — Human Rogue",
    "types": ["Creature"], "subtypes": ["Human", "Rogue"],
    "colors": ["B"], "colorIdentity": ["B"],
    "power": "3", "toughness": "2",
    "oracleText": "Flash\nYou control your opponents while they're searching their libraries. While an opponent is searching their library, they exile each card they find. You may play those cards for as long as they remain exiled, and you may spend mana as though it were mana of any color to cast them.",
    "keywords": ["flash"]
  }],
  "abilities": [
    {
      "kind": "replacement",
      "hook": "ON_WOULD_SEARCH",
      "condition": { "playerIs": "opponentOfController" },
      "comment": "You control the search: choose what they find (may find nothing), per CR 616 + search rules. The searching player still shuffles unless an effect says otherwise.",
      "effect": { "op": "custom", "scriptId": "opp-agent-control-search",
                  "params": { "controllerOverride": "you" } }
    },
    {
      "kind": "replacement",
      "hook": "ON_WOULD_SEARCH",
      "condition": { "playerIs": "opponentOfController" },
      "comment": "Each card found is exiled instead of going to the instructed zone. Ordered with the control effect by the affected player (here both are Agent's; engine still routes the choice).",
      "effect": { "op": "changeZone",
                  "target": { "kind": "chosen", "id": "foundCards" },
                  "to": "exile", "faceDown": false }
    },
    {
      "kind": "static",
      "comment": "Continuous permission: cast from exile + any-type mana.",
      "effect": { "op": "applyContinuous", "effect": {
        "layer": 6,
        "applyTo": { "zone": "exile", "exiledBy": { "kind": "self" } },
        "duration": "whileSourceOnBattlefield",
        "grants": { "mayCastFromExile": "controller",
                    "manaAsAnyType": "controller" }
      }}
    }
  ]
}
```

Engine implications the definition surfaces (not hides):
- **Ordering choice.** Two replacement effects modify the same search event.
  CR 616.1: the affected player (the searching opponent) chooses the order.
  The engine presents this as an explicit choice node — the AI evaluates it.
  (Both orders converge here, but the choice must exist for correctness and
  for cards where order matters, e.g. Agent vs. Aven Mindcensor.)
- **Control ≠ information leak.** "You control the search" means the Agent's
  controller makes the find/nothing decisions using *their* legal knowledge —
  the engine's per-player observation states enforce that the controller can't
  see unrevealed library cards unless the search instructs reveal.
- **Exile-then-cast tracking.** Cards exiled by Agent are tagged
  `exiledBy: <agent object id>`; the static permission references that tag, so
  it survives Agent leaving the battlefield for cards already exiled ("for as
  long as they remain exiled") while new searches are unaffected.
- **Mana permission** is a continuous effect on the *player's* mana-spending
  rules, applied in the cost-payment subsystem, not a card-text hack.

## 5. Sandboxed scripting fallback

Declarative coverage target: everything in the cEDH top-95% card pool. When a
card genuinely needs custom logic (e.g. Opposition Agent's search-control UX,
or unusual "play with the top card revealed plus…" interactions), authors write
a **sandboxed script** referenced by `{ op: "custom", scriptId }`.

**Allowed** inside the sandbox:
- The injected `engine` API only: read zones/objects via per-player
  observation views, query legal actions, propose choices, register triggers,
  emit effect events. No direct state mutation — scripts *request*; the engine
  *applies* after validation.
- Seeded RNG via `engine.random()`; deterministic math; string/array utils.

**Forbidden:** network, filesystem, timers, `Date.now()`, `Math.random()`,
globals, dynamic `import`/`eval`, prototype mutation, exceptions escaping the
boundary (trapped → `RULES_GAP` pause).

**Execution:** scripts run in an isolated VM (QuickJS/`isolated-vm`) with fuel
limits (max instructions, max wall-clock, max memory). Each `scriptId` is
versioned with the definition; scripts are code-reviewed like engine code and
must ship with the same test fixtures as declarative abilities (§6). A script
that exceeds fuel or throws is treated as a rules gap, never silently resolved.

**Graduation path:** commonly-used script patterns are promoted into new
declarative effect ops in the next schema version.

## 6. Testing & versioning

Every `CardDefinition` **must** include `tests: CardTest[]` or the definition
fails validation at build time. Fixture format:

```ts
interface CardTest {
  name: string;                       // "StP exiles and gains life = power"
  given: ScenarioState;               // battlefield, hands, life, stack, priority holder
  when: TestAction[];                 // CAST "Swords to Plowshares" TARGET Grizzly Bears; PASS x3; ...
  then: Assertion[];                  // see below
  seed?: number;                      // default fixed seed
}

type Assertion =
  | { assert: "zoneCount"; player: string; zone: ZoneId; count: number }
  | { assert: "life"; player: string; equals: number }
  | { assert: "exiled"; card: string; by?: string }
  | { assert: "stackEmpty" }
  | { assert: "eventFired"; event: string; with?: Record<string, unknown> }
  | { assert: "choiceOffered"; to: string; promptContains: string }
  | { assert: "illegalAction"; action: string; reason: string };
```

- **Given/When/Then** runs against the real engine in a headless harness;
  assertions inspect post-resolution state *and* the event log.
- Negative tests are required for targeting/legality cards
  (`illegalAction`, fizzle cases, hexproof).
- **Versioning:** `defVersion` bumps on any authoring change; `oracleHash`
  pins the Oracle text. A nightly job re-fetches Oracle text — on hash
  mismatch the definition is quarantined (`needsReview: true`) and its tests
  re-run; CI fails if tests reference stale wording semantics.
- Engine compatibility: `engineMinVersion`; schema migrations are explicit
  (`schemaVersion` N → N+1 scripts, never silent reinterpretation).
- Every fixed rules bug becomes a regression fixture in the affected card's
  `tests` (see the interaction test library).

## 7. Coverage strategy

Prioritize by **metagame frequency**, not alphabet. Pipeline:

1. **Frequency source:** aggregate cEDH decklists (Moxfield/Archidekt dumps,
   tournament top-8s). Metric: *share of decks containing the card*, weighted
   toward recent finishes. Recomputed monthly; stored as `cards.meta_share`.
2. **Complexity triage** per card: `simple` (hooks+effects only) /
   `moderate` (needs choices/ordering care) / `hard` (sandbox likely).
   Hard cards get senior-reviewer assignment; they must not block simple ones.
3. **Tier order within each milestone:**
   - T0: fast mana, free interaction, tutors, fetchlands/duals (the cards in
     >40% of decks — Mana Crypt, Sol Ring, Force of Will, Demonic Tutor…)
   - T1: major commanders + their combo packages (Thassa's Oracle lines,
     Breach lines, Dockside loops where legal, Kinnan/Basalt…)
   - T2: stax pieces, engines (Rhystic Study, Mystic Remora, Necropotence…),
     removal suite
   - T3: archetype staples, protection, win-outlets (Walking Ballista…)
   - T4: long tail
4. **Milestones** (share of *card occurrences* across sampled cEDH decklists,
   not distinct cards):
   - **50%** — T0+T1 complete with tests; vertical slice playable for the top
     ~8 archetypes (Blue Farm, Rog/Si, Kinnan, Sisay, Tivit, Najeela…).
   - **80%** — T2 complete; Scenario Lab's core scenarios all runnable;
     manual-override mode covers the rest.
   - **95%** — T3 complete; remaining 5% tracked on a public gap board with
     per-card status; any gap hit in a real game triggers the fail-safe pause
     (§fail-safe), never a silent mis-resolution.
5. **Ratchet rule:** coverage % never decreases — CI computes it from
   `meta_share × implemented` on every merge.

---

*Related docs: `rules-engine.md` (hooks/layers/priority), `ai-architecture.md`
(combo graph reads declarative definitions), `testing.md` (harness details).*
