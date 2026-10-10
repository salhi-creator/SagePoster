import { Queue } from "bullmq";
import { logError } from "../utilis/logError.js";

const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
};

export const postQueue = new Queue("post", {
  connection,
});

console.info("[BullMQ] Connecting to Redis", {
  host: connection.host,
  port: connection.port,
  hasUsername: Boolean(connection.username),
  hasPassword: Boolean(connection.password),
});

postQueue.on("error", (error) => {
  logError("BullMQ queue Redis error", error, {
    host: connection.host,
    port: connection.port,
  });
});

void postQueue
  .waitUntilReady()
  .then(() => console.info("[BullMQ] Queue connected to Redis"))
  .catch((error) =>
    logError("BullMQ queue failed to connect to Redis", error, {
      host: connection.host,
      port: connection.port,
    }),
  );

