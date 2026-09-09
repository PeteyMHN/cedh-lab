# AI Architecture — cEDH Playtesting Platform

**Status:** Design document. Implements the AI half of the product spec: a 6-layer opponent/reasoning stack that plays cEDH at tournament level without ever cheating (no hidden-card access) and without ever deciding legality (legality comes only from the deterministic rules engine).

## 0. Non-negotiable design principles

1. **Legality is engine-owned.** The AI consumes `legal_actions(observation) -> Vec<Action>` from the rules engine. It may rank, filter, and search over actions; it may never invent, reinterpret, or veto legality. If the engine reports "cannot resolve," the AI degrades to manual-mode suggestions, never to hallucinated rulings.
2. **No hidden information access.** All AI reasoning runs on `PlayerObservation`, never `TrueGameState`. Beliefs about hidden zones are explicit probability distributions, auditable in explanations. Any code path that reads an opponent's hand/library must go through the belief module, and CI enforces this with a lint rule (`no_true_state_in_ai`).
3. **Every decision is explainable.** Each chosen action carries an `Explanation` (Section 9) built from quantities the AI legally knew.
4. **Deterministic given seed.** Same `(observation, seed, AI config)` → same action. RNG for AI-internal sampling uses a dedicated stream derived from the game seed, so replays reproduce AI behavior exactly.
5. **Policy over scripts.** No "if opponent casts X, always counter." All behavior emerges from search + evaluation + policy weights, so new cards work without code changes.

---

## 1. Layer 1 — Rules engine interface (what the AI sees of the engine)

The engine exposes a narrow, stable API to the AI. The AI never touches engine internals.

```rust
// Action the engine declares legal for `player` in the current state.
pub struct Action {
    pub id: ActionId,
    pub kind: ActionKind,          // PassPriority | CastSpell | ActivateAbility
                                  // | DeclareAttackers | MulliganDecision | Choice(...) ...
    pub source: ObjectId,          // card/ability, or None for pass
    pub modes: Vec<ModeChoice>,   // chosen modes (engine-validated options attached)
    pub targets: Vec<Target>,     // engine-provided legal target options
    pub mana_payment: ManaPayment, // engine-computed options (each a legal way to pay)
    pub x_value: Option<i32>,
    pub description: String,       // human-readable, for UI + explanations
}

pub trait RulesEngine {
    fn legal_actions(&self, obs: &PlayerObservation) -> Vec<Action>;
    fn apply(&mut self, action: &Action) -> EngineResult; // advances true state
    fn clone_for_search(&self, obs: &PlayerObservation) -> SearchEngine;
    // SearchEngine: fast, headless, no UI hooks; supports:
    //   apply(action), undo(), determinize(hidden) -> fills hidden zones by sampling
}
```

Key contract details:

- **Mana payment options are enumerated by the engine.** The AI picks among legal payments; it never computes "can I pay" itself. Each `ManaPayment` lists which permanents/cards produce the mana and any restrictions (e.g., "spend only on artifacts").
- **Choices are explicit.** Modal spells, target selection, "choose a card name," trigger ordering, replacement-effect ordering all arrive as `ActionKind::Choice` with engine-validated option lists.
- **Priority windows are first-class.** The engine yields `ActionKind::PassPriority` / `HoldPriority` at every priority pass. "Smart pass" UI features are implemented as AI-chosen sequences of `PassPriority` with stop conditions evaluated on each new observation.
- **Determinize for search.** `SearchEngine::determinize(belief_sample)` fills unknown hidden zones by sampling from the belief module (Section 5), producing a fully-specified state the search can roll out. The sampler never leaks true hidden cards; it samples from the *belief distribution*.

Performance budget: `legal_actions` must return in <50ms for typical cEDH board states; `apply`/`undo` <1ms (persistent data structures, Section 3).

---

## 2. Layer 2 — Game state representation

### 2.1 Two states, hard separation

```rust
pub struct TrueGameState { /* everything; engine-internal only */ }

/// Everything player `p` legally knows. The ONLY input to AI reasoning.
pub struct PlayerObservation {
    pub me: PlayerId,
    pub turn: TurnInfo,            // active player, phase/step, turn number, APNAP order
    pub priority_holder: PlayerId,
    pub stack: Vec<StackObjectView>,
    pub battlefield: Vec<PermanentView>,
    pub players: Vec<PlayerView>,  // all 4: life, hand count, library count, poison,
                                  // commander damage taken (per commander), mana pool (mine only exact),
                                  // commanders (zone + tax), emblems
    pub my_hand: Vec<CardView>,    // full detail, only for me
    pub my_library_order: Option<Vec<CardId>>, // only if an effect lets me know (e.g., scry bottom)
    pub graveyards: Vec<Vec<CardView>>,
    pub exiles: Vec<Vec<CardView>>, // face-up exile only; face-down = counts + known-to-me
    pub command_zone: Vec<CardView>,
    pub triggers_pending: Vec<TriggerView>, // triggers I control awaiting ordering
    pub choices_pending: Vec<ChoiceView>,    // engine-offered choices for me
    pub known_info: KnownInfo,     // revealed/seen cards, tracked per opponent
    pub event_log_tail: Vec<EventSummary>, // recent public events (casts, triggers, payments)
    pub seed: u64,                 // for AI-internal RNG derivation
    pub rules_version: RulesVersion,
}
```

