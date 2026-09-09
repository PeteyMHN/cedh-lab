/**
 * actions.ts — translate a chosen LegalAction into engine calls.
 *
 * Every engine call that can fail goes through `matchesLegal` FIRST (in the
 * driver), so by the time we get here the action was legal a moment ago.
 * All async engine calls are awaited: in the async engine a synchronous
 * throw inside an async method becomes a rejection, which an un-awaited
 * call would turn into an unhandled rejection AND let `actionTaken` run
 * before the action actually happened (this caused a real infinite
 * priority loop in testing — see driver.ts history).
 *
 * Observation-only: this module never reads private zones from the Game.
 * Targets come from the public stack/battlefield; the policy layer works
 * from Observations.
 */
import { Engine } from '../../engine/src/engine.js';
import { LegalAction } from '../../engine/src/types.js';
import { DeckModel } from './eval.js';

/** True when `want` (a policy-selected action) is still in today's legal list. */
export function matchesLegal(want: LegalAction, legal: LegalAction[]): LegalAction | undefined {
  return legal.find((a) =>
    a.kind === want.kind &&
    (want.objectId === undefined || a.objectId === want.objectId) &&
    (want.abilityIndex === undefined || a.abilityIndex === want.abilityIndex) &&
    (((want.detail ?? {}) as Record<string, unknown>).targetId === ((a.detail ?? {}) as Record<string, unknown>).targetId));
}

/**
 * Choose targets for a cast from PUBLIC information only.
 * - Counterspell: the top spell on the stack (public).
 * - Swords to Plowshares: the largest enemy creature (public battlefield).
 * - Tutors / Demonic Consultation: name the card the deck model wants.
 */
export function targetsForCast(
  engine: Engine, seat: number, handObjectId: string, model?: DeckModel,
): string[] {
  const g = engine.game;
  const obj = g.getObject(handObjectId);
  const stack = g.turn.stack;
  switch (obj.oracleId) {
    case 'counterspell': {
      const top = stack[stack.length - 1];
      return top && top.controller !== seat ? [top.id] : [];
    }
    case 'swords-to-plowshares': {
      let best: string | null = null;
      let bestPow = -1;
      for (const [, o] of g.objects) {
        if (o.zone !== 'battlefield' || o.controller === seat) continue;
        const def = engine.cards.get(o.oracleId);
        if (!def.types.includes('creature')) continue;
        const pow = parseInt(def.power ?? '0', 10);
        if (pow > bestPow) { bestPow = pow; best = o.id; }
      }
      return best ? [best] : [];
    }
    case 'demonic-tutor':
    case 'vampiric-tutor': {
      const want = model?.comboPieces[0] ?? model?.winConditions[0];
      return []; // named via namedCard below
    }
    default:
      return [];
  }
}

/** Extra cast options (naming for tutors/Consultation) from the deck model. */
export function castExtras(
  engine: Engine, handObjectId: string, model?: DeckModel,
): { namedCard?: string } {
  const obj = engine.game.getObject(handObjectId);
  if (obj.oracleId === 'demonic-tutor' || obj.oracleId === 'vampiric-tutor') {
    const want = model?.comboPieces[0] ?? model?.winConditions[0];
    if (want) return { namedCard: want };
  }
  if (obj.oracleId === 'demonic-consultation') {
    const win = model?.winConditions[0];
    if (win && win !== obj.cardName) return { namedCard: win };
  }
  return {};
}

/**
 * Apply one legal action to the engine. All engine calls are awaited.
 *
 * NOTE on Force of Will: the engine's payCosts scripts only support paying
 * mana costs — alternate costs (pitch a blue card) are not implemented in
 * the engine. The AI therefore NEVER synthesizes an alternate-cost action:
 * Force of Will is cast only when the engine itself lists it as legally
 * castable. (A driver-level synthesis was tried and removed: without engine
 * support the cast rejects after partially applying, which is unsafe.)
 */
export async function applyLegalAction(
  engine: Engine, seat: number, action: LegalAction, model?: DeckModel,
): Promise<void> {
  switch (action.kind) {
    case 'pass':
      engine.priority.pass(seat);
      return;
    case 'cast': {
      const id = action.objectId;
      if (!id) throw new Error('cast action without objectId');
      const detail = (action.detail ?? {}) as Record<string, unknown>;
      if (detail.land === true) {
        await engine.playLand(seat, id);
        return;
      }
      const targets = targetsForCast(engine, seat, id, model);
      await engine.stack.castSpell(seat, id, { targets, ...castExtras(engine, id, model) });
      engine.priority.actionTaken(seat);
      return;
    }
    case 'activate': {
      const id = action.objectId;
      if (!id) throw new Error('activate action without objectId');
      const isMana = ((action.detail ?? {}) as Record<string, unknown>).mana === true;
      await engine.activateAbility(seat, id, action.abilityIndex ?? 0);
      // Mana abilities resolve immediately and don't use the stack (CR 605);
      // activating one is not a priority action.
      if (!isMana) engine.priority.actionTaken(seat);
      return;
    }
    default:
      throw new Error(`driver cannot apply action kind: ${action.kind}`);
  }
}
