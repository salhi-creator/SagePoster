import { Pool } from "pg";
import dotenv from "dotenv";
import type {
  ManagedPost,
  ScheduledRedditPostCandidate,
} from "../Data-Structure/types.js";

dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is missing");
}

const pool = new Pool({
  connectionString,
});

/** Run a parameterized SQL query against the configured PostgreSQL database. */
export async function readFromDB<
  Row extends Record<string, unknown> = Record<string, unknown>,
>(sql: string, parameters: unknown[] = []): Promise<Row[]> {
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS published_reddit_posts (
        id BIGSERIAL PRIMARY KEY,
        topic TEXT NOT NULL,
        subreddit TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        reddit_post_id TEXT NOT NULL,
        url TEXT NOT NULL,
        published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        delivery_type TEXT NOT NULL DEFAULT 'one-time',
        post_id TEXT
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS published_reddit_posts_topic_date_idx
      ON published_reddit_posts (topic, published_at DESC)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reddit_crosspost_history (
        source_post_id TEXT NOT NULL,
        target_subreddit TEXT NOT NULL,
        crosspost_id TEXT,
        url TEXT,
        status TEXT NOT NULL DEFAULT 'processing',
        published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source_post_id, target_subreddit)
      )
    `);
    for (const table of [
      "published_telegram_posts",
      "published_discord_posts",
    ]) {
      await pool.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS post_id TEXT`,
      );
      await pool.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS delivery_type TEXT NOT NULL DEFAULT 'one-time'`,
      );
    }
  })();

  await publishedPostsTable;
}

export async function getScheduledRedditCrosspostCandidates(
  targetSubreddits: string[],
  limit = 50,
): Promise<ScheduledRedditPostCandidate[]> {
  await ensurePublishedPostsTable();
  const targets = [...new Set(targetSubreddits.map((value) => value.trim().replace(/^r\//i, "").toLowerCase()).filter(Boolean))];
  if (!targets.length) return [];
  const result = await pool.query<{
    reddit_post_id: string;
    subreddit: string;
    title: string;
    content: string;
    url: string;
    topic: string;
  }>(
    `SELECT p.reddit_post_id, p.subreddit, p.title, p.content, p.url, p.topic
     FROM published_reddit_posts p
     WHERE p.delivery_type = 'scheduled'
       AND EXISTS (
         SELECT 1 FROM UNNEST($1::text[]) AS target(name)
         WHERE LOWER(target.name) <> LOWER(p.subreddit)
           AND NOT EXISTS (
             SELECT 1 FROM reddit_crosspost_history x
             WHERE x.source_post_id = p.reddit_post_id
               AND LOWER(x.target_subreddit) = LOWER(target.name)
           )
       )
     ORDER BY p.published_at ASC
     LIMIT $2`,
    [targets, Math.max(1, Math.min(200, Math.floor(limit)))],
  );
  return result.rows.map((row) => ({
    sourcePostId: row.reddit_post_id,
    sourceSubreddit: row.subreddit,
    title: row.title,
    content: row.content,
    url: row.url,
    topic: row.topic,
  }));
}

export async function hasRedditCrosspost(
  sourcePostId: string,
  targetSubreddit: string,
): Promise<boolean> {
  await ensurePublishedPostsTable();
  const result = await pool.query(
    `SELECT 1 FROM reddit_crosspost_history
     WHERE source_post_id = $1 AND LOWER(target_subreddit) = LOWER($2) LIMIT 1`,
    [sourcePostId, targetSubreddit],
  );
  return result && result?.rowCount ? result?.rowCount > 0 : false;
}

export async function reserveRedditCrosspost(input: {
  sourcePostId: string;
  targetSubreddit: string;
}): Promise<boolean> {
  await ensurePublishedPostsTable();
  const result = await pool.query(
    `INSERT INTO reddit_crosspost_history
       (source_post_id, target_subreddit)
     VALUES ($1, $2)
     ON CONFLICT (source_post_id, target_subreddit) DO NOTHING`,
    [input.sourcePostId, input.targetSubreddit],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function completeRedditCrosspost(input: {
  sourcePostId: string;
  targetSubreddit: string;
  crosspostId: string;
  url: string;
}): Promise<boolean> {
  await ensurePublishedPostsTable();
  const result = await pool.query(
    `UPDATE reddit_crosspost_history
     SET status = 'published', crosspost_id = $3, url = $4, published_at = NOW()
     WHERE source_post_id = $1 AND LOWER(target_subreddit) = LOWER($2)
       AND status = 'processing'`,
    [input.sourcePostId, input.targetSubreddit, input.crosspostId, input.url],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getRecentRedditPosts(topic: string): Promise<string[]> {
  await ensurePublishedPostsTable();
  const result = await pool.query<{ content: string }>(
    `SELECT content FROM published_reddit_posts WHERE topic = $1
     ORDER BY published_at DESC LIMIT 10`,
    [topic],
  );
  return result.rows.map((row) => row.content);
}

export async function savePublishedRedditPost(
  topic: string,
  post: { subreddit: string; title: string; content: string; redditPostId: string; url: string },
  options: { deliveryType?: "one-time" | "scheduled"; postId?: string } = {},
): Promise<void> {
  if (!topic.trim() || !post.subreddit.trim() || !post.title.trim() || !post.content.trim() || !post.redditPostId.trim()) return;
  await ensurePublishedPostsTable();
  await pool.query(
    `INSERT INTO published_reddit_posts
      (topic, subreddit, title, content, reddit_post_id, url, delivery_type, post_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [topic, post.subreddit, post.title, post.content, post.redditPostId, post.url,
      options.deliveryType ?? "one-time", options.postId ?? null],
  );
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
  options: { deliveryType?: "one-time" | "scheduled"; postId?: string } = {},
): Promise<void> {
  if (!topic.trim() || !content.trim()) return;
  await ensurePublishedPostsTable();
  await pool.query(
    `INSERT INTO published_telegram_posts (topic, content, delivery_type, post_id)
     VALUES ($1, $2, $3, $4)`,
    [
      topic,
      content,
      options.deliveryType ?? "one-time",
      options.postId ?? null,
    ],
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
  options: { deliveryType?: "one-time" | "scheduled"; postId?: string } = {},
): Promise<void> {
  if (!topic.trim() || !content.trim()) return;
  await ensurePublishedPostsTable();
  await pool.query(
    `INSERT INTO published_discord_posts (topic, content, delivery_type, post_id)
     VALUES ($1, $2, $3, $4)`,
    [
      topic,
      content,
      options.deliveryType ?? "one-time",
      options.postId ?? null,
    ],
  );
}

export async function getManageablePublishedPosts(
  limit = 50,
): Promise<ManagedPost[]> {
  await ensurePublishedPostsTable();
  const maxRows = Math.max(1, Math.min(100, Math.floor(limit)));
  const [telegram, discord, reddit] = await Promise.all([
    pool.query<{
      id: string;
      topic: string;
      content: string;
      published_at: Date;
      delivery_type: string;
    }>(
      `SELECT id, topic, content, published_at, delivery_type
       FROM published_telegram_posts
       ORDER BY published_at DESC
       LIMIT $1`,
      [maxRows],
    ),
    pool.query<{
      id: string;
      topic: string;
      content: string;
      published_at: Date;
      delivery_type: string;
    }>(
      `SELECT id, topic, content, published_at, delivery_type
       FROM published_discord_posts
       ORDER BY published_at DESC
       LIMIT $1`,
      [maxRows],
    ),
    pool.query<{
      id: string; topic: string; subreddit: string; title: string; content: string;
      reddit_post_id: string; url: string; published_at: Date; delivery_type: string;
    }>(
      `SELECT id, topic, subreddit, title, content, reddit_post_id, url, published_at, delivery_type
       FROM published_reddit_posts ORDER BY published_at DESC LIMIT $1`,
      [maxRows],
    ),
  ]);

  const rows = [
    ...telegram.rows.map((row) => ({ ...row, platform: "telegram" as const })),
    ...discord.rows.map((row) => ({ ...row, platform: "discord" as const })),
    ...reddit.rows.map((row) => ({ ...row, platform: "reddit" as const })),
  ];

  return rows
    .map((row) => ({
      postId: `published:${row.platform}:${row.id}`,
      kind: "published" as const,
      status: "published" as const,
      topic: row.topic,
      platforms: [row.platform],
      platform: row.platform,
      publishedAt: new Date(row.published_at).toISOString(),
      contentPreview: row.content.slice(0, 240),
      content: row.content,
      ...(row.platform === "reddit" ? {
        externalPostId: row.reddit_post_id,
        url: row.url,
        subreddit: row.subreddit,
        title: row.title,
      } : {}),
      deliveryType:
        row.delivery_type === "scheduled"
          ? ("scheduled" as const)
          : ("one-time" as const),
    }))
    .sort(
      (left, right) =>
        Date.parse(right.publishedAt) - Date.parse(left.publishedAt),
    );
}

export async function deleteManagedPublishedPost(
  postId: string,
): Promise<boolean> {
  await ensurePublishedPostsTable();
  const match = /^published:(telegram|discord|reddit):(\d+)$/.exec(postId);
  if (!match) return false;
  const [, platform, id] = match;
  const table = platform === "telegram"
    ? "published_telegram_posts"
    : platform === "discord"
      ? "published_discord_posts"
      : "published_reddit_posts";
  const result = await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

/** Close the pool cleanly when the application shuts down. */
export async function closeDB(): Promise<void> {
  await pool.end();
}

export default pool;
