import { AIanswer } from "../AI.js";
import type {
  Deadline,
  ManagePostsResult,
  ManagedPost,
  Platform,
  PostForm,
} from "../Data-Structure/types.js";
import { schedulePost } from "../queues/postWorker.js";
import { getManagedSchedules, removeManagedSchedule, removePlatformsFromManagedSchedule } from "../queues/postQueue.js";
import {
  deleteManagedPublishedPost,
  getManageablePublishedPosts,
} from "../SQL_DB/connectDB.js";
import { sendMessageBackToMe } from "../utilis.js";
import { deleteRedditPost } from "../Platform-ReplyHandle/sendToReddit.js";

type TopicGroup = {
  topicKey: string;
  topic: string;
  posts: ManagedPost[];
  counts: {
    total: number;
    published: number;
    scheduled: number;
    running: number;
    failed: number;
  };
  platforms: string[];
};

const REPEATS: Deadline["repeat"][] = [
  "every-day",
  "every-hour",
  "every-week",
  "next-day",
  "next-hour",
  "next-week",
];

function topicKey(topic: string): string {
  return topic.trim().toLocaleLowerCase();
}

function groupPosts(posts: ManagedPost[]): TopicGroup[] {
  const groups = new Map<string, TopicGroup>();

  for (const post of posts) {
    const key = topicKey(post.topic);
    if (!key) continue;

    let group = groups.get(key);
    if (!group) {
      group = {
        topicKey: key,
        topic: post.topic.trim(),
        posts: [],
        counts: { total: 0, published: 0, scheduled: 0, running: 0, failed: 0 },
        platforms: [],
      };
      groups.set(key, group);
    }

    group.posts.push(post);
    group.counts.total += 1;
    if (post.kind === "published") group.counts.published += 1;
    if (post.kind === "schedule") group.counts.scheduled += 1;
    if (post.status === "running") group.counts.running += 1;
    if (post.status === "failed") group.counts.failed += 1;
    for (const platform of post.platforms) {
      if (!group.platforms.includes(platform)) group.platforms.push(platform);
    }
  }

  return [...groups.values()].sort((left, right) => {
    const latest = (group: TopicGroup) =>
      Math.max(
        ...group.posts.map((post) =>
          Date.parse(post.scheduledAt ?? post.publishedAt ?? "") || 0,
        ),
      );
    return latest(right) - latest(left);
  });
}

function visibleTopic(group: TopicGroup, index: number, platformFilter?: Platform[]): string {
  const posts = platformFilter
    ? group.posts.filter((post) => post.platforms.some((platform) => platformFilter.includes(platform)))
    : group.posts;
  const published = posts.filter((post) => post.kind === "published").length;
  const scheduled = posts.filter((post) => post.kind === "schedule").length;
  const running = posts.filter((post) => post.status === "running").length;
  const failed = posts.filter((post) => post.status === "failed").length;
  const platforms = [...new Set(posts.flatMap((post) => post.platforms))];
  const kinds = [
    `published: ${published}`,
    `queued schedules: ${scheduled}`,
  ].join(" | ");
  const states = [
    scheduled ? `scheduled ${scheduled}` : "",
    running ? `running ${running}` : "",
    failed ? `failed ${failed}` : "",
  ].filter(Boolean);

  return [
    `${index + 1}. Topic: ${group.topic}`,
    `   Total records: ${posts.length} | ${kinds}`,
    `   Platforms: ${platforms.join(", ") || "none"}`,
    `   Cases: ${states.length ? states.join(", ") : "published only"}`,
  ].join("\n");
}

function chunkMessage(message: string, limit = 3500): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of message.split("\n")) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function reply(chatId: string, message: string): Promise<void> {
  for (const chunk of chunkMessage(message)) {
    await sendMessageBackToMe(chatId, chunk);
  }
}

function validResult(value: unknown): value is ManagePostsResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  const validPlatforms =
    result.platforms === "all" ||
    (Array.isArray(result.platforms) &&
      result.platforms.length > 0 &&
      result.platforms.every((platform) =>
        ["telegram", "discord", "reddit", "linkedin"].includes(String(platform)),
      ));
  const redditPost = result.reddit_post;
  return (
    ["list", "delete", "reschedule", "clarify"].includes(String(result.action)) &&
    Array.isArray(result.topicKeys) &&
    result.topicKeys.every((key) => typeof key === "string") &&
    typeof result.message === "string" &&
    validPlatforms &&
    (redditPost === undefined ||
      (typeof redditPost === "object" && redditPost !== null &&
        ["delete", "keep"].includes(
          String((redditPost as Record<string, unknown>).post_behaviour),
        )))
  );
}

