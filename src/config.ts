function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var ${name} (copy .env.example to .env)`);
  }
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`env var ${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export const config = {
  port: positiveInt('PORT', 3000),

  mysqlUrl: required('MYSQL_URL'),
  mongoUrl: required('MONGO_URL'),
  redisUrl: required('REDIS_URL'),

  /**
   * Ceiling on how long a single database call may take. Without this the Mongo driver's
   * 30s server-selection default decides how long a request hangs before failing.
   */
  dbTimeoutMs: positiveInt('DB_TIMEOUT_MS', 5000),

  /** Cap on the raw JSON envelope; individual fields are checked at the route boundary. */
  jsonBodyLimit: process.env.JSON_BODY_LIMIT || '64kb',
  maxMessageLength: positiveInt('MAX_MESSAGE_LENGTH', 4000),
  /** Mirrors conversations.title VARCHAR(200) — a longer value would be silently truncated. */
  maxTitleLength: positiveInt('MAX_TITLE_LENGTH', 200),
  /** Mirrors messages.client_id VARCHAR(64). */
  maxClientIdLength: 64,

  /** How long to let in-flight work finish after SIGTERM before exiting anyway. */
  shutdownTimeoutMs: positiveInt('SHUTDOWN_TIMEOUT_MS', 10_000),
};
