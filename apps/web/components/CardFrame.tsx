'use client';
import React from 'react';

export interface CardFrameProps {
  name: string;
  manaCost?: string;
  typeLine?: string;
  text?: string;
  power?: string;
  toughness?: string;
  tapped?: boolean;
  small?: boolean;
  selected?: boolean;
  targeting?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
}

/** Text-based card rendering — no images. Tapped = rotation + text badge (never color-alone). */
export const CardFrame = React.memo(function CardFrame({
  name,
  manaCost,
  typeLine,
  text,
  power,
  toughness,
  tapped,
  small,
  selected,
  targeting,
  onClick,
  ariaLabel,
}: CardFrameProps) {
  const label =
    ariaLabel ??
    `${name}${typeLine ? `, ${typeLine}` : ''}${tapped ? ', tapped' : ', untapped'}${
      power ? `, ${power}/${toughness}` : ''
    }`;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={selected}
      className={`card-frame relative flex flex-col text-left transition-transform ${
        small ? 'w-20 text-[10px] p-1' : 'w-32 text-xs p-1.5'
      } ${tapped ? 'tapped' : ''} ${
        selected ? 'ring-2 ring-seat0' : ''
      } ${targeting ? 'ring-2 ring-seat1 cursor-crosshair' : ''} ${
        onClick ? 'hover:-translate-y-1 focus-visible:outline-2 focus-visible:outline-seat0' : 'cursor-default'
      }`}
    >
      <div className="flex items-start justify-between gap-1">
        <span className="font-semibold leading-tight text-parchment">{name}</span>
        {manaCost && (
          <span className="shrink-0 rounded bg-black/40 px-1 font-mono" aria-label={`mana cost ${manaCost}`}>
            {manaCost}
          </span>
        )}
      </div>
      {typeLine && (
        <div className="mt-0.5 border-y border-[#3a4a3f] py-0.5 italic text-gray-300">{typeLine}</div>
      )}
      {text && !small && (
        <div className="mt-0.5 flex-1 overflow-hidden leading-snug text-gray-200">{text}</div>
      )}
      <div className="mt-0.5 flex items-center justify-between">
        {tapped ? (
          <span className="rounded bg-black/50 px-1 font-bold text-seat1" aria-hidden={false}>
            TAPPED
          </span>
        ) : (
          <span />
        )}
        {power !== undefined && (
          <span className="rounded bg-black/40 px-1 font-mono font-bold text-parchment">
            {power}/{toughness}
          </span>
        )}
      </div>
    </button>
  );
});
