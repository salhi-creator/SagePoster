import type {
  PostForm,
  PostStyle,
  TelegramPost,
  TelegramExperiment,
  TeleBotButton,
  TelegramQuestion,
  TelegramPoll,
} from "../../Data-Structure/types.js";
import { AllPostStyles } from "../../Data-Structure/types.js";
import { AIanswer } from "../../AI.js";

async function getExperiment(
  style: PostStyle,
  post: TelegramPost,
): Promise<TelegramExperiment> {
  const content = post.content ?? "";

  switch (style) {
    case "engagement": {
      const buttons = await AIanswer(content, "tele-button");

      return {
        type: "buttons",
        buttons: (buttons ?? []) as TeleBotButton[],
      };
    }

    case "curiosity": {
      const emoji = await AIanswer(content, "tele-reaction");

      return {
        type: "reaction",
        emoji: (emoji ?? []) as string[],
      };
    }

    case "joke": {
      const emoji = await AIanswer(content, "tele-reaction");

      return {
        type: "reaction",
        emoji: (emoji ?? []) as string[],
      };
    }

    case "hot_take": {
      const buttons = await AIanswer(content, "tele-button");

      return {
        type: "buttons",
        buttons: (buttons ?? []) as TeleBotButton[],
      };
    }

    case "poll": {
      const poll = await AIanswer(content, "tele-poll");
      const data = poll as TelegramPoll | null;
      if (
        !data ||
        typeof data.question !== "string" ||
        !data.question.trim() ||
        data.question.length > 300 ||
        !Array.isArray(data.options) ||
        data.options.length < 2 ||
        data.options.length > 12 ||
        data.options.some(
          (option) =>
            typeof option !== "string" || !option.trim() || option.length > 100,
        )
      ) {
        throw new Error("AI returned an invalid Telegram poll; expected a question and 2–12 options");
      }

      return {
        type: "poll",
        question: data.question,
        options: data.options,
        ...(data.durationHours !== undefined
          ? { durationHours: data.durationHours }
          : {}),
        is_anonymous: true,
      };
    }

    case "question": {
      const result = await AIanswer(content, "tele-question");

      console.info("[Telegram] Question experiment generated", { hasResult: Boolean(result) });

      const data = result as TelegramQuestion;

      console.info("[Telegram] Question experiment parsed", { hasQuestion: Boolean(data?.question) });

      return {
        type: "question",
        question: data?.question ?? "",
      };
    }

    case "experiment": {
      const buttons = await AIanswer(content, "tele-button");

      return {
        type: "buttons",
        buttons: (buttons ?? []) as TeleBotButton[],
      };
    }

    case "observation": {
      const emoji = await AIanswer(content, "tele-reaction");

      return {
        type: "reaction",
        emoji: (emoji ?? []) as string[],
      };
    }

    case "reaction": {
      const emoji = await AIanswer(content, "tele-reaction");

      return {
        type: "reaction",
        emoji: (emoji ?? []) as string[],
      };
    }

    case "educational": {
      const emoji = await AIanswer(content, "tele-reaction");

      return {
        type: "reaction",
        emoji: (emoji ?? []) as string[],
      };
    }

    case "self_aware": {
      const buttons = await AIanswer(content, "tele-button");

      return {
        type: "buttons",
        buttons: (buttons ?? []) as TeleBotButton[],
      };
    }

    default:
      return {
        type: "none",
      };
  }
}

async function prepareTelegramPost(
  aiResult: PostForm,
  scheduled = false,
): Promise<PostForm | undefined> {
  if (scheduled) {
    const style = AllPostStyles[Math.floor(Math.random() * AllPostStyles.length)];
  }
  const style = aiResult["post-style"];
  const telegram = aiResult.platforms.telegram;

  if (!telegram) return;
  if (!telegram.enabled) {
    return aiResult;
  }
  if (!telegram.content?.trim()) {
    throw new Error(
      "Telegram post content is empty; the planner marked Telegram enabled but returned no content",
    );
  }
  if (!style) return aiResult;

  const experiment = await getExperiment(style, telegram);

  return {
    ...aiResult,

    platforms: {
      ...aiResult.platforms,

      telegram: {
        ...telegram,
        experiment,
      },
    },
  };
}

export default prepareTelegramPost;
