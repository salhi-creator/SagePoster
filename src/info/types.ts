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
  title: string | null;
  media: {
    type: "image" | "video" | null;
    url: "string" | null;
  }[];
  experiment?: TelegramExperiment;
};

export type PostForm = {
  "current-state": "still-negotiate" | "submit";

  intent: "create_post";

  topic: string | null;

  summary: string | null;

  "post-style": PostStyle | null;

  platforms: {
    telegram: TelegramPost;

    reddit: {
      enabled: false;
      subreddit: null;
      title: null;
      content: null;
      media: {
        type: "image" | "video" | null;
        url: "string" | null;
      }[];
    };

    discord: {
      enabled: false;
      content: null;
      media: {
        type: "image" | "video" | null;
        url: "string" | null;
      }[];
    };

    linkedin: {
      enabled: false;
      content: null;
      media: {
        type: "image" | "video" | null;
        url: "string" | null;
      }[];
    };
  };

  metadata: {
    language: "en" | "ar" | "fr";

    tone: "casual" | "sarcastic" | "spontaneous" | "angry" | "happy";

    needs_review: boolean;
  };
};

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
  | "tele-button"
  | "tele-reaction"
  | "tele-poll"
  | "tele-question"
  | "discord";

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