function platformsForResult(result: ManagePostsResult, groups: TopicGroup[]): Platform[] {
  if (result.platforms !== "all") return result.platforms;
  return [...new Set(groups.flatMap((group) => group.platforms as Platform[]))];
}

function scheduleFromResult(
  value: ManagePostsResult["schedule"],
): { startTime: number; endTime: number; repeat: Deadline["repeat"] } {
  if (!value || !REPEATS.includes(value.repeat)) {
    throw new Error("The requested reschedule needs a valid repeat frequency");
  }
  const startTime = value.startAt === null ? -1 : Date.parse(value.startAt);
  const endTime = value.endAt === null ? -1 : Date.parse(value.endAt);
  if (
    (startTime !== -1 && !Number.isFinite(startTime)) ||
    (endTime !== -1 && !Number.isFinite(endTime)) ||
    (startTime !== -1 && endTime !== -1 && endTime < startTime)
  ) {
    throw new Error("The requested schedule contains an invalid date range");
  }
  return { startTime, endTime, repeat: value.repeat };
}

function formForReschedule(
  post: ManagedPost,
  deadline: { startTime: number; endTime: number; repeat: Deadline["repeat"] },
  selectedPlatforms: Platform[],
): PostForm {
  const effectiveStartTime =
    deadline.startTime === -1 &&
    (deadline.repeat === "every-hour" ||
      deadline.repeat === "every-day" ||
      deadline.repeat === "every-week")
      ? Date.now()
      : deadline.startTime;

  if (post.form) {
    const selected = new Set(selectedPlatforms);
    const platforms = Object.fromEntries(
      Object.entries(post.form.platforms).map(([name, platform]) => [
        name,
        platform
          ? { ...platform, enabled: platform.enabled && selected.has(name as Platform) }
          : platform,
      ]),
    ) as PostForm["platforms"];
    return {
      ...post.form,
      platforms,
      "current-state": "schedule-post",
      "dead-line": {
        "start-time": effectiveStartTime,
        "end-time": deadline.endTime,
        repeat: deadline.repeat,
      },
    };
  }
  if (!post.platform || !post.content) {
    throw new Error(`Saved post ${post.postId} has no content to schedule`);
  }

  const platforms: PostForm["platforms"] = {};
  if (post.platform === "telegram") {
    platforms.telegram = { enabled: true, content: post.content, media: [] };
  } else if (post.platform === "reddit") {
    throw new Error("Saved Reddit posts can be deleted but cannot be rescheduled from history yet");
  } else {
    platforms.discord = { enabled: true, content: post.content, media: [] };
  }

  return {
    "current-state": "schedule-post",
    intent: "create_post",
    topic: post.topic,
    summary: post.contentPreview,
    "post-style": null,
    platforms,
    metadata: { language: "en", tone: "casual", needs_review: false, images: [] },
    "dead-line": {
      "start-time": effectiveStartTime,
      "end-time": deadline.endTime,
      repeat: deadline.repeat,
    },
    report: "Rescheduled a saved post.",
  };
}

