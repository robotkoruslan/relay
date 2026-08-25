import express from 'express';
import type { RowDataPacket } from 'mysql2';
import { config } from '../config.ts';
import { execute, queryOne, queryRows } from '../db/mysql.ts';
import { asyncHandler } from '../http/errors.ts';
import { requiredId, requiredIdArray, requiredText } from '../http/validate.ts';

export const conversationsRouter = express.Router();

interface ConversationRow extends RowDataPacket {
  id: number;
  title: string;
}

interface LastMessageRow extends RowDataPacket {
  id: number;
  senderId: number;
  createdAt: Date;
}

interface CountRow extends RowDataPacket {
  count: number;
}

conversationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = requiredId(req.query.userId, 'userId');

    const conversations = await queryRows<ConversationRow>(
      `SELECT c.id, c.title
       FROM conversations c
       JOIN conversation_participants p ON p.conversation_id = c.id
       WHERE p.user_id = ?
       ORDER BY c.id ASC`,
      [userId],
    );

    const result = [];
    for (const conversation of conversations) {
      const last = await queryOne<LastMessageRow>(
        `SELECT id, sender_id AS senderId, created_at AS createdAt
         FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1`,
        [conversation.id],
      );
      const counted = await queryOne<CountRow>(
        'SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?',
        [conversation.id],
      );
      result.push({
        ...conversation,
        lastMessage: last ?? null,
        messageCount: counted?.count ?? 0,
      });
    }

    res.json(result);
  }),
);

conversationsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body: unknown = req.body;
    const input = (body ?? {}) as Record<string, unknown>;

    const title = requiredText(input.title, 'title', config.maxTitleLength);
    const participantIds = requiredIdArray(input.participantIds, 'participantIds');

    const created = await execute('INSERT INTO conversations (title) VALUES (?)', [title]);
    const id = created.insertId;

    for (const participantId of participantIds) {
      await execute(
        'INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)',
        [id, participantId],
      );
    }

    res.status(201).json({ id, title, participantIds });
  }),
);
