import express from 'express';
import type { RowDataPacket } from 'mysql2';
import { queryRows } from '../db/mysql.ts';
import { asyncHandler } from '../http/errors.ts';
import { callerId } from '../http/identity.ts';
import { limit } from '../http/validate.ts';
import { snippet } from '../search/snippet.ts';
import { participantConversationIds } from '../services/conversations.ts';
import { messageBodies } from '../services/messages.ts';

export const searchRouter = express.Router();

const DEFAULT_RESULTS = 25;
const MAX_RESULTS = 100;

interface TitleRow extends RowDataPacket {
  id: number;
  title: string;
}

interface ScoredBody {
  _id: number;
  conversationId: number;
  senderId: number;
  body: string;
  createdAt: Date;
  score: number;
}

// GET /api/search?q=... — the UI (web/app.js `renderResults`) expects at least
// { conversationId, conversationTitle, body }. messageId and createdAt ride along so a result
// can be opened at the right place in the transcript.
searchRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = callerId(req);
    const q = String(req.query.q ?? '').trim();
    if (!q) {
      res.json([]);
      return;
    }
    const max = limit(req.query.limit, 'limit', DEFAULT_RESULTS, MAX_RESULTS);

    // Scoped to the caller's own conversations. An unscoped text search over every body in the
    // system would be a read primitive for the entire corpus, which is worse than the missing
    // read checks it would sit next to.
    const conversationIds = await participantConversationIds(userId);
    if (conversationIds.length === 0) {
      res.json([]);
      return;
    }

    const docs = (await messageBodies()
      .find(
        { conversationId: { $in: conversationIds }, $text: { $search: q } },
        {
          projection: {
            body: 1,
            conversationId: 1,
            senderId: 1,
            createdAt: 1,
            score: { $meta: 'textScore' },
          },
        },
      )
      .sort({ score: { $meta: 'textScore' } })
      .limit(max)
      .toArray()) as unknown as ScoredBody[];

    if (docs.length === 0) {
      res.json([]);
      return;
    }

    // Titles live in MySQL while bodies live in Mongo, so one join per result set, not per result.
    const ids = [...new Set(docs.map((doc) => doc.conversationId))];
    const titles = await queryRows<TitleRow>(
      `SELECT id, title FROM conversations WHERE id IN (${ids.map(() => '?').join(', ')})`,
      ids,
    );
    const titleById = new Map(titles.map((row) => [row.id, row.title]));

    res.json(
      docs.map((doc) => ({
        messageId: doc._id,
        conversationId: doc.conversationId,
        conversationTitle: titleById.get(doc.conversationId) ?? null,
        senderId: doc.senderId,
        createdAt: doc.createdAt,
        body: snippet(doc.body, q),
      })),
    );
  }),
);
