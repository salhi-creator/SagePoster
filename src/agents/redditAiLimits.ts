/** Keep each AI comment batch bounded without truncating comment text or IDs. */
export const MAX_REDDIT_AI_COMMENTS_PER_BATCH = 12;
export const MAX_REDDIT_AI_COMMENT_CONTEXT_CHARS = 60_000;
export const MAX_REDDIT_AI_NEARBY_COMMENTS = 12;

export function chunkRedditComments<T extends { body: string }>(
  comments: T[],
  baseContext: unknown,
): T[][] {
  if (!comments.length) return [];

  const baseChars = JSON.stringify(baseContext)?.length ?? 0;
  const batches: T[][] = [];
  let batch: T[] = [];
  let batchChars = baseChars;

  for (const comment of comments) {
    const commentChars = JSON.stringify(comment).length;
    const exceedsLimit = batch.length > 0 && (
      batch.length >= MAX_REDDIT_AI_COMMENTS_PER_BATCH ||
      batchChars + commentChars > MAX_REDDIT_AI_COMMENT_CONTEXT_CHARS
    );
    if (exceedsLimit) {
      batches.push(batch);
      batch = [];
      batchChars = baseChars;
    }
    batch.push(comment);
    batchChars += commentChars;
  }

  if (batch.length) batches.push(batch);
  return batches;
}
