/**
 * Card database: oracle-level definitions + behavior scripts for the
 * initial cEDH-relevant card pool. Oracle text is authoritative;
 * scripts implement it. In production these sync from Scryfall (see scryfall.ts).
 */
import { CardDefinition, Color } from '../../engine/src/types.js';
import { CardRegistryLike, CardScript, ScriptApi } from '../../engine/src/scripts.js';
import type { Engine } from '../../engine/src/engine.js';
import { TIER2A_DEFS, TIER2A_SCRIPTS, resolveTier2aTrigger } from './tier2a.js';
import { TIER2B_DEFS, TIER2B_SCRIPTS, TOKEN_SCRIPTS } from './tier2b.js';

const LEGAL = { commander: 'legal' as const };

function def(d: Omit<CardDefinition, 'legalities'> & { legalities?: CardDefinition['legalities'] }): CardDefinition {
  return { ...d, legalities: d.legalities ?? LEGAL };
}

export const CARD_DEFS: CardDefinition[] = [
  def({ oracleId: 'sol-ring', name: 'Sol Ring', manaCost: '{1}', cmc: 1, types: ['artifact'], subtypes: [], supertypes: [],
    colors: [], colorIdentity: [], oracleText: '{T}: Add {C}{C}.', keywords: [], abilities: [{ kind: 'mana', text: '{T}: Add {C}{C}.' }] }),
  def({ oracleId: 'command-tower', name: 'Command Tower', cmc: 0, types: ['land'], subtypes: [], supertypes: [],
    colors: [], colorIdentity: [], oracleText: '{T}: Add one mana of any color in your commander\'s color identity.', keywords: [],
    abilities: [{ kind: 'mana', text: '{T}: Add one mana of any color.' }] }),
  def({ oracleId: 'island', name: 'Island', cmc: 0, types: ['land'], subtypes: ['Island'], supertypes: ['basic'],
    colors: [], colorIdentity: ['U'], oracleText: '({T}: Add {U}.)', keywords: [], abilities: [{ kind: 'mana', text: '{T}: Add {U}.' }] }),
  def({ oracleId: 'swamp', name: 'Swamp', cmc: 0, types: ['land'], subtypes: ['Swamp'], supertypes: ['basic'],
    colors: [], colorIdentity: ['B'], oracleText: '({T}: Add {B}.)', keywords: [], abilities: [{ kind: 'mana', text: '{T}: Add {B}.' }] }),
  def({ oracleId: 'plains', name: 'Plains', cmc: 0, types: ['land'], subtypes: ['Plains'], supertypes: ['basic'],
    colors: [], colorIdentity: ['W'], oracleText: '({T}: Add {W}.)', keywords: [], abilities: [{ kind: 'mana', text: '{T}: Add {W}.' }] }),
  def({ oracleId: 'forest', name: 'Forest', cmc: 0, types: ['land'], subtypes: ['Forest'], supertypes: ['basic'],
    colors: [], colorIdentity: ['G'], oracleText: '({T}: Add {G}.)', keywords: [], abilities: [{ kind: 'mana', text: '{T}: Add {G}.' }] }),
  def({ oracleId: 'llanowar-elves', name: 'Llanowar Elves', manaCost: '{G}', cmc: 1, types: ['creature'], subtypes: ['Elf', 'Druid'], supertypes: [],
    colors: ['G'], colorIdentity: ['G'], power: '1', toughness: '1', oracleText: '{T}: Add {G}.', keywords: [],
    abilities: [{ kind: 'mana', text: '{T}: Add {G}.' }] }),
  // ---- test dummies (engine/combat tests only; not real cEDH cards) ----
  def({ oracleId: 'test-grizzly', name: 'Test Grizzly', manaCost: '{1}{G}', cmc: 2, types: ['creature'], subtypes: ['Bear'], supertypes: [],
    colors: ['G'], colorIdentity: ['G'], power: '2', toughness: '2', oracleText: 'Vanilla 2/2.', keywords: [], abilities: [] }),
  def({ oracleId: 'test-fencer', name: 'Test Fencer', manaCost: '{1}{W}', cmc: 2, types: ['creature'], subtypes: ['Soldier'], supertypes: [],
    colors: ['W'], colorIdentity: ['W'], power: '1', toughness: '1', oracleText: 'First strike.', keywords: ['first-strike'], abilities: [] }),
  def({ oracleId: 'test-eagle', name: 'Test Eagle', manaCost: '{2}{U}', cmc: 3, types: ['creature'], subtypes: ['Bird'], supertypes: [],
    colors: ['U'], colorIdentity: ['U'], power: '2', toughness: '2', oracleText: 'Flying.', keywords: ['flying'], abilities: [] }),
  def({ oracleId: 'test-menace', name: 'Test Menace', manaCost: '{2}{B}', cmc: 3, types: ['creature'], subtypes: ['Horror'], supertypes: [],
    colors: ['B'], colorIdentity: ['B'], power: '3', toughness: '3', oracleText: 'Menace.', keywords: ['menace'], abilities: [] }),
  def({ oracleId: 'dark-ritual', name: 'Dark Ritual', manaCost: '{B}', cmc: 1, types: ['instant'], subtypes: [], supertypes: [],
    colors: ['B'], colorIdentity: ['B'], oracleText: 'Add {B}{B}{B}.', keywords: [], abilities: [] }),
  def({ oracleId: 'swords-to-plowshares', name: 'Swords to Plowshares', manaCost: '{W}', cmc: 1, types: ['instant'], subtypes: [], supertypes: [],
    colors: ['W'], colorIdentity: ['W'], oracleText: 'Exile target creature. Its controller gains life equal to its power.', keywords: [], abilities: [] }),
  def({ oracleId: 'counterspell', name: 'Counterspell', manaCost: '{U}{U}', cmc: 2, types: ['instant'], subtypes: [], supertypes: [],
    colors: ['U'], colorIdentity: ['U'], oracleText: 'Counter target spell.', keywords: [], abilities: [] }),
  def({ oracleId: 'force-of-will', name: 'Force of Will', manaCost: '{3}{U}{U}', cmc: 5, types: ['instant'], subtypes: [], supertypes: [],
    colors: ['U'], colorIdentity: ['U'],
    oracleText: 'You may pay 1 life and exile a blue card from your hand rather than pay this spell\'s mana cost. Counter target spell.',
    keywords: [], abilities: [] }),
  def({ oracleId: 'demonic-tutor', name: 'Demonic Tutor', manaCost: '{1}{B}', cmc: 2, types: ['sorcery'], subtypes: [], supertypes: [],
    colors: ['B'], colorIdentity: ['B'], oracleText: 'Search your library for a card, put that card into your hand, then shuffle.', keywords: [], abilities: [] }),
  def({ oracleId: 'vampiric-tutor', name: 'Vampiric Tutor', manaCost: '{B}', cmc: 1, types: ['instant'], subtypes: [], supertypes: [],
    colors: ['B'], colorIdentity: ['B'], oracleText: 'Search your library for a card, then shuffle and put that card on top. You lose 2 life.', keywords: [], abilities: [] }),
  def({ oracleId: 'brainstorm', name: 'Brainstorm', manaCost: '{U}', cmc: 1, types: ['instant'], subtypes: [], supertypes: [],
    colors: ['U'], colorIdentity: ['U'], oracleText: 'Draw three cards, then put two cards from your hand on top of your library in any order.', keywords: [], abilities: [] }),
  def({ oracleId: 'demonic-consultation', name: 'Demonic Consultation', manaCost: '{B}', cmc: 1, types: ['instant'], subtypes: [], supertypes: [],
    colors: ['B'], colorIdentity: ['B'], oracleText: 'Choose a card name. Exile the top six cards of your library, then reveal cards from the top until you reveal the named card, then put that card into your hand and exile all other cards revealed this way.', keywords: [], abilities: [] }),
  def({ oracleId: 'thassas-oracle', name: "Thassa's Oracle", manaCost: '{U}{U}', cmc: 2, types: ['creature'], subtypes: ['Merfolk', 'Wizard'], supertypes: [],
    colors: ['U'], colorIdentity: ['U'], power: '1', toughness: '3',
    oracleText: 'When Thassa\'s Oracle enters, look at the top X cards of your library, where X is your devotion to blue. Put up to one of them on top of your library and the rest on the bottom in a random order. If X is greater than or equal to the number of cards in your library, you win the game.',
    keywords: [], abilities: [{ kind: 'triggered', hook: 'ON_ETB', text: 'When Thassa\'s Oracle enters...' }] }),
  def({ oracleId: 'mystic-remora', name: 'Mystic Remora', manaCost: '{U}', cmc: 1, types: ['enchantment'], subtypes: [], supertypes: [],
    colors: ['U'], colorIdentity: ['U'],
    oracleText: 'Cumulative upkeep {1}. Whenever an opponent casts a noncreature spell, you may draw a card unless that player pays {4}.',
    keywords: [], abilities: [{ kind: 'triggered', hook: 'ON_CAST', text: 'Whenever an opponent casts a noncreature spell...' }] }),
  def({ oracleId: 'rhystic-study', name: 'Rhystic Study', manaCost: '{2}{U}', cmc: 3, types: ['enchantment'], subtypes: [], supertypes: [],
    colors: ['U'], colorIdentity: ['U'], oracleText: 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.',
    keywords: [], abilities: [{ kind: 'triggered', hook: 'ON_CAST', text: 'Whenever an opponent casts a spell...' }] }),
  ...TIER2A_DEFS,
  ...TIER2B_DEFS,
];

