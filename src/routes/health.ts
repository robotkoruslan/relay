import express from 'express';
import { config } from '../config.ts';
import { pingMongo } from '../db/mongo.ts';
import { pingMysql } from '../db/mysql.ts';
import { isDraining, withTimeout } from '../lifecycle.ts';
import { asyncHandler } from '../http/errors.ts';

export const healthRouter = express.Router();

async function check(name: string, probe: () => Promise<unknown>): Promise<[string, string]> {
  try {
    await withTimeout(probe(), config.dbTimeoutMs, name);
    return [name, 'ok'];
  } catch (err) {
    return [name, err instanceof Error ? err.message : String(err)];
  }
}

healthRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    // Reported unhealthy as soon as SIGTERM arrives, so the proxy can stop sending traffic
    // here while in-flight requests finish draining.
    if (isDraining()) {
      res.status(503).json({ status: 'draining' });
      return;
    }

    const results = await Promise.all([
      check('mysql', pingMysql),
      check('mongo', pingMongo),
    ]);

    const checks = Object.fromEntries(results);
    const healthy = results.every(([, status]) => status === 'ok');
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', checks });
  }),
);
