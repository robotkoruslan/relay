import type { RowDataPacket } from 'mysql2';
import { queryOne, queryRows } from '../db/mysql.ts';
import { HttpError } from '../http/errors.ts';

interface IdRow extends RowDataPacket {
  conversationId: number;
}

interface ExistsRow extends RowDataPacket {
  found: number;
}

export async function participantConversationIds(userId: number): Promise<number[]> {
  const rows = await queryRows<IdRow>(
    'SELECT conversation_id AS conversationId FROM conversation_participants WHERE user_id = ?',
    [userId],
  );
  return rows.map((row) => row.conversationId);
}

export async function isParticipant(userId: number, conversationId: number): Promise<boolean> {
  const row = await queryOne<ExistsRow>(
    `SELECT 1 AS found FROM conversation_participants
     WHERE user_id = ? AND conversation_id = ? LIMIT 1`,
    [userId, conversationId],
  );
  return row !== undefined;
}

/**
 * Answers 404 rather than 403 on purpose: "you are not allowed in here" confirms the
 * conversation exists, which is itself information the caller has no right to. A non-participant
 * and a non-existent conversation are indistinguishable from outside.
 */
export async function assertParticipant(userId: number, conversationId: number): Promise<void> {
  if (!(await isParticipant(userId, conversationId))) {
    throw HttpError.notFound('conversation not found', { conversationId });
  }
}
