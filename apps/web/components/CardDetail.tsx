'use client';
import React, { useEffect, useState } from 'react';
import type { Observation } from '@/lib/protocol';
import { CardFrame } from './CardFrame';
import { fetchCardDef, getCachedDef } from './cardCache';
import { useSelection } from './selection';

/** Inspector drawer for the selected card: full oracle text from /api/cards, fallback to observation def. */
export const CardDetail = React.memo(function CardDetail({
  observation,
}: {
  observation: Observation;
}) {
  const { selectedId, select } = useSelection();
  const [version, setVersion] = useState(0);

  // Resolve the selected id against hand / battlefield / stack.
  let found: {
    name: string;
    controller?: number;
    tapped?: boolean;
    power?: number;
    toughness?: number;
    def?: Observation['hand'][number]['def'];
    zone: string;
  } | null = null;

  if (selectedId) {
    const hand = observation.hand.find((c) => c.id === selectedId);
    if (hand) found = { name: hand.name, def: hand.def, zone: 'hand' };
    else {
      const bf = observation.battlefield.find((p) => p.id === selectedId);
      if (bf)
        found = {
          name: bf.name,
          controller: bf.controller,
          tapped: bf.tapped,
          power: bf.power,
          toughness: bf.toughness,
          zone: 'battlefield',
        };
    }
  }

  const foundName = found?.name;

  useEffect(() => {
    if (!foundName) return;
    if (getCachedDef(foundName)) return;
    let alive = true;
    fetchCardDef(foundName).then(() => {
      if (alive) setVersion((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, [selectedId, foundName]);

  if (!found || !foundName) return null;
  void version; // re-render trigger for async def loads
  const cached = getCachedDef(foundName);
  const def = cached ?? found.def;

  const typeLine =
    cached?.typeLine ??
    (def
      ? [def.supertypes?.join(' '), def.types?.join(' '), (def.subtypes ?? []).join(' ')]
          .filter((s) => s && s.trim().length > 0)
          .join(' — ') || undefined
      : undefined);
  const text = cached?.text ?? def?.oracleText;

  return (
    <aside
      aria-label={`Card details: ${found.name}`}
      className="fixed right-0 top-0 z-40 flex h-full w-80 flex-col gap-2 overflow-y-auto border-l border-[#3a4a3f] bg-panel p-3 shadow-xl"
    >
      <div className="flex items-start justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400">Card detail</h2>
        <button
          type="button"
          onClick={() => select(null)}
          aria-label="Close card detail (Esc)"
          className="rounded border border-gray-500 px-2 py-0.5 text-xs text-gray-300"
        >
          Close ✕
        </button>
      </div>
      <div className="flex justify-center">
        <CardFrame
          name={found.name}
          manaCost={cached?.manaCost ?? def?.manaCost}
          typeLine={typeLine}
          text={text}
          power={
            cached?.power ?? def?.power ?? (found.power !== undefined ? String(found.power) : undefined)
          }
          toughness={
            cached?.toughness ?? def?.toughness ?? (found.toughness !== undefined ? String(found.toughness) : undefined)
          }
          tapped={found.tapped}
        />
      </div>
      <dl className="text-xs text-gray-300">
        <div className="flex gap-2">
          <dt className="text-gray-500">Zone</dt>
          <dd>{found.zone}</dd>
        </div>
        {found.controller !== undefined && (
          <div className="flex gap-2">
            <dt className="text-gray-500">Controller</dt>
            <dd>P{found.controller}</dd>
          </div>
        )}
        {found.tapped !== undefined && (
          <div className="flex gap-2">
            <dt className="text-gray-500">Status</dt>
            <dd>{found.tapped ? 'Tapped' : 'Untapped'}</dd>
          </div>
        )}
      </dl>
      {text ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-parchment">{text}</p>
      ) : (
        <p className="text-xs italic text-gray-500">Oracle text unavailable.</p>
      )}
    </aside>
  );
});
