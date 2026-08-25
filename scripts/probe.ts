/**
 * Shared helpers for the check scripts. Kept separate so both send requests the same way —
 * with an identity, and tolerating the rate limiter rather than being derailed by it.
 */

export const BASE = process.env.CHECK_BASE ?? 'http://envoy:3000';

export function withUser(userId: number, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers ?? {}), 'x-user-id': String(userId) },
  };
}

export interface PostedMessage {
  id: number;
  conversationId: number;
  instance: string;
}

/**
 * Posts a message, waiting out a 429 rather than failing. These scripts generate bursts well
 * above what a human would, so hitting the limiter is expected; treating it as an error would
 * mean the send path could not be measured at all.
 */
export async function postMessage(
  userId: number,
  conversationId: number,
  body: string,
  clientId: string,
): Promise<PostedMessage> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(
      `${BASE}/api/messages`,
      withUser(userId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, body, clientId }),
      }),
    );

    if (res.status === 429) {
      const wait = (Number(res.headers.get('Retry-After')) || 1) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      throw new Error(`POST /api/messages returned ${res.status}: ${await res.text()}`);
    }

    const message = (await res.json()) as { id: number; conversationId: number };
    return { ...message, instance: res.headers.get('x-relay-instance') ?? 'unknown' };
  }
  throw new Error('still rate limited after 5 attempts');
}
