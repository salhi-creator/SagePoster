import type {
  RedditCrosspostCheck,
  RedditCrosspostRequest,
} from "../Data-Structure/types.js";

type RedditCreateResponse = {
  ok?: boolean;
  postId?: string;
  url?: string;
  error?: string;
};

type RedditDeleteResponse = { ok?: boolean; error?: string };
type RedditCheckResponse = RedditCrosspostCheck & { ok?: boolean; error?: string };
type RedditCrosspostResponse = {
  ok?: boolean;
  sourcePostId?: string;
  targetSubreddit?: string;
  crosspostId?: string;
  url?: string;
  permalink?: string;
  error?: string;
};

export type RedditCommunityPost = {
  postId: string;
  title: string;
  content: string;
  subreddit: string;
  url: string | null;
  author: string | null;
};

export type RedditCommunityComment = {
  commentId: string;
  postId: string;
  parentId: string | null;
  body: string;
  author: string | null;
  permalink: string | null;
  removed: boolean;
};

export type RedditAgentContextRequest = {
  subreddit: string;
  include?: { rules?: boolean; recentPostsLimit?: number; post?: boolean; commentsLimit?: number; crosspostCheck?: boolean };
  postId?: string;
  targetSubreddit?: string;
};

export type RedditAgentContext = {
  ok: true;
  subreddit: string;
  rules?: RedditCrosspostCheck["rules"];
  posts?: RedditCommunityPost[];
  post?: RedditCommunityPost;
  comments?: RedditCommunityComment[];
  canCrosspost?: boolean;
  targetSubreddit?: string;
};

function endpoint(path: string): string {
  const baseUrl = process.env.REDDIT_SERVICE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("REDDIT_SERVICE_URL is not configured");
  return `${baseUrl}${path}`;
}

function safeEndpointPath(url: string): string {
  try {
    const parsed = new URL(url);
    // Keep route and query keys/values useful for diagnosis, but never print credentials.
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "<invalid-url>";
  }
}

