'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useGameStore } from '@/store/gameStore';
import { useGameSocket } from '@/hooks/useGameSocket';
import { SERVER_HTTP } from '@/lib/config';
import type { LegalAction } from '@/lib/protocol';
import { SelectionProvider, useSelection } from '@/components/selection';
import { PlayerPanel } from '@/components/PlayerPanel';
import { StackPanel } from '@/components/StackPanel';
import { HandView } from '@/components/HandView';
import { ActionBar } from '@/components/ActionBar';
import { ChoiceModal } from '@/components/ChoiceModal';
import { CardDetail } from '@/components/CardDetail';
import { ChatPanel } from '@/components/ChatPanel';

const PHASES = [
  'untap',
  'upkeep',
  'draw',
  'precombat main',
  'combat',
  'postcombat main',
  'end',
];

function PhaseTrack({ phase, turn, activePlayer }: { phase: string; turn: number; activePlayer: number }) {
  const cur = phase.toLowerCase();
  const idx = PHASES.findIndex((p) => cur.includes(p));
  return (
    <section aria-label="Turn and phase" className="rounded-lg border border-[#2a352e] bg-panel p-2">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-bold text-parchment">Turn {turn}</span>
        <span className="text-gray-400">
          Active: <span className="font-bold text-parchment">P{activePlayer}</span>
        </span>
      </div>
      <ol className="flex flex-wrap gap-1" aria-label="Phases">
        {PHASES.map((p, i) => {
          const active = i === idx;
          return (
            <li
              key={p}
              aria-current={active ? 'step' : undefined}
              className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                active ? 'bg-seat1 text-black' : 'bg-black/40 text-gray-400'
              }`}
            >
              {p}
            </li>
          );
        })}
      </ol>
      {!PHASES.some((p) => cur.includes(p)) && (
        <p className="mt-1 text-[10px] text-gray-500">Phase: {phase}</p>
      )}
    </section>
  );
}

function GameOverOverlay({ winners, names }: { winners: number[]; names: string[] }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" role="dialog" aria-modal="true" aria-label="Game over">
      <div className="rounded-lg border border-seat1 bg-panel p-6 text-center">
        <h2 className="mb-2 text-2xl font-bold text-parchment">Game over</h2>
        <p className="mb-4 text-parchment" aria-live="polite">
          Winner{winners.length === 1 ? '' : 's'}:{' '}
          <span className="font-bold text-seat1">
            {winners.map((w) => `P${w}${names[w] ? ` (${names[w]})` : ''}`).join(', ')}
          </span>
        </p>
        <a href="/" className="rounded bg-seat1 px-4 py-2 font-bold text-black">
          Back to lobby
        </a>
      </div>
    </div>
  );
}

function TableInner({ podId }: { podId: string }) {
  const observation = useGameStore((s) => s.observation);
  const legal = useGameStore((s) => s.legal);
  const status = useGameStore((s) => s.status);
  const seat = useGameStore((s) => s.seat);
  const pendingChoice = useGameStore((s) => s.pendingChoice);
  const winners = useGameStore((s) => s.winners);
  const error = useGameStore((s) => s.error);
  const setError = useGameStore((s) => s.setError);
  const sendAction = useGameStore((s) => s.sendAction);

  const { select, cancelPending, pending, startPending } = useSelection();
  const [names, setNames] = useState<string[]>(['P0', 'P1', 'P2', 'P3']);
  const [confirmingConcede, setConfirmingConcede] = useState(false);
  const announceRef = useRef<HTMLDivElement>(null);
  const prevPriority = useRef<number | null>(null);

  // Seat names from the pod summary (best effort).
  useEffect(() => {
    let alive = true;
    fetch(`${SERVER_HTTP}/api/pods/${encodeURIComponent(podId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((pod) => {
        if (!alive || !pod?.seats) return;
        const n = ['P0', 'P1', 'P2', 'P3'];
        for (const s of pod.seats as { seat: number; name: string }[]) {
          if (s.seat >= 0 && s.seat < 4) n[s.seat] = s.name || `P${s.seat}`;
        }
        setNames(n);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [podId]);

  // Announce priority changes + winners to screen readers.
  useEffect(() => {
    if (!observation) return;
    const p = observation.priorityPlayer;
    if (p !== prevPriority.current) {
      prevPriority.current = p;
      const msg =
        p === null ? 'Priority cleared' : p === seat ? 'Priority: you' : `Priority: P${p}`;
      if (announceRef.current) announceRef.current.textContent = msg;
    }
  }, [observation, seat]);

  useEffect(() => {
    if (winners && winners.length > 0 && announceRef.current) {
      announceRef.current.textContent = `Game over. Winners: ${winners.map((w) => `P${w}`).join(', ')}`;
    }
  }, [winners]);

  // Keyboard: Space = pass, Esc = close detail / cancel targeting.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
      if (e.key === 'Escape') {
        if (pending) cancelPending();
        else select(null);
        return;
      }
      if (e.code === 'Space' && !typing) {
        const myChoice = pendingChoice && pendingChoice.player === seat;
        if (myChoice || pending) return; // modal open or targeting: don't pass
        if (observation?.priorityPlayer === seat && legal.some((a) => a.kind === 'pass')) {
          e.preventDefault();
          sendAction({ kind: 'pass' });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [observation, legal, pendingChoice, seat, pending, cancelPending, select, sendAction]);

  const handleActivate = useCallback(
    (a: LegalAction) => {
      if (!a.objectId) return;
      const needsTargets = (a.detail?.needsTargets ?? a.detail?.targets) === true;
      if (needsTargets) {
        const src = observation?.battlefield.find((p) => p.id === a.objectId);
        startPending({
          kind: 'activate',
          cardId: a.objectId,
          cardName: src?.name ?? a.label,
          abilityIndex: a.abilityIndex ?? 0,
          needsNamedCard: false,
        });
      } else {
        sendAction({ kind: 'activate', source: a.objectId, ability: a.abilityIndex ?? 0 });
      }
    },
    [observation, sendAction, startPending],
  );

  if (!observation) {
    return (
      <main className="flex h-screen items-center justify-center">
        <div className="text-center">
          <p className="mb-2 text-lg text-parchment" aria-live="polite">
            {status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
          </p>
          {error && (
            <div role="alert" className="rounded border border-red-500 bg-red-950/50 p-3 text-sm text-red-200">
              {error}
              <button type="button" onClick={() => setError(null)} aria-label="Dismiss error" className="ml-3 rounded border border-red-400 px-2 py-0.5 text-xs">
                Dismiss
              </button>
            </div>
          )}
        </div>
      </main>
    );
  }

  const mySeat = seat ?? 0;
  const top = (mySeat + 1) % 4;
  const left = (mySeat + 2) % 4;
  const right = (mySeat + 3) % 4;
  const myChoice = pendingChoice && pendingChoice.player === mySeat ? pendingChoice : null;

  const panelProps = (s: number) => ({
    seat: s,
    name: names[s],
    observation,
    isYou: s === mySeat,
    legal: s === mySeat ? legal : [],
    onActivate: handleActivate,
  });

  return (
    <main className="h-screen overflow-x-auto">
      <div className="sr-only" aria-live="polite" ref={announceRef} />
      <div
        className="grid h-full min-w-[1280px] gap-2 p-2"
        style={{ gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gridTemplateRows: 'repeat(8, minmax(0, 1fr))' }}
      >
        {/* top opponent */}
        <div style={{ gridArea: '1 / 4 / 3 / 10' }} className="min-h-0 overflow-y-auto">
          <PlayerPanel {...panelProps(top)} />
        </div>
        {/* left opponent */}
        <div style={{ gridArea: '2 / 1 / 6 / 4' }} className="min-h-0 overflow-y-auto">
          <PlayerPanel {...panelProps(left)} />
        </div>
        {/* center column */}
        <div style={{ gridArea: '3 / 5 / 6 / 9' }} className="flex min-h-0 flex-col gap-2">
          <PhaseTrack phase={observation.phase} turn={observation.turn} activePlayer={observation.activePlayer} />
          <StackPanel observation={observation} />
          <ActionBar observation={observation} legal={legal} seat={mySeat} names={names} />
        </div>
        {/* right opponent */}
        <div style={{ gridArea: '2 / 10 / 6 / 13' }} className="min-h-0 overflow-y-auto">
          <PlayerPanel {...panelProps(right)} />
        </div>
        {/* you */}
        <div style={{ gridArea: '6 / 4 / 9 / 10' }} className="flex min-h-0 flex-col gap-2 overflow-y-auto">
          <PlayerPanel {...panelProps(mySeat)} />
          <HandView observation={observation} legal={legal} />
        </div>

        {/* side strip: chat + concede live in the leftover grid cells */}
        <div style={{ gridArea: '6 / 1 / 9 / 4' }} className="flex min-h-0 flex-col gap-2 overflow-y-auto">
          <ChatPanel />
          <div className="rounded-lg border border-[#2a352e] bg-panel p-2">
            <button
              type="button"
              onClick={() => {
                if (confirmingConcede) {
                  sendAction({ kind: 'concede' });
                  setConfirmingConcede(false);
                } else {
                  setConfirmingConcede(true);
                }
              }}
              onBlur={() => setConfirmingConcede(false)}
              aria-label={confirmingConcede ? 'Confirm concede' : 'Concede the game'}
              className={`w-full rounded px-3 py-1.5 text-sm font-bold ${
                confirmingConcede ? 'bg-red-600 text-white' : 'border border-red-500/60 text-red-300'
              }`}
            >
              {confirmingConcede ? 'Click again to confirm concede' : 'Concede'}
            </button>
            <a href="/" className="mt-2 block text-center text-xs text-gray-500 underline">
              Leave table
            </a>
          </div>
        </div>
        <div style={{ gridArea: '6 / 10 / 9 / 13' }} className="min-h-0 overflow-y-auto">
          <section aria-label="Game info" className="rounded-lg border border-[#2a352e] bg-panel p-2 text-xs text-gray-400">
            <p className="font-mono">pod: {podId}</p>
            <p>
              You are <span className="font-bold text-parchment">P{mySeat}</span>
            </p>
            <p>
              Turn {observation.turn} · {observation.phase}
            </p>
            <p className="mt-1">
              Shortcuts: <kbd className="rounded bg-black/40 px-1">Space</kbd> pass,{' '}
              <kbd className="rounded bg-black/40 px-1">Esc</kbd> close detail
            </p>
          </section>
        </div>
      </div>

      {status !== 'live' && (
        <div className="fixed left-1/2 top-2 z-50 -translate-x-1/2 rounded bg-seat1 px-3 py-1 text-sm font-bold text-black" role="status">
          {status === 'reconnecting' ? 'Reconnecting…' : `Status: ${status}`} — input may be stale
        </div>
      )}

      {error && (
        <div role="alert" className="fixed bottom-2 left-1/2 z-50 -translate-x-1/2 rounded border border-red-500 bg-red-950/90 p-2 text-sm text-red-200">
          {error}
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error" className="ml-3 rounded border border-red-400 px-2 py-0.5 text-xs">
            Dismiss
          </button>
        </div>
      )}

      {myChoice && <ChoiceModal choice={myChoice} names={names} />}
      <CardDetail observation={observation} />
      {winners && winners.length > 0 && <GameOverOverlay winners={winners} names={names} />}
    </main>
  );
}

export default function GamePage({ params }: { params: { id: string } }) {
  const podId = params.id;
  const connect = useGameStore((s) => s.connect);
  const disconnect = useGameStore((s) => s.disconnect);
  const [token, setToken] = useState<string | null>(null);
  const [noSeat, setNoSeat] = useState(false);

  // Socket hook: called once; it no-ops until podId+token are set.
  useGameSocket(podId, token);

  useEffect(() => {
    let stored: { token?: string; seat?: number; name?: string } | null = null;
    try {
      const raw = localStorage.getItem(`cedh-seat-${podId}`);
      stored = raw ? JSON.parse(raw) : null;
    } catch {
      stored = null;
    }
    if (stored?.token) {
      setToken(stored.token);
      connect(podId, stored.token);
    } else {
      setNoSeat(true);
    }
    return () => {
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [podId]);

  if (noSeat) {
    return (
      <main className="flex h-screen items-center justify-center p-6">
        <div className="text-center">
          <p className="mb-3 text-parchment">
            No seat token found for this pod. Join the pod from the lobby first.
          </p>
          <a href="/" className="rounded bg-seat1 px-4 py-2 font-bold text-black">
            Back to lobby
          </a>
        </div>
      </main>
    );
  }

  return (
    <SelectionProvider>
      <TableInner podId={podId} />
    </SelectionProvider>
  );
}
