import crypto from 'node:crypto';
import type { RowDataPacket } from 'mysql2';
import { mongo } from '../db/mongo.ts';
import { config } from '../config.ts';
import { execute, queryOne } from '../db/mysql.ts';
import { HttpError } from '../http/errors.ts';

export interface NewMessage {
  conversationId: number;
  senderId: number;
  body: string;
  clientId: string | null;
}

export interface StoredMessage {
  id: number;
  conversationId: number;
  senderId: number;
  body: string;
  createdAt: Date;
}

export interface CreateMessageResult {
  message: StoredMessage;
  /** True when clientId matched an existing message, so nothing new was stored. */
  deduplicated: boolean;
}

interface MessageRow extends RowDataPacket {
  id: number;
  conversationId: number;
  senderId: number;
  createdAt: Date;
}

export interface MessageBodyDoc {
  _id: number;
  conversationId: number;
  senderId: number;
  body: string;
  signature: string;
  createdAt: Date;
}

export function messageBodies() {
  return mongo().collection<MessageBodyDoc>('message_bodies');
}

/**
 * Integrity tag stored alongside the body, so a body altered directly in Mongo can be told
 * apart from one this service wrote.
 *
 * This was pbkdf2Sync with 200k rounds — a password-hashing primitive doing an integrity job.
 * Two things were wrong with that. It cost ~40ms of synchronous CPU per send on the event loop,
 * which starved every other request on the instance; and with a constant salt and no key it
 * proved nothing, since anyone able to write the record could recompute the value. HMAC is the
 * primitive this actually wanted: keyed, and microseconds.
 *
 * The version prefix means the algorithm can change without every existing row failing
 * verification.
 */
const SIGNATURE_VERSION = 'v2';

export function signBody(body: string): string {
  const mac = crypto.createHmac('sha256', config.messageSigningKey).update(body, 'utf8').digest('hex');
  return `${SIGNATURE_VERSION}:${mac}`;
}

/**
 * Returns null when the signature predates the current scheme, so legacy rows are reported as
 * unverifiable rather than as tampered with.
 */
export function verifyBody(body: string, signature: string | undefined): boolean | null {
  if (!signature?.startsWith(`${SIGNATURE_VERSION}:`)) return null;
  const expected = Buffer.from(signBody(body), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  // Length check first: timingSafeEqual throws on a mismatch rather than returning false.
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function isDuplicateEntry(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ER_DUP_ENTRY';
}

async function findByClientId(
  conversationId: number,
  clientId: string,
): Promise<StoredMessage | undefined> {
  const row = await queryOne<MessageRow>(
    `SELECT id, conversation_id AS conversationId, sender_id AS senderId, created_at AS createdAt
     FROM messages WHERE conversation_id = ? AND client_id = ?`,
    [conversationId, clientId],
  );
  if (!row) return undefined;

  const doc = await messageBodies().findOne({ _id: row.id });
  return { ...row, body: doc?.body ?? '' };
}

export async function createMessage(input: NewMessage): Promise<CreateMessageResult> {
  const { conversationId, senderId, body, clientId } = input;

  const signature = signBody(body);

  // One timestamp, generated here and written to both stores, so the POST response, the
  // WebSocket payload and a later refetch all agree.
  const createdAt = new Date();

  let id: number;
  try {
    const result = await execute(
      `INSERT INTO messages (conversation_id, sender_id, client_id, created_at)
       VALUES (?, ?, ?, ?)`,
      [conversationId, senderId, clientId, createdAt],
    );
    id = result.insertId;
  } catch (err) {
    // A retry or a double-click resends the same clientId. The unique index turns that into a
    // duplicate-key error, which means the message already exists — return it as-is.
    if (clientId !== null && isDuplicateEntry(err)) {
      const existing = await findByClientId(conversationId, clientId);
      if (existing) return { message: existing, deduplicated: true };
    }
    throw err;
  }

  try {
    await messageBodies().insertOne({
      _id: id,
      conversationId,
      senderId,
      body,
      signature,
      createdAt,
    });
  } catch (err) {
    // The row exists but its body does not, and no transaction spans the two stores. Undo the
    // row so the send fails visibly, rather than leaving a message that renders blank forever.
    try {
      await execute('DELETE FROM messages WHERE id = ?', [id]);
    } catch (cleanupErr) {
      console.error(
        `[messages] orphaned row ${id}: body write failed and the row could not be removed`,
        cleanupErr,
      );
    }
    console.error(`[messages] body write failed for ${id}, send rejected`, err);
    throw HttpError.unavailable('message could not be stored, please retry');
  }

  return {
    message: { id, conversationId, senderId, body, createdAt },
    deduplicated: false,
  };
}