`CardView` for opponent cards carries only public info (name if revealed, else "face-down card #n"). `PermanentView` includes tap status, counters, attached objects, continuous-effect-derived characteristics (already computed by engine — the AI never computes layers).

### 2.2 Known-information ledger

The belief module maintains, per opponent, what has been *legally seen*:

```rust
pub struct KnownInfo {
    pub per_opponent: HashMap<PlayerId, OpponentKnowledge>,
}
pub struct OpponentKnowledge {
    pub decklist: Option<Decklist>,       // known if user provided / public in testing
    pub seen_in_hand: Vec<CardId>,       // revealed then returned (e.g., Thoughtseize saw, then...)
    pub seen_cards: HashMap<CardName, u32>, // copies observed anywhere (hand/GY/battlefield/stack)
    pub total_seen: u32,                  // cards removed from their unknown pool
    pub revealed_hand: Option<Vec<CardName>>, // currently revealed (e.g., Telepathy) w/ expiry
    pub mana_seen: Vec<ManaSnapshot>,     // mana they demonstrably had at past points
    pub behavioral_flags: Vec<BehaviorFlag>, // SuspiciousPass, HeldUpInteractionMana, TutoredRecently...
}
```

**Unknown pool accounting.** A 99-card library + hand of `h` + unknown. When a card is seen anywhere public, it leaves every opponent's unknown pool. This is the foundation of the hypergeometric belief (Section 5).

### 2.3 Belief state (probabilistic hidden)

```rust
pub struct BeliefState {
    pub per_opponent: HashMap<PlayerId, OpponentBelief>,
}
pub struct OpponentBelief {
    /// P(card name in hand) for interaction/combo-relevant cards.
    pub hand_probs: HashMap<CardName, f32>,
    /// P(opponent can produce >= X mana of color C next turn).
    pub mana_probs: HashMap<(Color, i32), f32>,
    /// P(opponent wins on their next turn if uninterrupted).
    pub win_next_turn_prob: f32,
    /// P(opponent holds >=1 piece of free interaction.
    pub free_interaction_prob: f32,
    /// Archetype posterior (Section 5.4).
    pub archetype: HashMap<ArchetypeId, f32>,
    pub last_updated_event: u64,
}
```

Beliefs update on every public event (event-driven, O(cards tracked)) — never on a timer, never from true state.

---

## 3. Layer 3 — Tactical search

### 3.1 Why naive search dies in Magic

A cEDH priority window routinely offers 30–200 legal actions (every instant in hand × targets × mana payments × modes). Depth-6 full search is ~10¹² nodes. We do not brute force. The pipeline is: **generate candidates → prune aggressively with cEDH heuristics → beam/expectimax over the survivors → evaluate leaves with Layer 4 → adjust with Layer 6 policy.**

### 3.2 Candidate generation and pruning

`generate_candidates(obs) -> Vec<Action>` applies these filters in order:

1. **Mana-feasibility pre-filter.** Drop actions whose cheapest legal mana payment exceeds available mana *unless* the action is itself a mana ability. (Engine enumerates payments; AI picks the min-cost one for the feasibility check.)
2. **Window relevance.** At a priority pass with an empty stack during an opponent's main phase, 95% of instants are irrelevant. Keep only actions tagged by the *relevance classifier*:
   - Interaction (counter/removal) if `stack non-empty` OR `opponent_win_prob > 0.15` OR `policy flag: must-answer threat on board`.
   - Combo pieces if `combo_window_open(obs)` (own mana + protection sufficient).
   - Card advantage engines if `turn < 4` and no immediate threat.
   - Everything else → collapsed into a single abstract action `Develop` (representative: "use remaining mana developing") to keep branching bounded. The abstract action expands during rollouts.
3. **Dominance pruning.** If action A and B have identical game effects but A costs more mana, drop A. If two targets are symmetric (two identical tokens), keep one.
4. **History pruning.** Never consider the same losing line twice in one search (transposition table on `(observation_hash, action)`).
5. **Combo-window focus.** If the AI's own deterministic win is available (combo graph, Section 3.5), candidate set shrinks to: *execute win*, *protect win* (hold interaction), *bait then win*. Nothing else is searched — this both prunes and models real cEDH behavior.

Typical surviving candidate count: **3–12** per node.

