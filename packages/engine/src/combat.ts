/**
 * Combat step logic (CR 507–510).
 *
 * Operates on ScriptApi so the turn machine can invoke it without importing
 * Engine (avoids an import cycle): Engine wires
 * `turns.phaseHook = (ph) => combatPhaseHook(this.api, ph)`.
 *
 * Supported keywords: flying, reach, menace, first-strike, double-strike,
 * trample, vigilance, haste, deathtouch. Anything else combat-relevant
 * (bands, "can't be blocked except by", planeswalker defenders, etc.) is
 * NOT implemented — see the unsupported list in the module docs below.
 *
 * Unsupported (throw UnsupportedInteraction if ever needed, never fake):
 * - attacking planeswalkers/battles (no such cards in the pool yet)
 * - "can't attack / can't block" restrictions from card text
 * - banding, flanking, bushido, rampage, shadow, horsemanship, fear/intimidate
 * - damage prevention / redirection (handled by the replacements workstream)
 * - removing attackers/blockers from combat mid-step beyond zone changes
 */
import type { ScriptApi } from './scripts.js';
import type { ChoiceSelection } from './choices.js';
import type { GameObject, Phase } from './types.js';
import type { Game } from './game.js';

/** Keywords this module understands for combat. */
export const COMBAT_KEYWORDS = [
  'flying', 'reach', 'menace', 'first-strike', 'double-strike',
  'trample', 'vigilance', 'haste', 'deathtouch',
] as const;

function keywordsOf(api: ScriptApi, o: GameObject): string[] {
  return api.engine.defFor(o).keywords ?? [];
}
function isCreature(api: ScriptApi, o: GameObject): boolean {
  return api.engine.defFor(o).types.includes('creature');
}
function powerOf(o: GameObject): number { return o.power ?? 0; }
function toughnessOf(o: GameObject): number { return o.toughness ?? 0; }
/** Still a legal combatant: exists and is on the battlefield. */
function onBattlefield(g: Game, o: GameObject | undefined): o is GameObject {
  return !!o && g.objects.has(o.id) && o.zone === 'battlefield';
}
function detailLine(api: ScriptApi, o: GameObject): string {
  const def = api.engine.defFor(o);
  const kw = keywordsOf(api, o);
  return `${powerOf(o)}/${toughnessOf(o)}${def.subtypes.length ? ' ' + def.subtypes.join(' ') : ''}${kw.length ? ' — ' + kw.join(', ') : ''}`;
}

/**
 * CR 508: declare attackers. Asks the attacking player which creatures attack
 * (kind 'cards'), then a defending player per attacker (kind 'player').
 * Taps attackers unless they have vigilance. Throws on any illegal choice.
 */
export async function declareAttackers(api: ScriptApi, attacker: number): Promise<void> {
  const g = api.game;
  g.turn.attackers = [];
  const me = g.players[attacker];
  const candidates = me.battlefield
    .map((id) => g.getObject(id))
    .filter((o) =>
      o.controller === attacker &&
      isCreature(api, o) &&
      !o.tapped &&
      (!o.summoningSick || keywordsOf(api, o).includes('haste')),
    );
  const opponents = g.players
    .filter((p) => p.index !== attacker && !p.hasLost)
    .map((p) => p.index);
  if (candidates.length === 0 || opponents.length === 0) {
    g.emit('ATTACKERS_DECLARED', { player: attacker, attackers: [] });
    return;
  }
  const sel = await api.askChoice({
    player: attacker,
    kind: 'cards',
    prompt: 'Declare attackers (CR 508.1): choose which creatures attack. You may choose none.',
    options: candidates.map((o) => ({ id: o.id, label: o.cardName, detail: detailLine(api, o) })),
    min: 0,
    max: candidates.length,
    zone: 'battlefield',
  });
  if (sel.kind !== 'cards') throw new Error('declareAttackers: expected a cards selection');
  const declarations: { attacker: string; defender: number }[] = [];
  for (const id of sel.cardIds) {
    const o = g.getObject(id);
    if (!candidates.some((c) => c.id === id) || o.tapped) {
      throw new Error(`declareAttackers: ${o.cardName} cannot attack (CR 508.1)`);
    }
    const dsel = await api.askChoice({
      player: attacker,
      kind: 'player',
      prompt: `Choose the defending player for ${o.cardName} (CR 508.1c).`,
      options: opponents.map((p) => ({ id: String(p), label: g.players[p].name })),
    });
    if (dsel.kind !== 'player') throw new Error('declareAttackers: expected a player selection');
    if (!opponents.includes(dsel.player)) {
      throw new Error(`declareAttackers: player ${dsel.player} is not a legal defender`);
    }
    if (!keywordsOf(api, o).includes('vigilance')) {
      o.tapped = true;
      g.emit('TAP', { object: id, card: o.cardName, reason: 'attacking' });
    }
    declarations.push({ attacker: id, defender: dsel.player });
    g.emit('ATTACKER_DECLARED', { player: attacker, attacker: id, card: o.cardName, defender: dsel.player });
  }
  g.turn.attackers = declarations;
  g.emit('ATTACKERS_DECLARED', { player: attacker, attackers: declarations });
}

