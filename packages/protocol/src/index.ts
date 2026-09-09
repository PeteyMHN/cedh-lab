/**
 * @cedh-lab/protocol — shared wire types for the cEDH Lab server and web client.
 * Re-exports engine choice types and AI observation types so client and server
 * can never drift.
 */
export type { ChoiceRequest, ChoiceSelection, ChoiceOption, ChoiceKind } from '@cedh-lab/engine';
export type { LegalAction } from '@cedh-lab/engine';
export type { Observation } from '@cedh-lab/ai';

// ---------- client -> server ----------
export type GameAction =
  | { kind: 'pass' }
  | { kind: 'cast'; card: string; targets?: string[]; modes?: number[]; namedCard?: string; xValue?: number }
  | { kind: 'activate'; source: string; ability: number; targets?: string[] }
  | { kind: 'playLand'; card: string }
  | { kind: 'declareAttackers'; attackers: string[] }
  | { kind: 'declareBlockers'; blockers: { blocker: string; attacker: string }[] }
  | { kind: 'answerChoice'; choiceId: string; selection: import('@cedh-lab/engine').ChoiceSelection }
  | { kind: 'concede' };

export type ClientMsg =
  | { t: 'auth'; token: string }
  | { t: 'action'; action: GameAction; nonce: string }
  | { t: 'chat'; text: string };

// ---------- server -> client ----------
export interface WireEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  hash: string;
}

export type ServerMsg =
  | { t: 'events'; fromSeq: number; events: WireEvent[] }
  | {
      t: 'view';
      seat: number;
      observation: import('@cedh-lab/ai').Observation;
      legal: import('@cedh-lab/engine').LegalAction[];
      pendingChoice?: import('@cedh-lab/engine').ChoiceRequest | null;
    }
  | { t: 'priority'; seat: number }
  | { t: 'gameOver'; winners: number[] }
  | { t: 'chat'; from: string; text: string }
  | { t: 'error'; code: string; message: string };

// ---------- REST ----------
export interface CreatePodRequest {
  name?: string;
  aiSeats?: number[];
  decks: { seat: number; list: string[]; commander?: string[] }[];
  seed?: number;
}
export interface PodSummary {
  id: string;
  name: string;
  seats: { seat: number; name: string; isAI: boolean; connected: boolean }[];
  status: 'lobby' | 'active' | 'finished';
  winners?: number[];
}
export interface DeckValidation {
  valid: boolean;
  violations: string[];
}