### 3.3 Search algorithms by decision type

| Decision | Algorithm | Depth / budget |
|---|---|---|
| Priority response / stack war | Expectimax over candidate actions; opponent nodes use opponent model (not optimal play) | depth 4–6 plies, 200ms–2s by skill level |
| My main-phase sequencing | Beam search, width 8, over action sequences until "pass turn" | depth ~10 actions, 500ms–3s |
| Combat (attackers/blockers) | MCTS, 500–5000 rollouts; chance nodes for blocks | 300ms–2s |
| Mulligan | Expectimax over keep/mulligan with hand-strength evaluator (Section 7) | full 7→6→… tree, <200ms |
| Tutor target | 1-ply + evaluator: score each legal target by resulting win prob | <300ms |
| Trigger ordering / replacement ordering | 1-ply + evaluator | <100ms |

**Expectimax details.** Max nodes = my decisions (choose max). Opponent nodes = *expectation over their likely actions* using the opponent model: for each candidate opponent action, weight by `P(opponent takes it | belief)` from a cheap heuristic policy (their evaluator + their policy weights), not by minimax. This models multiplayer reality: opponents don't always punish optimally, and two opponents may both assume the other answers. Chance nodes (draws, determinized hidden cards) sample from beliefs; 4–16 samples per node, seeded.

**Beam search for sequencing.** Standard: expand each beam state with pruned candidates, keep top-8 by `evaluator + policy_bonus`, stop when all beams pass priority/turn. Handles "should I cast the tutor now or after the draw step" style sequencing.

**MCTS for combat.** cEDH combat is small (few attackers) but political (who to attack). Rollouts use fast heuristic policies; backpropagated value = my win probability from Layer 4. Opponent block choices sampled from opponent model.

### 3.4 Determinization and hidden information in search

At search root, draw K determinizations (K = 4–16 by skill level): each fills opponents' hands/libraries by sampling from `BeliefState` (hypergeometric over unknown pools, Section 5). Search runs on each determinization; final action = argmax over average value. This is **PIMC (Perfect Information Monte Carlo)** with belief-weighted sampling — the standard, honest way to search hidden-information games. Known limitation (strategy fusion) is documented; mitigations: keep K small at low skill (models human fallibility), use belief-weighted averaging not majority vote.

### 3.5 Combo graph (win detection)

The engine maintains a **combo graph**: cards → conditions → effects (e.g., "infinite mana," "draw deck," "deal damage"). The AI queries:

```rust
fn available_wins(obs, belief) -> Vec<WinLine>;
// WinLine { combo_id, pieces_have: Vec<CardName>, pieces_missing: Vec<CardName>,
//           mana_needed: ManaCost, protection_needed: bool, deterministic: bool,
//           outlet: WinOutlet, steps: Vec<ActionSketch> }
```

