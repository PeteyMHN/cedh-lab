/**
 * Layer system (CR 613) — continuous effects.
 * Layers: 1 copy, 2 control, 3 text, 4 type, 5 color, 6 abilities, 7 p/t.
 * Effects carry timestamps; dependency reorders within a layer.
 * This is the framework; card scripts register LayerEffects.
 */
export interface LayerEffect {
  layer: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  sublayer?: '7a' | '7b' | '7c' | '7d';
  timestamp: number;
  sourceId: string;
  /** which objects it applies to (predicate over object id) */
  appliesTo: (objectId: string) => boolean;
  /** mutate a scratch copy of the object's characteristics */
  apply: (scratch: Record<string, unknown>) => void;
  dependsOn?: string[]; // sourceIds it depends on (dependency ordering)
}

export class LayerSystem {
  private effects: LayerEffect[] = [];
  private clock = 0;

  add(e: Omit<LayerEffect, 'timestamp'>): void {
    this.effects.push({ ...e, timestamp: ++this.clock });
  }
  removeBySource(sourceId: string): void {
    this.effects = this.effects.filter((e) => e.sourceId !== sourceId);
  }

  /** Apply all effects to produce final characteristics for one object. */
  evaluate(objectId: string, base: Record<string, unknown>): Record<string, unknown> {
    const applicable = this.effects.filter((e) => e.appliesTo(objectId));
    // order: layer, sublayer, dependency, timestamp
    const ordered = [...applicable].sort((a, b) => {
      if (a.layer !== b.layer) return a.layer - b.layer;
      const sa = a.sublayer ?? '', sb = b.sublayer ?? '';
      if (sa !== sb) return sa < sb ? -1 : 1;
      const aDepB = a.dependsOn?.includes(b.sourceId);
      const bDepA = b.dependsOn?.includes(a.sourceId);
      if (aDepB && !bDepA) return 1;
      if (bDepA && !aDepB) return -1;
      return a.timestamp - b.timestamp;
    });
    const scratch = { ...base };
    for (const e of ordered) e.apply(scratch);
    return scratch;
  }
}
