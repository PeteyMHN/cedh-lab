'use client';
import React from 'react';
import type { Observation } from '@/lib/protocol';
import { useSelection } from './selection';

const SEAT_BG = ['bg-seat0', 'bg-seat1', 'bg-seat2', 'bg-seat3'];

/** Vertical stack, top of list = top of stack (resolves first). */
export const StackPanel = React.memo(function StackPanel({
  observation,
}: {
  observation: Observation;
}) {
  const { select, selectedId } = useSelection();
  // Engine keeps the stack bottom-first; display newest on top.
  const items = [...observation.stack].reverse();

  return (
    <section aria-label="Stack" className="flex min-h-0 flex-1 flex-col rounded-lg border border-[#2a352e] bg-panel p-2">
      <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-gray-400">
        Stack · {items.length}
      </h3>
      {items.length === 0 ? (
        <p className="text-xs italic text-gray-500">The stack is empty.</p>
      ) : (
        <ol className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto" aria-label="Stack objects, top resolves first">
          {items.map((s, i) => {
            const key = `${s.cardName}-${s.controller}-${i}`;
            const isTrigger = s.kind.toLowerCase().includes('trigger');
            const selected = selectedId === key;
            return (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => select(selected ? null : key)}
                  aria-label={`Stack object: ${s.cardName}, controlled by P${s.controller}, ${s.kind}${
                    s.targets.length ? `, targets ${s.targets.join(', ')}` : ''
                  }`}
                  aria-pressed={selected}
                  className={`stack-object w-full rounded bg-[#182420] p-1.5 text-left text-xs ${
                    selected ? 'ring-2 ring-seat0' : ''
                  } hover:bg-[#1e2d26]`}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-black ${SEAT_BG[s.controller % 4]}`}
                      aria-label={`controller P${s.controller}`}
                    >
                      {s.controller}
                    </span>
                    <span className="font-semibold text-parchment">{s.cardName}</span>
                    {isTrigger && (
                      <span className="rounded bg-purple-900 px-1 text-[10px] font-bold text-purple-100">
                        TRIGGER
                      </span>
                    )}
                    {i === 0 && (
                      <span className="rounded bg-seat1 px-1 text-[10px] font-bold text-black">TOP</span>
                    )}
                  </div>
                  {s.targets.length > 0 && (
                    <div className="mt-0.5 text-gray-300">
                      Targets: {s.targets.join(', ')}
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
});
