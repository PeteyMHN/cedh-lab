/**
 * apps/web protocol surface.
 *
 * Type-only re-exports from '@cedh-lab/protocol' so the web client can never
 * drift from the server wire format, without pulling any engine/AI runtime
 * code into the client bundle. Import types from here, never from the
 * package directly, and never runtime-import engine/AI modules.
 */
import type {
  GameAction,
  ClientMsg,
  ServerMsg,
  WireEvent,
  PodSummary,
  CreatePodRequest,
  DeckValidation,
  Observation,
  LegalAction,
  ChoiceRequest,
  ChoiceSelection,
  ChoiceOption,
  ChoiceKind,
} from '@cedh-lab/protocol';

export type {
  GameAction,
  ClientMsg,
  ServerMsg,
  WireEvent,
  PodSummary,
  CreatePodRequest,
  DeckValidation,
  Observation,
  LegalAction,
  ChoiceRequest,
  ChoiceSelection,
  ChoiceOption,
  ChoiceKind,
};

/**
 * Create a client nonce for `{ t: 'action' }` messages (idempotency key).
 * Client-side only — safe to call in event handlers / components.
 */
export function newNonce(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for very old runtimes (never hit in practice).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
