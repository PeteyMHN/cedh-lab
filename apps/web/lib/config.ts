/** Shared client config: where the game server lives. */
export const SERVER_HTTP =
  process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:3001';
export const SERVER_WS =
  process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';

export function podSocketUrl(podId: string, since?: number): string {
  const base = `${SERVER_WS}/api/pods/${encodeURIComponent(podId)}/socket`;
  return since != null && since > 0 ? `${base}?since=${since}` : base;
}
