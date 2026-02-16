import { Redis } from "ioredis";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

redis.on("error", (err) => console.error("Redis Error:", err));
redis.on("connect", () => console.log("🚀 Connected to Redis"));
