'use client';
import React, { useEffect, useState } from 'react';
import type { LegalAction, Observation } from '@/lib/protocol';
import { CardFrame } from './CardFrame';
import { fetchCardDef, getCachedDef } from './cardCache';
import { useSelection, playerTargetId } from './selection';

interface BattlefieldProps {
  seat: number;
  observation: Observation;
  isYou: boolean;
  legal: LegalAction[];
}

type Permanent = Observation['battlefield'][number];

/** Load a card def once so permanents can be grouped by type; re-renders on arrival. */
function useDef(name: string) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (getCachedDef(name)) return;
    let alive = true;
    fetchCardDef(name).then(() => {
      if (alive) bump((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [name]);
  return getCachedDef(name);
}

function PermanentCard({
  p,
  isYou,
  legal,
  targeting,
  isTarget,
  onActivate,
}: {
  p: Permanent;
  isYou: boolean;
  legal: LegalAction[];
  targeting: boolean;
  isTarget: boolean;
  onActivate: (a: LegalAction) => void;
}) {
  useDef(p.name); // ensures grouping cache warms; component reads cache directly below
  const { select, selectedId, toggleTarget } = useSelection();
  const def = getCachedDef(p.name);
  const activates = legal.filter(
    (a) => a.kind === 'activate' && a.objectId === p.id,
  );
  const selected = selectedId === p.id;

  const handleClick = () => {
    if (targeting) toggleTarget(p.id);
    else select(selected ? null : p.id);
  };

  return (
    <div className="relative">
      <CardFrame
        name={p.name}
        manaCost={def?.manaCost}
        typeLine={def?.typeLine}
        power={p.power !== undefined ? String(p.power) : undefined}
        toughness={p.toughness !== undefined ? String(p.toughness) : undefined}
        tapped={p.tapped}
        small
        selected={selected || isTarget}
        targeting={targeting}
        onClick={handleClick}
        ariaLabel={`${p.name}, controlled by ${isYou ? 'you' : `P${p.controller}`}, ${
          p.tapped ? 'tapped' : 'untapped'
        }${isTarget ? ', targeted' : ''}`}
      />
      {isTarget && (
        <span className="absolute -top-2 left-1/2 -translate-x-1/2 rounded bg-seat1 px-1 text-[10px] font-bold text-black">
          TARGET
        </span>
      )}
      {isYou && activates.length > 0 && !targeting && (
        <div className="mt-0.5 flex flex-col gap-0.5">
          {activates.map((a, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onActivate(a)}
              aria-label={`Activate ability ${a.abilityIndex ?? i} of ${p.name}`}
              className="rounded bg-seat2/80 px-1 py-0.5 text-[10px] font-bold text-black hover:bg-seat2"
            >
              {a.label || `Activate${a.abilityIndex !== undefined ? ` ${a.abilityIndex}` : ''}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function groupOf(p: Permanent): 'lands' | 'creatures' | 'other' {
  const def = getCachedDef(p.name);
  const types = (def?.types ?? []).map((t) => t.toLowerCase());
  const line = (def?.typeLine ?? '').toLowerCase();
  const isLand = types.includes('land') || line.includes('land');
  const isCreature = types.includes('creature') || line.includes('creature');
  if (isLand) return 'lands';
  if (isCreature) return 'creatures';
  return 'other';
}

export const Battlefield = React.memo(function Battlefield({
  seat,
  observation,
  isYou,
  legal,
  onActivate,
}: BattlefieldProps & { onActivate: (a: LegalAction) => void }) {
  const { pending, targets } = useSelection();
  const targeting = pending !== null;
  const permanents = observation.battlefield.filter((p) => p.controller === seat);

  const lands = permanents.filter((p) => groupOf(p) === 'lands');
  const creatures = permanents.filter((p) => groupOf(p) === 'creatures');
  const other = permanents.filter((p) => groupOf(p) === 'other');

  const renderGroup = (title: string, list: Permanent[]) =>
    list.length > 0 && (
      <section aria-label={`${title} (${list.length})`}>
        <h4 className="mb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">
          {title} · {list.length}
        </h4>
        <div className="flex flex-wrap gap-1.5">
          {list.map((p) => (
            <PermanentCard
              key={p.id}
              p={p}
              isYou={isYou}
              legal={legal}
              targeting={targeting}
              isTarget={targets.includes(p.id) || targets.includes(playerTargetId(seat))}
              onActivate={onActivate}
            />
          ))}
        </div>
      </section>
    );

  return (
    <div className="flex flex-col gap-2" role="group" aria-label={`Battlefield of P${seat}`}>
      {permanents.length === 0 && (
        <p className="text-xs italic text-gray-500">No permanents.</p>
      )}
      {renderGroup('Lands', lands)}
      {renderGroup('Creatures', creatures)}
      {renderGroup('Other', other)}
    </div>
  );
});
