'use client';
import React from 'react';
import type { LegalAction, Observation } from '@/lib/protocol';
import { Battlefield } from './Battlefield';
import { useSelection, playerTargetId } from './selection';

const SEAT_BG = ['bg-seat0', 'bg-seat1', 'bg-seat2', 'bg-seat3'];

interface PlayerPanelProps {
  seat: number;
  name?: string;
  observation: Observation;
  isYou: boolean;
  legal: LegalAction[];
  onActivate: (a: LegalAction) => void;
}

function ManaPips({ pool }: { pool: Record<string, number> }) {
  const entries = Object.entries(pool).filter(([, n]) => n > 0);
  if (entries.length === 0) return <span className="text-xs text-gray-500">No floating mana</span>;
  return (
    <div className="flex gap-1" aria-label={`Mana pool: ${entries.map(([c, n]) => `${n} ${c}`).join(', ')}`}>
      {entries.map(([color, n]) => (
        <span
          key={color}
          className="rounded-full bg-black/50 px-1.5 py-0.5 font-mono text-xs font-bold text-parchment"
        >
          {n}
          {color}
        </span>
      ))}
    </div>
  );
}

export const PlayerPanel = React.memo(function PlayerPanel({
  seat,
  name,
  observation,
  isYou,
  legal,
  onActivate,
}: PlayerPanelProps) {
  const { pending, targets, toggleTarget, select, selectedId } = useSelection();
  const targeting = pending !== null;
  const hasPriority = observation.priorityPlayer === seat;
  const isActive = observation.activePlayer === seat;
  const life = observation.life[seat] ?? 0;
  const opp = observation.opponents.find((o) => o.player === seat);
  const handCount = isYou ? observation.hand.length : (opp?.handCount ?? 0);
  const libraryCount = isYou ? observation.libraryCount : null;
  const graveyardCount = observation.graveyards[seat]?.length ?? 0;
  const commanderName = observation.commanders.find((c) => c.player === seat)?.name;
  const isPlayerTarget = targets.includes(playerTargetId(seat));
  const playerLabel = isYou ? `${name ?? 'You'} (you)` : (name ?? `P${seat}`);

  return (
    <section
      aria-label={`${playerLabel} panel`}
      className={`relative flex h-full flex-col gap-2 rounded-lg border bg-panel p-2 ${
        hasPriority ? 'border-seat1 shadow-[0_0_12px_rgba(230,159,0,0.45)]' : 'border-[#2a352e]'
      }`}
    >
      {hasPriority && (
        <span className="absolute -top-2.5 left-2 rounded bg-seat1 px-1.5 text-[11px] font-bold text-black">
          PRIORITY
        </span>
      )}
      <header className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={`flex h-7 w-7 items-center justify-center rounded-full font-bold text-black ${SEAT_BG[seat % 4]}`}
            aria-hidden="true"
          >
            {seat}
          </span>
          <div>
            <div className="text-sm font-bold text-parchment">
              {playerLabel}
              {isActive && <span className="ml-1 text-xs font-normal text-gray-400">(active)</span>}
            </div>
            {commanderName && (
              <div className="text-xs text-gray-400" aria-label={`Commander: ${commanderName}`}>
                ⌘ {commanderName}
              </div>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold leading-none text-parchment" aria-label={`Life total ${life}`}>
            {life}
          </div>
          {opp?.tappedOut && (
            <div className="mt-0.5 rounded bg-black/50 px-1 text-[10px] font-bold text-gray-300">
              TAPPED OUT
            </div>
          )}
        </div>
      </header>

      <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-300" aria-label="Zone counts">
        <div className="flex gap-1">
          <dt className="text-gray-500">Hand</dt>
          <dd className="font-bold">{handCount}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-gray-500">Library</dt>
          <dd className="font-bold">{libraryCount ?? '—'}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-gray-500">Grave</dt>
          <dd className="font-bold">{graveyardCount}</dd>
        </div>
      </dl>

      {isYou && <ManaPips pool={observation.manaPool} />}

      {targeting && !isYou && (
        <button
          type="button"
          onClick={() => toggleTarget(playerTargetId(seat))}
          aria-label={`Target ${playerLabel}`}
          aria-pressed={isPlayerTarget}
          className={`rounded border px-2 py-1 text-xs font-bold ${
            isPlayerTarget
              ? 'border-seat1 bg-seat1 text-black'
              : 'border-seat1/60 text-seat1 hover:bg-seat1/20'
          }`}
        >
          {isPlayerTarget ? '✓ TARGETING' : 'Target player'}
        </button>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Battlefield
          seat={seat}
          observation={observation}
          isYou={isYou}
          legal={legal}
          onActivate={onActivate}
        />
      </div>

      {/* hidden affordance: selecting the panel header opens nothing; keep for a11y completeness */}
      <span className="sr-only" aria-live="off">
        {selectedId ? `Selected ${selectedId}` : ''}
      </span>
    </section>
  );
});
