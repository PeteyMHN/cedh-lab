/** Deck validation: pure, no I/O. Used by REST and tests. */
import { Registry } from '@cedh-lab/cards';
import type { DeckValidation } from '@cedh-lab/protocol';

const BASIC_LANDS = new Set(['plains', 'island', 'swamp', 'mountain', 'forest', 'wastes']);

export function validateDeck(list: string[], commander: string[] | undefined, registry: Registry): DeckValidation {
  const violations: string[] = [];
  for (const id of list) {
    if (!registry.has(id)) violations.push(`unknown card: ${id}`);
  }
  if (list.length !== 100) violations.push(`Commander decks must be exactly 100 cards (got ${list.length})`);
  const counts = new Map<string, number>();
  for (const id of list) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, n] of counts) {
    if (n > 1 && !BASIC_LANDS.has(id)) {
      try {
        violations.push(`singleton violation: ${registry.get(id).name} x${n}`);
      } catch { violations.push(`singleton violation: ${id} x${n}`); }
    }
  }
  if (commander && commander.length > 0) {
    const ci = new Set<string>();
    for (const c of commander) {
      try { registry.get(c).colorIdentity.forEach((col: string) => ci.add(col)); }
      catch { violations.push(`unknown commander: ${c}`); }
    }
    for (const id of new Set(list)) {
      try {
        const d = registry.get(id);
        for (const col of d.colorIdentity) {
          if (!ci.has(col)) { violations.push(`color identity violation: ${d.name} has ${col} outside commander's identity`); break; }
        }
      } catch { /* already reported */ }
    }
  }
  return { valid: violations.length === 0, violations };
}
