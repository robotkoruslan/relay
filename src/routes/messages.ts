import express from 'express';
import type { RowDataPacket } from 'mysql2';
import { config } from '../config.ts';
import { mongo } from '../db/mongo.ts';
import { queryRows } from '../db/mysql.ts';
import { asyncHandler } from '../http/errors.ts';
import { optionalClientId, requiredId, requiredText } from '../http/validate.ts';
import { createMessage } from '../services/messages.ts';
import { broadcast } from '../ws/hub.ts';

export const messagesRouter = express.Router();

interface MessageRow extends RowDataPacket {
  id: number;
  conversationId: number;
  senderId: number;
  createdAt: Date;
}

interface MessageBodyDoc {
  _id: number;
  body: string;
}

messagesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = (req.body ?? {}) as Record<string, unknown>;

    const message = await createMessage({
      conversationId: requiredId(input.conversationId, 'conversationId'),
      senderId: requiredId(input.senderId, 'senderId'),
      body: requiredText(input.body, 'body', config.maxMessageLength),
      clientId: optionalClientId(input.clientId),
    });

    broadcast(message.conversationId, { type: 'message', ...message });
    res.status(201).json(message);
  }),
);

messagesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const conversationId = requiredId(req.query.conversationId, 'conversationId');

    const rows = await queryRows<MessageRow>(
      `SELECT id, conversation_id AS conversationId, sender_id AS senderId, created_at AS createdAt
       FROM messages WHERE conversation_id = ? ORDER BY id ASC`,
      [conversationId],
    );

    const ids = rows.map((row) => row.id);
    const bodies = ids.length
      ? await mongo()
          .collection<MessageBodyDoc>('message_bodies')
          .find({ _id: { $in: ids } })
          .toArray()
      : [];
    const bodyById = new Map(bodies.map((doc) => [doc._id, doc.body]));

    res.json(rows.map((row) => ({ ...row, body: bodyById.get(row.id) ?? '' })));
  }),
);
