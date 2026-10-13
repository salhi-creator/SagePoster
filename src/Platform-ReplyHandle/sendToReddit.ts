type RedditCreateResponse = {
  ok?: boolean;
  postId?: string;
  url?: string;
  error?: string;
};

type RedditDeleteResponse = { ok?: boolean; error?: string };

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
