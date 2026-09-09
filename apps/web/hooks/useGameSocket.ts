'use client';

import { useEffect } from 'react';
import { useGameStore } from '@/store/gameStore';
import { podSocketUrl } from '@/lib/config';
import type { ClientMsg, ServerMsg } from '@/lib/protocol';

const MAX_BACKOFF_MS = 30_000;

/**
 * useGameSocket(podId, token)
 *
 * Opens the game WebSocket for a pod, authenticates, and funnels every
 * ServerMsg into the game store. Handles reconnects with exponential
 * backoff (1s, 2s, 4s … capped at 30s), resuming from `lastSeq` via the
 * `?since=` query param so the server can replay missed events.
 *
 * Cleanup on unmount: closes the socket, clears the sender, sets status idle.
 */
export function useGameSocket(podId: string | null, token: string | null): void {
  useEffect(() => {
    if (!podId || !token) return;

    let alive = true;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const clearRetry = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (!alive) return;
      const store = useGameStore.getState();
      store.setStatus('reconnecting');
      store.setSender(null);
      const delay = Math.min(1000 * 2 ** attempts, MAX_BACKOFF_MS);
      attempts += 1;
      clearRetry();
      retryTimer = setTimeout(() => {
        if (alive) open();
      }, delay);
    };

    const open = () => {
      if (!alive) return;
      const store = useGameStore.getState();
      // Resume from the last seen event seq so the server can resync us.
      const since = store.lastSeq > 0 ? store.lastSeq : undefined;
      const socket = new WebSocket(podSocketUrl(podId, since));
      ws = socket;

      socket.onopen = () => {
        if (!alive) {
          socket.close();
          return;
        }
        attempts = 0;
        const auth: ClientMsg = { t: 'auth', token };
        socket.send(JSON.stringify(auth));
        useGameStore.getState().setStatus('live');
        useGameStore.getState().setSender((msg: ClientMsg) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(msg));
          }
        });
      };

      socket.onmessage = (event) => {
        const store = useGameStore.getState();
        try {
          const msg = JSON.parse(event.data as string) as ServerMsg;
          if (!msg || typeof (msg as { t?: unknown }).t !== 'string') {
            throw new Error('malformed ServerMsg');
          }
          store.applyServerMsg(msg);
        } catch {
          // Malformed JSON must never crash the app — surface as toast data.
          store.setError('Received a malformed message from the game server.');
        }
      };

      socket.onerror = () => {
        // The close event follows; reconnect logic lives there.
      };

      socket.onclose = () => {
        if (ws === socket) ws = null;
        scheduleReconnect();
      };
    };

    open();

    return () => {
      alive = false;
      clearRetry();
      if (ws) {
        // Detach handlers so the manual close doesn't trigger a reconnect.
        ws.onclose = null;
        ws.close();
        ws = null;
      }
      const store = useGameStore.getState();
      store.setSender(null);
      store.setStatus('idle');
    };
  }, [podId, token]);
}