/** helper: pay a mana cost string, honoring alternativeCost for Force of Will.
 * FoW pitch is a real choice: exile a blue card from hand OTHER than itself. */
async function payCost(api: ScriptApi, player: number, objId: string, cost: string, alternativeCost?: string): Promise<void> {
  const { game, mana } = api;
  if (alternativeCost === 'force-of-will') {
    const pl = game.players[player];
    const blues = pl.hand.filter((id) =>
      id !== objId && api.cards.get(game.getObject(id).oracleId).colors.includes('U' as Color));
    if (blues.length === 0) throw new Error('FoW alt cost: no other blue card in hand (cannot pitch itself)');
    const sel = await api.askChoice({
      player, kind: 'card',
      prompt: 'Force of Will: exile a blue card from your hand to pay its alternative cost.',
      options: blues.map((id) => ({ id, label: dispName(api, game.getObject(id)) })),
    });
    if (sel.kind !== 'card') throw new Error('FoW: expected card choice');
    game.moveZone(sel.cardId, 'exile', player);
    game.changeLife(player, -1, "Force of Will");
    game.emit('ALTERNATIVE_COST', { player, card: 'Force of Will', exiled: sel.cardId });
    return;
  }
  mana.spendParsed(player, cost);
}

/** display name for choice labels (library cards still carry oracleId as cardName) */
function dispName(api: ScriptApi, o: import('../../engine/src/types.js').GameObject): string {
  if (o.isToken) return o.cardName;
  try { return api.cards.get(o.oracleId).name; } catch { return o.cardName; }
}

