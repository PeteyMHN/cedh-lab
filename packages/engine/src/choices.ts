/**
 * Choice-request pipeline (contract §1–2).
 *
 * Cards request decisions via `api.askChoice(init)`; the engine routes them
 * through `Engine.choicePolicy` (async). The default policy picks the first
 * legal/sensible option and never throws on a well-formed request — tests and
 * demos use it. Servers install a policy that pends on the human client and
 * complete it via `Engine.answerChoice`, which validates before resolving.
 */
import type { Color, Zone } from './types.js';
import type { Game } from './game.js';

export type ChoiceKind = 'card' | 'cards' | 'option' | 'number' | 'yesNo' | 'player' | 'color' | 'order';

export interface ChoiceOption {
  id: string;
  label: string;
  detail?: string;
  disabled?: boolean;
}

export interface ChoiceRequest {
  id: string;               // engine-assigned, deterministic
  player: number;           // who must choose
  kind: ChoiceKind;
  prompt: string;           // human-readable, includes rule citation where relevant
  options?: ChoiceOption[]; // for card/cards/option/order kinds
  min?: number; max?: number; // for cards/number kinds
  zone?: Zone;              // for card/cards: where to choose from
}

/** Everything except the engine-assigned id. */
export type ChoiceRequestInit = Omit<ChoiceRequest, 'id'>;

export type ChoiceSelection =
  | { kind: 'card'; cardId: string }
  | { kind: 'cards'; cardIds: string[] }
  | { kind: 'option'; index: number }
  | { kind: 'number'; value: number }
  | { kind: 'yesNo'; value: boolean }
  | { kind: 'player'; player: number }
  | { kind: 'color'; color: Color }
  | { kind: 'order'; order: string[] };

export type ChoicePolicy = (req: ChoiceRequest, game: Game) => Promise<ChoiceSelection>;

export class UnsupportedInteraction extends Error {
  constructor(message: string) { super(message); this.name = 'UnsupportedInteraction'; }
}

/** A request is well-formed if the engine can present it to a chooser. */
export function validateChoiceRequest(req: ChoiceRequest, playerCount: number): void {
  if (!Number.isInteger(req.player) || req.player < 0 || req.player >= playerCount) {
    throw new Error(`choice ${req.id}: invalid player ${req.player}`);
  }
  if (!req.prompt) throw new Error(`choice ${req.id}: missing prompt`);
  const needsOptions = req.kind === 'card' || req.kind === 'cards' || req.kind === 'option' || req.kind === 'color' || req.kind === 'order';
  if (needsOptions && (!req.options || req.options.length === 0)) {
    throw new Error(`choice ${req.id}: kind ${req.kind} requires options`);
  }
  if (req.kind === 'cards') {
    const min = req.min ?? 0, max = req.max ?? Number.MAX_SAFE_INTEGER;
    if (min < 0 || max < min) throw new Error(`choice ${req.id}: invalid min/max`);
  }
}

/**
 * Validate a selection against its request. Throws on anything invalid;
 * the game state is unchanged (callers validate before mutating).
 */
export function validateChoiceSelection(req: ChoiceRequest, sel: ChoiceSelection, game: Game): void {
  const bad = (why: string): never => { throw new Error(`choice ${req.id} (${req.kind}): ${why}`); };
  if (sel.kind !== req.kind) bad(`selection kind ${sel.kind} does not match request kind ${req.kind}`);
  const live = (req.options ?? []).filter((o) => !o.disabled);
  const liveIds = new Set(live.map((o) => o.id));
  switch (req.kind) {
    case 'card': {
      if (sel.kind !== 'card' || !liveIds.has(sel.cardId)) bad(`card ${sel.kind === 'card' ? sel.cardId : '?'} not a legal option`);
      break;
    }
    case 'cards': {
      if (sel.kind !== 'cards') bad('expected cards selection');
      else {
        const min = req.min ?? 0, max = req.max ?? Number.MAX_SAFE_INTEGER;
        if (sel.cardIds.length < min || sel.cardIds.length > max) bad(`need ${min}–${max} cards, got ${sel.cardIds.length}`);
        for (const id of sel.cardIds) if (!liveIds.has(id)) bad(`card ${id} not a legal option`);
        if (new Set(sel.cardIds).size !== sel.cardIds.length) bad('duplicate cards selected');
      }
      break;
    }
    case 'option': {
      if (sel.kind !== 'option') bad('expected option selection');
      else {
        const opt = (req.options ?? [])[sel.index];
        if (!opt || opt.disabled) bad(`option index ${sel.index} illegal`);
      }
      break;
    }
    case 'number': {
      if (sel.kind !== 'number' || !Number.isInteger(sel.value)) bad('expected integer number');
      else {
        const min = req.min ?? 0, max = req.max ?? Number.MAX_SAFE_INTEGER;
        if (sel.value < min || sel.value > max) bad(`number ${sel.value} outside ${min}–${max}`);
      }
      break;
    }
    case 'yesNo': {
      if (sel.kind !== 'yesNo' || typeof sel.value !== 'boolean') bad('expected yesNo boolean');
      break;
    }
    case 'player': {
      if (sel.kind !== 'player') bad('expected player selection');
      else if (!Number.isInteger(sel.player) || sel.player < 0 || sel.player >= game.players.length) bad(`invalid player ${sel.player}`);
      else if (req.options && req.options.length > 0 && !liveIds.has(String(sel.player))) bad(`player ${sel.player} not a legal option`);
      break;
    }
    case 'color': {
      if (sel.kind !== 'color' || !liveIds.has(sel.color)) bad(`color ${sel.kind === 'color' ? sel.color : '?'} not a legal option`);
      break;
    }
    case 'order': {
      if (sel.kind !== 'order') bad('expected order selection');
      else {
        const want = [...liveIds].sort().join(',');
        const got = [...new Set(sel.order)].sort().join(',');
        if (want !== got) bad(`order must be a permutation of the ${live.length} options`);
      }
      break;
    }
  }
}

/**
 * Default policy: first legal / sensible option. Never throws on a
 * well-formed request. Deterministic. Used by tests, demos, and AI fallback.
 */
export async function defaultChoicePolicy(req: ChoiceRequest, game: Game): Promise<ChoiceSelection> {
  const live = (req.options ?? []).filter((o) => !o.disabled);
  switch (req.kind) {
    case 'card':
      return { kind: 'card', cardId: live[0].id };
    case 'cards': {
      const min = req.min ?? 1, max = req.max ?? Number.MAX_SAFE_INTEGER;
      const n = Math.max(min, Math.min(max, live.length));
      return { kind: 'cards', cardIds: live.slice(0, n).map((o) => o.id) };
    }
    case 'option': {
      const idx = (req.options ?? []).findIndex((o) => !o.disabled);
      return { kind: 'option', index: Math.max(0, idx) };
    }
    case 'number':
      return { kind: 'number', value: req.min ?? 0 };
    case 'yesNo':
      return { kind: 'yesNo', value: false }; // decline by default (matches never-pay policy)
    case 'player': {
      // prefer choosing self when legal, else first legal option, else first alive player
      const selfOpt = live.find((o) => o.id === String(req.player));
      if (selfOpt) return { kind: 'player', player: req.player };
      if (live.length > 0) return { kind: 'player', player: Number(live[0].id) };
      const alive = game.alivePlayers[0] ?? 0;
      return { kind: 'player', player: alive };
    }
    case 'color':
      return { kind: 'color', color: live[0].id as Color };
    case 'order':
      return { kind: 'order', order: live.map((o) => o.id) }; // keep presented order
  }
}
