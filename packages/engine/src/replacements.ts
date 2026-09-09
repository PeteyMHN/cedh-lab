/**
 * Replacement effects (CR 614–616).
 *
 * Card scripts register replacements via `api.effects.addReplacement`.
 * `applyReplacements` collects every applicable effect for a candidate event;
 * when more than one applies, the affected player chooses the order
 * (CR 616.1) via an `order` choice. Replacements apply sequentially, each
 * seeing the event as modified by the previous ones.
 */
import type { Game } from './game.js';
import type { ScriptApi } from './scripts.js';
import type { ChoiceRequestInit } from './choices.js';

/** A not-yet-applied event that replacements may modify or replace. */
export interface GameEventCandidate {
  kind: string;
  /** player affected by the event (chooses order per CR 616.1) */
  affectedPlayer: number;
  [key: string]: unknown;
}

export interface ReplacementEffect {
  id: string;            // engine-assigned
  sourceId: string;      // permanent that generated it
  controller: number;    // controller of the source
  description: string;   // human-readable, shown in the ordering choice
  appliesTo(event: GameEventCandidate): boolean;
  replace(event: GameEventCandidate, api: ScriptApi): Promise<GameEventCandidate[]>;
}


/** Register a replacement on the game. Returns the effect id. */
export function addReplacement(
  game: Game,
  fx: Omit<ReplacementEffect, 'id' | 'sourceId' | 'controller'>,
  sourceId: string,
  controller: number,
): string {
  const id = `repl:${game.nextChoiceId()}`;
  game.replacements.push({ ...fx, id, sourceId, controller });
  game.emit('REPLACEMENT_REGISTERED', { id, source: sourceId, description: fx.description, controller });
  return id;
}

export function removeReplacement(game: Game, id: string): void {
  const i = game.replacements.findIndex((r) => r.id === id);
  if (i >= 0) {
    game.replacements.splice(i, 1);
    game.emit('REPLACEMENT_REMOVED', { id });
  }
}

export function removeBySource(game: Game, sourceId: string): void {
  for (const r of [...game.replacements]) {
    if (r.sourceId === sourceId) removeReplacement(game, r.id);
  }
}

/**
 * Apply all applicable replacements to a candidate event, in the affected
 * player's chosen order (CR 616.1). Returns the final candidate list
 * (a replacement may remove the event entirely → empty list).
 */
export async function applyReplacements(
  game: Game,
  api: ScriptApi,
  candidate: GameEventCandidate,
): Promise<GameEventCandidate[]> {
  // CR 614.5: a replacement effect applies at most once to a given event.
  // Tracked per candidate lineage (outputs inherit the applied set).
  const applied = new WeakMap<object, Set<string>>();
  const markApplied = (ev: GameEventCandidate): Set<string> => {
    let s = applied.get(ev);
    if (!s) { s = new Set(); applied.set(ev, s); }
    return s;
  };
  const sourceName = (sourceId: string): string => {
    try { return api.game.getObject(sourceId).cardName; } catch { return 'unknown'; }
  };
  let current: GameEventCandidate[] = [candidate];
  // A replacement's output can itself be replaceable; loop to a fixed point.
  let guard = 0;
  while (guard++ < 16) {
    let progressed = false;
    const next: GameEventCandidate[] = [];
    for (const ev of current) {
      const done = markApplied(ev);
      const applicable = game.replacements.filter((r) => {
        if (done.has(r.id)) return false;
        try { return r.appliesTo(ev); } catch { return false; }
      });
      if (applicable.length === 0) { next.push(ev); continue; }
      let ordered = applicable;
      if (applicable.length > 1) {
        const init: ChoiceRequestInit = {
          player: ev.affectedPlayer,
          kind: 'order',
          prompt: `Multiple replacement effects apply (CR 616.1). Choose the order they apply in:`,
          options: applicable.map((r) => ({
            id: r.id,
            label: r.description,
            detail: `from ${sourceName(r.sourceId)}`,
          })),
        };
        const sel = await api.askChoice(init);
        if (sel.kind !== 'order') throw new Error('replacement ordering: expected order selection');
        const rank = new Map(sel.order.map((id, i) => [id, i]));
        ordered = [...applicable].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
      }
      let evs = [ev];
      for (const r of ordered) {
        const out: GameEventCandidate[] = [];
        for (const e of evs) {
          const replaced = await r.replace(e, api);
          game.emit('REPLACEMENT_APPLIED', { effect: r.id, description: r.description, eventKind: e.kind });
          for (const o of replaced) {
            const s = markApplied(o);
            for (const id of markApplied(e)) s.add(id);
            s.add(r.id);
          }
          out.push(...replaced);
        }
        evs = out;
      }
      next.push(...evs);
      progressed = true;
    }
    current = next;
    if (!progressed) break;
  }
  if (guard >= 16) throw new Error('replacement loop did not converge');
  return current;
}
