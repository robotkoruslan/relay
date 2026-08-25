import express from 'express';
import { asyncHandler } from '../http/errors.ts';

export const searchRouter = express.Router();

// GET /api/search?q=... — the UI (web/app.js `renderResults`) expects
// [{ conversationId, conversationTitle, body }]. Not implemented yet.
searchRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) {
      res.json([]);
      return;
    }
    res.json([]);
  }),
);
