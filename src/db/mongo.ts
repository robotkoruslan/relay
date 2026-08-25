import { MongoClient, type Db } from 'mongodb';
import { config } from '../config.ts';

const client = new MongoClient(config.mongoUrl, {
  // Fail fast instead of inheriting the driver's 30s default, which turns a dependency
  // outage into a 30s hang on every request that touches Mongo.
  serverSelectionTimeoutMS: config.dbTimeoutMs,
  connectTimeoutMS: config.dbTimeoutMs,
});

let db: Db | undefined;

export async function connectMongo(retries = 20): Promise<Db> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      await client.connect();
      db = client.db();
      return db;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`mongo not reachable after ${retries} attempts: ${String(lastErr)}`);
}

/**
 * Idempotent, so it is safe to run on every boot. The text index is what makes search possible
 * at all; the conversationId index serves the membership filter that scopes it.
 */
export async function ensureMongoIndexes(): Promise<void> {
  const bodies = mongo().collection('message_bodies');
  await bodies.createIndex({ body: 'text' }, { name: 'text_body' });
  await bodies.createIndex({ conversationId: 1 }, { name: 'by_conversation' });
  console.log('[mongo] indexes ensured');
}

export function mongo(): Db {
  if (!db) throw new Error('mongo not connected');
  return db;
}

export async function pingMongo(): Promise<void> {
  await mongo().command({ ping: 1 });
}

export async function closeMongo(): Promise<void> {
  await client.close();
}
