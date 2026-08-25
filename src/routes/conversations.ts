import express from 'express';
import type { RowDataPacket } from 'mysql2';
import { config } from '../config.ts';
import { execute, queryRows } from '../db/mysql.ts';
import { asyncHandler } from '../http/errors.ts';
import { callerId } from '../http/identity.ts';
import { requiredId, requiredIdArray, requiredText } from '../http/validate.ts';
import { assertParticipant } from '../services/conversations.ts';

export const conversationsRouter = express.Router();

interface SidebarRow extends RowDataPacket {
  id: number;
  title: string;
  messageCount: number;
  unreadCount: number;
  lastMessageId: number | null;
  lastSenderId: number | null;
  lastCreatedAt: Date | null;
}

conversationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    // Your conversations, not an arbitrary user's: the id comes from the caller, not the query.
    const userId = callerId(req);

    // Previously this issued two extra queries per conversation — 1 + 2N round trips, each of
    // them a full table scan. The correlated subqueries below run inside the database and are
    // served by the (conversation_id, id) index: a backward seek for the newest id, an
    // index-only scan for the count.
    const rows = await queryRows<SidebarRow>(
      `SELECT c.id,
              c.title,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS messageCount,
              (SELECT COUNT(*) FROM messages m
                WHERE m.conversation_id = c.id
                  AND m.id > COALESCE(p.last_read_message_id, 0)
                  AND m.sender_id <> p.user_id)                                AS unreadCount,
              lm.id         AS lastMessageId,
              lm.sender_id  AS lastSenderId,
              lm.created_at AS lastCreatedAt
       FROM conversations c
       JOIN conversation_participants p ON p.conversation_id = c.id
       LEFT JOIN messages lm
              ON lm.id = (SELECT MAX(m2.id) FROM messages m2 WHERE m2.conversation_id = c.id)
       WHERE p.user_id = ?
       ORDER BY c.id ASC`,
      [userId],
    );

    res.json(
      rows.map((row) => ({
        id: row.id,
        title: row.title,
        messageCount: Number(row.messageCount),
        unreadCount: Number(row.unreadCount),
        lastMessage:
          row.lastMessageId === null
            ? null
            : { id: row.lastMessageId, senderId: row.lastSenderId, createdAt: row.lastCreatedAt },
      })),
    );
  }),
);

conversationsRouter.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const userId = callerId(req);
    const conversationId = requiredId(req.params.id, 'id');
    await assertParticipant(userId, conversationId);

    const input = (req.body ?? {}) as Record<string, unknown>;
    const messageId = requiredId(input.messageId, 'messageId');

    // GREATEST keeps the cursor monotonic. Two tabs, or requests arriving out of order, would
    // otherwise move it backwards and resurrect messages the user has already read.
    await execute(
      `UPDATE conversation_participants
       SET last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), ?)
       WHERE conversation_id = ? AND user_id = ?`,
      [messageId, conversationId, userId],
    );

    res.status(204).end();
  }),
);

conversationsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = (req.body ?? {}) as Record<string, unknown>;

    const userId = callerId(req);
    const title = requiredText(input.title, 'title', config.maxTitleLength);
    // The creator is always a participant, otherwise it is possible to create a conversation
    // that the creator cannot then read.
    const participantIds = [...new Set([userId, ...requiredIdArray(input.participantIds, 'participantIds')])];

    const created = await execute('INSERT INTO conversations (title) VALUES (?)', [title]);
    const id = created.insertId;

    // One statement instead of one per participant.
    await execute(
      `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ${participantIds
        .map(() => '(?, ?)')
        .join(', ')}`,
      participantIds.flatMap((participantId) => [id, participantId]),
    );

    res.status(201).json({ id, title, participantIds });
  }),
);