/**
 * CR 509: declare blockers. For each player being attacked, and for each
 * attacker declared against them, asks which creatures block that attacker
 * (kind 'cards'). Enforces flying/reach evasion and menace. Throws on any
 * illegal assignment.
 */
export async function declareBlockers(api: ScriptApi): Promise<void> {
  const g = api.game;
  g.turn.blockers = [];
  const defendingPlayers = [...new Set(g.turn.attackers.map((a) => a.defender))];
  const assigned = new Set<string>(); // blockers already committed this combat
  const blocks: { blocker: string; attacker: string }[] = [];
  for (const dp of defendingPlayers) {
    const pl = g.players[dp];
    if (pl.hasLost) continue;
    for (const decl of g.turn.attackers.filter((a) => a.defender === dp)) {
      const atk = g.objects.get(decl.attacker);
      if (!onBattlefield(g, atk) || !isCreature(api, atk)) continue; // attacker left; nothing to block
      const atkKw = keywordsOf(api, atk);
      const canBlock = (o: GameObject): boolean => {
        if (o.controller !== dp || o.tapped || assigned.has(o.id)) return false;
        if (!isCreature(api, o)) return false;
        const kw = keywordsOf(api, o);
        // CR 702.9b: flying can only be blocked by flying or reach
        if (atkKw.includes('flying') && !(kw.includes('flying') || kw.includes('reach'))) return false;
        return true;
      };
      const options = pl.battlefield
        .map((id) => g.getObject(id))
        .filter(canBlock);
      if (options.length === 0) continue;
      const sel = await api.askChoice({
        player: dp,
        kind: 'cards',
        prompt: `Declare blockers for ${atk.cardName} (CR 509.1): choose creatures blocking it. You may choose none.`,
        options: options.map((o) => ({ id: o.id, label: o.cardName, detail: detailLine(api, o) })),
        min: 0,
        max: options.length,
        zone: 'battlefield',
      });
      if (sel.kind !== 'cards') throw new Error('declareBlockers: expected a cards selection');
      for (const id of sel.cardIds) {
        const b = g.getObject(id);
        if (!canBlock(b)) {
          throw new Error(`declareBlockers: ${b.cardName} cannot block ${atk.cardName} (CR 509.1)`);
        }
        assigned.add(id);
      }
      // CR 702.111b: menace — can't be blocked except by two or more creatures
      if (atkKw.includes('menace') && sel.cardIds.length === 1) {
        throw new Error(`declareBlockers: ${atk.cardName} has menace and cannot be blocked by a single creature (CR 702.111b)`);
      }
      for (const id of sel.cardIds) {
        blocks.push({ blocker: id, attacker: decl.attacker });
        g.emit('BLOCKER_DECLARED', { player: dp, blocker: id, card: g.getObject(id).cardName, attacker: decl.attacker });
      }
    }
  }
  g.turn.blockers = blocks;
  g.emit('BLOCKERS_DECLARED', { blockers: blocks });
}

/**
 * CR 510: combat damage. One call = one damage step.
 * firstStrikeStep=true: only first-strike/double-strike creatures deal damage.
 * firstStrikeStep=false: everything except first-strike-only creatures deals
 * (double-strike deals in both steps).
 *
 * Per attacker: blocked → order blockers (kind 'order' when >1 alive), assign
 * lethal to each in order (1 suffices with deathtouch), excess tramples to the
 * defending player; unblocked → all damage to the defending player. Blockers
 * assign their damage back to the attacker. Commander damage is tracked via
 * game.dealCommanderDamage. Emits COMBAT_DAMAGE per damage event:
 * {attacker, target, amount, toPlayer?, commander?}. Runs SBAs afterwards.
 */
