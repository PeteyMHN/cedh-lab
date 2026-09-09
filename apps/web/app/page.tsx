'use client';
import React, { useCallback, useState } from 'react';
import { SERVER_HTTP } from '@/lib/config';
import type { PodSummary } from '@/lib/protocol';

/** Well-known card names -> oracleIds for the deck textarea. Unknown lines pass through as-is. */
const NAME_TO_ORACLE: Record<string, string> = {
  island: 'island',
  brainstorm: 'brainstorm',
  counterspell: 'counterspell',
  'demonic consultation': 'demonic-consultation',
  "thassa's oracle": 'thassas-oracle',
  'force of will': 'force-of-will',
  'dark ritual': 'dark-ritual',
  'mystic remora': 'mystic-remora',
  'rhystic study': 'rhystic-study',
  'swords to plowshares': 'swords-to-plowshares',
  'llanowar elves': 'llanowar-elves',
  'sol ring': 'sol-ring',
};

function parseDeckList(raw: string): string[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('//'))
    .map((l) => l.replace(/^\d+[xX]?\s+/, '')) // strip "4 " / "4x " counts
    .map((l) => NAME_TO_ORACLE[l.toLowerCase()] ?? l);
}

interface StoredSeat {
  token: string;
  seat: number;
  name: string;
}

function seatKey(podId: string) {
  return `cedh-seat-${podId}`;
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return res.json();
}