- `deterministic` wins (Thoracle+Consultation with empty library) are preferred; probabilistic lines (Ad Nauseam at 30 life) carry a success probability from the deck model.
- The AI only *attempts* a win when `protection_adequate OR opponents_tapped_out_likely`, where "likely" comes from belief state — this is where bluffing and reading opponents lives.
- Loop shortcuts: when a deterministic loop is available, the AI proposes the engine's "demonstrate loop" flow with iteration count = exactly what's needed (not infinite — cEDH-relevant: don't over-expose to interaction).

### 3.6 Time management

Total AI think budget is split: 60% tactical search, 25% belief updates (incremental anyway), 15% explanation generation. Hard caps per decision type (table above); exceeding the cap returns the best action found so far (anytime algorithms throughout). UI shows a thinking indicator; "pause and inspect" freezes mid-search and dumps the current beam/frontier into the explanation view.

---

## 4. Layer 4 — Strategic evaluator

### 4.1 Feature vector (all computable from `PlayerObservation` + `BeliefState`)

**Resources (me):** lands, total mana available this turn, fast mana in hand, cards in hand, life total, commander tax paid, cards in GY enabling recursion (Breach/Sevinne's), storm count.

**Board:** my creatures (power sum, evasion, combo pieces on board), my stax pieces, my card-advantage engines (Rhystic/Mystic/Esper Sentinel triggers expected), opponent stax pieces affecting me (as a vector of "taxes": Rule of Law flag, Thorn effects, etc.), opponent combo pieces on board, opponent engines.

**Threats (per opponent):** `win_next_turn_prob` (belief), combo pieces in GY (Breach fuel count), tutors cast this game, mana available (estimated), cards in hand, commander on board + damage dealt to me.

**Interaction:** my interaction in hand (by type: free/1-mana/2+-mana), known opponent interaction probs, stack depth and top-of-stack threat level.

**Position:** turn number, seat order relative to threats (who acts before me), my Ad Nauseam/Peer thresholds (life vs deck composition), monarch/initiative if relevant.

**Meta:** archetype posteriors, known decklists, format snapshot id.

Total: ~120 features. All features are logged with every AI decision (training data, Section 11).

### 4.2 Win probability estimation

**Now (heuristic):** logistic model `P(win) = σ(w·f + b)` with hand-tuned weights from cEDH expert review, plus special-case overrides:

- Deterministic win available and protection adequate → 0.85+ (never 1.0; respect interaction).
- Opponent deterministic win on stack unanswered and I have no interaction → my win prob collapses to `1 - their_win_prob`.
- Ad Nauseam/Peer lines: separate sub-model `P(fizzle)` from deck's mana curve (computed from decklist: count of CMC≥3 hits).

**Later (value network):** MLP (256-256-1) on the same feature vector, trained on self-play outcomes (Section 11). The heuristic remains as a prior/regularizer and as the fallback when the network is uncertain (out-of-distribution flag). Network outputs are calibrated by isotonic regression on a held-out set; the explanation layer reports "model confidence" from calibration bins.

**Leaf evaluation in search** = `P(win)` from this estimator, from *my* perspective, computed on the determinized leaf observation. Opponent nodes in expectimax evaluate from the acting opponent's perspective using *their* (AI-estimated) evaluator with *their* personality weights — this is what makes "passing the buck" emerge rather than being scripted.

### 4.3 Intermediate rewards (rollout shaping)

Pure win/loss is too sparse for rollouts. Rollout policy uses shaped reward: `ΔP(win) + 0.1·(cards drawn) + 0.05·(mana advantage) − 0.2·(pieces lost)` with weights an order of magnitude smaller than terminal outcomes, so shaping guides but never overrides winning.

---

## 5. Layer 5 — Opponent modeling

### 5.1 Hypergeometric hidden-card beliefs

For opponent `o`, card name `c` with `m` copies in their 99 (from known decklist; if decklist unknown, use archetype-average counts from the metagame prior):

- `seen` = copies of `c` observed anywhere public (their GY, battlefield, exile, stack).
- `m' = m − seen` remaining copies; `N' = 99 − total_seen_by_me` unknown cards; `h` = their hand size.
- `P(c in hand) = 1 − C(N'−m', h) / C(N', h)`.

Updates are O(1) per event. Joint probabilities (e.g., "has Force *or* Fierce Guardianship") use inclusion–exclusion over the top-k relevant cards, capped at pairs for speed; the UI shows these as "interaction likelihood."

**No-decklist case:** archetype posterior (5.4) gives expected copy counts: `m_effective = Σ_archetype P(arch) · avg_copies(arch, c)`. New/unknown commanders start from the global cEDH prior (Force of Will ~0.85 of blue decks, etc.), updated as cards are revealed.

### 5.2 Mana beliefs

Track lands/dorks/rocks *observed* on their battlefield (public) + fast mana possibly in hand (belief). `P(can produce ≥X of color C)` = deterministic part (board) + hypergeometric over "untapped mana sources in hand" estimated from archetype fast-mana density. Used for "can they pay for Rhystic" and "are they holding up interaction."

### 5.3 Behavioral signals ("suspicious pass" detection)

On every priority pass by opponent `o`, record: `mana_open(o)`, `stack_state`, `threat_level`. Flags:

- **SuspiciousPass:** `o` passed with ≥2 mana open including blue/white while a win attempt or must-answer threat was on the stack, and the threat resolved or was answered by someone else. → `free_interaction_prob[o] += 0.25` (decays 10%/turn). Rationale: players with nothing often tap out; passing with interaction mana up through a threat is information.
- **TappedOut:** `o` spent all mana on their turn → `win_next_turn_prob` and interaction probs drop for one round.
- **TutoredRecently:** `o` cast a tutor within last 2 turns and hasn't revealed the card → `win_next_turn_prob[o] += 0.3`, and the *type* of tutor narrows likely targets (Vampiric → combo piece; Enlightened → stax/artifact).
- **Sandbagging:** `o` has 7+ cards in hand, hasn't deployed threats for 2+ turns, holds mana up → increases both interaction and combo-readiness beliefs.
- **CantripIntoPass:** `o` cast card selection then passed with mana up → small interaction-prob bump.

Flags decay; all are shown in the UI's opponent panel as "reads" with the evidence listed (this doubles as coaching content).

### 5.4 Archetype inference

Each commander maps to a distribution over archetypes (Kinnan → {Simic combo-midrange 0.8, …}). Observations (fast mana turn 1 → turbo; turn-2 Rhystic → farm/control) update via naive Bayes over archetype-conditional card likelihoods. Archetype drives: mulligan profile selection, expected interaction density, likely win lines the AI must respect (e.g., vs Najeela, combat = danger).

### 5.5 "Who must answer?" — multiplayer incentive model

For a threat `T` on the stack, compute per player `p`: `cost_p(T resolves)` = drop in `p`'s win probability (via evaluator). The AI's decision:

1. If I have interaction and `cost_me` is highest or near-highest → I answer (no buck-passing when I'm the one who dies).
2. Else, estimate `P(someone else answers) = 1 − Π_p (1 − P(p has interaction) · P(p willing))`, where `P(willing)` rises with `cost_p`. If this exceeds threshold (0.55 default, personality-adjusted) → pass priority, but *with a stop*: if priority comes back and T is still resolving, re-evaluate (never blindly let it resolve — recheck each pass).
3. Explicitly avoid kingmaking: never pass in a way that hands the win to a specific player when an alternative (answering) keeps the game going, unless answering is futile (their win prob → 0 regardless).

This is computed, not scripted — it naturally produces "interaction chicken" and correct buck-passing.

---

## 6. Layer 6 — cEDH policy

Policy is a set of **adjustments applied to search results**, not a replacement for search. Each rule has: trigger condition (on observation+belief), effect (bonus/penalty to action values, or candidate filter), and a weight modulated by personality (Section 8).

**P1. Don't waste interaction.** Penalty to countering/removing a threat when `P(someone else answers) > 0.55` (from 5.5) unless I'm the most threatened. Bonus to *holding* interaction when my win is 1–2 turns away.

**P2. Interaction triage.** Rank threats: (a) deterministic win attempts, (b) tutors (counter the tutor, not the payoff — cheaper and hits the enabler), (c) card-advantage engines *only if* they'll draw ≥3 cards before removal is likely, (d) stax pieces that stop *my* plan, (e) everything else. Never spend premium interaction (Force of Will) on (c)–(e).

**P3. Rhystic Study heuristic.** When opponent's Rhystic triggers on my spell: pay {1} if `spell_is_win_attempt` OR (`my_mana_spare ≥ 1` AND `game_expected_length > 4 turns` AND `opponent_hand < 5`); otherwise don't pay (tempo > their card). Mirror: as Rhystic controller, note who pays — payers are mana-rich or desperate, both informative.

**P4. Mystic Remora heuristic ("feed the fish?").** Pay cumulative upkeep while `expected_draws_before_death ≥ 2` and I can pay without missing my curve; stop paying the turn I plan to win (don't give opponents cards during my combo turn — the classic punt). As an opponent: don't cast noncritical noncreature spells into an active Remora; *do* force the Remora controller to have it when you're going for the win if they can't afford to keep paying.

**P5. Tutor danger.** Opponent tutor resolving → treat as `win_next_turn_prob += 0.3` and hold up interaction; *my* tutor target selection prefers the piece that wins through the most likely interaction (from beliefs), not just the fastest win.

**P6. Stax navigation.** If a stax piece blocks my primary line, value "remove stax then win next turn" over "force through now" unless the table is about to win. Value *keeping* opponent stax that hurts the archenemy more than me.

**P7. Combo windows.** Attempt win only if `protection_ok OR all_opponents_tapped_or_unlikely`. "Unlikely" = `Π_p (1 − free_interaction_prob[p]) > 0.6`. Prefer winning on turns where you untap with priority (sorcery-speed windows are safer than mid-stack chaos).

**P8. Combat politics.** Attack the player with highest `win_next_turn_prob`, not lowest life — but avoid attacking into obvious blocks that lose your commander for free. With Najeela-type commanders at the table, treat "move to combat" as a win attempt.

**P9. Resource denial awareness.** Track opponent GY for Breach lines (fuel count = cards in GY); treat "Breach + LED + wheel in GY" as an active win threat. Track Dockside counts (artifacts+enchantments opponents control) — high counts mean hold interaction for the payoff, not the Dockside.

**P10. When NOT to interact.** Explicit: don't counter card draw that's replacing itself early unless it's the *engine* (Necropotence/Ad Nauseam resolving = answer); don't remove a stax piece that's locking the turbo player while you're midrange; don't fight over a counterspell war you can't win — let it resolve and answer the *result*.

**P11. Bluffing (advanced personalities only).** Occasionally representing interaction: attack/act as if holding up countermagic with mana open and a confident line, when `free_interaction_prob` opponents hold is low. Never "bluff" by making illegal or nonsensical plays; bluff = line selection among reasonable lines, weighted by opponent beliefs.

**P12. Communication.** AI chat limited to templates grounded in public info + own intentions: "Can anyone stop the Oracle?", "I can answer the Breach, not the tutor", "If Drannith dies I can win." Never reveals hand contents unless the AI *chooses* to as a political act (logged as a decision).

---

## 7. Mulligan module

Mulligan = expectimax over keep/mulligan-down decisions, scored by a **hand evaluator**:

```
hand_score = w1·mana_sources(weighted by color correctness for commander's identity)
           + w2·fast_mana_count
           + w3·interaction_count(weighted: free > 1-mana > 2-mana)
           + w4·card_advantage_engines
           + w5·tutor_access
           + w6·win_condition_proximity (combo pieces / enablers in hand)
           + w7·commander_castable_by_turn_X
           − w8·color_screw_risk − w9·stax_antisynergy
```

- **Deck-specific profiles** adjust weights: Kinnan (mulligans aggressively for dork + land + interaction, keeps 2-landers with Crypt), Rog/Si (keeps any hand with fast mana + tutor or Ad Naus enabler), stax decks (keep Mox + stax piece + land). Profiles ship as data (per-commander YAML), defaulting to the general evaluator.
- **Seat/opponent adjustment:** on the draw vs turbo commanders, upweight interaction; in seat 4 vs 3 fast decks, mulligan harder for Force effects.
- **London mulligan** modeled exactly: each mulligan −1 card then put back `mulligans_taken` cards on the bottom; the search evaluates keep vs "mulligan to N−1 with bottoming choice" (bottoming = 1-ply choice of worst cards by evaluator).
- Threshold: keep if `hand_score ≥ keep_threshold(mulligans_taken, seat, matchup)`; threshold rises slightly with each mulligan (diminishing returns are real).

---

## 8. Skill levels and personalities

One engine, parameterized. No separate "dumb AI" code paths — lower skill = tighter budgets + noisier evaluation + fewer candidate actions, which degrades *gracefully* like a weaker player.

| Parameter | Beginner | Intermediate | Advanced | Tournament | Solver |
|---|---|---|---|---|---|
| Search time budget | 100ms | 300ms | 800ms | 2s | 10s+ |
| Determinizations K | 2 | 4 | 8 | 12 | 24 |
| Beam width / expectimax depth | 4 / 2 | 6 / 3 | 8 / 4 | 10 / 6 | 16 / 8 |
| Eval noise σ (win prob) | 0.08 | 0.04 | 0.015 | 0.005 | 0 |
| Pruning aggressiveness | high | med-high | medium | low | minimal |
| Opponent modeling | off (uniform priors) | basic (hypergeometric only) | full − bluff | full | full |
| Policy rules active | P2,P10 | +P1,P3,P4 | +P5..P9 | all | all |
| Mulligan profile | general only | general+seat | +deck profile | +deck profile | +deck profile |

**Tendencies** (orthogonal multipliers on policy weights): Conservative (interaction hold bonus ×1.5, win-attempt threshold stricter), Aggressive (win-attempt threshold looser, combat-heavy), Greedy (card-advantage bonus ×1.4), Bluff-heavy (P11 enabled, represent-heavy lines), Interaction-heavy (P2 triage widened — answers more threats), Tempo-focused (develop-mana bonus, punishes durdling). Tendencies never license illegal/nonsensical plays — they're weight shifts inside the same search.

---

## 9. Explanation schema and worked example

Every AI action emits:

```rust
pub struct Explanation {
    pub action: ActionSummary,          // what was done, in plain language
    pub decision_type: DecisionType,    // PriorityResponse | Sequencing | Combat | Mulligan | Tutor | ...
    pub considered: Vec<ConsideredAction>, // ALL actions that survived pruning (not hundreds)
    pub beliefs_used: BeliefSnapshot,  // the exact belief numbers behind the call
    pub policy_rules_fired: Vec<PolicyId>, // e.g., P2, P5
    pub search_stats: SearchStats,     // nodes, depth, time, determinizations
    pub confidence: f32,               // calibrated: value gap between best and second-best
    pub counterfactual: Option<String>, // "If Player 3 had been tapped out, I would have..."
    pub hidden_info_audit: Vec<String>, // what the AI did NOT know (for trust)
}
pub struct ConsideredAction {
    pub description: String,
    pub estimated_win_prob: f32,   // my P(win) if I take this action
    pub delta_vs_baseline: f32,    // vs "pass / do nothing"
    pub key_reasons: Vec<String>,  // 1–3 short reasons, referencing public info only
}
```

### Worked example

*Situation: Player 1 (Blue Farm) casts Mystic Remora, turn 2. AI is Player 3 (Kinnan), holding Mental Misstep, with Mana Crypt + land in play, 2 cards in hand. Beliefs: P1 has 5 cards in hand, 2 lands + Sol Ring on board; archetype Blue Farm (fast combo-control).*

**AI action:** Cast Mental Misstep targeting Mystic Remora.

**Explanation shown in UI:**

> **Why I countered the Remora**
>
> | Considered | My est. win prob | Δ vs pass |
> |---|---|---|
> | Counter with Misstep | 24.1% | **+4.3%** ✓ chosen |
> | Let it resolve | 19.8% | baseline |
> | Hold Misstep for later | 21.5% | +1.7% |
>
> **Reasons:**
> 1. Player 1 kept 7 and deployed Sol Ring + Remora — their hand is resource-light but mana-rich; Remora likely draws 3+ cards before their next turn (P1 plays ~4 noncreature spells/turn in this archetype).
> 2. My hand has no card advantage; falling behind on cards now compounds — my win prob drops ~1.5% per card they draw (evaluator feature weight).
> 3. Mental Misstep is my *worst* interaction here (dead against most of my own win lines); spending it preserves my premium counters for Oracle/Consultation windows.
>
> **Policy rules fired:** P2 (interaction triage — engine removal worth it), P10 inverse (this engine *is* worth answering early).
>
> **Beliefs used:** P(P1 draws ≥3 off Remora) = 0.72; P(I draw into better interaction in 2 turns) = 0.31.
>
> **What I didn't know:** P1's actual hand (5 unknown cards); whether P2/P4 hold interaction for the Remora themselves (P(P2 answers) = 0.28 — below my buck-passing threshold, so I acted).
>
> **Counterfactual:** If P2 had passed with 2 blue mana open (SuspiciousPass), P(P2 answers) would rise to ~0.55 and I'd let it ride.
>
> *Search: 1,842 nodes, depth 4, 6 determinizations, 410ms. Confidence: medium (gap 2.6%).*

Note what the explanation does **not** contain: any actual hidden card, any claim about P1's hand contents, any engine-internal data. Everything is belief + public info.

---

## 10. LLM integration — augmentation points and hard boundaries

### Where LLMs help (all advisory, all validated)

1. **Strategic summarization.** "Describe the table state and each player's plan in 3 sentences" for the UI's game-overview panel and for coaching recaps. Input: observation + beliefs (never true state). Output: text only.
2. **Explanation prose.** Layer 9 produces structured data; an LLM renders it into natural coaching language and answers follow-up questions ("why not counter the tutor instead?") by re-querying the search cache — never by inventing new evaluations.
3. **Deck analysis.** From a decklist: archetype writeup, combo-package detection cross-check (verifies the combo-graph output in prose), mulligan-profile suggestion for review by a human before it becomes data.
4. **Scenario generation.** Draft Scenario Lab setups ("Stop the Oracle") from templates; every generated scenario is *validated by the engine* (setup must be a legal game state; expected solution must be a legal line) before it ships.
5. **AI table talk.** Generate phrasing for the template intents in P12. Intent selection is algorithmic; the LLM only words it.
6. **Opponent-model priors.** Suggest initial archetype/interaction priors for new commanders from metagame knowledge; stored as data, versioned, overridable.

### Hard boundaries (violations are architecture bugs)

- **Never legality.** No LLM output may create, filter, or validate a legal action. The `legal_actions` path contains zero LLM calls — enforced by module boundaries (LLM lives in `ai/advisory/`, which cannot import `engine/rules/`).
- **Never hidden state.** Advisory prompts are built from `PlayerObservation` + `BeliefState` serializers. A redaction test suite feeds known-hidden info through every prompt builder and fails if it appears.
- **Never final action selection.** The LLM may *propose* candidate lines for the search to evaluate (as an additional candidate generator at high skill levels), but the chosen action is always `argmax` of search values. If the LLM service is down, the AI plays identically minus prose.
- **Latency isolation.** All LLM calls are async and non-blocking to decisions; explanations render structured-first, prose streams in after.
- **Determinism preserved.** LLM outputs are never part of the replay event log as *decisions*; only the chosen `Action` is logged. Advisory text is cached by `(observation_hash, prompt_version)` for reproducibility.

---

## 11. Self-play and training data plan

### 11.1 Replay dataset format

Every game (self-play or human) logs:

```
GameRecord {
  header: { game_id, seed, rules_version, oracle_version, banlist_snapshot,
            ai_configs[4], decklists[4] (hashes), timestamp },
  events: [ EventLog ],        // the engine's canonical event source (Section: Replay System)
  ai_decisions: [ AIDecision ],// per AI action: observation_hash, features (Sec 4.1),
                               // candidates + values, chosen action, explanation, think_time
  outcome: { winner, win_condition, turns, per_player_stats },
  flags: [ InvalidFlag ],      // engine "cannot resolve" occurrences -> excluded from training
}
```

Storage: Parquet, partitioned by `rules_version/date`. PII: human games are opt-in for training, anonymized, with a 30-day deletion path.

### 11.2 Training targets

- **Value network:** input = feature vector (4.1) + belief snapshot; target = game outcome (win/loss from acting player's perspective) with TD(λ) bootstrapping from search values for sample efficiency. Calibration via isotonic regression on holdout.
- **Policy network (candidate ranking):** input = (observation, candidate action features); target = action chosen by Tournament+ search in self-play, filtered to decisions where search confidence was high. Used to *order* candidates and widen/narrow beams — never to bypass search.
- **Opponent model:** input = public history; targets = revealed hidden cards (from showdown-like events: Thoughtseize, Gitaxian Probe, game end reveals). Directly trains the hypergeometric priors and behavioral-flag weights.
- **Mulligan model:** input = (hand, commander, seat, opponents); target = eventual win. Trains keep/mulligan thresholds per archetype.
- **Anti-pathology measures:** population-based training (pool of past + diverse personalities, not just self-play vs latest), plus a fixed suite of "examiner" scenarios (Section 12) that must not regress. Exploitability probing: a dedicated adversarial AI tries to find lines that beat the main policy; wins against it become training data.

### 11.3 Data flywheel

1. Ship with heuristic evaluator + scripted examiner suite.
2. Self-play at scale (target: 1M games/month on the worker pool) → train value/policy v1.
3. v1 plays in the pool; humans opt into "contribute anonymized games."
4. Monthly retrain; promotion only if: examiner suite ≥ current, Elo vs current ≥ +25 over 2000 games, exploitability probe doesn't find new holes.

---

## 12. Evaluation benchmarks

### 12.1 Examiner scenario suite (correctness, not vibes)

Each scenario: fixed seed, fixed setup, expected behavior class. Examples mapped to the spec's test list:

| Scenario | What it measures |
|---|---|
| Stop the Oracle (T2 Thoracle+Consult, you hold Force + Flusterstorm) | Interaction triage: counter the *Consultation*, not the Oracle |
| Rhystic on board, you're comboing off | P3: don't pay when winning; do pay when developing |
| Opponent tutors EOT, you hold 1 counterspell | P5: hold for the payoff window vs counter tutor — must reason from beliefs |
| Two opponents open with interaction mana, third attempts win | P1/5.5: buck-passing — AI should pass when someone else is more incentivized |
| Ad Nauseam at 28 life vs 12 life | Threshold sub-model: go at 28, don't at 12 (deck-dependent) |
| Breach + LED + Brain Freeze in opponent GY | P9: threat recognition from public GY info |
| Mulligan battery (1,000 scripted hands per archetype) | Keep/mulligan agreement with expert labels |
| Najeela player moves to combat with 5 warriors | P8: treat as win attempt, hold removal/interaction |
| Counter-war over Ad Nauseam, you're 4th priority | Stack-war expectimax: don't throw good interaction after bad |

Scoring: per-scenario pass/fail + action-quality score (Δ win prob of chosen vs best action, computed by Solver-level search as ground truth). Target: Tournament AI ≥90% action-quality on the suite.

### 12.2 Strength measurement

- **Internal Elo:** every AI config has a rating; self-play and human games (opt-in) update via Glicko-2. Published per (skill level, personality).
- **Rules accuracy:** % of AI decisions where the chosen action was legal on first submission (must be 100% — anything less is an engine/AI-interface bug, paged as such).
- **Win conversion:** % of games where AI had a deterministic win available and converted within 2 turns.
- **Avoided losses:** % of opponent win attempts where AI had interaction and used it at the correct window.
- **Exploitability:** adversarial AI (max-exploitation config) win rate vs the candidate; must stay <55% for promotion.
- **Human eval:** quarterly blind review — cEDH experts rate AI explanations and a sample of decisions (1–5) without knowing which skill level played.

### 12.3 Regression gates

No model/config ships if: examiner suite regresses on any scenario, rules accuracy <100%, exploitability worsens, or explanation audit (human) flags hidden-info leakage.

---

## 13. Implementation roadmap (AI track, maps to product phases 4–5)

1. **Observation + belief plumbing.** `PlayerObservation` serializer, known-info ledger, hypergeometric beliefs, event-driven updates. (No intelligence yet — random-legal-action bot behind the interface to validate plumbing.)
2. **Heuristic evaluator + 1-ply search.** Feature vector, logistic win-prob, candidate generation with pruning. Playable "Intermediate" AI.
3. **Expectimax/beam/MCTS.** Full Layer 3; determinization; combo-graph integration. "Advanced" AI.
4. **Opponent modeling + policy layer.** Behavioral flags, incentive model, P1–P12. Mulligan module. "Tournament" AI.
5. **Explanations + coaching hooks.** Explanation emission, pause-and-inspect UI data, mistake-category tagging (sequencing, threat assessment, mulligan, interaction, tutor target, mana efficiency, missed win, political error — each a detector comparing chosen action vs search-best).
6. **Advisory LLM integration.** Behind feature flags, non-blocking, all boundaries from Section 10 tested.
7. **Self-play infra + value network v1.** Worker pool, Parquet pipeline, training jobs, promotion gates.

Each step is independently shippable and the AI remains playable throughout — intelligence upgrades, never rewrites.
