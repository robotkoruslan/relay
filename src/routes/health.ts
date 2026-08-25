import express from 'express';
import { pingRedis } from '../bus.ts';
import { config } from '../config.ts';
import { pingMongo } from '../db/mongo.ts';
import { pingMysql } from '../db/mysql.ts';
import { asyncHandler } from '../http/errors.ts';
import { isDraining, withTimeout } from '../lifecycle.ts';

export const healthRouter = express.Router();

/**
 * Required dependencies decide the status code, because the proxy uses it to route. Redis is
 * deliberately not one of them: without it messages are still stored and still delivered to
 * clients on the same instance, so failing the health check would take the whole service out
 * of rotation over a degradation. It is reported instead.
 */
const required = { mysql: pingMysql, mongo: pingMongo };
const optional = { redis: pingRedis };

async function probe(name: string, run: () => Promise<unknown>): Promise<[string, string]> {
  try {
    await withTimeout(run(), config.dbTimeoutMs, name);
    return [name, 'ok'];
  } catch (err) {
    return [name, err instanceof Error ? err.message : String(err)];
  }
}

async function runAll(checks: Record<string, () => Promise<unknown>>) {
  return Promise.all(Object.entries(checks).map(([name, run]) => probe(name, run)));
}

healthRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    // Reported unhealthy as soon as SIGTERM arrives, so the proxy stops sending work here
    // while in-flight requests drain.
    if (isDraining()) {
      res.status(503).json({ status: 'draining', instance: config.instanceId });
      return;
    }

    const [requiredResults, optionalResults] = await Promise.all([runAll(required), runAll(optional)]);

    const healthy = requiredResults.every(([, status]) => status === 'ok');
    const degraded = optionalResults.some(([, status]) => status !== 'ok');

    res.status(healthy ? 200 : 503).json({
      status: !healthy ? 'unhealthy' : degraded ? 'degraded' : 'ok',
      instance: config.instanceId,
      checks: Object.fromEntries([...requiredResults, ...optionalResults]),
    });
  }),
);