async function requestRedditService<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const url = endpoint(path);
  const token = process.env.REDDIT_SERVICE_TOKEN?.trim();
  const startedAt = Date.now();
  let response: Response | undefined;
  const maxRateLimitRetries = method === "GET" ? 2 : 0;
  for (let attempt = 0; attempt <= maxRateLimitRetries; attempt += 1) {
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      console.error("[Reddit service] Request failed before receiving a response", {
        method,
        endpoint: safeEndpointPath(url),
        attempt: attempt + 1,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    if (response.status !== 429 || attempt >= maxRateLimitRetries) break;

    const retryAfter = response.headers.get("retry-after");
    const retryAfterSeconds = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter)
      ? Number(retryAfter)
      : retryAfter && Number.isFinite(Date.parse(retryAfter))
        ? Math.max(0, (Date.parse(retryAfter) - Date.now()) / 1000)
        : undefined;
    const delayMs = Math.min(
      30_000,
      Math.max(500, retryAfterSeconds === undefined ? 1_000 * (attempt + 1) : retryAfterSeconds * 1_000),
    );
    console.warn("[Reddit service] Rate limited; retrying safe GET", {
      method,
      endpoint: safeEndpointPath(url),
      attempt: attempt + 1,
      retryAfter,
      delayMs,
    });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  if (!response) throw new Error(`Reddit service ${method} ${safeEndpointPath(url)} returned no response`);

  const responseText = await response.text();
  let payload: (T & { error?: string; message?: string }) | Record<string, unknown> = {};
  try {
    payload = responseText ? JSON.parse(responseText) as T & { error?: string; message?: string } : {};
  } catch {
    payload = {};
  }
  const payloadRecord = payload as Record<string, unknown>;
  const context = {
    method,
    endpoint: safeEndpointPath(url),
    status: response.status,
    durationMs: Date.now() - startedAt,
    ...(response.headers.get("retry-after")
      ? { retryAfter: response.headers.get("retry-after") }
      : {}),
  };

  if (!response.ok) {
    const serviceMessage = [payloadRecord.error, payloadRecord.message]
      .find((value): value is string => typeof value === "string" && value.length > 0);
    console.error("[Reddit service] Request returned an error", {
      ...context,
      ...(serviceMessage ? { serviceMessage: serviceMessage.slice(0, 500) } : {}),
    });
    const failure = new Error(
      serviceMessage ?? `Reddit service ${method} ${safeEndpointPath(url)} returned HTTP ${response.status}`,
    ) as Error & { status?: number; endpoint?: string; retryAfter?: string };
    failure.status = response.status;
    failure.endpoint = safeEndpointPath(url);
    failure.retryAfter = response.headers.get("retry-after") ?? undefined;
    throw failure;
  }

  console.info("[Reddit service] Request succeeded", context);
  return payload as T;
}

async function request<T>(path: string, body: unknown): Promise<T> {
  return requestRedditService<T>("POST", path, body);
}

async function requestGet<T>(path: string): Promise<T> {
  return requestRedditService<T>("GET", path);
}

/** Batch reads for Reddit agents; Devvit implements POST /agent/context. */
export async function getRedditAgentContext(
  input: RedditAgentContextRequest,
): Promise<RedditAgentContext> {
  const subreddit = input.subreddit.trim().replace(/^r\//i, "");
  if (!subreddit) throw new Error("A subreddit is required for Reddit agent context");
  const result = await request<RedditAgentContext>("/agent/context", {
    ...input,
    subreddit,
    ...(input.targetSubreddit
      ? { targetSubreddit: input.targetSubreddit.trim().replace(/^r\//i, "") }
      : {}),
  });
  if (result?.ok !== true || !result.subreddit) {
    throw new Error("Reddit service returned incomplete agent context");
  }
  return result;
}

function parseCommunityPost(value: unknown, requestedSubreddit: string): RedditCommunityPost | null {
  if (!value || typeof value !== "object") return null;
  const post = value as Record<string, unknown>;
  const nestedPost =
    post.post && typeof post.post === "object"
      ? (post.post as Record<string, unknown>)
      : post;
  const postId = [nestedPost.postId, nestedPost.redditPostId, nestedPost.id]
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)
    ?.trim();
  const title = typeof nestedPost.title === "string" ? nestedPost.title.trim() : "";
  const contentValue = nestedPost.content ?? nestedPost.body ?? nestedPost.selftext;
  const content = typeof contentValue === "string" ? contentValue.trim() : "";
  if (!postId || !title) return null;
  return {
    postId,
    title,
    content,
    subreddit:
      typeof nestedPost.subreddit === "string"
        ? nestedPost.subreddit
        : requestedSubreddit,
    url: typeof nestedPost.url === "string" ? nestedPost.url : null,
    author: typeof nestedPost.author === "string" ? nestedPost.author : null,
  };
}

function parseCommunityComment(value: unknown): RedditCommunityComment | null {
  if (!value || typeof value !== "object") return null;
  const comment = value as Record<string, unknown>;
  const commentId = typeof comment.id === "string" ? comment.id.trim() : "";
  const postId = typeof comment.postId === "string" ? comment.postId.trim() : "";
  const body = typeof comment.body === "string" ? comment.body.trim() : "";
  if (!commentId || !postId || !body) return null;
  return {
    commentId,
    postId,
    parentId: typeof comment.parentId === "string" ? comment.parentId : null,
    body,
    author: typeof comment.author === "string" ? comment.author : null,
    permalink: typeof comment.permalink === "string" ? comment.permalink : null,
    removed: comment.removed === true,
  };
}

function extractList(payload: unknown, key: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const value = record[key] ?? record.data;
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const nested = value as Record<string, unknown>;
    const list = nested[key] ?? nested.items;
    return Array.isArray(list) ? list : [];
  }
  return [];
}

/** Fetches community posts from the Devvit service GET /posts endpoint. */
export async function getRedditSubredditPosts(
  subredditInput: string,
  limit = 12,
): Promise<RedditCommunityPost[]> {
  const subreddit = subredditInput.trim().replace(/^r\//i, "");
  if (!subreddit) throw new Error("A subreddit is required to fetch community posts");
  const cappedLimit = Math.max(1, Math.min(30, Math.floor(limit)));
  const query = new URLSearchParams({ subreddit, limit: String(cappedLimit) });
  const payload = await requestGet<unknown>(`/posts?${query.toString()}`);
  const records = extractList(payload, "posts");
  return records
    .map((record) => parseCommunityPost(record, subreddit))
    .filter((post): post is RedditCommunityPost => post !== null)
    .slice(0, cappedLimit);
}

export async function getRedditPostComments(
  postIdInput: string,
  limit = 100,
): Promise<RedditCommunityComment[]> {
  const postId = postIdInput.trim();
  if (!postId) throw new Error("A post ID is required to fetch Reddit comments");
  const cappedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const query = new URLSearchParams({ postId, limit: String(cappedLimit) });
  const payload = await requestGet<unknown>(`/comments?${query.toString()}`);
  return extractList(payload, "comments")
    .map(parseCommunityComment)
    .filter((comment): comment is RedditCommunityComment => comment !== null)
    .slice(0, cappedLimit);
}

export async function replyToRedditComment(input: {
  commentId: string;
  body: string;
  idempotencyKey: string;
}): Promise<{ commentId: string; body: string; idempotencyKey: string }> {
  const commentId = input.commentId.trim();
  const body = input.body.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  if (!commentId || !body || !idempotencyKey) throw new Error("A Reddit comment ID, reply body, and idempotency key are required");
  const response = await request<{
    ok?: boolean;
    commentId?: string;
    body?: string;
    idempotencyKey?: string | null;
    error?: string;
  }>("/comments/reply", { commentId, body, idempotencyKey });
  if (!response.commentId || typeof response.body !== "string") {
    throw new Error(response.error || "Reddit service returned an incomplete comment reply response");
  }
  return {
    commentId: response.commentId,
    body: typeof response.body === "string" ? response.body : body,
    idempotencyKey: response.idempotencyKey ?? idempotencyKey,
  };
}

export async function createRedditComment(input: {
  postId: string;
  body: string;
}): Promise<{ commentId: string; url: string }> {
  const postId = input.postId.trim();
  const body = input.body.trim();
  if (!postId || !body) throw new Error("A Reddit post ID and comment body are required");
  const response = await request<{
    ok?: boolean;
    commentId?: string;
    url?: string;
    error?: string;
  }>("/comments", { postId, body });
  if (!response.commentId || !response.url) {
    throw new Error(response.error || "Reddit service returned an incomplete comment response");
  }
  return { commentId: response.commentId, url: response.url };
}

/** Requires the Devvit service to expose POST /comments/delete. */
export async function deleteRedditComment(commentIdInput: string): Promise<void> {
  const commentId = commentIdInput.trim();
  if (!commentId) throw new Error("Reddit comment ID is required for deletion");
  const result = await request<RedditDeleteResponse & { commentId?: string }>(
    "/comments/delete",
    { commentId },
  );
  if (!result.ok) throw new Error(result.error || "Reddit comment deletion failed");
}

export async function sendToReddit(post: {
  subreddit: string;
  title: string;
  content: string;
  idempotencyKey?: string;
  media?: { type: "image" | "video" | null; url: string | null }[];
}): Promise<{ postId: string; url: string }> {
  const subreddit = post.subreddit?.trim().replace(/^r\//i, "");
  const title = post.title?.trim();
  const body = post.content?.trim();
  if (!subreddit || !title || !body) {
    throw new Error("Reddit posts require a subreddit, title, and content");
  }

  const result = await request<RedditCreateResponse>("/posts", {
    subreddit,
    title,
    body,
    ...(post.idempotencyKey ? { idempotencyKey: post.idempotencyKey } : {}),
    ...(post.media?.length
      ? {
          media: post.media.filter(
            (item): item is { type: "image" | "video"; url: string } =>
              (item.type === "image" || item.type === "video") &&
              typeof item.url === "string" &&
              item.url.trim().length > 0,
          ),
        }
      : {}),
  });
  if (!result.ok || !result.postId || !result.url) {
    throw new Error("Reddit service did not return a post ID and URL");
  }
  return { postId: result.postId, url: result.url };
}

export async function deleteRedditPost(postId: string): Promise<void> {
  if (!postId.trim()) throw new Error("Reddit post ID is required for deletion");
  const result = await request<RedditDeleteResponse>("/posts/delete", {
    postId,
  });
  if (!result.ok) throw new Error(result.error || "Reddit post deletion failed");
}
function validateCrosspostRequest(input: RedditCrosspostRequest): RedditCrosspostRequest {
  let sourcePostId = input.sourcePostId.trim();
  if (/^https?:\/\//i.test(sourcePostId)) {
    try {
      const sourceUrl = new URL(sourcePostId);
      const redditPostId =
        sourceUrl.pathname.match(/\/comments\/([a-z0-9]+)/i)?.[1] ??
        (sourceUrl.hostname.toLowerCase().endsWith("redd.it")
          ? sourceUrl.pathname.split("/").filter(Boolean)[0]
          : undefined);
      if (redditPostId) sourcePostId = redditPostId;
    } catch {
      throw new Error("The Reddit source post URL is invalid");
    }
  }
  const targetSubreddit = input.targetSubreddit.trim().replace(/^r\//i, "");
  if (!sourcePostId || !targetSubreddit) {
    throw new Error("Reddit crossposts require a source post ID and target subreddit");
  }
  return { ...input, sourcePostId, targetSubreddit };
}

export async function checkRedditCrosspost(
  input: RedditCrosspostRequest,
): Promise<RedditCrosspostCheck> {
  const requestBody = validateCrosspostRequest(input);
  const result = await request<RedditCheckResponse>("/crossposts/check", {
    sourcePostId: requestBody.sourcePostId,
    targetSubreddit: requestBody.targetSubreddit,
    ...(requestBody.title ? { title: requestBody.title } : {}),
  });
  if (
    !result.ok ||
    typeof result.canCrosspost !== "boolean" ||
    !result.sourcePost?.id ||
    !result.targetSubreddit ||
    !Array.isArray(result.rules)
  ) {
    throw new Error("Reddit service returned incomplete crosspost check data");
  }
  return {
    canCrosspost: result.canCrosspost,
    sourcePost: result.sourcePost,
    targetSubreddit: result.targetSubreddit,
    rules: result.rules,
  };
}

/** Fetches one exact post through Devvit's sourcePost lookup in /crossposts/check. */
export async function getRedditPostById(
  postIdInput: string,
  subredditInput: string,
): Promise<RedditCommunityPost> {
  const postId = postIdInput.trim();
  const subreddit = subredditInput.trim().replace(/^r\//i, "");
  if (!postId || !subreddit) {
    throw new Error("A Reddit post ID and subreddit are required to fetch post context");
  }

  const checked = await checkRedditCrosspost({
    sourcePostId: postId,
    targetSubreddit: subreddit,
    title: null,
  });
  const sourcePost = checked.sourcePost;
  if (!sourcePost.title.trim()) {
    throw new Error(`Reddit returned no title for post ${postId}`);
  }
  return {
    postId: sourcePost.id,
    title: sourcePost.title,
    content: sourcePost.body ?? "",
    subreddit: sourcePost.subreddit || subreddit,
    url: sourcePost.url || null,
    author: null,
  };
}

export async function publishRedditCrosspost(
  input: RedditCrosspostRequest,
): Promise<{ crosspostId: string; targetSubreddit: string; url: string; permalink: string }> {
  const requestBody = validateCrosspostRequest(input);
  const result = await request<RedditCrosspostResponse>("/crossposts", {
    sourcePostId: requestBody.sourcePostId,
    targetSubreddit: requestBody.targetSubreddit,
    ...(requestBody.title ? { title: requestBody.title } : {}),
    ...(requestBody.idempotencyKey ? { idempotencyKey: requestBody.idempotencyKey } : {}),
  });
  if (!result.ok || !result.crosspostId || !result.targetSubreddit || !result.url || !result.permalink) {
    throw new Error("Reddit service did not return complete crosspost details");
  }
  return {
    crosspostId: result.crosspostId,
    targetSubreddit: result.targetSubreddit,
    url: result.url,
    permalink: result.permalink,
  };
}
