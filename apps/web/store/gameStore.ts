'use client';

import { create } from 'zustand';
import {
  newNonce,
  type ClientMsg,
  type GameAction,
  type LegalAction,
  type Observation,
  type ServerMsg,
  type WireEvent,
  type ChoiceRequest,
} from '@/lib/protocol';

export interface ChatMessage {
  from: string;
  text: string;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error';

export interface GameStore {
  status: ConnectionStatus;
  podId: string | null;
  seat: number | null;
  observation: Observation | null;
  legal: LegalAction[];
  pendingChoice: ChoiceRequest | null;
  events: WireEvent[];
  lastSeq: number;
  chat: ChatMessage[];
  winners: number[] | null;
  error: string | null;
  sender: ((msg: ClientMsg) => void) | null;
  setSender(fn: ((msg: ClientMsg) => void) | null): void;
  connect(podId: string, token: string): void;
  disconnect(): void;
  sendAction(action: GameAction): void;
  sendChat(text: string): void;
  applyServerMsg(msg: ServerMsg): void;
  setError(e: string | null): void;
  setStatus(s: ConnectionStatus): void;
}

const MAX_EVENTS = 500;
const MAX_CHAT = 100;

const initialPodState = {
  seat: null as number | null,
  observation: null as Observation | null,
  legal: [] as LegalAction[],
  pendingChoice: null as ChoiceRequest | null,
  events: [] as WireEvent[],
  lastSeq: 0,
  chat: [] as ChatMessage[],
  winners: null as number[] | null,
  error: null as string | null,
};

export const useGameStore = create<GameStore>()((set, get) => ({
  status: 'idle',
  podId: null,
  sender: null,
  ...initialPodState,

  setSender: (fn) => set({ sender: fn }),

  setStatus: (s) => set({ status: s }),

  setError: (e) => set({ error: e }),

  connect: (podId, _token) => {
    // _token is used by the socket hook for auth; the store only tracks the pod.
    set({ podId, status: 'connecting', ...initialPodState });
  },

  disconnect: () =>
    set({
      status: 'idle',
      podId: null,
      sender: null,
      ...initialPodState,
    }),

  sendAction: (action) => {
    const { sender, status } = get();
    if (status !== 'live' || !sender) return; // no-op when not live
    sender({ t: 'action', action, nonce: newNonce() });
  },

  sendChat: (text) => {
    const { sender } = get();
    if (!sender) return;
    sender({ t: 'chat', text });
  },

  applyServerMsg: (msg) => {
    switch (msg.t) {
      case 'view': {
        set({
          seat: msg.seat,
          observation: msg.observation,
          legal: msg.legal,
          // pendingChoice may be absent or null — normalize to null.
          pendingChoice: msg.pendingChoice ?? null,
        });
        break;
      }
      case 'events': {
        const { events, lastSeq } = get();
        // Dedupe by seq: resilient to out-of-order retransmits and reconnect replays.
        const seen = new Set(events.map((e) => e.seq));
        const fresh = msg.events.filter((e) => !seen.has(e.seq));
        if (fresh.length === 0) {
          // Still advance lastSeq if the server claims a higher watermark.
          if (msg.fromSeq > lastSeq) set({ lastSeq: msg.fromSeq });
          break;
        }
        const merged = [...events, ...fresh].sort((a, b) => a.seq - b.seq);
        const capped = merged.slice(-MAX_EVENTS);
        const maxSeq = Math.max(lastSeq, msg.fromSeq, ...fresh.map((e) => e.seq));
        set({ events: capped, lastSeq: maxSeq });
        break;
      }
      case 'priority': {
        // observation.priorityPlayer already carries this; reserved for future UI hints.
        break;
      }
      case 'gameOver': {
        set({ winners: msg.winners });
        break;
      }
      case 'chat': {
        const { chat } = get();
        set({ chat: [...chat, { from: msg.from, text: msg.text }].slice(-MAX_CHAT) });
        break;
      }
      case 'error': {
        set({ error: msg.message });
        break;
      }
    }
  },
}));
