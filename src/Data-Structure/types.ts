export type PostStyle =
  | "engagement"
  | "curiosity"
  | "joke"
  | "hot_take"
  | "poll"
  | "question"
  | "observation"
  | "reaction"
  | "experiment"
  | "self_aware"
  | "educational";

export const AllPostStyles: PostStyle[] = [
  "engagement",
  "curiosity",
  "joke",
  "hot_take",
  "poll",
  "question",
  "observation",
  "reaction",
  "experiment",
  "self_aware",
  "educational",
];
export type TelegramButton = {
  text: string;

  // Used when the button should open a URL.
  url?: string;

  // Used when the button should send a callback to your bot.
  callback_data?: string;
};
export type TelegramPost = {
  enabled: boolean;
  content: string | null;
  media: {
    type: "image" | "video" | null;
    url: string | null;
  }[];
  experiment?: TelegramExperiment;
};

export type DiscordPost = {
  enabled: boolean;
  content: string;
  media: {
    type: "image" | "video" | null;
    url: string | null;
  }[];
};

export type PostForm = {
  "current-state": "still-negotiate" | "submit" | "schedule-post";

  intent: "create_post";

  topic: string | null;

  summary: string | null;

  "post-style": PostStyle | null;

  platforms: {
    telegram?: TelegramPost;

    reddit?: {
      enabled: false;
      subreddit: string;
      title: string;
      content: string;
      media: {
        type: "image" | "video" | null;
        url: string | null;
      }[];
    };

    discord?: DiscordPost;

    linkedin?: {
      enabled: false;
      content: string;
      media: {
        type: "image" | "video" | null;
        url: string | null;
      }[];
    };
  };

  metadata: {
    language: "en" | "ar" | "fr";

    tone: "casual" | "sarcastic" | "spontaneous" | "angry" | "happy";

    needs_review: boolean;
  };

  "dead-line": Deadline;
  report: string;
};

export interface Deadline {
  "start-time": number;
  "end-time": number;
  repeat:
    | "every-day"
    | "every-week"
    | "every-hour"
    | "next-day"
    | "next-week"
    | "next-hour";
}

export type TelegramExperiment =
  | {
      type: "buttons";
      buttons: TeleBotButton[];
    }
  | {
      type: "reaction";
      emoji: string[];
    }
  | {
      type: "poll";
      question: string;
      options: string[];
      is_anonymous: boolean;
    }
  | {
      type: "question";
      question: string;
    }
  | {
      type: "none";
    };

export interface ScheduledTelegramInput {
  topic: string;
  instruction: string;
  media: TelegramPost["media"];
  recentPosts: string[];
}

export type ScheduledTelegramOutput = {
  content: string;
  experiment: TelegramExperiment;
};

export interface ScheduledDiscordInput {
  topic: string;
  instruction: string;
  media: DiscordPost["media"];
  recentPosts: string[];
}

export type ScheduledDiscordOutput = {
  historyText: string;
  payload: Record<string, unknown>;
};

export interface TeleBotButton {
  text: string;
  callback_data: string;
}

export interface TelegramPoll {
  question: string;
  options: string[];
}

export interface TelegramQuestion {
  question: string;
}

export type AIOption =
  | "sheduled-telegram"
  | "scheduled-discord"
  | "tele-button"
  | "tele-reaction"
  | "tele-poll"
  | "tele-question"
  | "discord"
  | "reddit"
  | "linkedin";

export const telegramReactions = [
  "👍",
  "👎",
  "❤️",
  "🔥",
  "😂",
  "🎉",
  "😁",
  "😢",
  "😡",
  "🤔",
  "👏",
  "🤩",
  "🙏",
  "💯",
  "🥰",
];

export type Platform = "telegram" | "discord" | "reddit" | "linkedin";

export interface PostJobData {
  postId: string;

  platforms: Platform[];

  form: PostForm;
}
