/**
 * Tier-2B card implementations: Silence, Grand Abolisher, Drannith Magistrate,
 * Cyclonic Rift, Flusterstorm, Swan Song, Opposition Agent, plus the Treasure
 * and Bird token scripts. Oracle text is authoritative; scripts implement it.
 * Mirrors cards.ts patterns (def() helper, tap guard, paymentPolicy use).
 */
import { CardDefinition, Color } from '../../engine/src/types.js';
import { CardScript, ScriptApi } from '../../engine/src/scripts.js';

const LEGAL = { commander: 'legal' as const };

function def(d: Omit<CardDefinition, 'legalities'> & { legalities?: CardDefinition['legalities'] }): CardDefinition {
  return { ...d, legalities: d.legalities ?? LEGAL };
}

export const TIER2B_DEFS: CardDefinition[] = [
  def({ oracleId: 'silence', name: 'Silence', manaCost: '{W}', cmc: 1, types: ['instant'], subtypes: [], supertypes: [],
    colors: ['W'], colorIdentity: ['W'], oracleText: "Your opponents can't cast spells this turn.", keywords: [], abilities: [] }),
  def({ oracleId: 'grand-abolisher', name: 'Grand Abolisher', manaCost: '{1}{W}', cmc: 2, types: ['creature'], subtypes: ['Human', 'Cleric'], supertypes: [],
    colors: ['W'], colorIdentity: ['W'], power: '2', toughness: '2',
    oracleText: "During your turn, your opponents can't cast spells or activate abilities of artifacts, creatures, or enchantments.",
    keywords: [], abilities: [] }),
  def({ oracleId: 'drannith-magistrate', name: 'Drannith Magistrate', manaCost: '{1}{W}', cmc: 2, types: ['creature'], subtypes: ['Human', 'Wizard'], supertypes: [],
    colors: ['W'], colorIdentity: ['W'], power: '1', toughness: '3',
    oracleText: "Your opponents can't cast spells from anywhere other than their hands.", keywords: [], abilities: [] }),
  def({ oracleId: 'cyclonic-rift', name: 'Cyclonic Rift', manaCost: '{1}{U}', cmc: 2, types: ['instant'], subtypes: [], supertypes: [],
    colors: ['U'], colorIdentity: ['U'],
    oracleText: 'Return target nonland permanent you don\'t control to its owner\'s hand.\nOverload {6}{U} (You may cast this spell for its overload cost. If you do, change "target" in its text to "each.")',
    keywords: [], abilities: [] }),
  def({ oracleId: 'flusterstorm', name: 'Flusterstorm', manaCost: '{U}', cmc: 1, types: ['instant'], subtypes: [], supertypes: [],
    colors: ['U'], colorIdentity: ['U'],
    oracleText: 'Counter target instant or sorcery spell unless its controller pays {1}.\nStorm (When you cast this spell, copy it for each spell cast before it this turn. You may choose new targets for the copies.)',
    keywords: [], abilities: [] }),
  def({ oracleId: 'swan-song', name: 'Swan Song', manaCost: '{U}', cmc: 1, types: ['instant'], subtypes: [], supertypes: [],
    colors: ['U'], colorIdentity: ['U'],
    oracleText: 'Counter target enchantment, instant, or sorcery spell. Its controller creates a 2/2 blue Bird creature token with flying.',
    keywords: [], abilities: [] }),
  def({ oracleId: 'opposition-agent', name: 'Opposition Agent', manaCost: '{2}{B}', cmc: 3, types: ['creature'], subtypes: ['Human', 'Rogue'], supertypes: [],
    colors: ['B'], colorIdentity: ['B'], power: '3', toughness: '2',
    oracleText: 'Flash\nYou control your opponents while they\'re searching their libraries.\nWhile an opponent is searching their library, they exile each card they find.',
    keywords: ['flash'], abilities: [] }),
];

/** display name for choice labels (mirrors cards.ts) */
function dispName(api: ScriptApi, o: import('../../engine/src/types.js').GameObject): string {
  if (o.isToken) return o.cardName;
  try { return api.cards.get(o.oracleId).name; } catch { return o.cardName; }
}

