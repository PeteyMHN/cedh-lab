/**
 * Tier-2A card pool: cEDH mana rocks, fast mana, and staple creatures.
 * Oracle text is authoritative; scripts implement it.
 *
 * Wiring note for the coordinator: register `resolveTier2aTrigger` alongside
 * cards.ts's `resolveTrigger` (chain: if this returns true the trigger was
 * handled), and register the Treasure token script under key 'treasure' in
 * `engine.tokenScripts` (Dockside passes `scriptKey: 'treasure'`).
 */
import type { CardDefinition, Color, GameObject, StackObject } from '../../engine/src/types.js';
import type { Game } from '../../engine/src/game.js';
import type { CardRegistryLike, CardScript, ScriptApi } from '../../engine/src/scripts.js';
import { UnsupportedInteraction } from '../../engine/src/choices.js';

const LEGAL = { commander: 'legal' as const };

function def(d: Omit<CardDefinition, 'legalities'> & { legalities?: CardDefinition['legalities'] }): CardDefinition {
  return { ...d, legalities: d.legalities ?? LEGAL };
}

/** display name for choice labels */
function dispName(api: ScriptApi, o: GameObject): string {
  if (o.isToken) return o.cardName;
  try { return api.cards.get(o.oracleId).name; } catch { return o.cardName; }
}

const tapToUntapGuard = (api: ScriptApi, player: number, objId: string) => {
  const o = api.game.getObject(objId);
  if (o.tapped) throw new Error('already tapped');
  // 302.6: summoning sickness only restricts CREATURES' {T} abilities
  const d = api.game.cardDb?.get(o.oracleId);
  if (o.summoningSick && d?.types.includes('creature')) throw new Error('summoning sickness');
  o.tapped = true;
};

function sacrifice(api: ScriptApi, src: GameObject, reason: string): void {
  api.game.moveZone(src.id, 'graveyard', src.owner);
  api.game.emit('SACRIFICED', { object: src.id, card: src.cardName, reason });
}

/** deterministic target: lowest-index alive opponent (triggers can't ask choices) */
function firstOpponent(game: Game, controller: number): number {
  const p = game.players.find((pl) => pl.index !== controller && !pl.hasLost);
  if (!p) throw new UnsupportedInteraction('no legal opponent to target');
  return p.index;
}

/** Tymna: distinct alive opponents dealt combat damage by your creatures this turn.
 *  combat.ts tracks turn.combatDamageDealtTo[attackerController][defender] = total. */
function tymnaOpponentCount(game: Game, controller: number): number {
  const row = game.turn.combatDamageDealtTo[controller] ?? {};
  let n = 0;
  for (const key of Object.keys(row)) {
    const p = Number(key);
    if (p !== controller && !game.players[p]?.hasLost) n++;
  }
  return n;
}