export default function LobbyPage() {
  const [name, setName] = useState('');
  const [aiSeats, setAiSeats] = useState(3);
  const [deckText, setDeckText] = useState(
    ['Island', 'Brainstorm', 'Counterspell', 'Sol Ring', 'Dark Ritual'].join('\n'),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pod, setPod] = useState<PodSummary | null>(null);
  const [lookupId, setLookupId] = useState('');
  const [mySeat, setMySeat] = useState<StoredSeat | null>(null);

  const fail = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    setError(
      msg.includes('Failed to fetch')
        ? `Could not reach the game server at ${SERVER_HTTP}. Is it running? (${msg})`
        : msg,
    );
  };

  const refreshPod = useCallback(async (podId: string) => {
    const res = await fetch(`${SERVER_HTTP}/api/pods/${encodeURIComponent(podId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} loading pod ${podId}`);
    const summary = (await res.json()) as PodSummary;
    setPod(summary);
    try {
      const stored = localStorage.getItem(seatKey(podId));
      setMySeat(stored ? (JSON.parse(stored) as StoredSeat) : null);
    } catch {
      setMySeat(null);
    }
  }, []);

  const createPod = async () => {
    setBusy(true);
    setError(null);
    try {
      const list = parseDeckList(deckText);
      const body = await postJson(`${SERVER_HTTP}/api/pods`, {
        name: name.trim() || undefined,
        aiSeats,
        decks: [{ seat: 0, list, commander: [] }],
      });
      const podId: string = body.id ?? body.podId;
      if (!podId) throw new Error('Server did not return a pod id.');
      const token: string | undefined = body.seatToken ?? body.token;
      const seat: number = body.seat ?? 0;
      if (token) {
        const stored: StoredSeat = { token, seat, name: name.trim() || 'Player' };
        localStorage.setItem(seatKey(podId), JSON.stringify(stored));
        setMySeat(stored);
      }
      await refreshPod(podId);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const joinPod = async () => {
    if (!pod) return;
    setBusy(true);
    setError(null);
    try {
      const body = await postJson(`${SERVER_HTTP}/api/pods/${encodeURIComponent(pod.id)}/join`, {
        name: name.trim() || 'Player',
      });
      const token: string | undefined = body.seatToken ?? body.token;
      const seat: number = body.seat ?? 0;
      if (!token) throw new Error('Server did not return a seat token.');
      const stored: StoredSeat = { token, seat, name: name.trim() || 'Player' };
      localStorage.setItem(seatKey(pod.id), JSON.stringify(stored));
      setMySeat(stored);
      await refreshPod(pod.id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const startPod = async () => {
    if (!pod) return;
    setBusy(true);
    setError(null);
    try {
      await postJson(`${SERVER_HTTP}/api/pods/${encodeURIComponent(pod.id)}/start`, {});
      await refreshPod(pod.id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const lookupPod = async () => {
    const id = lookupId.trim();
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await refreshPod(id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-3xl p-6">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-parchment">cEDH Lab</h1>
        <p className="text-sm text-gray-400">
          The definitive digital cEDH testing environment — create a pod, take a seat, play.
        </p>
      </header>

      {error && (
        <div role="alert" className="mb-4 rounded border border-red-500 bg-red-950/50 p-3 text-sm text-red-200">
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="ml-3 rounded border border-red-400 px-2 py-0.5 text-xs"
          >
            Dismiss
          </button>
        </div>
      )}

      <section aria-label="Create a pod" className="mb-6 rounded-lg border border-[#2a352e] bg-panel p-4">
        <h2 className="mb-3 text-lg font-bold text-parchment">Create a pod</h2>
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-gray-300">Your name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Renz"
              className="rounded border border-[#3a4a3f] bg-black/40 px-2 py-1.5 text-parchment"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-gray-300">AI opponents</span>
            <select
              value={aiSeats}
              onChange={(e) => setAiSeats(Number(e.target.value))}
              aria-label="Number of AI seats"
              className="rounded border border-[#3a4a3f] bg-black/40 px-2 py-1.5 text-parchment"
            >
              {[0, 1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n} AI seat{n === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="mb-3 flex flex-col gap-1 text-sm">
          <span className="text-gray-300">
            Your deck — one card name or oracleId per line
            <span className="text-gray-500"> (well-known names like “Sol Ring” are mapped automatically)</span>
          </span>
          <textarea
            value={deckText}
            onChange={(e) => setDeckText(e.target.value)}
            rows={8}
            spellCheck={false}
            aria-label="Deck list, one card per line"
            className="rounded border border-[#3a4a3f] bg-black/40 px-2 py-1.5 font-mono text-sm text-parchment"
          />
        </label>
        <button
          type="button"
          onClick={createPod}
          disabled={busy}
          className="rounded bg-seat1 px-4 py-2 font-bold text-black disabled:opacity-40"
        >
          {busy ? 'Working…' : 'Create pod'}
        </button>
      </section>

      <section aria-label="Find an existing pod" className="mb-6 rounded-lg border border-[#2a352e] bg-panel p-4">
        <h2 className="mb-3 text-lg font-bold text-parchment">…or find a pod</h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={lookupId}
            onChange={(e) => setLookupId(e.target.value)}
            placeholder="Pod ID"
            aria-label="Pod ID"
            className="min-w-0 flex-1 rounded border border-[#3a4a3f] bg-black/40 px-2 py-1.5 font-mono text-sm text-parchment"
          />
          <button
            type="button"
            onClick={lookupPod}
            disabled={busy || !lookupId.trim()}
            className="rounded border border-seat0 px-4 py-1.5 font-bold text-seat0 disabled:opacity-40"
          >
            Load
          </button>
        </div>
      </section>

      {pod && (
        <section aria-label="Pod status" className="rounded-lg border border-[#2a352e] bg-panel p-4">
          <h2 className="mb-1 text-lg font-bold text-parchment">{pod.name || 'Pod'}</h2>
          <p className="mb-2 font-mono text-xs text-gray-400">id: {pod.id}</p>
          <p className="mb-3 text-sm">
            Status:{' '}
            <span className="font-bold text-seat2">{pod.status}</span>
            {pod.winners && pod.winners.length > 0 && (
              <span className="ml-2 text-parchment">Winners: {pod.winners.map((w) => `P${w}`).join(', ')}</span>
            )}
          </p>
          <ul className="mb-3 flex flex-col gap-1" aria-label="Seats">
            {pod.seats.map((s) => (
              <li key={s.seat} className="flex items-center gap-2 text-sm">
                <span className="font-mono font-bold text-seat0">P{s.seat}</span>
                <span className="text-gray-200">{s.name}</span>
                {s.isAI && <span className="rounded bg-black/50 px-1 text-xs text-gray-400">AI</span>}
                {mySeat?.seat === s.seat && (
                  <span className="rounded bg-seat1 px-1 text-xs font-bold text-black">YOU</span>
                )}
                {!s.connected && <span className="text-xs text-gray-500">(disconnected)</span>}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {!mySeat && pod.status === 'lobby' && (
              <button
                type="button"
                onClick={joinPod}
                disabled={busy}
                className="rounded bg-seat2 px-4 py-1.5 font-bold text-black disabled:opacity-40"
              >
                Join
              </button>
            )}
            {pod.status === 'lobby' && (
              <button
                type="button"
                onClick={startPod}
                disabled={busy}
                className="rounded bg-seat1 px-4 py-1.5 font-bold text-black disabled:opacity-40"
              >
                Start game
              </button>
            )}
            {(pod.status === 'active' || mySeat) && (
              <a
                href={`/games/${encodeURIComponent(pod.id)}`}
                className="rounded border border-seat1 px-4 py-1.5 font-bold text-seat1"
              >
                Enter table →
              </a>
            )}
          </div>
          {!mySeat && (
            <p className="mt-2 text-xs text-gray-500">
              You don&apos;t have a seat token for this pod yet — press Join first.
            </p>
          )}
        </section>
      )}
    </main>
  );
}
