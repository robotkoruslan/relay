import mysql, { type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { config } from '../config.ts';

export const pool = mysql.createPool({
  uri: config.mysqlUrl,
  // Read and write DATETIME/TIMESTAMP as UTC. Without this mysql2 converts using the process
  // timezone, so the same row reads back differently depending on where the app runs.
  timezone: 'Z',
  connectTimeout: config.dbTimeoutMs,
});

/** What a placeholder may legitimately be bound to. Keeps `unknown` out of the query layer. */
export type SqlValue = string | number | boolean | Date | null;

/**
 * mysql2 returns `[rows, fields]` and types rows as a union wide enough to be unusable. These
 * wrappers pin the row shape at the call site so routes work with real types.
 */
export async function queryRows<T extends RowDataPacket>(
  sql: string,
  params: SqlValue[] = [],
): Promise<T[]> {
  const [rows] = await pool.query<T[]>(sql, params);
  return rows;
}

export async function queryOne<T extends RowDataPacket>(
  sql: string,
  params: SqlValue[] = [],
): Promise<T | undefined> {
  const rows = await queryRows<T>(sql, params);
  return rows[0];
}

export async function execute(sql: string, params: SqlValue[] = []): Promise<ResultSetHeader> {
  const [result] = await pool.execute<ResultSetHeader>(sql, params);
  return result;
}

export async function waitForMysql(retries = 40): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`mysql not reachable after ${retries} attempts: ${String(lastErr)}`);
}

export async function pingMysql(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function closeMysql(): Promise<void> {
  await pool.end();
}
