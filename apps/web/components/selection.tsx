'use client';
import React, { createContext, useCallback, useContext, useState } from 'react';

/** A pending intent that needs targets before it can be sent. */
export interface PendingIntent {
  kind: 'cast' | 'activate';
  /** hand card id (cast) or battlefield object id (activate) */
  cardId: string;
  cardName: string;
  abilityIndex?: number;
  needsNamedCard: boolean;
}

interface SelectionState {
  /** object/hand/stack id currently shown in CardDetail */
  selectedId: string | null;
  select: (id: string | null) => void;
  /** pending cast/activate awaiting targets */
  pending: PendingIntent | null;
  startPending: (p: PendingIntent) => void;
  cancelPending: () => void;
  targets: string[];
  toggleTarget: (id: string) => void;
  clearTargets: () => void;
  namedCard: string;
  setNamedCard: (s: string) => void;
}

const Ctx = createContext<SelectionState | null>(null);

export function SelectionProvider({ children }: { children: React.ReactNode }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingIntent | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [namedCard, setNamedCard] = useState('');

  const select = useCallback((id: string | null) => setSelectedId(id), []);
  const startPending = useCallback((p: PendingIntent) => {
    setPending(p);
    setTargets([]);
    setNamedCard('');
    setSelectedId(null);
  }, []);
  const cancelPending = useCallback(() => {
    setPending(null);
    setTargets([]);
    setNamedCard('');
  }, []);
  const toggleTarget = useCallback((id: string) => {
    setTargets((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  }, []);
  const clearTargets = useCallback(() => setTargets([]), []);

  return (
    <Ctx.Provider
      value={{
        selectedId,
        select,
        pending,
        startPending,
        cancelPending,
        targets,
        toggleTarget,
        clearTargets,
        namedCard,
        setNamedCard,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useSelection(): SelectionState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSelection must be used inside SelectionProvider');
  return ctx;
}

/** Target ids for players use the `player:<seat>` convention. */
export function playerTargetId(seat: number): string {
  return `player:${seat}`;
}