export const TIER2A_DEFS: CardDefinition[] = [
  // ---------------- mana / rocks / lands ----------------
  def({ oracleId: 'mana-crypt', name: 'Mana Crypt', manaCost: '{0}', cmc: 0, types: ['artifact'], subtypes: [], supertypes: [],
    colors: [], colorIdentity: [],
    oracleText: 'At the beginning of your upkeep, flip a coin. If you lose the flip, Mana Crypt deals 3 damage to you.\n{T}: Add {C}{C}.',
    keywords: [], abilities: [
      { kind: 'triggered', hook: 'ON_UPKEEP', text: 'At the beginning of your upkeep, flip a coin. If you lose the flip, Mana Crypt deals 3 damage to you.' },
      { kind: 'mana', text: '{T}: Add {C}{C}.' },
    ] }),
  def({ oracleId: 'jeweled-lotus', name: 'Jeweled Lotus', manaCost: '{0}', cmc: 0, types: ['artifact'], subtypes: [], supertypes: [],
    colors: [], colorIdentity: [],
    oracleText: '{T}, Sacrifice Jeweled Lotus: Add three mana of any one color. Spend this mana only to cast your commander.',
    keywords: [], abilities: [{ kind: 'mana', text: '{T}, Sacrifice Jeweled Lotus: Add three mana of any one color.' }] }),
  def({ oracleId: 'chrome-mox', name: 'Chrome Mox', manaCost: '{0}', cmc: 0, types: ['artifact'], subtypes: [], supertypes: [],
    colors: [], colorIdentity: [],
    oracleText: 'Imprint — When Chrome Mox enters the battlefield, you may exile a nonartifact, nonland card from your hand.\n{T}: Add one mana of any of the exiled card\'s colors.',
    keywords: [], abilities: [{ kind: 'mana', text: '{T}: Add one mana of any of the exiled card\'s colors.' }] }),
  def({ oracleId: 'mox-diamond', name: 'Mox Diamond', manaCost: '{0}', cmc: 0, types: ['artifact'], subtypes: [], supertypes: [],
    colors: [], colorIdentity: [],
    oracleText: 'If Mox Diamond would enter the battlefield, you may discard a land card instead. If you do, put Mox Diamond onto the battlefield. If you don\'t, put it into its owner\'s graveyard.\n{T}: Add one mana of any color.',
    keywords: [], abilities: [{ kind: 'mana', text: '{T}: Add one mana of any color.' }] }),
  def({ oracleId: 'mana-vault', name: 'Mana Vault', manaCost: '{1}', cmc: 1, types: ['artifact'], subtypes: [], supertypes: [],
    colors: [], colorIdentity: [],
    oracleText: 'Mana Vault doesn\'t untap during your untap step.\nAt the beginning of your upkeep, you may pay {4}. If you do, untap Mana Vault.\nOtherwise, Mana Vault deals 1 damage to you.\n{T}: Add {C}{C}{C}.',
    keywords: [], abilities: [
      { kind: 'triggered', hook: 'ON_UPKEEP', text: 'At the beginning of your upkeep, you may pay {4}. If you do, untap Mana Vault. Otherwise, Mana Vault deals 1 damage to you.' },
      { kind: 'mana', text: '{T}: Add {C}{C}{C}.' },
    ] }),
  def({ oracleId: 'grim-monolith', name: 'Grim Monolith', manaCost: '{2}', cmc: 2, types: ['artifact'], subtypes: [], supertypes: [],
    colors: [], colorIdentity: [],
    oracleText: 'Grim Monolith doesn\'t untap during your untap step.\n{T}: Add {C}{C}{C}.\n{4}: Untap Grim Monolith.',
    keywords: [], abilities: [
      { kind: 'mana', text: '{T}: Add {C}{C}{C}.' },
      { kind: 'activated', text: '{4}: Untap Grim Monolith.' },
    ] }),
  def({ oracleId: 'lotus-petal', name: 'Lotus Petal', manaCost: '{0}', cmc: 0, types: ['artifact'], subtypes: [], supertypes: [],
    colors: [], colorIdentity: [],
    oracleText: '{T}, Sacrifice Lotus Petal: Add one mana of any color.',
    keywords: [], abilities: [{ kind: 'mana', text: '{T}, Sacrifice Lotus Petal: Add one mana of any color.' }] }),
  def({ oracleId: 'mountain', name: 'Mountain', cmc: 0, types: ['land'], subtypes: ['Mountain'], supertypes: ['basic'],
    colors: [], colorIdentity: ['R'],
    oracleText: '({T}: Add {R}.)',
    keywords: [], abilities: [{ kind: 'mana', text: '{T}: Add {R}.' }] }),
  // ---------------- creatures ----------------
  def({ oracleId: 'dockside-extortionist', name: 'Dockside Extortionist', manaCost: '{1}{R}', cmc: 2,
    types: ['creature'], subtypes: ['Goblin', 'Pirate'], supertypes: [], colors: ['R'], colorIdentity: ['R'],
    power: '1', toughness: '2',
    oracleText: 'When Dockside Extortionist enters the battlefield, create X Treasure tokens, where X is the number of artifacts and enchantments your opponents control.',
    keywords: [], abilities: [{ kind: 'triggered', hook: 'ON_ETB', text: 'When Dockside Extortionist enters the battlefield, create X Treasure tokens...' }] }),
  def({ oracleId: 'orcish-bowmasters', name: 'Orcish Bowmasters', manaCost: '{1}{B}', cmc: 2,
    types: ['creature'], subtypes: ['Orc', 'Archer'], supertypes: [], colors: ['B'], colorIdentity: ['B'],
    power: '1', toughness: '1',
    oracleText: 'Flash\nWhen Orcish Bowmasters enters the battlefield and whenever an opponent draws a card except the first one they draw in each of their draw steps, Orcish Bowmasters deals 1 damage to target creature or player.',
    keywords: ['flash'], abilities: [
      { kind: 'triggered', hook: 'ON_ETB', text: 'When Orcish Bowmasters enters the battlefield, it deals 1 damage to target creature or player.' },
      { kind: 'triggered', hook: 'ON_DRAW', text: 'Whenever an opponent draws a card except the first one they draw in each of their draw steps, Orcish Bowmasters deals 1 damage to target creature or player.' },
    ] }),
  def({ oracleId: 'esper-sentinel', name: 'Esper Sentinel', manaCost: '{W}', cmc: 1,
    types: ['creature'], subtypes: ['Human', 'Soldier'], supertypes: [], colors: ['W'], colorIdentity: ['W'],
    power: '1', toughness: '1',
    oracleText: 'Whenever an opponent casts their first noncreature spell each turn, draw a card unless that player pays {X}, where X is Esper Sentinel\'s power.',
    keywords: [], abilities: [{ kind: 'triggered', hook: 'ON_CAST', text: 'Whenever an opponent casts their first noncreature spell each turn, draw a card unless that player pays {X}...' }] }),
  def({ oracleId: 'tymna-the-weaver', name: 'Tymna the Weaver', manaCost: '{1}{W}{B}', cmc: 3,
    types: ['creature'], subtypes: ['Human', 'Cleric'], supertypes: ['legendary'], colors: ['W', 'B'], colorIdentity: ['W', 'B'],
    power: '2', toughness: '2',
    oracleText: 'At the beginning of your postcombat main phase, you may pay X life, where X is the number of opponents who were dealt combat damage this turn by a creature you controlled. If you do, draw X cards.\nPartner (You can have two commanders if both have partner.)',
    keywords: ['partner'], abilities: [{ kind: 'triggered', hook: 'ON_POSTCOMBAT_MAIN', text: 'At the beginning of your postcombat main phase, you may pay X life...' }] }),
  def({ oracleId: 'kraum-ludevic-s-opus', name: 'Kraum, Ludevic\'s Opus', manaCost: '{3}{U}{R}', cmc: 5,
    types: ['creature'], subtypes: ['Zombie', 'Horror'], supertypes: ['legendary'], colors: ['U', 'R'], colorIdentity: ['U', 'R'],
    power: '4', toughness: '4',
    oracleText: 'Flying, haste\nWhenever you cast your second spell each turn, draw a card.\nPartner (You can have two commanders if both have partner.)',
    keywords: ['flying', 'haste', 'partner'], abilities: [{ kind: 'triggered', hook: 'ON_CAST', text: 'Whenever you cast your second spell each turn, draw a card.' }] }),
  def({ oracleId: 'thrasios-triton-hero', name: 'Thrasios, Triton Hero', manaCost: '{G}{U}', cmc: 2,
    types: ['creature'], subtypes: ['Merfolk', 'Wizard'], supertypes: ['legendary'], colors: ['G', 'U'], colorIdentity: ['G', 'U'],
    power: '1', toughness: '3',
    oracleText: '{4}: Scry 1, then reveal the top card of your library. If it\'s a land card, put it onto the battlefield tapped. Otherwise, draw a card.\nPartner (You can have two commanders if both have partner.)',
    keywords: ['partner'], abilities: [{ kind: 'activated', text: '{4}: Scry 1, then reveal the top card of your library...' }] }),
  def({ oracleId: 'rograkh-son-of-rohgahh', name: 'Rograkh, Son of Rohgahh', manaCost: '{0}', cmc: 0,
    types: ['creature'], subtypes: ['Kobold', 'Warrior'], supertypes: ['legendary'], colors: ['R'], colorIdentity: ['R'],
    power: '0', toughness: '1',
    oracleText: 'First strike, menace, trample\nPartner (You can have two commanders if both have partner.)',
    keywords: ['first-strike', 'menace', 'trample', 'partner'], abilities: [] }),
  def({ oracleId: 'kinnan-bonder-prodigy', name: 'Kinnan, Bonder Prodigy', manaCost: '{G}{U}', cmc: 2,
    types: ['creature'], subtypes: ['Human', 'Druid'], supertypes: ['legendary'], colors: ['G', 'U'], colorIdentity: ['G', 'U'],
    power: '2', toughness: '2',
    oracleText: 'Whenever you tap a nonland permanent for mana, add one mana of any type that permanent produced.\n{5}{G}{U}: Look at the top five cards of your library. You may put a non-Human creature card from among them onto the battlefield. Put the rest on the bottom of your library in a random order.',
    keywords: [], abilities: [
      { kind: 'triggered', hook: 'ON_MANA_TAP', text: 'Whenever you tap a nonland permanent for mana, add one mana of any type that permanent produced. (Implemented by the engine\'s maybeKinnan hook.)' },
      { kind: 'activated', text: '{5}{G}{U}: Look at the top five cards of your library...' },
    ] }),
];

