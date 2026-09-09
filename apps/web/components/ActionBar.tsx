'use client';
import React, { useState } from 'react';
import { useGameStore } from '@/store/gameStore';
import type { ChoiceSelection, GameAction, LegalAction, Observation } from '@/lib/protocol';
import { getCachedDef } from './cardCache';
import { useSelection } from './selection';

interface ActionBarProps {
  observation: Observation;
  legal: LegalAction[];
  seat: number;
  names: string[];
}

function isCreatureLike(name: string): boolean {
  const def = getCachedDef(name);
  if (!def) return true; // unknown: include as candidate, exclude lands by name below
  const t = `${def.typeLine ?? ''} ${(def.types ?? []).join(' ')}`.toLowerCase();
  if (t.includes('land')) return false;
  return t.includes('creature') || t === '';
}

export const ActionBar = React.memo(function ActionBar({
  observation,
  legal,
  seat,
  names,
}: ActionBarProps) {
  const sendAction = useGameStore((s) => s.sendAction);
  const pendingChoice = useGameStore((s) => s.pendingChoice);
  const { pending, cancelPending, targets } = useSelection();

  const [attackMode, setAttackMode] = useState(false);
  const [attackers, setAttackers] = useState<string[]>([]);
  const [blockMode, setBlockMode] = useState(false);
  const [blockPairs, setBlockPairs] = useState<{ blocker: string; attacker: string }[]>([]);
  const [chosenBlocker, setChosenBlocker] = useState<string | null>(null);

  const isMyPriority = observation.priorityPlayer === seat;
  const priorityLabel =
    observation.priorityPlayer === null
      ? 'Priority: —'
      : observation.priorityPlayer === seat
        ? 'Priority: you'
        : `Priority: P${observation.priorityPlayer} (${names[observation.priorityPlayer] ?? '?'})`;

  const byKind = (k: LegalAction['kind']) => legal.filter((a) => a.kind === k);
  const passActions = byKind('pass');
  const castActions = byKind('cast');
  const activateActions = byKind('activate');
  const specialActions = byKind('special');
  const attackActions = byKind('attack');
  const blockActions = byKind('block');
  const choiceActions = byKind('choice');
  const miscActions = legal.filter((a) => a.kind === 'mulligan' || a.kind === 'shortcut');

  const handById = new Map(observation.hand.map((c) => [c.id, c]));
  const bfById = new Map(observation.battlefield.map((p) => [p.id, p]));

  const send = (a: GameAction) => sendAction(a);

  // top-level hook value, used by event handlers below
  const selection = useSelection();

  const doActivate = (a: LegalAction) => {
    const needsTargets = (a.detail?.needsTargets ?? a.detail?.targets) === true;
    if (needsTargets) {
      const src = a.objectId ? bfById.get(a.objectId) : undefined;
      selection.startPending({
        kind: 'activate',
        cardId: a.objectId ?? '',
        cardName: src?.name ?? a.label,
        abilityIndex: a.abilityIndex ?? 0,
        needsNamedCard: false,
      });
    } else {
      send({
        kind: 'activate',
        source: a.objectId ?? '',
        ability: a.abilityIndex ?? 0,
      });
    }
  };

  const confirmActivate = () => {
    if (!pending || pending.kind !== 'activate') return;
    send({
      kind: 'activate',
      source: pending.cardId,
      ability: pending.abilityIndex ?? 0,
      targets: targets.length > 0 ? targets : undefined,
    });
    cancelPending();
  };

  const myCreatures = observation.battlefield.filter(
    (p) => p.controller === seat && isCreatureLike(p.name) && !p.tapped,
  );
  const myBlockers = observation.battlefield.filter(
    (p) => p.controller === seat && isCreatureLike(p.name) && !p.tapped,
  );
  const enemyAttackers = observation.battlefield.filter(
    (p) => p.controller !== seat && isCreatureLike(p.name) && p.tapped,
  );

  const declareAttackers = () => {
    if (attackers.length === 0) return;
    send({ kind: 'declareAttackers', attackers });
    setAttackers([]);
    setAttackMode(false);
  };

  const pairBlocker = (attackerId: string) => {
    if (!chosenBlocker) return;
    setBlockPairs((pairs) => {
      const without = pairs.filter((pr) => pr.blocker !== chosenBlocker);
      return [...without, { blocker: chosenBlocker, attacker: attackerId }];
    });
    setChosenBlocker(null);
  };

  const declareBlockers = () => {
    if (blockPairs.length === 0) return;
    send({ kind: 'declareBlockers', blockers: blockPairs });
    setBlockPairs([]);
    setBlockMode(false);
  };

  const answerMisc = (a: LegalAction) => {
    const sel = a.detail?.selection as ChoiceSelection | undefined;
    send({
      kind: 'answerChoice',
      choiceId: a.choiceId ?? '',
      selection: sel ?? { kind: 'option', index: 0 },
    });
  };

  return (
    <section
      aria-label="Priority and actions"
      className={`rounded-lg border p-2 ${
        isMyPriority ? 'border-seat1 bg-seat1/10' : 'border-[#2a352e] bg-panel'
      }`}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-bold text-parchment" aria-live="off">
          {priorityLabel}
        </span>
        {isMyPriority && (
          <span className="rounded bg-seat1 px-1.5 text-xs font-bold text-black">YOUR MOVE</span>
        )}
      </div>

      {/* pending activate targeting confirm */}
      {pending?.kind === 'activate' && (
        <div className="mb-2 rounded border border-seat1 bg-seat1/10 p-2 text-xs" role="group" aria-label={`Activating ${pending.cardName}: choose targets`}>
          <p className="font-bold text-seat1">
            Activating {pending.cardName} — click a target
            {targets.length > 0 && ` (${targets.length} selected)`}
          </p>
          <div className="mt-1.5 flex gap-2">
            <button type="button" onClick={confirmActivate} className="rounded bg-seat1 px-3 py-1 font-bold text-black">
              Activate
            </button>
            <button type="button" onClick={cancelPending} className="rounded border border-gray-500 px-3 py-1 text-gray-300">
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {passActions.length > 0 && (
          <button
            type="button"
            onClick={() => send({ kind: 'pass' })}
            aria-label="Pass priority (Space)"
            className="rounded bg-seat1 px-4 py-1.5 font-bold text-black hover:brightness-110"
          >
            PASS ⏎
          </button>
        )}

        {castActions.map((a, i) => {
          const card = a.objectId ? handById.get(a.objectId) : undefined;
          const label = card ? `Cast ${card.name}` : a.label || 'Cast';
          return (
            <button
              key={`cast-${i}`}
              type="button"
              onClick={() => {
                if (!a.objectId) return;
                selection.startPending({
                  kind: 'cast',
                  cardId: a.objectId,
                  cardName: card?.name ?? a.label,
                  needsNamedCard:
                    (card?.name ?? '').toLowerCase().includes('demonic consultation'),
                });
              }}
              aria-label={label}
              className="rounded border border-seat1/70 px-2 py-1.5 text-xs font-bold text-seat1 hover:bg-seat1/20"
            >
              {label}
            </button>
          );
        })}

        {specialActions.map((a, i) => {
          const inHand = a.objectId && handById.has(a.objectId);
          if (!inHand) return null;
          return (
            <button
              key={`special-${i}`}
              type="button"
              onClick={() => send({ kind: 'playLand', card: a.objectId! })}
              aria-label={a.label || 'Play land'}
              className="rounded bg-seat2 px-2 py-1.5 text-xs font-bold text-black hover:brightness-110"
            >
              {a.label || 'Play land'}
            </button>
          );
        })}

        {activateActions.map((a, i) => (
          <button
            key={`act-${i}`}
            type="button"
            onClick={() => doActivate(a)}
            aria-label={`Activate: ${a.label}`}
            className="rounded border border-seat2/70 px-2 py-1.5 text-xs font-bold text-seat2 hover:bg-seat2/20"
          >
            {a.label || 'Activate'}
          </button>
        ))}

        {attackActions.length > 0 && !attackMode && (
          <button
            type="button"
            onClick={() => {
              setAttackMode(true);
              setBlockMode(false);
            }}
            aria-label="Choose attackers"
            className="rounded border border-red-400/70 px-2 py-1.5 text-xs font-bold text-red-300 hover:bg-red-400/20"
          >
            ⚔ Attack…
          </button>
        )}

        {blockActions.length > 0 && !blockMode && (
          <button
            type="button"
            onClick={() => {
              setBlockMode(true);
              setAttackMode(false);
            }}
            aria-label="Choose blockers"
            className="rounded border border-blue-400/70 px-2 py-1.5 text-xs font-bold text-blue-300 hover:bg-blue-400/20"
          >
            🛡 Block…
          </button>
        )}

        {choiceActions.map((a, i) => (
          <button
            key={`choice-${i}`}
            type="button"
            onClick={() => {
              const el = document.getElementById('choice-modal-heading');
              el?.focus();
            }}
            aria-label={a.label || 'Answer pending choice'}
            className="rounded border border-purple-400/70 px-2 py-1.5 text-xs font-bold text-purple-300 hover:bg-purple-400/20"
          >
            {pendingChoice ? 'Answer choice…' : a.label || 'Choice'}
          </button>
        ))}

        {miscActions.map((a, i) => (
          <button
            key={`misc-${i}`}
            type="button"
            onClick={() => a.choiceId && answerMisc(a)}
            disabled={!a.choiceId}
            aria-label={a.label || a.kind}
            className="rounded border border-gray-500 px-2 py-1.5 text-xs text-gray-300 disabled:opacity-40"
          >
            {a.label || a.kind}
          </button>
        ))}

        {legal.length === 0 && (
          <span className="text-xs italic text-gray-500">
            {isMyPriority ? 'No legal actions.' : 'Waiting…'}
          </span>
        )}
      </div>

      {/* attack picker */}
      {attackMode && (
        <div className="mt-2 rounded border border-red-400/50 p-2" role="group" aria-label="Choose attackers">
          <p className="mb-1 text-xs font-bold text-red-300">Select attackers ({attackers.length}):</p>
          <div className="flex flex-wrap gap-1">
            {myCreatures.map((p) => {
              const on = attackers.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() =>
                    setAttackers((s) => (on ? s.filter((x) => x !== p.id) : [...s, p.id]))
                  }
                  aria-pressed={on}
                  aria-label={`${on ? 'Remove' : 'Add'} ${p.name} ${on ? 'from' : 'to'} attackers`}
                  className={`rounded border px-2 py-1 text-xs ${on ? 'border-red-400 bg-red-400/30 text-red-100' : 'border-gray-600 text-gray-300'}`}
                >
                  {p.name}
                  {p.power !== undefined && ` (${p.power}/${p.toughness})`}
                </button>
              );
            })}
            {myCreatures.length === 0 && <span className="text-xs text-gray-500">No eligible attackers.</span>}
          </div>
          <div className="mt-1.5 flex gap-2">
            <button type="button" onClick={declareAttackers} disabled={attackers.length === 0} className="rounded bg-red-500 px-3 py-1 text-xs font-bold text-black disabled:opacity-40">
              Declare attackers ({attackers.length})
            </button>
            <button type="button" onClick={() => { setAttackMode(false); setAttackers([]); }} className="rounded border border-gray-500 px-3 py-1 text-xs text-gray-300">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* block picker */}
      {blockMode && (
        <div className="mt-2 rounded border border-blue-400/50 p-2" role="group" aria-label="Choose blockers">
          <p className="mb-1 text-xs font-bold text-blue-300">1. Pick your blocker, 2. pick the attacker it blocks:</p>
          <div className="mb-1 text-xs text-gray-400">Blockers:</div>
          <div className="flex flex-wrap gap-1">
            {myBlockers.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setChosenBlocker(chosenBlocker === p.id ? null : p.id)}
                aria-pressed={chosenBlocker === p.id}
                className={`rounded border px-2 py-1 text-xs ${chosenBlocker === p.id ? 'border-blue-400 bg-blue-400/30 text-blue-100' : 'border-gray-600 text-gray-300'}`}
              >
                {p.name}
              </button>
            ))}
          </div>
          <div className="mb-1 mt-2 text-xs text-gray-400">Attackers:</div>
          <div className="flex flex-wrap gap-1">
            {enemyAttackers.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={!chosenBlocker}
                onClick={() => pairBlocker(p.id)}
                className="rounded border border-gray-600 px-2 py-1 text-xs text-gray-300 disabled:opacity-40"
              >
                {p.name} [P{p.controller}]
              </button>
            ))}
            {enemyAttackers.length === 0 && <span className="text-xs text-gray-500">No tapped enemy creatures.</span>}
          </div>
          {blockPairs.length > 0 && (
            <ul className="mt-1 text-xs text-gray-300" aria-label="Declared blocks">
              {blockPairs.map((pr) => (
                <li key={pr.blocker}>
                  {bfById.get(pr.blocker)?.name ?? pr.blocker} blocks {bfById.get(pr.attacker)?.name ?? pr.attacker}
                  <button type="button" onClick={() => setBlockPairs((s) => s.filter((x) => x.blocker !== pr.blocker))} aria-label="Remove block" className="ml-2 text-red-300">✕</button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-1.5 flex gap-2">
            <button type="button" onClick={declareBlockers} disabled={blockPairs.length === 0} className="rounded bg-blue-500 px-3 py-1 text-xs font-bold text-black disabled:opacity-40">
              Declare blockers ({blockPairs.length})
            </button>
            <button type="button" onClick={() => { setBlockMode(false); setBlockPairs([]); setChosenBlocker(null); }} className="rounded border border-gray-500 px-3 py-1 text-xs text-gray-300">
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
});
