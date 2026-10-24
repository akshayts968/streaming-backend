const Redis = require('ioredis');
const dotenv = require('dotenv');

dotenv.config();

const PREFIX = 'streaming:';

// Initialize singleton ioredis client with auto-reconnect and error suppression
let redisClient = null;
let isRedisAvailable = false;

try {
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    enableOfflineQueue: false,
    retryStrategy(times) {
      if (times > 10) {
        // Keep retrying quietly in background every 5 seconds
        return 5000;
      }
      return Math.min(times * 200, 2000);
    },
    lazyConnect: false,
  });

  redisClient.on('connect', () => {
    isRedisAvailable = true;
    console.log('✅ Redis connected successfully');
  });

  redisClient.on('ready', () => {
    isRedisAvailable = true;
  });

  redisClient.on('close', () => {
    isRedisAvailable = false;
  });

  redisClient.on('error', (err) => {
    isRedisAvailable = false;
    // Suppress unhandled exceptions when Redis is offline or not installed
  });
} catch (e) {
  isRedisAvailable = false;
  console.warn('⚠️ Could not initialize Redis client. Falling back to direct streaming.');
}

const getRedisClient = () => {
  return isRedisAvailable ? redisClient : null;
};

/**
 * 1. Metadata caching (7 days TTL)
 * key: video:meta:{videoId}
 */
const getVideoMetadataCache = async (videoId) => {
  if (!isRedisAvailable || !redisClient) return null;
  try {
    const key = `video:meta:${videoId}`;
    const data = await redisClient.hgetall(key);
    if (data && data.fileSize && data.mimeType) {
      return {
        fileSize: parseInt(data.fileSize, 10),
        mimeType: data.mimeType,
      };
    }
    return null;
  } catch (err) {
    return null;
  }
};

const setVideoMetadataCache = async (videoId, metadata) => {
  if (!isRedisAvailable || !redisClient) return;
  try {
    const key = `video:meta:${videoId}`;
    await redisClient.hmset(key, {
      fileSize: String(metadata.fileSize),
      mimeType: String(metadata.mimeType || 'video/mp4'),
    });
    // 7-day TTL (604800 seconds)
    await redisClient.expire(key, 604800);
  } catch (err) {
    // Ignore Redis write errors gracefully
  }
};

/**
 * 2. Initial Chunk Caching (24 hours TTL)
 * key: video:chunk:{videoId}:{range}
 */
const getVideoChunkCache = async (videoId, rangeStr) => {
  if (!isRedisAvailable || !redisClient) return null;
  try {
    const key = `video:chunk:${videoId}:${rangeStr}`;
    // Using Buffer directly from Redis
    const chunkBuffer = await redisClient.getBuffer(key);
    return chunkBuffer || null;
  } catch (err) {
    return null;
  }
};

const setVideoChunkCache = async (videoId, rangeStr, buffer) => {
  if (!isRedisAvailable || !redisClient || !buffer) return;
  try {
    const key = `video:chunk:${videoId}:${rangeStr}`;
    // 24 hours TTL (86400 seconds)
    await redisClient.set(key, buffer, 'EX', 86400);
  } catch (err) {
    // Ignore write errors gracefully
  }
};

/**
 * 3. Request Coalescing / Mutex Lock
 * Lock key: video:lock:{videoId}:{range}
 */
const acquireChunkLock = async (videoId, rangeStr, ttlMs = 5000) => {
  if (!isRedisAvailable || !redisClient) return true; // If no Redis, proceed directly
  try {
    const lockKey = `video:lock:${videoId}:${rangeStr}`;
    // SET lockKey "locked" NX PX ttlMs
    const result = await redisClient.set(lockKey, 'locked', 'PX', ttlMs, 'NX');
    return result === 'OK';
  } catch (err) {
    return true; // Bypass on failure
  }
};

const releaseChunkLock = async (videoId, rangeStr) => {
  if (!isRedisAvailable || !redisClient) return;
  try {
    const lockKey = `video:lock:${videoId}:${rangeStr}`;
    await redisClient.del(lockKey);
  } catch (err) {
    // Ignore lock release error
  }
};

/**
 * 4. Rate Limiter Middleware
 * Limit to 60 range requests per IP per minute
 */
const checkRateLimit = async (ip, limit = 60, windowSec = 60) => {
  if (!isRedisAvailable || !redisClient) {
    return { allowed: true, remaining: limit };
  }
  try {
    const key = `ratelimit:${ip}`;
    const current = await redisClient.incr(key);
    if (current === 1) {
      await redisClient.expire(key, windowSec);
    }
    if (current > limit) {
      return { allowed: false, remaining: 0 };
    }
    return { allowed: true, remaining: limit - current };
  } catch (err) {
    return { allowed: true, remaining: limit };
  }
};

// Legacy helpers for existing controllers (backward compatibility)
const getCache = async (key) => {
  if (!isRedisAvailable || !redisClient) return null;
  try {
    const val = await redisClient.get(`${PREFIX}${key}`);
    return val ? JSON.parse(val) : null;
  } catch (e) {
    return null;
  }
};

const setCache = async (key, value, expiry = 3600) => {
  if (!isRedisAvailable || !redisClient) return;
  try {
    await redisClient.set(`${PREFIX}${key}`, JSON.stringify(value), 'EX', expiry);
  } catch (e) {}
};

const clearCachePattern = async (pattern) => {
  if (!isRedisAvailable || !redisClient) return;
  try {
    const fullPattern = `${PREFIX}${pattern}`;
    const keys = await redisClient.keys(fullPattern);
    if (keys && keys.length > 0) {
      await redisClient.del(...keys);
    }
  } catch (e) {}
};

module.exports = {
  redisClient,
  getRedisClient,
  getVideoMetadataCache,
  setVideoMetadataCache,
  getVideoChunkCache,
  setVideoChunkCache,
  acquireChunkLock,
  releaseChunkLock,
  checkRateLimit,
  getCache,
  setCache,
  clearCachePattern,
};