/** pay a creature's cast cost from hand (commander casts are handled by commander.ts) */
function creaturePay(cost: string) {
  return (api: ScriptApi, p: number, o: GameObject) => {
    if (o.zone === 'hand') api.mana.spendParsed(p, cost);
  };
}

/** spell on the stack resolving -> enters the battlefield */
async function spellEnters(api: ScriptApi, p: number, o: GameObject, so: StackObject): Promise<void> {
  if (so.kind === 'spell') await api.engine.enterBattlefield(o.id, p);
}

const COLOR_CHOICE = (prompt: string) => ({
  player: 0, kind: 'color' as const, prompt,
  options: (['W', 'U', 'B', 'R', 'G'] as Color[]).map((c) => ({ id: c, label: c })),
});

export const TIER2A_SCRIPTS: Record<string, CardScript> = {
  // ---------------- mana / rocks / lands ----------------
  'mana-crypt': {
    abilities: [{ tapCost: true, manaAbility: true }],
    payCosts: (api, p, o) => tapToUntapGuard(api, p, o.id),
    // kind 'activated': the {T} mana ability (engine resolves mana abilities via
    // a synthetic stack object). Upkeep triggers are resolved by
    // resolveTier2aTrigger, not here.
    onResolve: (api, p, o, so) => { if (so.kind === 'activated') api.mana.add(p, 'C', 2); },
    triggersFor: (api, o) => [{
      on: 'PHASE_CHANGED',
      condition: (a, obj, payload) =>
        payload.phase === 'upkeep' && payload.activePlayer === obj.controller,
      describe: () => 'Mana Crypt: upkeep coin flip (lose 3 life on loss)',
      make: (a, obj) => ({
        kind: 'triggered', cardName: obj.cardName, controller: obj.controller,
        targets: [], modes: [], detail: { manaCryptUpkeep: true },
      }),
    }],
  },
  'jeweled-lotus': {
    abilities: [{ tapCost: true, manaAbility: true }],
    payCosts: (api, p, o) => {
      tapToUntapGuard(api, p, o.id);
      sacrifice(api, o, 'Jeweled Lotus cost');
    },
    onResolve: async (api, p) => {
      const sel = await api.askChoice({ ...COLOR_CHOICE('Jeweled Lotus: add three mana of any one color (spend this mana only to cast your commander).'), player: p });
      if (sel.kind === 'color') api.mana.add(p, sel.color, 3, 'commander');
    },
  },
  'chrome-mox': {
    abilities: [{ tapCost: true, manaAbility: true }],
    payCosts: (api, p, o) => tapToUntapGuard(api, p, o.id),
    onEnterBattlefield: async (api, controller, obj) => {
      const { game } = api;
      const pl = game.players[controller];
      const candidates = pl.hand.filter((id) => {
        const d = api.cards.get(game.getObject(id).oracleId);
        return !d.types.includes('artifact') && !d.types.includes('land');
      });
      if (candidates.length === 0) {
        game.emit('IMPRINTED', { player: controller, source: obj.id, card: obj.cardName, count: 0 });
        return;
      }
      const sel = await api.askChoice({
        player: controller, kind: 'cards', min: 0, max: 1, zone: 'hand',
        prompt: 'Chrome Mox imprint: you may exile a nonartifact, nonland card from your hand.',
        options: candidates.map((id) => ({ id, label: dispName(api, game.getObject(id)) })),
      });
      if (sel.kind !== 'cards' || sel.cardIds.length === 0) {
        game.emit('IMPRINTED', { player: controller, source: obj.id, card: obj.cardName, count: 0 });
        return;
      }
      const imprintedId = sel.cardIds[0];
      game.moveZone(imprintedId, 'exile', controller);
      obj.imprinted = [imprintedId];
      game.emit('IMPRINTED', { player: controller, source: obj.id, card: obj.cardName, count: 1 });
    },
    onResolve: async (api, p, o) => {
      const { game } = api;
      const colors = [...new Set((o.imprinted ?? []).flatMap((id) => {
        try { return api.cards.get(game.getObject(id).oracleId).colors; } catch { return []; }
      }))];
      if (colors.length === 0) {
        game.emit('CHROME_MOX_EMPTY', { player: p, source: o.id, reason: 'nothing imprinted' });
        return;
      }
      const sel = await api.askChoice({
        ...COLOR_CHOICE('Chrome Mox: add one mana of any of the imprinted card\'s colors.'),
        player: p,
        options: colors.map((c) => ({ id: c, label: c })),
      });
      if (sel.kind === 'color') api.mana.add(p, sel.color, 1);
    },
  },
  'mox-diamond': {
    abilities: [{ tapCost: true, manaAbility: true }],
    payCosts: (api, p, o) => tapToUntapGuard(api, p, o.id),
    onEnterBattlefield: async (api, controller, obj) => {
      const { game } = api;
      const pl = game.players[controller];
      const lands = pl.hand.filter((id) =>
        api.cards.get(game.getObject(id).oracleId).types.includes('land'));
      if (lands.length === 0) {
        sacrifice(api, obj, 'Mox Diamond: no land card to discard');
        return;
      }
      const sel = await api.askChoice({
        player: controller, kind: 'card', zone: 'hand',
        prompt: 'Mox Diamond: discard a land card (or it is sacrificed).',
        options: lands.map((id) => ({ id, label: dispName(api, game.getObject(id)) })),
      });
      if (sel.kind !== 'card') throw new Error('Mox Diamond: expected a land choice');
      game.moveZone(sel.cardId, 'graveyard', controller);
      game.emit('DISCARDED', { player: controller, object: sel.cardId, reason: 'Mox Diamond' });
    },
    onResolve: async (api, p) => {
      const sel = await api.askChoice({ ...COLOR_CHOICE('Mox Diamond: add one mana of any color.'), player: p });
      if (sel.kind === 'color') api.mana.add(p, sel.color, 1);
    },
  },
  'mana-vault': {
    abilities: [{ tapCost: true, manaAbility: true }],
    payCosts: (api, p, o) => {
      if (o.zone === 'hand') api.mana.spendParsed(p, '{1}');
      else tapToUntapGuard(api, p, o.id);
    },
    // "Mana Vault doesn't untap during your untap step."
    onEnterBattlefield: (api, p, o) => { o.skipUntap = true; },
    onResolve: async (api, p, o, so) => {
      if (so.kind === 'spell') { await api.engine.enterBattlefield(o.id, p); return; }
      // kind 'activated': the {T} mana ability. The upkeep trigger is resolved
      // by resolveTier2aTrigger, not here.
      if (so.kind === 'activated') api.mana.add(p, 'C', 3);
    },
    triggersFor: (api, o) => [{
      on: 'PHASE_CHANGED',
      condition: (a, obj, payload) =>
        payload.phase === 'upkeep' && payload.activePlayer === obj.controller,
      describe: () => 'Mana Vault: upkeep — pay {4} to untap, else 1 damage',
      make: (a, obj) => ({
        kind: 'triggered', cardName: obj.cardName, controller: obj.controller,
        targets: [], modes: [], detail: { manaVaultUpkeep: true },
      }),
    }],
  },
  'grim-monolith': {
    abilities: [{ tapCost: true, manaAbility: true }, {}],
    payCosts: (api, p, o, opts) => {
      if (o.zone === 'hand') { api.mana.spendParsed(p, '{2}'); return; }
      // abilities[1] = "{4}: Untap Grim Monolith" (non-mana; costs paid at activation)
      if (opts.abilityIndex === 1) { api.mana.spendParsed(p, '{4}'); return; }
      tapToUntapGuard(api, p, o.id); // {T} mana ability
    },
    onResolve: async (api, p, o, so) => {
      if (so.kind === 'spell') { await api.engine.enterBattlefield(o.id, p); return; }
      if (so.abilityIndex === 1) {
        o.tapped = false;
        api.game.emit('UNTAPPED', { object: o.id, card: o.cardName, source: 'Grim Monolith' });
      } else {
        api.mana.add(p, 'C', 3);
      }
    },
  },
  'lotus-petal': {
    abilities: [{ tapCost: true, manaAbility: true }],
    payCosts: (api, p, o) => {
      tapToUntapGuard(api, p, o.id);
      sacrifice(api, o, 'Lotus Petal cost');
    },
    onResolve: async (api, p) => {
      const sel = await api.askChoice({ ...COLOR_CHOICE('Lotus Petal: add one mana of any color.'), player: p });
      if (sel.kind === 'color') api.mana.add(p, sel.color, 1);
    },
  },
  'mountain': {
    abilities: [{ tapCost: true, manaAbility: true }],
    payCosts: (api, p, o) => tapToUntapGuard(api, p, o.id),
    onResolve: (api, p) => { api.mana.add(p, 'R', 1); },
  },
  // ---------------- creatures ----------------
  'dockside-extortionist': {
    abilities: [],
    payCosts: creaturePay('{1}{R}'),
    onResolve: spellEnters,
    triggersFor: (api, o) => [{
      on: 'ETB',
      condition: (a, obj, payload) => payload.object === obj.id,
      describe: () => 'Dockside Extortionist: create Treasure tokens for opponents\' artifacts/enchantments',
      make: (a, obj) => ({
        kind: 'triggered', cardName: obj.cardName, controller: obj.controller,
        targets: [], modes: [], detail: { docksideEtb: true },
      }),
    }],
  },
  'orcish-bowmasters': {
    abilities: [],
    payCosts: creaturePay('{1}{B}'),
    onResolve: spellEnters,
    triggersFor: (api, o) => [
      {
        on: 'ETB',
        condition: (a, obj, payload) => payload.object === obj.id,
        describe: () => 'Orcish Bowmasters: ETB deals 1 damage to target opponent',
        make: (a, obj) => ({
          kind: 'triggered', cardName: obj.cardName, controller: obj.controller,
          targets: [`player:${firstOpponent(a.game, obj.controller)}`], modes: [],
          detail: { bowmastersEtb: true },
        }),
      },
      {
        on: 'DRAW',
        condition: (a, obj, payload) => {
          if (payload.player === obj.controller) return false;
          // "except the first one they draw in each of their draw steps"
          if (payload.turnDraw && (a.game.turn.drawStepDraws[payload.player as number] ?? 0) <= 1) return false;
          return true;
        },
        describe: () => 'Orcish Bowmasters: opponent drew beyond their first draw-step draw — 1 damage',
        make: (a, obj, payload) => ({
          kind: 'triggered', cardName: obj.cardName, controller: obj.controller,
          targets: [`player:${payload.player as number}`], modes: [],
          detail: { bowmastersDraw: true },
        }),
      },
    ],
  },
  'esper-sentinel': {
    abilities: [],
    payCosts: creaturePay('{W}'),
    onResolve: spellEnters,
    triggersFor: (api, o) => [{
      on: 'CAST',
      condition: (a, obj, payload) => {
        if (payload.player === obj.controller) return false;
        if (a.game.turn.sentinelTaxed[payload.player as number]) return false;
        let castObj: GameObject;
        try { castObj = a.game.getObject(payload.object as string); } catch { return false; }
        const d = a.game.cardDb?.get(castObj.oracleId);
        return !!d && !d.types.includes('creature');
      },
      describe: () => "Esper Sentinel: opponent's first noncreature spell each turn — draw unless they pay {X}",
      make: (a, obj, payload) => {
        a.game.turn.sentinelTaxed[payload.player as number] = true;
        return {
          kind: 'triggered', cardName: obj.cardName, controller: obj.controller,
          targets: [], modes: [], detail: { sentinelTax: true, caster: payload.player },
        };
      },
    }],
  },
  'tymna-the-weaver': {
    abilities: [],
    payCosts: creaturePay('{1}{W}{B}'),
    onResolve: spellEnters,
    triggersFor: (api, o) => [{
      on: 'PHASE_CHANGED',
      condition: (a, obj, payload) =>
        payload.phase === 'postcombatMain' &&
        payload.activePlayer === obj.controller &&
        tymnaOpponentCount(a.game, obj.controller) > 0,
      describe: () => 'Tymna the Weaver: postcombat main — pay X life to draw X',
      make: (a, obj) => ({
        kind: 'triggered', cardName: obj.cardName, controller: obj.controller,
        targets: [], modes: [], detail: { tymnaPhase: true },
      }),
    }],
  },
  'kraum-ludevic-s-opus': {
    abilities: [],
    payCosts: creaturePay('{3}{U}{R}'),
    onResolve: spellEnters,
    triggersFor: (api, o) => [{
      on: 'CAST',
      condition: (a, obj, payload) =>
        payload.player === obj.controller &&
        (a.game.turn.spellsCastThisTurn[obj.controller]?.length ?? 0) === 2,
      describe: () => "Kraum, Ludevic's Opus: second spell each turn — draw a card",
      make: (a, obj) => ({
        kind: 'triggered', cardName: obj.cardName, controller: obj.controller,
        targets: [], modes: [], detail: { kraumSecond: true },
      }),
    }],
  },
  'thrasios-triton-hero': {
    abilities: [{}],
    payCosts: (api, p, o, opts) => {
      if (o.zone === 'hand') { api.mana.spendParsed(p, '{G}{U}'); return; }
      // "{4}: Scry 1..." — activation cost paid at activation (602.2)
      api.mana.spendParsed(p, '{4}');
    },
    onResolve: async (api, p, o, so) => {
      const { game } = api;
      if (so.kind === 'spell') { await api.engine.enterBattlefield(o.id, p); return; }
      const pl = game.players[p];
      if (pl.library.length === 0) {
        game.emit('THRASIOS_SCRY', { player: p, empty: true });
        return;
      }
      const topId = pl.library[0];
      const sel = await api.askChoice({
        player: p, kind: 'option',
        prompt: `Thrasios, Triton Hero: scry 1 — ${dispName(api, game.getObject(topId))} is on top. Keep it on top or put it on the bottom?`,
        options: [{ id: 'top', label: 'Keep on top' }, { id: 'bottom', label: 'Put on bottom' }],
      });
      if (sel.kind === 'option' && sel.index === 1) {
        pl.library.shift();
        pl.library.push(topId);
        game.emit('SCRY', { player: p, toBottom: true });
      } else {
        game.emit('SCRY', { player: p, toBottom: false });
      }
      const revealId = pl.library[0];
      const revealObj = game.getObject(revealId);
      game.emit('CARD_REVEALED', { player: p, card: dispName(api, revealObj), object: revealId, source: 'Thrasios, Triton Hero' });
      if (api.cards.get(revealObj.oracleId).types.includes('land')) {
        await api.engine.enterBattlefield(revealId, p);
        game.getObject(revealId).tapped = true;
        game.emit('THRASIOS_LAND', { player: p, card: dispName(api, revealObj) });
      } else {
        game.draw(p, 1);
      }
    },
  },
  'rograkh-son-of-rohgahh': {
    abilities: [],
    payCosts: (api, p, o) => {
      if (o.zone === 'hand') api.mana.spendParsed(p, '{0}');
    },
    onResolve: spellEnters,
  },
  'kinnan-bonder-prodigy': {
    // The triggered mana ability ("whenever you tap a nonland permanent for
    // mana...") is implemented by the engine's maybeKinnan hook; no trigger
    // registration needed here.
    abilities: [{}],
    payCosts: (api, p, o) => {
      if (o.zone === 'hand') { api.mana.spendParsed(p, '{G}{U}'); return; }
      // "{5}{G}{U}: ..." — activation cost paid at activation (602.2)
      api.mana.spendParsed(p, '{5}{G}{U}');
    },
    onResolve: async (api, p, o, so) => {
      const { game } = api;
      if (so.kind === 'spell') { await api.engine.enterBattlefield(o.id, p); return; }
      const pl = game.players[p];
      const seen = pl.library.splice(0, 5);
      game.emit('KINNAN_LOOK', { player: p, count: seen.length });
      const candidates = seen.filter((id) => {
        const d = api.cards.get(game.getObject(id).oracleId);
        return d.types.includes('creature') && !d.subtypes.includes('Human');
      });
      let chosen: string | null = null;
      if (candidates.length > 0) {
        const sel = await api.askChoice({
          player: p, kind: 'cards', min: 0, max: 1, zone: 'library',
          prompt: 'Kinnan, Bonder Prodigy: you may put a non-Human creature card from among the top five onto the battlefield.',
          options: candidates.map((id) => ({ id, label: dispName(api, game.getObject(id)) })),
        });
        if (sel.kind === 'cards' && sel.cardIds.length > 0) chosen = sel.cardIds[0];
      }
      const rest = seen.filter((id) => id !== chosen);
      if (chosen) await api.engine.enterBattlefield(chosen, p);
      const shuffled = game.rng.shuffle(rest);
      pl.library.push(...shuffled);
      game.emit('KINNAN_BOTTOM', { player: p, count: shuffled.length });
    },
  },
};

