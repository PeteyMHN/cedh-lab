'use client';
import React, { useEffect, useState } from 'react';
import { useGameStore } from '@/store/gameStore';
import type { LegalAction, Observation } from '@/lib/protocol';
import { CardFrame } from './CardFrame';
import { fetchCardDef, getCachedDef } from './cardCache';
import { useSelection } from './selection';

type HandCard = Observation['hand'][number];

function useWarmDef(name: string) {
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
}

/** Heuristic: demonic-consultation-style spells need a named card. */
function needsNamedCard(card: HandCard): boolean {
  const def = getCachedDef(card.name);
  const oracleId = (card.oracleId || def?.oracleId || '').toLowerCase();
  return (
    oracleId === 'demonic-consultation' ||
    card.name.toLowerCase().includes('demonic consultation')
  );
}

function HandCardView({
  card,
  legal,
}: {
  card: HandCard;
  legal: LegalAction[];
}) {
  useWarmDef(card.name);
  const def = getCachedDef(card.name) ?? card.def;
  const { select, selectedId, startPending, pending } = useSelection();
  const castActions = legal.filter((a) => a.kind === 'cast' && a.objectId === card.id);
  const landActions = legal.filter(
    (a) => a.kind === 'special' && a.objectId === card.id,
  );
  const selected = selectedId === card.id;
  const isPending = pending?.kind === 'cast' && pending.cardId === card.id;

  const typeLine = def
    ? [def.supertypes?.join(' '), def.types?.join(' '), (def.subtypes ?? []).join(' ')]
        .filter((s) => s && s.trim().length > 0)
        .join(' — ') || undefined
    : undefined;

  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <CardFrame
        name={card.name}
        manaCost={def?.manaCost}
        typeLine={typeLine}
        text={def?.oracleText}
        power={def?.power}
        toughness={def?.toughness}
        selected={selected}
        targeting={isPending}
        onClick={() => select(selected ? null : card.id)}
        ariaLabel={`${card.name}, in your hand${castActions.length ? ', castable' : ''}`}
      />
      <div className="flex gap-1">
        {castActions.map((a, i) => (
          <button
            key={`cast-${i}`}
            type="button"
            onClick={() =>
              startPending({
                kind: 'cast',
                cardId: card.id,
                cardName: card.name,
                needsNamedCard: needsNamedCard(card),
              })
            }
            aria-label={`Cast ${card.name}`}
            className="rounded bg-seat1 px-2 py-0.5 text-xs font-bold text-black hover:brightness-110"
          >
            Cast
          </button>
        ))}
        {landActions.map((a, i) => (
          <button
            key={`land-${i}`}
            type="button"
            onClick={() => sendPlayLand(card.id)}
            aria-label={`Play ${card.name} as your land`}
            className="rounded bg-seat2 px-2 py-0.5 text-xs font-bold text-black hover:brightness-110"
          >
            {a.label || 'Play land'}
          </button>
        ))}
      </div>
    </div>
  );
}

function sendPlayLand(cardId: string) {
  useGameStore.getState().sendAction({ kind: 'playLand', card: cardId });
}

export const HandView = React.memo(function HandView({
  observation,
  legal,
}: {
  observation: Observation;
  legal: LegalAction[];
}) {
  const { pending, cancelPending, targets, namedCard, setNamedCard } = useSelection();
  const sendAction = useGameStore((s) => s.sendAction);

  const confirmCast = () => {
    if (!pending || pending.kind !== 'cast') return;
    if (pending.needsNamedCard && namedCard.trim().length === 0) return;
    const action = {
      kind: 'cast' as const,
      card: pending.cardId,
      targets: targets.length > 0 ? targets : undefined,
      namedCard: pending.needsNamedCard ? namedCard.trim() : undefined,
    };
    sendAction(action);
    cancelPending();
  };

  return (
    <section aria-label="Your hand" className="rounded-lg border border-[#2a352e] bg-panel p-2">
      <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-gray-400">
        Hand · {observation.hand.length}
      </h3>

      {pending?.kind === 'cast' && (
        <div
          className="mb-2 rounded border border-seat1 bg-seat1/10 p-2 text-xs"
          role="group"
          aria-label={`Casting ${pending.cardName}: choose targets`}
        >
          <p className="font-bold text-seat1">
            Casting {pending.cardName} — click a target
            {targets.length > 0 && ` (${targets.length} selected)`}
          </p>
          {pending.needsNamedCard && (
            <label className="mt-1 flex items-center gap-2">
              <span className="text-gray-300">Name a card:</span>
              <input
                type="text"
                value={namedCard}
                onChange={(e) => setNamedCard(e.target.value)}
                placeholder="e.g. Thassa's Oracle"
                aria-label="Name a card for Demonic Consultation"
                className="rounded border border-[#3a4a3f] bg-black/40 px-2 py-1 text-parchment"
              />
            </label>
          )}
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              onClick={confirmCast}
              disabled={pending.needsNamedCard && namedCard.trim().length === 0}
              className="rounded bg-seat1 px-3 py-1 font-bold text-black disabled:opacity-40"
            >
              Cast
            </button>
            <button
              type="button"
              onClick={cancelPending}
              className="rounded border border-gray-500 px-3 py-1 text-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {observation.hand.length === 0 ? (
        <p className="text-xs italic text-gray-500">No cards in hand.</p>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1" role="list" aria-label="Cards in hand">
          {observation.hand.map((c) => (
            <div key={c.id} role="listitem">
              <HandCardView card={c} legal={legal} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
});
