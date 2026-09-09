/**
 * store.ts — persistence boundary.
 *
 * In-memory by default so the server runs with zero infrastructure (`npm run dev`).
 * Set CEDH_STORE=postgres / CEDH_REDIS_URL to plug in real backends later —
 * implement `Store` against those env vars without touching the driver.
 */
import { ulid } from 'ulid';

export interface SeatInfo {
  seat: number;
  name: string;
  isAI: boolean;
  token: string | null; // human seat token; null until joined
  connected: boolean;
  userId: string | null;
}

export interface PodRecord {
  id: string;
  name: string;
  status: 'lobby' | 'active' | 'finished';
  seats: SeatInfo[];
  decks: { seat: number; list: string[]; commander?: string[] }[];
  seed: number;
  winners: number[] | null;
  createdAt: number;
  // serialized event log tail for reconnect (WireEvent-ish); full log lives with the room while active
  eventCount: number;
}

export interface TokenRecord {
  token: string;
  userId: string;
  name: string;
  issuedAt: number;
}

export interface Store {
  createPod(p: Omit<PodRecord, 'id' | 'createdAt' | 'eventCount' | 'status' | 'winners'>): PodRecord;
  getPod(id: string): PodRecord | null;
  updatePod(id: string, patch: Partial<PodRecord>): PodRecord | null;
  listPods(): PodRecord[];
  issueToken(userId: string, name: string): TokenRecord;
  getToken(token: string): TokenRecord | null;
  /** Nonce dedup: returns true if this (seat,nonce) was already processed. */
  seenNonce(podId: string, seat: number, nonce: string): boolean;
  recordNonce(podId: string, seat: number, nonce: string): void;
}

export class InMemoryStore implements Store {
  private pods = new Map<string, PodRecord>();
  private tokens = new Map<string, TokenRecord>();
  private nonces = new Map<string, Set<string>>(); // `${podId}:${seat}` -> nonces

  createPod(p: Omit<PodRecord, 'id' | 'createdAt' | 'eventCount' | 'status' | 'winners'>): PodRecord {
    const rec: PodRecord = {
      ...p, id: ulid(), createdAt: Date.now(), eventCount: 0, status: 'lobby', winners: null,
    };
    this.pods.set(rec.id, rec);
    return rec;
  }
  getPod(id: string): PodRecord | null { return this.pods.get(id) ?? null; }
  updatePod(id: string, patch: Partial<PodRecord>): PodRecord | null {
    const cur = this.pods.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.pods.set(id, next);
    return next;
  }
  listPods(): PodRecord[] { return [...this.pods.values()]; }

  issueToken(userId: string, name: string): TokenRecord {
    const rec = { token: ulid(), userId, name, issuedAt: Date.now() };
    this.tokens.set(rec.token, rec);
    return rec;
  }
  getToken(token: string): TokenRecord | null { return this.tokens.get(token) ?? null; }

  seenNonce(podId: string, seat: number, nonce: string): boolean {
    return this.nonces.get(`${podId}:${seat}`)?.has(nonce) ?? false;
  }
  recordNonce(podId: string, seat: number, nonce: string): void {
    const k = `${podId}:${seat}`;
    if (!this.nonces.has(k)) this.nonces.set(k, new Set());
    this.nonces.get(k)!.add(nonce);
  }
}

/** Factory: picks backend from env. Only "memory" is implemented in this slice. */
export function createStore(): Store {
  const backend = (process.env.CEDH_STORE ?? 'memory').toLowerCase();
  if (backend !== 'memory') {
    // Plug point: return a Postgres/Redis-backed Store here.
    console.warn(`[store] CEDH_STORE=${backend} requested but not implemented in this slice; using memory`);
  }
  return new InMemoryStore();
}