async function deleteTopic(
  group: TopicGroup,
  selectedPlatforms: Platform[],
  redditBehaviour: "delete" | "keep",
): Promise<{ removed: number; failed: number }> {
  let removed = 0;
  let failed = 0;
  for (const post of group.posts) {
    const affectedPlatforms = post.platforms.filter((platform) =>
      selectedPlatforms.includes(platform),
    );
    if (!affectedPlatforms.length) continue;
    try {
      if (post.kind === "schedule") {
        const scheduleId = post.postId.slice("schedule:".length);
        const result = affectedPlatforms.length === post.platforms.length
          ? await removeManagedSchedule(scheduleId)
          : await removePlatformsFromManagedSchedule(scheduleId, affectedPlatforms);
        if (result) removed += 1;
        else failed += 1;
        continue;
      }
      if (post.platform === "reddit") {
        if (redditBehaviour === "keep") continue;
        if (!post.externalPostId) throw new Error("Saved Reddit post has no Reddit post ID");
        await deleteRedditPost(post.externalPostId);
      }
      const result = await deleteManagedPublishedPost(post.postId);
      if (result) removed += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}

export async function managePosts(userRequest: string, chatId: string): Promise<void> {
  const [scheduled, published] = await Promise.all([
    getManagedSchedules(),
    getManageablePublishedPosts(),
  ]);
  const topics = groupPosts([...scheduled, ...published]);
  const orderedTopics = topics.map((group, index) => ({ index: index + 1, ...group }));

  const result = await AIanswer(
    JSON.stringify({
      userRequest,
      topics: orderedTopics.map(({ index, topicKey: key, topic, counts, platforms }) => ({
        index,
        topicKey: key,
        topic,
        counts,
        platforms,
      })),
      platformOptions: ["telegram", "discord", "reddit", "linkedin"],
    }),
    "manage-posts",
  );

  if (!validResult(result)) {
    await reply(chatId, "I couldn't safely understand that request. Ask to list topics, delete a topic, or reschedule a topic.");
    return;
  }
  if (result.action === "list") {
    const requestedPlatforms = platformsForResult(result, topics);
    const visibleTopics = topics.filter((group) =>
      group.platforms.some((platform) => requestedPlatforms.includes(platform as Platform)),
    );
    await reply(
      chatId,
      visibleTopics.length
        ? `Topics for ${result.platforms === "all" ? "all platforms" : requestedPlatforms.join(", ")} (choose a topic index):\n\n${visibleTopics.map((group) => visibleTopic(group, topics.indexOf(group), requestedPlatforms)).join("\n\n")}`
        : "There are no saved posts or schedules grouped by topic right now.",
    );
    return;
  }
  if (result.action === "clarify") {
    await reply(chatId, result.message || "Which topic index should I use?");
    return;
  }

  const topicsByKey = new Map(topics.map((group) => [group.topicKey, group]));
  if (result.topicKeys.some((key) => !topicsByKey.has(key))) {
    await reply(chatId, "I couldn't match the selected topic to the current list. Ask me to list topics again, then choose an index.");
    return;
  }
  const selected = [...new Set(result.topicKeys)].map((key) => topicsByKey.get(key)!);
  if (!selected.length) {
    await reply(chatId, "I couldn't identify a topic to act on. Ask me to list topics, then choose an index.");
    return;
  }

  if (result.action === "delete") {
    const requestedPlatforms = platformsForResult(result, selected);
    const redditBehaviour = result.reddit_post?.post_behaviour ?? "keep";
    let removed = 0;
    let failed = 0;
    for (const group of selected) {
      const outcome = await deleteTopic(group, requestedPlatforms, redditBehaviour);
      removed += outcome.removed;
      failed += outcome.failed;
    }
    await reply(
      chatId,
      `Selected topics: ${selected.map((group) => group.topic).join(", ")}\nPlatforms: ${requestedPlatforms.join(", ") || "none"}. Removed ${removed} records${failed ? `; ${failed} could not be removed` : ""}. Reddit published posts: ${redditBehaviour === "delete" && requestedPlatforms.includes("reddit") ? "deleted through Devvit" : "kept live"}. Telegram/Discord published posts remain live; only their SagePoster history is removed.`,
    );
    return;
  }

  let deadline: ReturnType<typeof scheduleFromResult>;
  try {
    deadline = scheduleFromResult(result.schedule);
  } catch (error) {
    await reply(chatId, error instanceof Error ? error.message : "The schedule details are incomplete.");
    return;
  }

  const created: string[] = [];
  const failed: string[] = [];
  const requestedPlatforms = platformsForResult(result, selected);
  for (const group of selected) {
    const schedules = group.posts.filter(
      (post) => post.kind === "schedule" &&
        post.platforms.some((platform) => requestedPlatforms.includes(platform)),
    );
    if (schedules.some((post) => post.status === "running")) {
      failed.push(`${group.topic} (a schedule is currently running)`);
      continue;
    }
    if (!schedules.length) {
      failed.push(`${group.topic} (no queued schedules to reschedule)`);
      continue;
    }

    for (const post of schedules) {
      try {
        const affectedPlatforms = post.platforms.filter((platform) =>
          requestedPlatforms.includes(platform),
        );
        const job = await schedulePost(
          formForReschedule(post, deadline, affectedPlatforms),
        );
        if (!job) throw new Error("scheduler did not create a job");
        await removePlatformsFromManagedSchedule(
          post.postId.slice("schedule:".length),
          affectedPlatforms,
        );
        created.push(group.topic);
      } catch (error) {
        failed.push(`${group.topic} (${error instanceof Error ? error.message : "failed"})`);
      }
    }
  }

  await reply(
    chatId,
    [
      created.length ? `Rescheduled ${created.length} queued job(s) for: ${[...new Set(created)].join(", " )}.` : "No queued schedules were rescheduled.",
      failed.length ? `Could not reschedule: ${failed.join("; ")}.` : "",
    ].filter(Boolean).join("\n"),
  );
}
