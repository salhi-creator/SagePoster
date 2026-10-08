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

      const data = poll as TelegramPoll;

      return {
        type: "poll",
        question: data.question,
        options: data.options,
        is_anonymous: true,
      };
    }

    case "question": {
      const result = await AIanswer(content, "tele-question");

      console.log("🧠 TELE QUESTION AI RESULT:", result);

      const data = result as TelegramQuestion;

      console.log("❓ EXTRACTED QUESTION:", JSON.stringify(data?.question));

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
  if (!telegram.enabled || !style) {
    return aiResult;
  }

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