/** local tap guard (mirrors cards.ts tapToUntapGuard; Treasure is an artifact so no summoning-sickness check needed) */
function tapGuard(api: ScriptApi, player: number, objId: string): void {
  const o = api.game.getObject(objId);
  if (o.controller !== player) throw new Error('not your permanent');
  if (o.tapped) throw new Error('already tapped');
  o.tapped = true;
}

/** enter-the-battlefield resolution shared by the vanilla creatures */
async function etbCreature(api: ScriptApi, p: number, o: import('../../engine/src/types.js').GameObject, so: import('../../engine/src/types.js').StackObject): Promise<void> {
  if (so.kind === 'spell') await api.engine.enterBattlefield(o.id, p);
}

export const TIER2B_SCRIPTS: Record<string, CardScript> = {
  'silence': {
    abilities: [],
    payCosts: (api, p) => api.mana.spendParsed(p, '{W}'),
    onResolve: (api, p) => {
      // opponents = every player other than the controller; nothing else is stopped
      api.game.turn.cantCastSpells = api.game.players.filter((pl) => pl.index !== p).map((pl) => pl.index);
      api.game.emit('SILENCE', { player: p, locked: api.game.turn.cantCastSpells });
    },
  },
  // Grand Abolisher's lock is enforced by the engine (stack.checkCanCast /
  // stack.activateAbility); the script is vanilla ETB.
  'grand-abolisher': {
    abilities: [],
    payCosts: (api, p) => api.mana.spendParsed(p, '{1}{W}'),
    onResolve: etbCreature,
  },
  // Drannith Magistrate's lock is enforced by the engine (CommanderSystem);
  // the script is vanilla ETB.
  'drannith-magistrate': {
    abilities: [],
    payCosts: (api, p) => api.mana.spendParsed(p, '{1}{W}'),
    onResolve: etbCreature,
  },
  'cyclonic-rift': {
    abilities: [],
    payCosts: (api, p, o, opts) => {
      api.mana.spendParsed(p, opts.alternativeCost === 'overload' ? '{6}{U}' : '{1}{U}');
    },
    // normal mode: target must be a nonland permanent controlled by an opponent
    isLegalTarget: (api, controller, targetId) => {
      try {
        const t = api.game.getObject(targetId);
        if (t.controller === controller) return false;
        return !api.engine.defFor(t).types.includes('land');
      } catch { return false; }
    },
    onResolve: (api, p, src, so) => {
      const { game } = api;
      if (so.modes?.includes(1)) {
        // overload: each nonland permanent opponents control -> its owner's hand
        const ids: string[] = [];
        for (const pl of game.players) {
          if (pl.index === p) continue;
          for (const id of [...pl.battlefield]) {
            if (!api.engine.defFor(game.getObject(id)).types.includes('land')) ids.push(id);
          }
        }
        for (const id of ids) game.moveZone(id, 'hand', game.getObject(id).owner);
        game.emit('CYCLONIC_RIFT', { player: p, overload: true, bounced: ids.length });
        return;
      }
      const t = so.targets[0];
      const target = game.getObject(t);
      game.moveZone(t, 'hand', target.owner);
      game.emit('CYCLONIC_RIFT', { player: p, overload: false, target: t });
    },
  },
  'flusterstorm': {
    abilities: [],
    payCosts: (api, p) => api.mana.spendParsed(p, '{U}'),
    onResolve: async (api, p, src, so) => {
      const { game, stack } = api;
      // both the cast spell and each storm copy: counter target unless its
      // controller pays {1}
      const counterUnlessPaid = (targetId: string | undefined) => {
        if (!targetId) return;
        const t = game.turn.stack.find((s) => s.id === targetId);
        if (!t) return; // already countered / left the stack
        if (!api.engine.paymentPolicy(t.controller, 1, 'Flusterstorm')) {
          stack.counterSpell(targetId, p);
        }
      };
      if (so.kind !== 'copy') {
        // Move the resolving spell card to the graveyard BEFORE pushing storm
        // copies. Game.moveZone's stack branch removes the first stack object
        // matching by id OR sourceId, and every storm copy shares this spell's
        // sourceId — so if the card were still on the stack here, resolveTop's
        // putInGraveyard would eat the first copy. (Engine quirk; flagged in
        // the handoff report. resolveTop skips putInGraveyard once moved.)
        game.moveZone(src.id, 'graveyard', src.owner);
        // storm: copy once per spell cast this turn (including Flusterstorm itself)
        const n = stack.stormCount();
        for (let i = 0; i < n; i++) {
          const options = game.turn.stack
            .filter((s) => s.kind === 'spell' && s.id !== so.id)
            .map((s) => ({ id: s.id, label: `${s.cardName} (P${s.controller})` }));
          let targetId = so.targets[0];
          if (options.length > 0) {
            const sel = await api.askChoice({
              player: p, kind: 'card',
              prompt: `Flusterstorm storm copy ${i + 1} of ${n}: choose target spell.`,
              options,
            });
            if (sel.kind === 'card') targetId = sel.cardId;
          }
          const copy: import('../../engine/src/types.js').StackObject = {
            id: `copy:${so.id}:${i}`, kind: 'copy',
            sourceId: so.sourceId, cardName: 'Flusterstorm', controller: p,
            targets: targetId ? [targetId] : [], modes: [],
          };
          game.turn.stack.push(copy);
          game.emit('STACK_PUSH', { object: copy.id, card: copy.cardName, kind: 'copy', controller: p, targets: copy.targets });
        }
      }
      counterUnlessPaid(so.targets[0]);
    },
  },
  'swan-song': {
    abilities: [],
    payCosts: (api, p) => api.mana.spendParsed(p, '{U}'),
    onResolve: async (api, p, src, so) => {
      const targetId = so.targets[0];
      const t = api.game.turn.stack.find((s) => s.id === targetId);
      if (!t) return; // target already gone
      const tc = t.controller;
      api.stack.counterSpell(targetId, p);
      await api.engine.createToken(tc, {
        name: 'Bird', types: ['creature'], subtypes: ['Bird'],
        power: '2', toughness: '2', colors: ['U'], keywords: ['flying'],
        scriptKey: 'bird',
      });
    },
  },
  'opposition-agent': {
    abilities: [],
    payCosts: (api, p) => api.mana.spendParsed(p, '{2}{B}'),
    onResolve: etbCreature,
    // "If an opponent would search a library, instead you control that player
    // during the search and you exile each card found."
    replacementsFor: (api, obj) => [{
      appliesTo: (c) => c.kind === 'search' && c.affectedPlayer !== obj.controller,
      replace: async (event, a2) => {
        const searcher = event.player as number;
        const ctrl = obj.controller;
        const lib = a2.game.players[searcher].library;
        const sel = await a2.askChoice({
          player: ctrl, kind: 'card',
          prompt: 'Opposition Agent: choose a card to exile (you control the search).',
          zone: 'library',
          options: lib.map((id) => ({ id, label: dispName(a2, a2.game.getObject(id)) })),
        });
        if (sel.kind !== 'card') return []; // fail to find
        return [{ kind: 'search-exile', affectedPlayer: event.affectedPlayer, player: searcher, cardId: sel.cardId }];
      },
      description: 'Opposition Agent',
    }],
  },
};

/** tokenKey -> script; the app wires these into engine.tokenScripts */
export const TOKEN_SCRIPTS: Record<string, CardScript> = {
  'treasure': {
    abilities: [{ tapCost: true, manaAbility: true }],
    payCosts: (api, p, o) => tapGuard(api, p, o.id),
    onResolve: async (api, p, o) => {
      // sacrifice the treasure, then add one mana of any color
      api.game.moveZone(o.id, 'graveyard', o.owner);
      const sel = await api.askChoice({
        player: p, kind: 'color',
        prompt: 'Treasure: choose a color of mana to add.',
        options: (['W', 'U', 'B', 'R', 'G'] as Color[]).map((c) => ({ id: c, label: c })),
      });
      if (sel.kind === 'color') api.mana.add(p, sel.color, 1);
      api.game.emit('TREASURE_CRACKED', { player: p, color: sel.kind === 'color' ? sel.color : null });
    },
  },
  // 2/2 blue Bird with flying; evasion comes from the token def's keywords
  'bird': {
    abilities: [],
  },
};
