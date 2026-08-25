import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { pool } from './mysql.ts';

/**
 * Schema evolution lives here rather than in docker/db/mysql.sql, because that file only runs
 * when MySQL initialises a fresh data directory. Editing it leaves every already-deployed
 * database untouched while looking like the change was applied.
 *
 * Steps must be safe to re-run: DDL in MySQL commits implicitly and cannot be rolled back, so
 * a crash part-way through a migration leaves it applied but unrecorded.
 */

const LOCK_NAME = 'relay:migrations';
const LOCK_TIMEOUT_SECONDS = 30;

interface Migration {
  id: string;
  run: (conn: PoolConnection) => Promise<void>;
}

async function indexExists(conn: PoolConnection, table: string, index: string): Promise<boolean> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, index],
  );
  return rows.length > 0;
}

async function ensureIndex(
  conn: PoolConnection,
  table: string,
  index: string,
  definition: string,
): Promise<void> {
  if (await indexExists(conn, table, index)) {
    console.log(`[migrate]   ${table}.${index} already present`);
    return;
  }
  await conn.query(`ALTER TABLE ${table} ADD ${definition}`);
  console.log(`[migrate]   ${table}.${index} created`);
}

const migrations: Migration[] = [
  {
    // Every hot query filters on conversation_id and the table had only PRIMARY(id), so the
    // message list, the sidebar preview and the message count were all full scans. The sidebar
    // also looks participants up by user_id, which the (conversation_id, user_id) primary key
    // cannot serve because user_id is not its leading column.
    id: '001-index-hot-paths',
    async run(conn) {
      await ensureIndex(
        conn,
        'messages',
        'idx_messages_conversation_id',
        'INDEX idx_messages_conversation_id (conversation_id, id)',
      );
      await ensureIndex(
        conn,
        'conversation_participants',
        'idx_participants_user',
        'INDEX idx_participants_user (user_id, conversation_id)',
      );
    },
  },
  {
    // client_id was generated per send by the client and stored, but nothing enforced or read
    // it, so any retry or double-click produced a second message. Existing duplicates have to
    // go before the constraint can be added.
    id: '002-dedupe-client-id',
    async run(conn) {
      const [result] = await conn.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS duplicates FROM messages m1
         JOIN messages m2
           ON m1.conversation_id = m2.conversation_id
          AND m1.client_id = m2.client_id
          AND m1.id > m2.id
         WHERE m1.client_id IS NOT NULL`,
      );
      const duplicates = Number(result[0]?.duplicates ?? 0);
      if (duplicates > 0) {
        console.log(`[migrate]   removing ${duplicates} duplicate message(s), keeping the earliest`);
        await conn.query(
          `DELETE m1 FROM messages m1
           JOIN messages m2
             ON m1.conversation_id = m2.conversation_id
            AND m1.client_id = m2.client_id
            AND m1.id > m2.id
           WHERE m1.client_id IS NOT NULL`,
        );
      }
      // NULLs compare as distinct in a MySQL unique index, so messages sent before client ids
      // existed are unaffected.
      await ensureIndex(
        conn,
        'messages',
        'uq_messages_client_id',
        'UNIQUE INDEX uq_messages_client_id (conversation_id, client_id)',
      );
    },
  },
  {
    // created_at was second-precision and filled by the database, while the POST response
    // returned the application's own new Date(). The two disagreed, so a message moved in time
    // when the page reloaded and concurrent messages could order differently.
    id: '003-millisecond-timestamps',
    async run(conn) {
      await conn.query(
        `ALTER TABLE messages
         MODIFY created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`,
      );
      console.log('[migrate]   messages.created_at widened to millisecond precision');
    },
  },
  {
    // Unread state lived only in one browser tab's memory: the API never returned it and a
    // refresh wiped it, so the dot meant nothing after a reload. A read cursor per participant
    // makes it real and shared between an account's devices.
    id: '004-read-cursors',
    async run(conn) {
      const [columns] = await conn.query<RowDataPacket[]>(
        `SELECT 1 FROM information_schema.COLUMNS
         WHERE table_schema = DATABASE() AND table_name = 'conversation_participants'
           AND column_name = 'last_read_message_id' LIMIT 1`,
      );
      if (columns.length > 0) {
        console.log('[migrate]   conversation_participants.last_read_message_id already present');
        return;
      }
      await conn.query(
        `ALTER TABLE conversation_participants
         ADD COLUMN last_read_message_id BIGINT NULL`,
      );
      console.log('[migrate]   conversation_participants.last_read_message_id added');
    },
  },
];

export async function runMigrations(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    // Several instances boot at once under `--scale api=3`; without this they race to apply
    // the same DDL and all but one fail.
    const [lockRows] = await conn.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS acquired', [
      LOCK_NAME,
      LOCK_TIMEOUT_SECONDS,
    ]);
    if (Number(lockRows[0]?.acquired) !== 1) {
      throw new Error(`could not acquire migration lock within ${LOCK_TIMEOUT_SECONDS}s`);
    }

    try {
      await conn.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           id VARCHAR(100) PRIMARY KEY,
           applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
         )`,
      );

      const [appliedRows] = await conn.query<RowDataPacket[]>('SELECT id FROM schema_migrations');
      const applied = new Set(appliedRows.map((row) => String(row.id)));

      let ran = 0;
      for (const migration of migrations) {
        if (applied.has(migration.id)) continue;
        console.log(`[migrate] ${migration.id}`);
        await migration.run(conn);
        await conn.query('INSERT INTO schema_migrations (id) VALUES (?)', [migration.id]);
        ran += 1;
      }
      console.log(ran === 0 ? '[migrate] up to date' : `[migrate] applied ${ran} migration(s)`);
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
  } finally {
    conn.release();
  }
}
