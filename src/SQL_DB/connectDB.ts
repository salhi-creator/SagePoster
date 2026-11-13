import { Pool } from "pg";
import { createHash } from "node:crypto";
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
    // telegram insure the table and index
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

    // discord insure the table and index

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

    // reddit insure the table and index

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

    // reddit crossPostHistory

    //SELECT e.name , e.salary  FROM employees e WHERE e.salary < (SELECT AVG(e.salary)  FROM employees  )
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reddit_agent_drafts (
        draft_id TEXT PRIMARY KEY,
        subreddit TEXT NOT NULL,
        topic TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        content_fingerprint TEXT NOT NULL,
        redis_stream_id TEXT,
        reddit_post_id TEXT,
        published_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (subreddit, content_fingerprint)
      )
    `);
    await pool.query(`
      ALTER TABLE reddit_agent_drafts
      ADD COLUMN IF NOT EXISTS reddit_post_id TEXT,
      ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reddit_post_publication_slots (
        action_id TEXT PRIMARY KEY,
        subreddit TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'processing',
        reddit_post_id TEXT,
        url TEXT,
        reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reddit_engagement_replies (
        comment_id TEXT PRIMARY KEY,
        subreddit TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'processing',
        reply_id TEXT,
        reply_body TEXT,
        reason TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      `ALTER TABLE reddit_engagement_replies ADD COLUMN IF NOT EXISTS reason TEXT`,
    );
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
  const targets = [
    ...new Set(
      targetSubreddits
        .map((value) => value.trim().replace(/^r\//i, "").toLowerCase())
        .filter(Boolean),
    ),
  ];
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

/*SELECT departments.name AS  department_name , COUNT(*) AS employees_count , AVG(employees.salary) as avg_salary , CASE  WHEN employees_count >= 5 THEN "large" WHEN employees_count BETWEEN  2 AND 4 THEN "meduim" ELSE "small" END AS case , MAX(employees.salary) as Highest Salary   FROM employees RIGHT JOIN departments ON empoloyees.department_id  = departments.id ORDER BY employees_count ASC*/
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

export type RedditCrosspostReservation = "reserved" | "duplicate" | "daily_limit";

export async function reserveRedditCrosspost(input: {
  sourcePostId: string;
  targetSubreddit: string;
}): Promise<RedditCrosspostReservation> {
  await ensurePublishedPostsTable();
  const client = await pool.connect();
  const sourcePostId = input.sourcePostId.trim();
  const targetSubreddit = input.targetSubreddit.trim().replace(/^r\//i, "").toLowerCase();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "sageposter:reddit-crosspost-daily-limit",
    ]);

    const existing = await client.query<{ status: string }>(
      `SELECT status FROM reddit_crosspost_history
       WHERE source_post_id = $1 AND LOWER(target_subreddit) = $2 LIMIT 1`,
      [sourcePostId, targetSubreddit],
    );
    if (existing.rows[0]?.status === "published") {
      await client.query("COMMIT");
      return "duplicate";
    }
    if (existing.rows[0]?.status === "processing") {
      // Re-enqueueing uses a deterministic action ID, so this recovers a crash
      // between reserving the pair and placing its action in Redis.
      await client.query("COMMIT");
      return "reserved";
    }

    const recent = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM reddit_crosspost_history
       WHERE status IN ('processing', 'published')
         AND published_at >= NOW() - INTERVAL '24 hours'`,
    );
    if (Number(recent.rows[0]?.count ?? 0) >= 2) {
      await client.query("COMMIT");
      return "daily_limit";
    }

    await client.query(
      `INSERT INTO reddit_crosspost_history (source_post_id, target_subreddit)
       VALUES ($1, $2)`,
      [sourcePostId, targetSubreddit],
    );
    await client.query("COMMIT");
    return "reserved";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function releaseRedditCrosspostReservation(input: {
  sourcePostId: string;
  targetSubreddit: string;
}): Promise<void> {
  await ensurePublishedPostsTable();
  await pool.query(
    `DELETE FROM reddit_crosspost_history
     WHERE source_post_id = $1 AND LOWER(target_subreddit) = LOWER($2)
       AND status = 'processing'`,
    [input.sourcePostId.trim(), input.targetSubreddit.trim().replace(/^r\//i, "")],
  );
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
       AND (status = 'processing' OR (status = 'published' AND crosspost_id = $3))`,
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

export type RedditContentHistoryEntry = {
  topic: string;
  subreddit: string;
  title: string;
  content: string;
  publishedAt: string;
};

export type PendingRedditDraftInput = {
  draftId: string;
  subreddit: string;
  topic: string;
  title: string;
  content: string;
};

function redditDraftFingerprint(title: string, content: string): string {
  const normalized = `${title}\n${content}`
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

export async function getLatestRedditContentHistory(
  subreddit: string,
  limit = 20,
): Promise<RedditContentHistoryEntry[]> {
  await ensurePublishedPostsTable();
  const normalizedSubreddit = subreddit.trim().replace(/^r\//i, "").toLowerCase();
  if (!normalizedSubreddit) return [];
  const result = await pool.query<{
    topic: string;
    subreddit: string;
    title: string;
    content: string;
    published_at: Date;
  }>(
    `SELECT topic, subreddit, title, content, published_at
     FROM published_reddit_posts
     WHERE LOWER(REGEXP_REPLACE(subreddit, '^r/', '', 'i')) = $1
     ORDER BY published_at DESC
     LIMIT $2`,
    [normalizedSubreddit, Math.max(1, Math.min(20, Math.floor(limit)))],
  );
  return result.rows.map((row) => ({
    topic: row.topic,
    subreddit: row.subreddit,
    title: row.title,
    content: row.content,
    publishedAt: new Date(row.published_at).toISOString(),
  }));
}

export async function getLatestPublishedRedditPostId(): Promise<string | null> {
  await ensurePublishedPostsTable();
  const result = await pool.query<{ reddit_post_id: string }>(
    `SELECT reddit_post_id
     FROM published_reddit_posts
     WHERE reddit_post_id <> ''
     ORDER BY published_at DESC
     LIMIT 1`,
  );
  return result.rows[0]?.reddit_post_id ?? null;
}

/**
 * Rechecks recent published content and pending drafts while holding a
 * subreddit-scoped advisory lock, then inserts the draft if it is unique.
 */
export async function savePendingRedditDraftIfUnique(
  input: PendingRedditDraftInput,
): Promise<{ saved: boolean; duplicate?: { topic: string; title: string } }> {
  await ensurePublishedPostsTable();
  const subreddit = input.subreddit.trim().replace(/^r\//i, "").toLowerCase();
  const topic = input.topic.trim();
  const title = input.title.trim();
  const content = input.content.trim();
  if (!subreddit || !topic || !title || !content || !input.draftId.trim()) {
    throw new Error("A Reddit draft requires a subreddit, topic, title, and content");
  }

  const fingerprint = redditDraftFingerprint(title, content);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `reddit-content-creator:${subreddit}`,
    ]);

    const published = await client.query<{
      topic: string;
      title: string;
      content: string;
    }>(
      `SELECT topic, title, content
       FROM published_reddit_posts
       WHERE LOWER(REGEXP_REPLACE(subreddit, '^r/', '', 'i')) = $1
       ORDER BY published_at DESC
       LIMIT 20`,
      [subreddit],
    );
    const pending = await client.query<{
      topic: string;
      title: string;
      content: string;
    }>(
      `SELECT topic, title, content
       FROM reddit_agent_drafts
       WHERE subreddit = $1 AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 100`,
      [subreddit],
    );
    const duplicate = [...published.rows, ...pending.rows].find(
      (row) => redditDraftFingerprint(row.title, row.content) === fingerprint,
    );
    if (duplicate) {
      await client.query("ROLLBACK");
      return {
        saved: false,
        duplicate: { topic: duplicate.topic, title: duplicate.title },
      };
    }

    const inserted = await client.query(
      `INSERT INTO reddit_agent_drafts
         (draft_id, subreddit, topic, title, content, status, content_fingerprint)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)
       ON CONFLICT (subreddit, content_fingerprint) DO NOTHING
       RETURNING draft_id`,
      [input.draftId, subreddit, topic, title, content, fingerprint],
    );
    await client.query("COMMIT");
    if (inserted.rowCount === 0) {
      return { saved: false, duplicate: { topic, title } };
    }
    return { saved: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function setRedditDraftStreamId(
  draftId: string,
  streamId: string,
): Promise<boolean> {
  await ensurePublishedPostsTable();
  const result = await pool.query(
    `UPDATE reddit_agent_drafts
     SET redis_stream_id = $2, status = 'publishing'
     WHERE draft_id = $1 AND status = 'pending'`,
    [draftId, streamId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getPendingRedditDrafts(
  subreddit: string,
  limit = 20,
): Promise<PendingRedditDraftInput[]> {
  await ensurePublishedPostsTable();
  const result = await pool.query<PendingRedditDraftInput>(
    `SELECT draft_id AS "draftId", subreddit, topic, title, content
     FROM reddit_agent_drafts
     WHERE status = 'pending' AND LOWER(subreddit) = LOWER($1)
     ORDER BY created_at ASC LIMIT $2`,
    [subreddit.trim().replace(/^r\//i, ""), Math.max(1, Math.min(100, Math.floor(limit)))],
  );
  return result.rows;
}

export async function markRedditDraftPublished(
  draftId: string,
  redditPostId: string,
): Promise<void> {
  await ensurePublishedPostsTable();
  await pool.query(
    `UPDATE reddit_agent_drafts
     SET status = 'published', reddit_post_id = $2, published_at = NOW()
     WHERE draft_id = $1 AND status IN ('pending', 'publishing')`,
    [draftId, redditPostId],
  );
}

export async function markRedditDraftCancelled(draftId: string): Promise<void> {
  await ensurePublishedPostsTable();
  await pool.query(
    `UPDATE reddit_agent_drafts SET status = 'cancelled'
     WHERE draft_id = $1 AND status IN ('pending', 'publishing')`,
    [draftId],
  );
}

export async function markRedditDraftPending(draftId: string): Promise<void> {
  await ensurePublishedPostsTable();
  await pool.query(
    `UPDATE reddit_agent_drafts
     SET status = 'pending', redis_stream_id = NULL
     WHERE draft_id = $1 AND status = 'publishing'`,
    [draftId],
  );
}

export type RedditPostPublicationReservation =
  | { status: "reserved" }
  | { status: "published"; postId: string; url: string }
  | { status: "daily_limit" };

/** Atomically reserve one of two per-subreddit Reddit publication slots per rolling 24h. */
export async function reserveRedditPostPublication(
  actionId: string,
  subredditInput: string,
): Promise<RedditPostPublicationReservation> {
  await ensurePublishedPostsTable();
  const actionKey = actionId.trim();
  const subreddit = subredditInput.trim().replace(/^r\//i, "").toLowerCase();
  if (!actionKey || !subreddit) throw new Error("An action ID and subreddit are required to reserve a Reddit post slot");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `reddit-post-publication:${subreddit}`,
    ]);

    const existing = await client.query<{
      status: string;
      reddit_post_id: string | null;
      url: string | null;
      reserved_at: Date;
    }>(
      `SELECT status, reddit_post_id, url, reserved_at
       FROM reddit_post_publication_slots WHERE action_id = $1`,
      [actionKey],
    );
    const existingSlot = existing.rows[0];
    if (existingSlot?.status === "published" && existingSlot.reddit_post_id && existingSlot.url) {
      await client.query("COMMIT");
      return { status: "published", postId: existingSlot.reddit_post_id, url: existingSlot.url };
    }
    if (existingSlot?.status === "processing" &&
        existingSlot.reserved_at.getTime() >= Date.now() - 24 * 60 * 60 * 1000) {
      await client.query("COMMIT");
      return { status: "reserved" };
    }

    const recent = await client.query<{ count: string }>(
      `SELECT (
         SELECT COUNT(*) FROM reddit_post_publication_slots s
         WHERE LOWER(s.subreddit) = $1
           AND s.status IN ('processing', 'published')
           AND s.reserved_at >= NOW() - INTERVAL '24 hours'
       ) + (
         SELECT COUNT(*) FROM published_reddit_posts p
         WHERE LOWER(REGEXP_REPLACE(p.subreddit, '^r/', '', 'i')) = $1
           AND p.published_at >= NOW() - INTERVAL '24 hours'
           AND NOT EXISTS (
             SELECT 1 FROM reddit_post_publication_slots s
             WHERE s.reddit_post_id = p.reddit_post_id
           )
       ) AS count`,
      [subreddit],
    );
    if (Number(recent.rows[0]?.count ?? 0) >= 2) {
      if (existingSlot?.status === "processing") {
        await client.query(
          "DELETE FROM reddit_post_publication_slots WHERE action_id = $1 AND status = 'processing'",
          [actionKey],
        );
      }
      await client.query("COMMIT");
      return { status: "daily_limit" };
    }

    if (existingSlot?.status === "processing") {
      await client.query(
        `UPDATE reddit_post_publication_slots
         SET reserved_at = NOW(), subreddit = $2
         WHERE action_id = $1 AND status = 'processing'`,
        [actionKey, subreddit],
      );
    } else {
      await client.query(
        `INSERT INTO reddit_post_publication_slots (action_id, subreddit, status)
         VALUES ($1, $2, 'processing')`,
        [actionKey, subreddit],
      );
    }
    await client.query("COMMIT");
    return { status: "reserved" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function completeRedditPostPublication(input: {
  actionId: string;
  subreddit: string;
  postId: string;
  url: string;
}): Promise<void> {
  await ensurePublishedPostsTable();
  const result = await pool.query(
    `UPDATE reddit_post_publication_slots
     SET status = 'published', reddit_post_id = $3, url = $4, published_at = NOW()
     WHERE action_id = $1 AND LOWER(subreddit) = LOWER($2)
       AND status IN ('processing', 'published')`,
    [input.actionId.trim(), input.subreddit.trim().replace(/^r\//i, ""), input.postId, input.url],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(`Could not mark Reddit post slot published for action ${input.actionId}`);
  }
}

export async function claimRedditEngagementComment(
  commentId: string,
  subreddit: string,
): Promise<boolean> {
  await ensurePublishedPostsTable();
  const result = await pool.query(
    `INSERT INTO reddit_engagement_replies (comment_id, subreddit, status)
     VALUES ($1, $2, 'processing')
     ON CONFLICT (comment_id) DO UPDATE
       SET status = 'processing', subreddit = EXCLUDED.subreddit, updated_at = NOW()
       WHERE reddit_engagement_replies.status = 'pending'
     RETURNING comment_id`,
    [commentId, subreddit],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function hasRedditEngagementComment(commentId: string): Promise<boolean> {
  await ensurePublishedPostsTable();
  const result = await pool.query(
    `SELECT 1 FROM reddit_engagement_replies
     WHERE comment_id = $1 AND status <> 'pending' LIMIT 1`,
    [commentId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function releaseRedditEngagementCommentClaim(commentId: string): Promise<void> {
  await ensurePublishedPostsTable();
  await pool.query(
    `UPDATE reddit_engagement_replies
     SET status = 'pending', updated_at = NOW()
     WHERE comment_id = $1 AND status = 'processing'`,
    [commentId],
  );
}

export async function finishRedditEngagementComment(input: {
  commentId: string;
  status: "replied" | "skipped" | "rejected";
  replyId?: string;
  replyBody?: string;
  reason?: string;
}): Promise<void> {
  await ensurePublishedPostsTable();
  await pool.query(
    `UPDATE reddit_engagement_replies
     SET status = $2, reply_id = $3, reply_body = $4, reason = $5, updated_at = NOW()
     WHERE comment_id = $1 AND status = 'processing'`,
    [input.commentId, input.status, input.replyId ?? null, input.replyBody ?? null, input.reason ?? null],
  );
}

export async function savePublishedRedditPost(
  topic: string,
  post: {
    subreddit: string;
    title: string;
    content: string;
    redditPostId: string;
    url: string;
  },
  options: { deliveryType?: "one-time" | "scheduled"; postId?: string } = {},
): Promise<void> {
  if (
    !topic.trim() ||
    !post.subreddit.trim() ||
    !post.title.trim() ||
    !post.content.trim() ||
    !post.redditPostId.trim()
  )
    return;
  await ensurePublishedPostsTable();
  await pool.query(
    `INSERT INTO published_reddit_posts
      (topic, subreddit, title, content, reddit_post_id, url, delivery_type, post_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      topic,
      post.subreddit,
      post.title,
      post.content,
      post.redditPostId,
      post.url,
      options.deliveryType ?? "one-time",
      options.postId ?? null,
    ],
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
      id: string;
      topic: string;
      subreddit: string;
      title: string;
      content: string;
      reddit_post_id: string;
      url: string;
      published_at: Date;
      delivery_type: string;
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
      ...(row.platform === "reddit"
        ? {
            externalPostId: row.reddit_post_id,
            url: row.url,
            subreddit: row.subreddit,
            title: row.title,
          }
        : {}),
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
  const table =
    platform === "telegram"
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
