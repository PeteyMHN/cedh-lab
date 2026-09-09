'use client';
import React, { useEffect, useState } from 'react';
import { useGameStore } from '@/store/gameStore';
import type { ChoiceRequest, ChoiceSelection } from '@/lib/protocol';

const COLORS = ['W', 'U', 'B', 'R', 'G'] as const;

/**
 * Modal for a pending ChoiceRequest. Esc does NOT submit — it is inert here
 * (Esc only closes CardDetail). One explicit Submit button per choice.
 *
 * Selection mapping: ChoiceSelection has no 'color'/'order' kinds, so
 * color -> {kind:'option', index} and order -> {kind:'cards', cardIds} (in chosen order).
 */
export const ChoiceModal = React.memo(function ChoiceModal({
  choice,
  names,
}: {
  choice: ChoiceRequest;
  names: string[];
}) {
  const sendAction = useGameStore((s) => s.sendAction);
  const [single, setSingle] = useState<string | number | boolean | null>(null);
  const [multi, setMulti] = useState<string[]>([]);
  const [num, setNum] = useState<number>(choice.min ?? 0);
  const [order, setOrder] = useState<string[]>([]);

  useEffect(() => {
    setSingle(null);
    setMulti([]);
    setNum(choice.min ?? 0);
    setOrder((choice.options ?? []).map((o) => o.id));
  }, [choice.id, choice.min, choice.options]);

  const min = choice.min ?? (choice.kind === 'cards' ? 1 : 0);
  const max = choice.max ?? (choice.options?.length ?? 1);

  const move = (idx: number, dir: -1 | 1) => {
    setOrder((o) => {
      const next = [...o];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return next;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };

  const buildSelection = (): ChoiceSelection | null => {
    switch (choice.kind) {
      case 'card':
        return typeof single === 'string' ? { kind: 'card', cardId: single } : null;
      case 'cards':
        return multi.length >= min && multi.length <= max
          ? { kind: 'cards', cardIds: multi }
          : null;
      case 'option':
        return typeof single === 'number' ? { kind: 'option', index: single } : null;
      case 'number':
        return num >= (choice.min ?? -Infinity) && num <= (choice.max ?? Infinity)
          ? { kind: 'number', value: num }
          : null;
      case 'yesNo':
        return typeof single === 'boolean' ? { kind: 'yesNo', value: single } : null;
      case 'player':
        return typeof single === 'number' ? { kind: 'player', player: single } : null;
      case 'color':
        return typeof single === 'number' ? { kind: 'option', index: single } : null;
      case 'order':
        return { kind: 'cards', cardIds: order };
      default:
        return null;
    }
  };

  const selection = buildSelection();

  const submit = () => {
    if (!selection) return;
    sendAction({ kind: 'answerChoice', choiceId: choice.id, selection });
  };

  const toggleMulti = (id: string) =>
    setMulti((m) =>
      m.includes(id) ? m.filter((x) => x !== id) : m.length < max ? [...m, id] : m,
    );

  const optionLabel = (id: string) =>
    choice.options?.find((o) => o.id === id)?.label ?? id;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      role="dialog"
      aria-modal="true"
      aria-labelledby="choice-modal-heading"
    >
      <div className="max-h-[85vh] w-[min(28rem,92vw)] overflow-y-auto rounded-lg border border-seat1 bg-panel p-4">
        <h2 id="choice-modal-heading" tabIndex={-1} className="mb-1 text-base font-bold text-parchment">
          {choice.prompt}
        </h2>
        <p className="mb-3 text-xs text-gray-400">
          Choice for {choice.kind === 'player' ? 'a player' : choice.kind}
          {choice.kind === 'cards' && ` — pick ${min}–${max}`}
        </p>

        {(choice.kind === 'card' || choice.kind === 'option') && (
          <div className="flex flex-col gap-1" role={choice.kind === 'option' ? 'radiogroup' : 'listbox'} aria-label="Options">
            {(choice.options ?? []).map((o, i) => {
              const val = choice.kind === 'option' ? i : o.id;
              const on = single === val;
              return (
                <button
                  key={o.id}
                  type="button"
                  role={choice.kind === 'option' ? 'radio' : 'option'}
                  aria-checked={on}
                  aria-selected={on}
                  disabled={o.disabled}
                  onClick={() => setSingle(val)}
                  className={`rounded border px-2 py-1.5 text-left text-sm ${
                    on ? 'border-seat1 bg-seat1/20 text-parchment' : 'border-[#3a4a3f] text-gray-200'
                  } disabled:opacity-40`}
                >
                  <span className="font-semibold">{o.label}</span>
                  {o.detail && <span className="ml-2 text-xs text-gray-400">{o.detail}</span>}
                </button>
              );
            })}
          </div>
        )}

        {choice.kind === 'cards' && (
          <div className="flex flex-col gap-1" aria-label={`Pick ${min} to ${max} cards`}>
            {(choice.options ?? []).map((o) => {
              const on = multi.includes(o.id);
              return (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={on}
                  disabled={o.disabled}
                  onClick={() => toggleMulti(o.id)}
                  className={`rounded border px-2 py-1.5 text-left text-sm ${
                    on ? 'border-seat1 bg-seat1/20 text-parchment' : 'border-[#3a4a3f] text-gray-200'
                  } disabled:opacity-40`}
                >
                  {on ? '☑' : '☐'} <span className="font-semibold">{o.label}</span>
                  {o.detail && <span className="ml-2 text-xs text-gray-400">{o.detail}</span>}
                </button>
              );
            })}
            <p className="text-xs text-gray-400">Selected {multi.length} (need {min}–{max})</p>
          </div>
        )}

        {choice.kind === 'number' && (
          <label className="flex items-center gap-2 text-sm text-gray-200">
            Value
            <input
              type="number"
              value={num}
              min={choice.min}
              max={choice.max}
              onChange={(e) => setNum(Number(e.target.value))}
              aria-label={`Choose a number${choice.min !== undefined ? ` between ${choice.min} and ${choice.max}` : ''}`}
              className="w-24 rounded border border-[#3a4a3f] bg-black/40 px-2 py-1 text-parchment"
            />
          </label>
        )}

        {choice.kind === 'yesNo' && (
          <div className="flex gap-2" role="group" aria-label="Yes or no">
            {([true, false] as const).map((v) => (
              <button
                key={String(v)}
                type="button"
                aria-pressed={single === v}
                onClick={() => setSingle(v)}
                className={`rounded border px-4 py-1.5 font-bold ${
                  single === v ? 'border-seat1 bg-seat1/20 text-parchment' : 'border-[#3a4a3f] text-gray-200'
                }`}
              >
                {v ? 'Yes' : 'No'}
              </button>
            ))}
          </div>
        )}

        {choice.kind === 'player' && (
          <div className="flex gap-2" role="group" aria-label="Choose a player">
            {[0, 1, 2, 3].map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={single === p}
                onClick={() => setSingle(p)}
                aria-label={`Choose ${names[p] ?? `P${p}`}`}
                className={`rounded border px-3 py-1.5 font-bold ${
                  single === p ? 'border-seat1 bg-seat1/20 text-parchment' : 'border-[#3a4a3f] text-gray-200'
                }`}
              >
                P{p} {names[p] ? `(${names[p]})` : ''}
              </button>
            ))}
          </div>
        )}

        {choice.kind === 'color' && (
          <div className="flex gap-2" role="radiogroup" aria-label="Choose a color">
            {COLORS.map((c, i) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={single === i}
                onClick={() => setSingle(i)}
                className={`flex h-10 w-10 items-center justify-center rounded-full border-2 font-bold ${
                  single === i ? 'border-seat1 bg-seat1/20 text-parchment' : 'border-[#3a4a3f] text-gray-200'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        )}

        {choice.kind === 'order' && (
          <ol className="flex flex-col gap-1" aria-label="Reorder choices">
            {order.map((id, i) => (
              <li key={id} className="flex items-center gap-2 rounded border border-[#3a4a3f] px-2 py-1 text-sm text-gray-200">
                <span className="flex-1">{i + 1}. {optionLabel(id)}</span>
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${optionLabel(id)} up`} className="rounded bg-black/40 px-2 disabled:opacity-30">↑</button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === order.length - 1} aria-label={`Move ${optionLabel(id)} down`} className="rounded bg-black/40 px-2 disabled:opacity-30">↓</button>
              </li>
            ))}
          </ol>
        )}

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={submit}
            disabled={!selection}
            className="rounded bg-seat1 px-4 py-1.5 font-bold text-black disabled:opacity-40"
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  );
});