export async function dealCombatDamage(api: ScriptApi, firstStrikeStep: boolean): Promise<void> {
  const g = api.game;

  for (const decl of g.turn.attackers) {
    const atk = g.objects.get(decl.attacker);
    // Removed from combat (destroyed, bounced…) deals no damage. CR 510.4
    if (!onBattlefield(g, atk) || !isCreature(api, atk)) continue;
    const ctrl = atk.controller;
    const defender = decl.defender;
    const atkKw = keywordsOf(api, atk);
    const doubleStrike = atkKw.includes('double-strike');
    const firstStrike = atkKw.includes('first-strike');
    const attackerDeals = firstStrikeStep ? (firstStrike || doubleStrike) : (!firstStrike || doubleStrike);

    const emits: Array<{ attacker: string; target: string; amount: number; toPlayer?: number; commander?: boolean }> = [];
    const damageCreature = (sourceId: string, target: GameObject, amount: number) => {
      if (amount <= 0) return;
      target.damageMarked = (target.damageMarked ?? 0) + amount;
      emits.push({ attacker: sourceId, target: target.id, amount });
    };
    const damagePlayer = (sourceId: string, p: number, amount: number) => {
      if (amount <= 0) return;
      const isCommander = g.players[ctrl].commanderIds.includes(sourceId);
      if (isCommander) g.dealCommanderDamage(sourceId, p, amount);
      else g.changeLife(p, -amount, g.getObject(sourceId).cardName);
      // Tymna-style tracking: attacker-player -> defender-player -> total
      const row = g.turn.combatDamageDealtTo[ctrl] ?? {};
      row[p] = (row[p] ?? 0) + amount;
      g.turn.combatDamageDealtTo[ctrl] = row;
      emits.push({ attacker: sourceId, target: `player:${p}`, amount, toPlayer: p, commander: isCommander });
    };

    // Blockers declared for this attacker that are still around (CR 510.1c:
    // removed blockers don't take damage, but the attacker is still blocked).
    const wasBlocked = g.turn.blockers.some((b) => b.attacker === atk.id);
    const liveBlockers = g.turn.blockers
      .filter((b) => b.attacker === atk.id)
      .map((b) => g.objects.get(b.blocker))
      .filter((b): b is GameObject => onBattlefield(g, b) && isCreature(api, b));

    if (attackerDeals) {
      let remaining = powerOf(atk);
      if (wasBlocked) {
        let ordered = liveBlockers;
        if (liveBlockers.length > 1) {
          const sel: ChoiceSelection = await api.askChoice({
            player: ctrl,
            kind: 'order',
            prompt: `Order blockers for ${atk.cardName} (CR 510.1c). Damage is assigned in this order.`,
            options: liveBlockers.map((b) => ({ id: b.id, label: b.cardName, detail: detailLine(api, b) })),
          });
          if (sel.kind !== 'order') throw new Error('dealCombatDamage: expected an order selection');
          const byId = new Map(liveBlockers.map((b) => [b.id, b]));
          ordered = sel.order.map((id) => {
            const b = byId.get(id);
            if (!b) throw new Error('dealCombatDamage: blocker order references an unknown creature');
            return b;
          });
        }
        const deathtouch = atkKw.includes('deathtouch');
        for (const b of ordered) {
          if (remaining <= 0) break;
          // lethal = toughness − damage already marked; 1 is enough with deathtouch
          const lethal = deathtouch ? 1 : Math.max(0, toughnessOf(b) - (b.damageMarked ?? 0));
          const dealt = Math.min(remaining, lethal);
          damageCreature(atk.id, b, dealt);
          remaining -= dealt;
        }
        // CR 702.19: excess damage tramples to the defending player; otherwise it's lost
        if (remaining > 0 && atkKw.includes('trample')) damagePlayer(atk.id, defender, remaining);
      } else {
        damagePlayer(atk.id, defender, remaining);
      }
    }

    // Blockers assign their combat damage to the attacker (CR 510.1d).
    for (const b of liveBlockers) {
      const kw = keywordsOf(api, b);
      const bDouble = kw.includes('double-strike');
      const bFirst = kw.includes('first-strike');
      const blockerDeals = firstStrikeStep ? (bFirst || bDouble) : (!bFirst || bDouble);
      if (blockerDeals) damageCreature(b.id, atk, powerOf(b));
    }

    for (const e of emits) g.emit('COMBAT_DAMAGE', e as Record<string, unknown>);
  }

  await api.engine.checkSbas();
}

/**
 * Dispatch combat phases to their step logic. Wired as TurnMachine.phaseHook
 * by the Engine constructor (turns.ts must not import Engine).
 */
export async function combatPhaseHook(api: ScriptApi, ph: Phase): Promise<void> {
  switch (ph) {
    case 'declareAttackers':
      await declareAttackers(api, api.game.turn.activePlayer);
      break;
    case 'declareBlockers':
      await declareBlockers(api);
      break;
    case 'combatDamage':
      await dealCombatDamage(api, true);
      await dealCombatDamage(api, false);
      break;
    default:
      break;
  }
}
