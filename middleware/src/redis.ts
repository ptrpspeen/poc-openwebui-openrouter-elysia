import { Redis } from "ioredis";

if (!process.env.REDIS_URL || process.env.REDIS_URL.trim() === "") {
  throw new Error("Missing required config: REDIS_URL");
}

const redisUrl = process.env.REDIS_URL;

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

redis.on("error", (err) => console.error("Redis Error:", err));
redis.on("connect", () => console.log("🚀 Connected to Redis"));
