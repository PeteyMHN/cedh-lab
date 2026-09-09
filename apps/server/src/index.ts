/**
 * index.ts — cEDH Lab authoritative game server.
 *
 * REST (Fastify) + WebSocket (ws). The server is authoritative: clients send
 * intents, every action is revalidated against the rules engine, and each seat
 * receives only its own filtered view (see views.ts).
 *
 * Auth in this slice is DEV-ONLY: POST /api/auth/dev-login mints a bearer token
 * with no password. Do not expose this to the internet; production auth is a
 * roadmap item (see README.md).
 */
import Fastify from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { ulid } from 'ulid';
import { Registry } from '@cedh-lab/cards';
import type {
  ClientMsg, CreatePodRequest, DeckValidation, GameAction, PodSummary, ServerMsg,
} from '@cedh-lab/protocol';
import { GameRoom } from './driver.js';
import { validateDeck } from './validation.js';
import { createStore } from './store.js';
import type { PodRecord } from './store.js';
import { filterEventForSeat, toWireEvent } from './views.js';

const PORT = Number(process.env.PORT ?? 3001);
const registry = new Registry();
const store = createStore();
const rooms = new Map<string, GameRoom>();
/** podId -> seat -> sockets (a seat may briefly have two during reconnect) */
const sockets = new Map<string, Map<number, Set<WebSocket>>>();
/** per-socket chat rate limiting */
const chatTimes = new WeakMap<WebSocket, number[]>();

const fastify = Fastify({ logger: false });

// ---------- helpers ----------

