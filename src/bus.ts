import Redis, { type RedisOptions } from 'ioredis';
import { config } from './config.ts';

/**
 * Fan-out across API instances.
 *
 * The WebSocket hub can only reach sockets held by its own process, so with more than one
 * instance a send only reached the fraction of clients that happened to be connected to the
 * instance handling the POST. Redis pub/sub carries the event to every instance instead.
 *
 * Note that the publisher does not deliver to its own clients directly: it publishes, and its
 * own subscriber delivers along with everyone else's. One path for every instance, so there is
 * no double-delivery case to reason about.
 */

const CHANNEL = 'relay:events';

export interface MessageEvent {
  type: 'message';
  conversationId: number;
  id: number;
  senderId: number;
  body: string;
  createdAt: string;
}

export interface TypingEvent {
  type: 'typing';
  conversationId: number;
  userId: number;
  /** False signals that the user stopped, so the indicator can clear without waiting to expire. */
  active: boolean;
}

export type BusEvent = MessageEvent | TypingEvent;

const options: RedisOptions = {
  // Fail a command immediately when Redis is unreachable instead of queueing it. Queueing would
  // make a send hang on a dependency that is not required for correctness.
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: config.dbTimeoutMs,
  retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
};

/** Commands and publishing. A subscribed connection cannot issue anything else, hence two. */
export const redis = new Redis(config.redisUrl, options);
const subscriber = new Redis(config.redisUrl, options);

// ioredis is an EventEmitter: an unhandled 'error' would be thrown and kill the process.
redis.on('error', (err: Error) => console.error('[bus] redis error', err.message));
subscriber.on('error', (err: Error) => console.error('[bus] subscriber error', err.message));

type Handler = (event: BusEvent) => void;
const handlers = new Set<Handler>();

export function onBusEvent(handler: Handler): void {
  handlers.add(handler);
}

function dispatch(event: BusEvent): void {
  for (const handler of handlers) {
    try {
      handler(event);
    } catch (err) {
      console.error('[bus] handler threw', err);
    }
  }
}

/** Resolves when the client is usable, or after the timeout. Never rejects: see connectBus. */
function waitReady(client: Redis, label: string, timeoutMs: number): Promise<boolean> {
  if (client.status === 'ready') return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ready: boolean) => {
      clearTimeout(timer);
      client.off('ready', onReady);
      resolve(ready);
    };
    const onReady = () => done(true);
    const timer = setTimeout(() => {
      console.error(`[bus] ${label} not ready after ${timeoutMs}ms, continuing degraded`);
      done(false);
    }, timeoutMs);
    client.once('ready', onReady);
  });
}

export async function connectBus(): Promise<void> {
  subscriber.on('message', (_channel: string, raw: string) => {
    try {
      dispatch(JSON.parse(raw) as BusEvent);
    } catch (err) {
      console.error('[bus] undecodable event dropped', err);
    }
  });

  // Subscribe on every 'ready', which covers both the first connection and every reconnect
  // after an outage. Subscribing to a channel already subscribed to is a no-op.
  const subscribeNow = () => {
    subscriber.subscribe(CHANNEL).then(
      () => console.log('[bus] subscribed to', CHANNEL),
      (err: Error) => console.error('[bus] subscribe failed', err.message),
    );
  };
  subscriber.on('ready', subscribeNow);
  if (subscriber.status === 'ready') subscribeNow();

  // Wait for both connections so a normal boot has a working bus before the first request —
  // with enableOfflineQueue off, a command issued mid-connect fails immediately. But never
  // fail startup: Redis is an optional dependency, and refusing to boot without it would turn
  // a degraded fan-out into a total outage.
  await Promise.all([
    waitReady(redis, 'command connection', config.dbTimeoutMs),
    waitReady(subscriber, 'subscriber', config.dbTimeoutMs),
  ]);
}

/** Used by tests, which must not race the initial connection. */
export function busReady(timeoutMs = 5000): Promise<boolean> {
  return waitReady(redis, 'command connection', timeoutMs);
}

export async function emit(event: BusEvent): Promise<void> {
  try {
    await redis.publish(CHANNEL, JSON.stringify(event));
  } catch (err) {
    // The message is already durable, so refusing the send would be worse than a degraded
    // delivery. Fall back to this instance's own clients; everyone else's client closes the gap
    // when it reconnects and refetches.
    console.error('[bus] publish failed, delivering locally only', err);
    dispatch(event);
  }
}

export async function closeBus(): Promise<void> {
  await Promise.allSettled([redis.quit(), subscriber.quit()]);
}

export async function pingRedis(): Promise<void> {
  await redis.ping();
}
