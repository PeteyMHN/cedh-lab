/**
 * Deterministic seeded RNG (mulberry32). ALL game randomness flows through this.
 * Same seed + same actions => identical event log. Replays depend on it.
 */
export class Rng {
  private s: number;
  constructor(seed: number | string) {
    this.s = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  /** Fisher-Yates using this RNG. Returns a new array. */
  shuffle<T>(arr: readonly T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  coin(): boolean { return this.next() < 0.5; }
  get state(): number { return this.s; }
  set state(v: number) { this.s = v >>> 0; }
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
