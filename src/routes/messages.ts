import express from 'express';
import type { RowDataPacket } from 'mysql2';
import { config } from '../config.ts';
import { queryRows } from '../db/mysql.ts';
import { asyncHandler } from '../http/errors.ts';
import { limit, optionalClientId, optionalId, requiredId, requiredText } from '../http/validate.ts';
import { createMessage, messageBodies } from '../services/messages.ts';
import { broadcast } from '../ws/hub.ts';

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

    const { message, deduplicated } = await createMessage({
      conversationId: requiredId(input.conversationId, 'conversationId'),
      senderId: requiredId(input.senderId, 'senderId'),
      body: requiredText(input.body, 'body', config.maxMessageLength),
      clientId: optionalClientId(input.clientId),
    });

    if (deduplicated) {
      // The same clientId already produced this message. Nothing was stored and nothing was
      // broadcast the first time round either, so 200 rather than 201 and no second event.
      res.status(200).json(message);
      return;
    }

    broadcast(message.conversationId, { type: 'message', ...message });
    res.status(201).json(message);
  }),
);

messagesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const conversationId = requiredId(req.query.conversationId, 'conversationId');
    const before = optionalId(req.query.before, 'before');
    const pageSize = limit(req.query.limit, 'limit', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    // Keyset pagination on the primary key rather than OFFSET: it stays cheap on deep pages and
    // cannot skip or repeat rows when new messages arrive mid-scroll.
    const rows = await queryRows<MessageRow>(
      `SELECT id, conversation_id AS conversationId, sender_id AS senderId, created_at AS createdAt
       FROM messages
       WHERE conversation_id = ?${before === undefined ? '' : ' AND id < ?'}
       ORDER BY id DESC
       LIMIT ?`,
      before === undefined ? [conversationId, pageSize] : [conversationId, before, pageSize],
    );

    // Fetched newest-first so the newest page is the cheap one; returned oldest-first because
    // that is the order the transcript renders in.
    rows.reverse();

    const ids = rows.map((row) => row.id);
    const bodies = ids.length
      ? await messageBodies()
          .find({ _id: { $in: ids } }, { projection: { body: 1 } })
          .toArray()
      : [];
    const bodyById = new Map(bodies.map((doc) => [doc._id, doc.body]));

    res.json({
      messages: rows.map((row) => ({ ...row, body: bodyById.get(row.id) ?? '' })),
      // Cursor for the next older page; absent once the oldest message has been returned.
      nextBefore: rows.length === pageSize ? rows[0]?.id : null,
    });
  }),
);