function authToken(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

function podSummary(pod: PodRecord): PodSummary {
  return {
    id: pod.id,
    name: pod.name,
    seats: pod.seats.map((s) => ({ seat: s.seat, name: s.name, isAI: s.isAI, connected: s.connected })),
    status: pod.status,
    ...(pod.winners ? { winners: pod.winners } : {}),
  };
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendToSeat(podId: string, seat: number, msg: ServerMsg): void {
  sockets.get(podId)?.get(seat)?.forEach((ws) => send(ws, msg));
}

function broadcastPod(podId: string, msg: ServerMsg): void {
  sockets.get(podId)?.forEach((set) => set.forEach((ws) => send(ws, msg)));
}

function seatOfToken(pod: PodRecord, token: string): number | null {
  const s = pod.seats.find((x) => x.token === token);
  return s ? s.seat : null;
}

// ---------- REST ----------

// DEV-ONLY auth: mint a bearer token for any name. Not production auth.
fastify.post('/api/auth/dev-login', async (req) => {
  const body = (req.body ?? {}) as { name?: string };
  const name = (body.name ?? 'Player').slice(0, 40);
  const rec = store.issueToken(ulid(), name);
  return { token: rec.token, userId: rec.userId, name };
});

fastify.post('/api/pods', async (req, reply) => {
  const token = authToken(req);
  if (!token || !store.getToken(token)) return reply.code(401).send({ error: 'unauthorized' });
  const body = req.body as CreatePodRequest;
  if (!body || !Array.isArray(body.decks) || body.decks.length === 0) {
    return reply.code(400).send({ error: 'decks[] required' });
  }
  const aiSeats = new Set(body.aiSeats ?? []);
  const seats = body.decks.map((d, i) => ({
    seat: d.seat ?? i,
    name: `Seat ${d.seat ?? i}`,
    isAI: aiSeats.has(d.seat ?? i),
    token: null as string | null,
    connected: false,
    userId: null as string | null,
  }));
  const pod = store.createPod({
    name: body.name ?? `Pod ${new Date().toISOString()}`,
    seats,
    decks: body.decks.map((d, i) => ({ seat: d.seat ?? i, list: d.list, commander: d.commander })),
    seed: body.seed ?? Math.floor(Math.random() * 1_000_000_000),
  });
  return podSummary(pod);
});

fastify.get('/api/pods/:id', async (req, reply) => {
  const pod = store.getPod((req.params as { id: string }).id);
  if (!pod) return reply.code(404).send({ error: 'pod not found' });
  return podSummary(pod);
});

fastify.post('/api/pods/:id/join', async (req, reply) => {
  const token = authToken(req);
  const user = token ? store.getToken(token) : null;
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  const pod = store.getPod((req.params as { id: string }).id);
  if (!pod) return reply.code(404).send({ error: 'pod not found' });
  if (pod.status !== 'lobby') return reply.code(409).send({ error: 'pod already started' });
  const body = (req.body ?? {}) as { seat?: number };
  const seat = pod.seats.find((s) => !s.isAI && !s.token && (body.seat === undefined || s.seat === body.seat));
  if (!seat) return reply.code(409).send({ error: 'no open human seat' });
  const seatToken = ulid();
  store.updatePod(pod.id, {
    seats: pod.seats.map((s) => s.seat === seat.seat
      ? { ...s, token: seatToken, name: user.name, userId: user.userId }
      : s),
  });
  return { seat: seat.seat, seatToken, pod: podSummary(store.getPod(pod.id)!) };
});

fastify.post('/api/pods/:id/start', async (req, reply) => {
  const pod = store.getPod((req.params as { id: string }).id);
  if (!pod) return reply.code(404).send({ error: 'pod not found' });
  if (pod.status !== 'lobby') return reply.code(409).send({ error: 'pod already started' });
  // Validate every deck before starting.
  for (const d of pod.decks) {
    const v = validateDeck(d.list, d.commander, registry);
    if (!v.valid) return reply.code(422).send({ error: 'deck invalid', seat: d.seat, violations: v.violations });
  }
  store.updatePod(pod.id, { status: 'active' });
  const room = GameRoom.create({
    podId: pod.id,
    seats: pod.seats,
    decks: pod.decks,
    seed: pod.seed,
    callbacks: {
      sendTo: (seat, msg) => sendToSeat(pod.id, seat, msg),
      broadcast: (msg) => broadcastPod(pod.id, msg),
      onGameOver: (winners) => store.updatePod(pod.id, { status: 'finished', winners }),
    },
  }, registry);
  rooms.set(pod.id, room);
  // Fire-and-forget: the driver pumps synchronously until the first human prompt.
  room.start().catch((err) => {
    console.error(`[pod ${pod.id}] driver error:`, err);
    broadcastPod(pod.id, { t: 'error', code: 'INTERNAL', message: String(err?.message ?? err) });
  });
  return { ok: true, pod: podSummary(store.getPod(pod.id)!) };
});

fastify.get('/api/pods/:id/replay', async (req, reply) => {
  const pod = store.getPod((req.params as { id: string }).id);
  if (!pod) return reply.code(404).send({ error: 'pod not found' });
  const room = rooms.get(pod.id);
  if (!room) return reply.code(404).send({ error: 'no live game for this pod' });
  // Public replay: full event log. Per-seat filtered replays are a roadmap item;
  // hidden-card names in DRAW events are stripped unless the requester proves a seat.
  const token = authToken(req);
  const seat = token ? seatOfToken(pod, token) : null;
  const events = room.engine.game.events.map(toWireEvent).map((e) =>
    seat === null ? { ...e, payload: stripAllCardNames(e.payload) } : filterEventForSeat(e, seat, room.engine.game),
  );
  return {
    podId: pod.id,
    seed: pod.seed,
    status: pod.status,
    winners: pod.winners,
    chainValid: room.engine.game.verifyChain(),
    events,
  };
});

fastify.get('/api/pods/:id/replay/verify', async (req, reply) => {
  const pod = store.getPod((req.params as { id: string }).id);
  if (!pod) return reply.code(404).send({ error: 'pod not found' });
  const room = rooms.get(pod.id);
  if (!room) return reply.code(404).send({ error: 'no live game for this pod' });
  return { valid: room.engine.game.verifyChain(), eventCount: room.engine.game.events.length };
});

fastify.get('/api/cards', async () => {
  return registry.all().map((d) => ({
    oracleId: d.oracleId, name: d.name, manaCost: d.manaCost, types: d.types,
    colors: d.colors, colorIdentity: d.colorIdentity, oracleText: d.oracleText,
  }));
});

fastify.post('/api/decks/validate', async (req) => {
  const body = (req.body ?? {}) as { list?: string[]; commander?: string[] };
  return validateDeck(body.list ?? [], body.commander, registry);
});

function stripAllCardNames(payload: Record<string, unknown>): Record<string, unknown> {
  const p = { ...payload };
  delete p.card;
  return p;
}

// ---------- deck validation (pure; see validation.ts) ----------

// ---------- WebSocket ----------

const wss = new WebSocketServer({ noServer: true });

interface ConnState {
  podId: string;
  seat: number | null; // null until authed
  authed: boolean;
  fromSeq: number;
}

fastify.server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const m = url.pathname.match(/^\/api\/pods\/([^/]+)\/socket$/);
  if (!m) { socket.destroy(); return; }
  const podId = m[1];
  const fromSeq = Number(url.searchParams.get('fromSeq') ?? -1);
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, { podId, fromSeq: Number.isFinite(fromSeq) ? fromSeq : -1 } as ConnState & { fromSeq: number });
  });
});

