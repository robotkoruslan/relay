import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.ts';
import { beginDraining } from './lifecycle.ts';
import { closeMysql, waitForMysql } from './db/mysql.ts';
import { runMigrations } from './db/migrations.ts';
import { closeMongo, connectMongo } from './db/mongo.ts';
import { errorHandler, notFoundHandler } from './http/errors.ts';
import { conversationsRouter } from './routes/conversations.ts';
import { healthRouter } from './routes/health.ts';
import { messagesRouter } from './routes/messages.ts';
import { searchRouter } from './routes/search.ts';
import { attachWs, closeWs } from './ws/hub.ts';

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const app = express();
app.use(express.json({ limit: config.jsonBodyLimit }));
app.use(express.static(webRoot));
app.use('/healthz', healthRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/search', searchRouter);

// Unknown /api paths should be a JSON 404, not the static handler's HTML.
app.use('/api', notFoundHandler);
app.use(errorHandler);

const server = http.createServer(app);
attachWs(server);

await waitForMysql();
await runMigrations();
await connectMongo();

server.listen(config.port, () => {
  console.log(`relay listening on :${config.port}`);
});

let shuttingDown = false;

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  beginDraining();
  console.log(`[shutdown] ${reason}: draining`);

  const force = setTimeout(() => {
    console.error(`[shutdown] still busy after ${config.shutdownTimeoutMs}ms, exiting anyway`);
    process.exit(exitCode || 1);
  }, config.shutdownTimeoutMs);
  force.unref();

  try {
    // WebSockets first: they are long-lived, so server.close() would otherwise never resolve.
    await closeWs();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await Promise.allSettled([closeMysql(), closeMongo()]);
    console.log('[shutdown] complete');
    process.exit(exitCode);
  } catch (err) {
    console.error('[shutdown] failed', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// A rejection reaching here is a bug outside the request path: report it with a stack, then
// exit rather than continuing in an unknown state. The supervisor restarts us.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection', reason);
  void shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception', err);
  void shutdown('uncaughtException', 1);
});