/** search via the engine's replacement-aware search pipeline (Opposition Agent etc.) */
async function searchLibrary(api: ScriptApi, player: number, toZone: 'hand' | 'top', prompt: string): Promise<string | null> {
  return api.engine.searchLibrary(player, toZone, { prompt });
}

const tapToUntapGuard = (api: ScriptApi, player: number, objId: string) => {
  const o = api.game.getObject(objId);
  if (o.tapped) throw new Error('already tapped');
  // 302.6: summoning sickness only restricts CREATURES' {T} abilities
  const d = api.game.cardDb?.get(o.oracleId);
  if (o.summoningSick && d?.types.includes('creature')) throw new Error('summoning sickness');
  o.tapped = true;
};

export const CARD_SCRIPTS: Record<string, CardScript> = {
  'sol-ring': {
    abilities: [{ tapCost: true, manaAbility: true }],
    payCosts: (api, p, o) => tapToUntapGuard(api, p, o.id),
    onResolve: (api, p) => { api.mana.add(p, 'C', 2); },
  },
  'command-tower': {
    abilities: [{ tapCost: true, manaAbility: true }],
    payCosts: (api, p, o) => tapToUntapGuard(api, p, o.id),
    onResolve: async (api, p) => {
      const { game } = api;
      const pl = game.players[p];
      const identities = pl.commanderIds.flatMap((cid) => {
        try { return api.cards.get(game.getObject(cid).oracleId).colorIdentity; } catch { return []; }
      });
      const colors = [...new Set(identities)] as import('../../engine/src/types.js').Color[];
      const opts = colors.length > 0 ? colors : ['W', 'U', 'B', 'R', 'G'] as import('../../engine/src/types.js').Color[];
      const sel = await api.askChoice({
        player: p, kind: 'color',
        prompt: "Command Tower: add one mana of any color in your commander's color identity.",
        options: opts.map((c) => ({ id: c, label: c })),
      });
      if (sel.kind === 'color') api.mana.add(p, sel.color, 1);
    },
  },
  'island': {
    abilities: [{ tapCost: true, manaAbility: true }],
    payCosts: (api, p, o) => tapToUntapGuard(api, p, o.id),
    onResolve: (api, p) => { api.mana.add(p, 'U', 1); },
  },
  'swamp': {
    abilities: [{ tapCost: true, manaAbility: true }],
    payCosts: (api, p, o) => tapToUntapGuard(api, p, o.id),
    onResolve: (api, p) => { api.mana.add(p, 'B', 1); },
  },
  'plains': {
    abilities: [{ tapCost: true, manaAbility: true }],
    payCosts: (api, p, o) => tapToUntapGuard(api, p, o.id),
    onResolve: (api, p) => { api.mana.add(p, 'W', 1); },
  },
  'forest': {
    abilities: [{ tapCost: true, manaAbility: true }],
    payCosts: (api, p, o) => tapToUntapGuard(api, p, o.id),
    onResolve: (api, p) => { api.mana.add(p, 'G', 1); },
  },
  // ---- test dummies ----
  'test-grizzly': {
    abilities: [],
    payCosts: (api, p) => api.mana.spendParsed(p, '{1}{G}'),
    onResolve: async (api, p, o, so) => { if (so.kind === 'spell') await api.engine.enterBattlefield(o.id, p); },
  },
  'test-fencer': {
    abilities: [],
    payCosts: (api, p) => api.mana.spendParsed(p, '{1}{W}'),
    onResolve: async (api, p, o, so) => { if (so.kind === 'spell') await api.engine.enterBattlefield(o.id, p); },
  },
  'test-eagle': {
    abilities: [],
    payCosts: (api, p) => api.mana.spendParsed(p, '{2}{U}'),
    onResolve: async (api, p, o, so) => { if (so.kind === 'spell') await api.engine.enterBattlefield(o.id, p); },
  },
  'test-menace': {
    abilities: [],
    payCosts: (api, p) => api.mana.spendParsed(p, '{2}{B}'),
    onResolve: async (api, p, o, so) => { if (so.kind === 'spell') await api.engine.enterBattlefield(o.id, p); },
  },
  'llanowar-elves': {
    abilities: [{ tapCost: true, manaAbility: true }],
    payCosts: (api, p, o, opts) => {
      if (o.zone === 'hand') api.mana.spendParsed(p, '{G}');
      else tapToUntapGuard(api, p, o.id);
    },
    onResolve: async (api, p, o, so) => {
      if (so.kind === 'activated') api.mana.add(p, 'G', 1);
      else await api.engine.enterBattlefield(o.id, p);
    },
  },
  'dark-ritual': {
    abilities: [],
    payCosts: (api, p) => api.mana.spendParsed(p, '{B}'),
    onResolve: (api, p) => { api.mana.add(p, 'B', 3); },
  },
  'swords-to-plowshares': {
    abilities: [],
    payCosts: (api, p) => api.mana.spendParsed(p, '{W}'),
    onResolve: (api, p, src, so) => {
      const t = so.targets[0];
      const target = api.game.getObject(t);
      const ctrl = target.controller;
      const power = target.power ?? 0;
      api.game.moveZone(t, 'exile', target.owner);
      api.game.changeLife(ctrl, power, 'Swords to Plowshares');
    },
  },
  'counterspell': {
    abilities: [],
    payCosts: (api, p) => api.mana.spendParsed(p, '{U}{U}'),
    onResolve: (api, p, src, so) => { api.stack.counterSpell(so.targets[0], p); },
  },
  'force-of-will': {
    abilities: [],
    payCosts: (api, p, o, opts) => payCost(api, p, o.id, '{3}{U}{U}', opts.alternativeCost),
    onResolve: (api, p, src, so) => { api.stack.counterSpell(so.targets[0], p); },
  },
  'demonic-tutor': {
    abilities: [],
    payCosts: (api, p) => api.mana.spendParsed(p, '{1}{B}'),
    onResolve: async (api, p) => {
      await searchLibrary(api, p, 'hand', 'Demonic Tutor: search your library for a card and put it into your hand.');
    },
  },
  'vampiric-tutor': {
    abilities: [],
    payCosts: (api, p) => api.mana.spendParsed(p, '{B}'),
    onResolve: async (api, p) => {
      await searchLibrary(api, p, 'top', 'Vampiric Tutor: search your library for a card and put it on top.');
      api.game.changeLife(p, -2, 'Vampiric Tutor');
    },
  },
  'demonic-consultation': {
    abilities: [],
    payCosts: (api, p) => api.mana.spendParsed(p, '{B}'),
    // exact sequencing: name -> exile top six one at a time -> hit? hand : exile all
    onResolve: async (api, p, src, so) => {
      const { game } = api;
      let named = so.namedCard;
      if (!named) {
        const names = [...new Set(api.cards.all().map((d) => d.name))].sort();
        const sel = await api.askChoice({
          player: p, kind: 'option',
          prompt: 'Demonic Consultation: name a card.',
          options: names.map((n) => ({ id: n, label: n })),
        });
        if (sel.kind !== 'option') throw new Error('consultation: expected a card name');
        named = names[sel.index];
      }
      game.emit('CARD_NAMED', { player: p, card: named, source: 'Demonic Consultation' });
      const pl = game.players[p];
      const exiled: string[] = [];
      // top of library is the front of the array (draw() uses shift())
      for (let i = 0; i < 6 && pl.library.length > 0; i++) {
        const id = pl.library.shift()!;
        const o = game.getObject(id);
        o.zone = 'exile';
        pl.exile.push(id);
        exiled.push(id);
        game.emit('EXILED', { player: p, object: id, card: dispName(api, o), reason: 'Demonic Consultation', n: i + 1 });
      }
      const hit = exiled.find((id) => dispName(api, game.getObject(id)) === named);
      if (hit) {
        pl.exile.splice(pl.exile.indexOf(hit), 1);
        pl.hand.push(hit);
        game.getObject(hit).zone = 'hand';
        game.emit('CONSULTATION_HIT', { player: p, card: named });
      } else {
        while (pl.library.length > 0) {
          const id = pl.library.shift()!;
          game.getObject(id).zone = 'exile';
          pl.exile.push(id);
        }
        game.emit('CONSULTATION_MISS', { player: p, card: named });
      }
    },
  },
  'brainstorm': {
    abilities: [],
    payCosts: (api, p) => api.mana.spendParsed(p, '{U}'),
    onResolve: (api, p) => {
      const { game } = api;
      game.draw(p, 3);
      const pl = game.players[p];
      for (let i = 0; i < 2 && pl.hand.length > 0; i++) {
        const id = pl.hand.pop()!; // simplified: bottom two drawn go back
        pl.library.unshift(id);
        game.getObject(id).zone = 'library';
      }
      game.emit('BRAINSTORM', { player: p });
    },
  },
  'thassas-oracle': {
    abilities: [],
    devotion: { U: 2 },
    payCosts: (api, p) => api.mana.spendParsed(p, '{U}{U}'),
    onResolve: async (api, p, o, so) => {
      if (so.kind === 'spell') await api.engine.enterBattlefield(o.id, p);
    },
    triggersFor: (api, o) => [{
      on: 'ETB',
      condition: (a, obj, payload) => payload.object === obj.id,
      describe: () => "Thassa's Oracle ETB: scry X, win if X >= library",
      make: (a, obj) => ({
        kind: 'triggered', cardName: obj.cardName, controller: obj.controller,
        targets: [], modes: [],
      }),
    }],
  },
  'mystic-remora': {
    abilities: [],
    payCosts: (api, p) => api.mana.spendParsed(p, '{U}'),
    onResolve: async (api, p, o, so) => { if (so.kind === 'spell') await api.engine.enterBattlefield(o.id, p); },
    triggersFor: (api, o) => [
      {
        on: 'CAST',
        condition: (a, obj, payload) => {
          if (payload.player === obj.controller) return false;
          const castObj = a.game.getObject(payload.object as string);
          const d = a.game.cardDb?.get(castObj.oracleId);
          if (!d) return false;
          return !d.types.includes('creature');
        },
        describe: () => 'Mystic Remora: opponent may pay {4}, else draw',
        make: (a, obj, payload) => ({
          kind: 'triggered', cardName: obj.cardName, controller: obj.controller,
          targets: [], modes: [], detail: { caster: payload.player },
        }),
      },
      {
        on: 'PHASE_CHANGED',
        condition: (a, obj, payload) =>
          payload.phase === 'upkeep' && payload.activePlayer === obj.controller,
        describe: () => 'Mystic Remora cumulative upkeep {1}',
        make: (a, obj) => ({
          kind: 'triggered', cardName: obj.cardName, controller: obj.controller,
          targets: [], modes: [], detail: { upkeep: true },
        }),
      },
    ],
  },
  'rhystic-study': {
    abilities: [],
    payCosts: (api, p) => api.mana.spendParsed(p, '{2}{U}'),
    onResolve: async (api, p, o, so) => { if (so.kind === 'spell') await api.engine.enterBattlefield(o.id, p); },
    triggersFor: (api, o) => [{
      on: 'CAST',
      condition: (a, obj, payload) => payload.player !== obj.controller,
      describe: () => 'Rhystic Study: opponent may pay {1}, else draw',
      make: (a, obj, payload) => ({
        kind: 'triggered', cardName: obj.cardName, controller: obj.controller,
        targets: [], modes: [], detail: { caster: payload.player },
      }),
    }],
  },
  ...TIER2A_SCRIPTS,
  ...TIER2B_SCRIPTS,
};