/**
 * Trigger resolutions that need game decisions. Returns true if the trigger
 * was handled (coordinator: chain with cards.ts's resolveTrigger).
 */
export async function resolveTier2aTrigger(api: ScriptApi, so: StackObject): Promise<boolean> {
  const { game } = api;
  const src = game.getObject(so.sourceId);
  const detail = so.detail ?? {};
  switch (src.oracleId) {
    case 'mana-crypt': {
      if (!detail.manaCryptUpkeep) return false;
      const won = game.rng.coin();
      game.emit('MANA_CRYPT_FLIP', { player: src.controller, won, source: src.cardName });
      if (!won) game.changeLife(src.controller, -3, 'Mana Crypt');
      return true;
    }
    case 'mana-vault': {
      if (!detail.manaVaultUpkeep) return false;
      const ctrl = src.controller;
      const pays = api.engine.paymentPolicy(ctrl, 4, 'Mana Vault');
      game.emit('MANA_VAULT_UPKEEP', { player: ctrl, pays });
      if (pays) {
        try {
          api.mana.spendParsed(ctrl, '{4}');
          src.tapped = false;
          game.emit('UPKEEP_PAID', { source: src.cardName, player: ctrl });
        } catch {
          game.changeLife(ctrl, -1, 'Mana Vault');
        }
      } else {
        game.changeLife(ctrl, -1, 'Mana Vault');
      }
      return true;
    }
    case 'dockside-extortionist': {
      if (!detail.docksideEtb) return false;
      const ctrl = src.controller;
      let n = 0;
      for (const pl of game.players) {
        if (pl.index === ctrl || pl.hasLost) continue;
        for (const id of pl.battlefield) {
          const o = game.getObject(id);
          if (o.controller === ctrl) continue;
          const d = api.engine.defFor(o);
          if (d.types.includes('artifact') || d.types.includes('enchantment')) n++;
        }
      }
      game.emit('DOCKSIDE_COUNT', { player: ctrl, count: n });
      for (let i = 0; i < n; i++) {
        await api.engine.createToken(ctrl, {
          name: 'Treasure', types: ['artifact'], subtypes: ['Treasure'],
          scriptKey: 'treasure',
        });
      }
      return true;
    }
    case 'orcish-bowmasters': {
      if (!detail.bowmastersEtb && !detail.bowmastersDraw) return false;
      const target = so.targets[0];
      if (!target) { game.emit('BOWMASTERS_FIZZLE', { source: src.id }); return true; }
      const p = Number(target.split(':')[1]);
      // engine has no noncombat-damage primitive; life loss with source attribution
      game.changeLife(p, -1, 'Orcish Bowmasters');
      game.emit('BOWMASTERS_PING', { player: p, source: src.id });
      return true;
    }
    case 'esper-sentinel': {
      if (!detail.sentinelTax) return false;
      const caster = detail.caster as number;
      const x = src.power ?? 1;
      const pays = api.engine.paymentPolicy(caster, x, 'Esper Sentinel');
      game.emit('SENTINEL_TAX', { caster, pays, cost: x });
      if (!pays) game.draw(src.controller, 1);
      return true;
    }
    case 'tymna-the-weaver': {
      if (!detail.tymnaPhase) return false;
      const ctrl = src.controller;
      const x = tymnaOpponentCount(game, ctrl);
      if (x <= 0) return true;
      const sel = await api.askChoice({
        player: ctrl, kind: 'yesNo',
        prompt: `Tymna the Weaver: pay ${x} life to draw ${x} card${x === 1 ? '' : 's'}? (X = opponents dealt combat damage this turn)`,
      });
      const yes = sel.kind === 'yesNo' && sel.value;
      game.emit('TYMNA_OFFER', { player: ctrl, x, paid: yes });
      if (yes) {
        game.changeLife(ctrl, -x, 'Tymna the Weaver');
        game.draw(ctrl, x);
      }
      return true;
    }
    case 'kraum-ludevic-s-opus': {
      if (!detail.kraumSecond) return false;
      game.draw(src.controller, 1);
      game.emit('KRAUM_DRAW', { player: src.controller });
      return true;
    }
    default:
      return false;
  }
}

export class Tier2aRegistry implements CardRegistryLike {
  private defs = new Map(TIER2A_DEFS.map((d) => [d.oracleId, d]));
  get(oracleId: string): CardDefinition {
    const d = this.defs.get(oracleId);
    if (!d) throw new Error(`unknown card: ${oracleId}`);
    return d;
  }
  script(oracleId: string): CardScript {
    const s = TIER2A_SCRIPTS[oracleId];
    if (!s) throw new Error(`no script for card: ${oracleId}`);
    return s;
  }
  has(oracleId: string): boolean { return this.defs.has(oracleId); }
  all(): CardDefinition[] { return [...this.defs.values()]; }
}