wss.on('connection', (ws: WebSocket, req: unknown) => {
  const { podId, fromSeq } = req as { podId: string; fromSeq: number };
  const state: ConnState = { podId, seat: null, authed: false, fromSeq };
  const pod = store.getPod(podId);
  if (!pod) { send(ws, { t: 'error', code: 'NOT_FOUND', message: 'pod not found' }); ws.close(); return; }
  if (!sockets.has(podId)) sockets.set(podId, new Map());

  // Auth timeout: 10s to send {t:'auth'}.
  const authTimer = setTimeout(() => {
    if (!state.authed) {
      send(ws, { t: 'error', code: 'UNAUTHENTICATED', message: 'auth timeout' });
      ws.close();
    }
  }, 10_000);

  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      send(ws, { t: 'error', code: 'INVALID', message: 'not JSON' });
      return;
    }
    void handleClientMsg(ws, state, podId, msg).catch((err) => {
      send(ws, { t: 'error', code: 'INTERNAL', message: String(err?.message ?? err) });
    });
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (state.seat !== null) {
      sockets.get(podId)?.get(state.seat)?.delete(ws);
      const p = store.getPod(podId);
      if (p) {
        const anyoneLeft = [...(sockets.get(podId)?.get(state.seat) ?? [])].length > 0;
        store.updatePod(podId, {
          seats: p.seats.map((s) => (s.seat === state.seat ? { ...s, connected: anyoneLeft } : s)),
        });
      }
    }
  });

  async function handleClientMsg(ws: WebSocket, st: ConnState, pid: string, msg: ClientMsg): Promise<void> {
    const room = rooms.get(pid);
    if (msg.t === 'auth') {
      const p = store.getPod(pid)!;
      const seat = seatOfToken(p, msg.token);
      if (seat === null) {
        send(ws, { t: 'error', code: 'BAD_TOKEN', message: 'unknown seat token' });
        ws.close();
        return;
      }
      st.authed = true;
      st.seat = seat;
      clearTimeout(authTimer);
      if (!sockets.get(pid)!.has(seat)) sockets.get(pid)!.set(seat, new Set());
      sockets.get(pid)!.get(seat)!.add(ws);
      store.updatePod(pid, { seats: p.seats.map((s) => (s.seat === seat ? { ...s, connected: true } : s)) });
      // Reconnect catch-up (contract §7): >500 behind → snapshot (= full view), else missed events.
      // A fresh view always follows auth as the auth acknowledgement (protocol has no authOk type).
      if (room) {
        if (st.fromSeq >= 0 && st.fromSeq < room.lastSeq && !room.needsSnapshot(st.fromSeq)) {
          const missed = room.missedEvents(st.fromSeq)
            .map(toWireEvent)
            .map((e) => filterEventForSeat(e, seat, room.engine.game));
          if (missed.length > 0) send(ws, { t: 'events', fromSeq: st.fromSeq, events: missed });
        } else if (st.fromSeq >= 0 && st.fromSeq < room.lastSeq) {
          send(ws, { t: 'events', fromSeq: st.fromSeq, events: [] }); // snapshot marker: full view follows
        }
        const snap = room.snapshotFor(seat);
        send(ws, { t: 'view', seat, observation: snap.view.observation, legal: snap.view.legal, pendingChoice: snap.view.pendingChoice });
        // If the game is parked awaiting this seat's action (connected after
        // /start, or reconnected), re-send the priority prompt so it can't be missed.
        room.nudge(seat);
      } else {
        send(ws, { t: 'error', code: 'NOT_STARTED', message: 'pod lobby: game not started yet' });
      }
      return;
    }
    if (!st.authed || st.seat === null) {
      send(ws, { t: 'error', code: 'UNAUTHENTICATED', message: 'send auth first' });
      return;
    }
    if (msg.t === 'chat') {
      const now = Date.now();
      const times = (chatTimes.get(ws) ?? []).filter((t) => now - t < 10_000);
      if (times.length >= 5) {
        send(ws, { t: 'error', code: 'RATE_LIMITED', message: 'chat: 5 per 10s' });
        return;
      }
      times.push(now);
      chatTimes.set(ws, times);
      const p = store.getPod(pid)!;
      const name = p.seats[st.seat]?.name ?? `Seat ${st.seat}`;
      broadcastPod(pid, { t: 'chat', from: name, text: String(msg.text).slice(0, 500) });
      return;
    }
    if (msg.t === 'action') {
      if (!room) {
        send(ws, { t: 'error', code: 'NO_GAME', message: 'game has not started' });
        return;
      }
      // Nonce dedup: same (seat, nonce) never executes twice.
      if (store.seenNonce(pid, st.seat, msg.nonce)) return;
      store.recordNonce(pid, st.seat, msg.nonce);
      try {
        await room.applyAction(st.seat, msg.action as GameAction);
      } catch (err) {
        const message = (err as Error).message;
        const code = /priority|turn|phase/i.test(message) ? 'NOT_YOUR_PRIORITY' : 'ILLEGAL_ACTION';
        send(ws, { t: 'error', code, message });
      }
      return;
    }
  }
});

// ---------- boot ----------

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`[cedh-lab server] REST+WS on :${PORT} (dev auth enabled — see README)`);
});