/**
 * Register this card pool's token scripts on an engine (Treasure, Bird, ...).
 * Apps call this once per Engine: `wireTokens(engine)`.
 */
export function wireTokens(engine: Engine): void {
  for (const [key, script] of Object.entries(TOKEN_SCRIPTS)) {
    engine.tokenScripts.set(key, script);
  }
}

/**
 * Trigger resolutions that need game decisions (pay-or-draw, upkeep).
 * Wired by the app: after resolveTop of a triggered ability, call this.
 */
export async function resolveTrigger(api: ScriptApi, so: import('../../engine/src/types.js').StackObject): Promise<void> {
  // tier-2A triggers (Esper Sentinel, Tymna, Kraum, Mana Vault upkeep, ...)
  if (await resolveTier2aTrigger(api, so)) return;
  const { game } = api;
  const src = game.getObject(so.sourceId);
  const detail = so.detail ?? {};
  if ((src.oracleId === 'mystic-remora' || src.oracleId === 'rhystic-study') && detail.caster !== undefined) {
    const cost = src.oracleId === 'mystic-remora' ? 4 : 1;
    const caster = detail.caster as number;
    const pays = api.engine.paymentPolicy(caster, cost, src.cardName);
    game.emit('FISH_TRIGGER', { source: src.cardName, caster, pays, cost });
    if (!pays) game.draw(src.controller, 1);
    return;
  }
  if (src.oracleId === 'mystic-remora' && detail.upkeep) {
    const ctrl = src.controller;
    const pays = api.engine.paymentPolicy(ctrl, 1, 'Mystic Remora upkeep');
    if (pays) {
      try { api.mana.spend(ctrl, 1, {}); game.emit('UPKEEP_PAID', { source: src.cardName, player: ctrl }); }
      catch { sacrifice(api, src); }
    } else sacrifice(api, src);
    return;
  }
  if (src.oracleId === 'thassas-oracle') {
    const ctrl = src.controller;
    const devotion = api.engine.devotion(ctrl, 'U');
    const pl = game.players[ctrl];
    const x = devotion;
    // look at top X: put up to one on top, rest on bottom (simplified: keep order)
    const seen = pl.library.splice(0, Math.min(x, pl.library.length));
    game.emit('ORACLE_SCRY', { player: ctrl, devotion: x, seen: seen.length });
    if (seen.length > 0) {
      const top = seen.shift()!;
      pl.library = [top, ...pl.library, ...seen];
    }
    if (x >= pl.library.length) {
      game.emit('ORACLE_WIN', { player: ctrl, devotion: x, library: pl.library.length });
      for (const p of game.players) if (p.index !== ctrl && !p.hasLost) game.lose(p.index, "Thassa's Oracle");
    }
  }
}

function sacrifice(api: ScriptApi, src: import('../../engine/src/types.js').GameObject): void {
  api.game.moveZone(src.id, 'graveyard', src.owner);
  api.game.emit('SACRIFICED', { object: src.id, card: src.cardName, reason: 'upkeep not paid' });
}

export class Registry implements CardRegistryLike {
  private defs = new Map(CARD_DEFS.map((d) => [d.oracleId, d]));
  get(oracleId: string): CardDefinition {
    const d = this.defs.get(oracleId);
    if (!d) throw new Error(`unknown card: ${oracleId}`);
    return d;
  }
  script(oracleId: string): CardScript {
    const s = CARD_SCRIPTS[oracleId];
    if (!s) throw new Error(`no script for card: ${oracleId}`);
    return s;
  }
  has(oracleId: string): boolean { return this.defs.has(oracleId); }
  all(): CardDefinition[] { return [...this.defs.values()]; }
}
