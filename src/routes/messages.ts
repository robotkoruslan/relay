import express from 'express';
import type { RowDataPacket } from 'mysql2';
import { config } from '../config.ts';
import { queryRows } from '../db/mysql.ts';
import { asyncHandler, HttpError } from '../http/errors.ts';
import { callerId } from '../http/identity.ts';
import { assertParticipant } from '../services/conversations.ts';
import { limit, optionalClientId, optionalId, requiredId, requiredText } from '../http/validate.ts';
import { createMessage, messageBodies, verifyBody } from '../services/messages.ts';
import { emit } from '../bus.ts';
import { checkLimit, sendKey } from '../rate-limit.ts';

export const messagesRouter = express.Router();

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

interface MessageRow extends RowDataPacket {
  id: number;
  conversationId: number;
  senderId: number;
  createdAt: Date;
}

messagesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = (req.body ?? {}) as Record<string, unknown>;

    // Validate before consulting the limiter, so a malformed request does not spend quota.
    const senderId = callerId(req);
    const conversationId = requiredId(input.conversationId, 'conversationId');
    const body = requiredText(input.body, 'body', config.maxMessageLength);

    // Previously senderId came from the body, so anyone could post as anyone, into any
    // conversation, without being in it.
    await assertParticipant(senderId, conversationId);
    const clientId = optionalClientId(input.clientId);

    const limit = await checkLimit(sendKey(senderId, conversationId));
    res.setHeader('RateLimit-Limit', String(limit.limit));
    res.setHeader('RateLimit-Remaining', String(limit.remaining));
    if (!limit.allowed) {
      // Whole seconds, and never zero: Retry-After: 0 invites an immediate retry that is
      // certain to be refused as well.
      const retryAfter = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
      throw HttpError.tooManyRequests(
        `too many messages in this conversation, retry in ${retryAfter}s`,
        { limit: limit.limit, windowMs: config.rateLimitWindowMs, retryAfterMs: limit.retryAfterMs },
        { 'Retry-After': String(retryAfter) },
      );
    }

    const { message, deduplicated } = await createMessage({
      conversationId,
      senderId,
      body,
      clientId,
    });

    if (deduplicated) {
      // The same clientId already produced this message. Nothing was stored and nothing was
      // broadcast the first time round either, so 200 rather than 201 and no second event.
      res.status(200).json(message);
      return;
    }

    await emit({
      type: 'message',
      conversationId: message.conversationId,
      id: message.id,
      senderId: message.senderId,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
    });
    res.status(201).json(message);
  }),
);

messagesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const conversationId = requiredId(req.query.conversationId, 'conversationId');
    await assertParticipant(callerId(req), conversationId);
    const before = optionalId(req.query.before, 'before');
    const around = optionalId(req.query.around, 'around');
    const pageSize = limit(req.query.limit, 'limit', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const columns =
      'id, conversation_id AS conversationId, sender_id AS senderId, created_at AS createdAt';

    let rows: MessageRow[];
    let olderPageWasFull: boolean;

    if (around !== undefined) {
      // Opening a search hit: centre the page on that message instead of returning the newest
      // page, which would not contain it. Two seeks, both on (conversation_id, id).
      const olderSize = Math.ceil(pageSize / 2);
      const [older, newer] = await Promise.all([
        queryRows<MessageRow>(
          `SELECT ${columns} FROM messages
           WHERE conversation_id = ? AND id <= ? ORDER BY id DESC LIMIT ?`,
          [conversationId, around, olderSize],
        ),
        queryRows<MessageRow>(
          `SELECT ${columns} FROM messages
           WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
          [conversationId, around, pageSize - olderSize],
        ),
      ]);
      older.reverse();
      rows = [...older, ...newer];
      olderPageWasFull = older.length === olderSize;
    } else {
      // Keyset pagination on the primary key rather than OFFSET: it stays cheap on deep pages
      // and cannot skip or repeat rows when new messages arrive mid-scroll.
      rows = await queryRows<MessageRow>(
        `SELECT ${columns} FROM messages
         WHERE conversation_id = ?${before === undefined ? '' : ' AND id < ?'}
         ORDER BY id DESC
         LIMIT ?`,
        before === undefined ? [conversationId, pageSize] : [conversationId, before, pageSize],
      );
      // Fetched newest-first so the newest page is the cheap one; returned oldest-first because
      // that is the order the transcript renders in.
      rows.reverse();
      olderPageWasFull = rows.length === pageSize;
    }

    const ids = rows.map((row) => row.id);
    const bodies = ids.length
      ? await messageBodies()
          .find({ _id: { $in: ids } }, { projection: { body: 1, signature: 1 } })
          .toArray()
      : [];
    const bodyById = new Map(bodies.map((doc) => [doc._id, doc.body]));

    // The integrity tag was written but never checked, which made it decorative. Verifying is
    // a few microseconds per message now that it is an HMAC. A failure is logged rather than
    // hidden from the reader, since the body is still the best copy available.
    for (const doc of bodies) {
      if (verifyBody(doc.body, doc.signature) === false) {
        console.error(`[messages] signature mismatch on message ${doc._id}`);
      }
    }

    res.json({
      messages: rows.map((row) => ({ ...row, body: bodyById.get(row.id) ?? '' })),
      // Cursor for the next older page; null once the oldest message has been returned.
      nextBefore: olderPageWasFull ? (rows[0]?.id ?? null) : null,
    });
  }),
);
