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

function endpoint(path: string): string {
  const baseUrl = process.env.REDDIT_SERVICE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("REDDIT_SERVICE_URL is not configured");
  return `${baseUrl}${path}`;
}

async function request<T>(path: string, body: unknown): Promise<T> {
  const token = process.env.REDDIT_SERVICE_TOKEN?.trim();
  const response = await fetch(endpoint(path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || `Reddit service returned HTTP ${response.status}`);
  }
  return payload;
}

export async function sendToReddit(post: {
  subreddit: string;
  title: string;
  content: string;
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

export async function publishRedditCrosspost(
  input: RedditCrosspostRequest,
): Promise<{ crosspostId: string; targetSubreddit: string; url: string; permalink: string }> {
  const requestBody = validateCrosspostRequest(input);
  const result = await request<RedditCrosspostResponse>("/crossposts", {
    sourcePostId: requestBody.sourcePostId,
    targetSubreddit: requestBody.targetSubreddit,
    ...(requestBody.title ? { title: requestBody.title } : {}),
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
