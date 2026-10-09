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

let publishedPostsTable: Promise<void> | undefined;

async function ensurePublishedPostsTable(): Promise<void> {
  publishedPostsTable ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS published_telegram_posts (
        id BIGSERIAL PRIMARY KEY,
        topic TEXT NOT NULL,
        content TEXT NOT NULL,
        published_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS published_telegram_posts_topic_date_idx
      ON published_telegram_posts (topic, published_at DESC)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS published_discord_posts (
        id BIGSERIAL PRIMARY KEY,
        topic TEXT NOT NULL,
        content TEXT NOT NULL,
        published_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS published_discord_posts_topic_date_idx
      ON published_discord_posts (topic, published_at DESC)
    `);
  })();

  await publishedPostsTable;
}

export async function getRecentTelegramPosts(topic: string): Promise<string[]> {
  await ensurePublishedPostsTable();
  const result = await pool.query<{ content: string }>(
    `SELECT content
     FROM published_telegram_posts
     WHERE topic = $1
     ORDER BY published_at DESC
     LIMIT 10`,
    [topic],
  );
  return result.rows.map((row) => row.content);
}

export async function savePublishedTelegramPost(
  topic: string,
  content: string,
): Promise<void> {
  if (!topic.trim() || !content.trim()) return;
  await ensurePublishedPostsTable();
  await pool.query(
    `INSERT INTO published_telegram_posts (topic, content) VALUES ($1, $2)`,
    [topic, content],
  );
}

export async function getRecentDiscordPosts(topic: string): Promise<string[]> {
  await ensurePublishedPostsTable();
  const result = await pool.query<{ content: string }>(
    `SELECT content
     FROM published_discord_posts
     WHERE topic = $1
     ORDER BY published_at DESC
     LIMIT 10`,
    [topic],
  );
  return result.rows.map((row) => row.content);
}

export async function savePublishedDiscordPost(
  topic: string,
  content: string,
): Promise<void> {
  if (!topic.trim() || !content.trim()) return;
  await ensurePublishedPostsTable();
  await pool.query(
    `INSERT INTO published_discord_posts (topic, content) VALUES ($1, $2)`,
    [topic, content],
  );
}

/** Close the pool cleanly when the application shuts down. */
export async function closeDB(): Promise<void> {
  await pool.end();
}

export default pool;

