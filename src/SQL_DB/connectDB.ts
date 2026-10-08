import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is missing");
}

const pool = new Pool({
  connectionString,
});

/** Run a parameterized SQL query against the configured PostgreSQL database. */
export async function readFromDB<Row extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  parameters: unknown[] = [],
): Promise<Row[]> {
  const result = await pool.query<Row>(sql, parameters);
  return result.rows;
}

/** Close the pool cleanly when the application shuts down. */
export async function closeDB(): Promise<void> {
  await pool.end();
}

export default pool;

