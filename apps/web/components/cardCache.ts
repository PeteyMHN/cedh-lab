/** Module-level cache of card definitions fetched from the server.
 *  Falls back gracefully when the server is unreachable. */
import { SERVER_HTTP } from '@/lib/config';

export interface CardDefLite {
  oracleId?: string;
  name: string;
  manaCost?: string;
  typeLine?: string;
  types?: string[];
  supertypes?: string[];
  subtypes?: string[];
  text?: string;
  oracleText?: string;
  power?: string;
  toughness?: string;
}

const cache = new Map<string, CardDefLite | null>();
const inflight = new Map<string, Promise<CardDefLite | null>>();

function normalize(raw: unknown, name: string): CardDefLite | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const typeLine =
    typeof d.typeLine === 'string'
      ? d.typeLine
      : Array.isArray(d.types)
        ? (d.types as string[]).join(' ')
        : undefined;
  const text =
    typeof d.oracleText === 'string'
      ? d.oracleText
      : typeof d.text === 'string'
        ? d.text
        : undefined;
  return {
    oracleId: typeof d.oracleId === 'string' ? d.oracleId : undefined,
    name: typeof d.name === 'string' ? d.name : name,
    manaCost: typeof d.manaCost === 'string' ? d.manaCost : undefined,
    typeLine,
    types: Array.isArray(d.types) ? (d.types as string[]) : undefined,
    supertypes: Array.isArray(d.supertypes) ? (d.supertypes as string[]) : undefined,
    subtypes: Array.isArray(d.subtypes) ? (d.subtypes as string[]) : undefined,
    text,
    oracleText: text,
    power: typeof d.power === 'string' ? d.power : undefined,
    toughness: typeof d.toughness === 'string' ? d.toughness : undefined,
  };
}

/** Fetch a card definition by name. Resolves null on any failure; results cached. */
export function fetchCardDef(name: string): Promise<CardDefLite | null> {
  const key = name.toLowerCase();
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async () => {
    try {
      const res = await fetch(
        `${SERVER_HTTP}/api/cards?name=${encodeURIComponent(name)}`,
      );
      if (!res.ok) return null;
      const body: unknown = await res.json();
      let raw: unknown = null;
      if (Array.isArray(body)) raw = body[0] ?? null;
      else if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        if (Array.isArray(b.cards)) raw = b.cards[0] ?? null;
        else if (b.card) raw = b.card;
        else raw = b;
      }
      const def = normalize(raw, name);
      cache.set(key, def);
      return def;
    } catch {
      cache.set(key, null);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** Synchronous cache read (null = not loaded or failed). */
export function getCachedDef(name: string): CardDefLite | null {
  return cache.get(name.toLowerCase()) ?? null;
}
