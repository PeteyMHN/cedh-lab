#!/usr/bin/env node
/**
 * cEDH Lab — mock game server for web client development.
 *
 * HOW TO RUN (from apps/web):
 *   npm run mock-server          # listens on http://localhost:3001
 *
 * WHAT IT COVERS:
 *   REST
 *     POST /api/pods            -> { id:'pod1', ...PodSummary }
 *     GET  /api/pods/:id        -> PodSummary
 *     POST /api/pods/:id/join   -> { seatToken:'tok0', seat:0 }
 *     POST /api/pods/:id/start  -> { ok:true }
 *     GET  /api/cards           -> [{ name, manaCost, typeLine, oracleText }] from the real
 *                                   card pool (CARD_DEFS in packages/cards/src/cards.ts,
 *                                   extracted from source — never hard-copied)
 *   WS at /api/pods/:id/socket
 *     client { t:'auth', token }  -> canned 'view' (seat 0: hand Island/Brainstorm/Counterspell
 *                                      w/ defs, battlefield Island + seat-2 Mystic Remora,
 *                                      stack w/ one triggered Rhystic Study object,
 *                                      opponents counts-only, priorityPlayer 0,
 *                                      phase 'precombatMain'), 'legal' (pass / cast Brainstorm /
 *                                      activate Island), then { t:'priority', seat:0 }
 *     client { t:'action', ... }  -> plausible 'events' batch (seq++), then an updated 'view'
 *     client { t:'chat', text }   -> broadcast { t:'chat', from, text } to all sockets on the pod
 *     malformed JSON              -> { t:'error', code:'BAD_JSON', message }
 *     ?since=<seq> query param is accepted and logged (resync hook for the real server)
 *
 * This is a dev stub only — it is NOT bundled and does not implement game rules.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MOCK_PORT ?? 3001);

// ---------------------------------------------------------------------------
// Card data: extracted live from packages/cards/src/cards.ts (CARD_DEFS array)
// ---------------------------------------------------------------------------
// Node type-stripping can't resolve the `.js`-style intra-package specifiers
// inside cards.ts, so instead of importing the module we extract the pure-data
// CARD_DEFS array literal from source and evaluate it with a stub `def()`.
// This keeps the mock's card data identical to the real pool without copying.
function loadCardDefs() {
  const src = readFileSync(join(__dirname, '../../../packages/cards/src/cards.ts'), 'utf8');
  const marker = 'export const CARD_DEFS';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('CARD_DEFS not found in cards.ts');
  const eq = src.indexOf('=', start);
  if (eq < 0) throw new Error('CARD_DEFS initializer not found in cards.ts');
  const arrStart = src.indexOf('[', eq);
  if (arrStart < 0) throw new Error('CARD_DEFS array literal not found in cards.ts');
  // Bracket-match to the closing `]`, skipping strings/comments.
  let depth = 0, i = arrStart, inStr = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") {
      inStr = ch;
    } else if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const literal = src.slice(arrStart, i + 1);
  const def = (d) => d; // identity stub: CARD_DEFS entries are def({...})
  // eslint-disable-next-line no-new-func
  return new Function('def', `return ${literal}`)(def);
}

const CARD_DEFS = loadCardDefs();
const defById = new Map(CARD_DEFS.map((d) => [d.oracleId, d]));

function typeLine(d) {
  const parts = [...(d.supertypes ?? []), ...(d.types ?? [])];
  const sub = (d.subtypes ?? []).join(' ');
  return sub ? `${parts.join(' ')} — ${sub}` : parts.join(' ');
}

const cardIndex = CARD_DEFS.map((d) => ({
  oracleId: d.oracleId,
  name: d.name,
  manaCost: d.manaCost ?? '',
  typeLine: typeLine(d),
  oracleText: d.oracleText,
}));
console.log(`[mock] loaded ${cardIndex.length} card defs from packages/cards`);

// ---------------------------------------------------------------------------
// Pod state
// ---------------------------------------------------------------------------
const pods = new Map();
function getPod(id) {
  if (!pods.has(id)) {
    pods.set(id, {
      summary: {
        id,
        name: 'Mock Pod',
        seats: [
          { seat: 0, name: 'You', isAI: false, connected: false },
          { seat: 1, name: 'AI Ada', isAI: true, connected: true },
          { seat: 2, name: 'AI Bob', isAI: true, connected: true },
          { seat: 3, name: 'AI Cat', isAI: true, connected: true },
        ],
        status: 'lobby',
      },
      seq: 0,
      sockets: new Set(),
    });
  }
  return pods.get(id);
}
const nextSeq = (pod) => ++pod.seq;
const hashOf = (s) => `mock-${s}`;

// ---------------------------------------------------------------------------
// Canned game view (seat 0)
// ---------------------------------------------------------------------------
function handCard(id, oracleId) {
  const d = defById.get(oracleId);
  return { id, name: d.name, oracleId, def: d };
}

function cannedView(pod) {
  const belief = (player, handCount, tappedOut) => ({
    player, handCount, knownCards: [], manaAvailable: tappedOut ? 0 : 2,
    openManaColors: ['U'], pInteraction: 0.25, pWinAttemptNextTurn: 0.1, tappedOut,
  });
  return {
    t: 'view',
    seat: 0,
    observation: {
      self: 0, turn: 3, phase: 'precombatMain', activePlayer: 0, priorityPlayer: 0,
      life: [40, 40, 40, 40],
      hand: [handCard('h1', 'island'), handCard('h2', 'brainstorm'), handCard('h3', 'counterspell')],
      battlefield: [
        { id: 'b1', name: 'Island', controller: 0, tapped: false },
        { id: 'b2', name: 'Mystic Remora', controller: 2, tapped: false },
      ],
      graveyards: [[], [], [], []],
      stack: [{ cardName: 'Rhystic Study', controller: 1, kind: 'triggered', targets: [] }],
      opponents: [belief(1, 5, false), belief(2, 4, true), belief(3, 6, false)],
      libraryCount: 90,
      manaPool: { U: 1 },
      decklist: [],
      commanders: [],
    },
    legal: [
      { kind: 'pass', label: 'Pass priority' },
      { kind: 'cast', label: 'Cast Brainstorm', objectId: 'h2' },
      { kind: 'activate', label: 'Activate Island: Add {U}', objectId: 'b1', abilityIndex: 0 },
    ],
    pendingChoice: null,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;
  const podMatch = pathname.match(/^\/api\/pods\/([^/]+)(\/(join|start|replay))?$/);

  try {
    if (req.method === 'POST' && pathname === '/api/pods') {
      const body = await readBody(req);
      const pod = getPod('pod1');
      pod.summary.name = body.name ?? 'Mock Pod';
      pod.summary.status = 'lobby';
      return json(res, 200, pod.summary);
    }
    if (podMatch && req.method === 'GET' && !podMatch[3]) {
      return json(res, 200, getPod(podMatch[1]).summary);
    }
    if (podMatch && podMatch[3] === 'join' && req.method === 'POST') {
      const pod = getPod(podMatch[1]);
      pod.summary.seats[0].connected = true;
      return json(res, 200, { seatToken: 'tok0', seat: 0 });
    }
    if (podMatch && podMatch[3] === 'start' && req.method === 'POST') {
      const pod = getPod(podMatch[1]);
      pod.summary.status = 'active';
      return json(res, 200, { ok: true });
    }
    if (podMatch && podMatch[3] === 'replay' && req.method === 'GET') {
      return json(res, 200, { events: [], fromSeq: 0 });
    }
    if (req.method === 'GET' && pathname === '/api/cards') {
      return json(res, 200, cardIndex);
    }
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[mock] http error', err);
    return json(res, 500, { error: 'internal' });
  }
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const m = url.pathname.match(/^\/api\/pods\/([^/]+)\/socket$/);
  if (!m) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const pod = getPod(m[1]);
    const since = url.searchParams.get('since');
    console.log(`[mock] ws connected pod=${m[1]} since=${since ?? 'none'}`);
    pod.sockets.add(ws);
    ws.on('close', () => {
      pod.sockets.delete(ws);
      console.log(`[mock] ws closed pod=${m[1]}`);
    });
    ws.on('message', (raw) => handleClientMsg(pod, ws, String(raw)));
  });
});

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(pod, msg, except) {
  for (const ws of pod.sockets) {
    if (ws !== except) send(ws, msg);
  }
}

function handleClientMsg(pod, ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    console.log('[mock] malformed JSON from client');
    return send(ws, { t: 'error', code: 'BAD_JSON', message: 'Could not parse message as JSON.' });
  }
  console.log('[mock] <-', msg.t, msg.t === 'action' ? JSON.stringify(msg.action) : '');

  if (msg.t === 'auth') {
    // Canned opening: view, then priority prompt.
    send(ws, cannedView(pod));
    send(ws, { t: 'priority', seat: 0 });
    return;
  }

  if (msg.t === 'action') {
    const a = msg.action ?? {};
    const s1 = nextSeq(pod);
    const s2 = nextSeq(pod);
    const events = [
      { seq: s1, type: 'ACTION', payload: { kind: a.kind ?? 'pass', nonce: msg.nonce ?? null }, hash: hashOf(s1) },
    ];
    if (a.kind === 'cast') {
      events.push({ seq: s2, type: 'CAST', payload: { player: 0, card: 'Brainstorm' }, hash: hashOf(s2) });
    } else {
      events.push({ seq: s2, type: 'PASS', payload: { player: 0 }, hash: hashOf(s2) });
    }
    send(ws, { t: 'events', fromSeq: s1, events });
    // Follow with an updated view (Brainstorm leaves hand onto the stack).
    const view = cannedView(pod);
    if (a.kind === 'cast') {
      view.observation.hand = view.observation.hand.filter((c) => c.id !== 'h2');
      view.observation.stack.unshift({ cardName: 'Brainstorm', controller: 0, kind: 'spell', targets: [] });
      view.legal = [
        { kind: 'pass', label: 'Pass priority' },
        { kind: 'activate', label: 'Activate Island: Add {U}', objectId: 'b1', abilityIndex: 0 },
      ];
    }
    send(ws, view);
    return;
  }

  if (msg.t === 'chat') {
    broadcast(pod, { t: 'chat', from: 'seat0', text: String(msg.text ?? '') });
    return;
  }

  send(ws, { t: 'error', code: 'UNKNOWN_MSG', message: `Unknown message type: ${msg.t}` });
}

server.listen(PORT, () => {
  console.log(`[mock] cEDH Lab mock server listening on http://localhost:${PORT}`);
});
