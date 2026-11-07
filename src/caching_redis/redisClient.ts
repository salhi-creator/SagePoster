import { Redis } from "ioredis";
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT ?? 6379),
  username: "default",
  password: process.env.REDIS_PASSWORD,
});

redis.on("connect", () => {
  console.log("✅ Redis connected");
});

redis.on("ready", () => {
  console.log("🚀 Redis ready");
});

redis.on("close", () => {
  console.log("🔌 Redis connection closed");
});

redis.on("reconnecting", () => {
  console.log("🔄 Redis reconnecting...");
});