const { Redis } = require('@upstash/redis');
const dotenv = require('dotenv');

dotenv.config();

const PREFIX = 'streaming:';

// Check if Upstash credentials are provided
const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null;

if (!redis) {
  console.warn('Upstash Redis credentials missing. Caching will be disabled.');
} else {
  console.log('Upstash Redis client initialized with prefix:', PREFIX);
}

const getCache = async (key) => {
  if (!redis) return null;
  try {
    return await redis.get(`${PREFIX}${key}`);
  } catch (err) {
    console.error('Redis Get Error:', err.message);
    return null;
  }
};

const setCache = async (key, value, expiry = 3600) => {
  if (!redis) return;
  try {
    await redis.set(`${PREFIX}${key}`, value, { ex: expiry });
  } catch (err) {
    console.error('Redis Set Error:', err.message);
  }
};

/**
 * Safely clear keys matching a pattern within the app's namespace
 * @param {string} pattern - The pattern within the namespace (e.g., 'videos_list_*')
 */
const clearCachePattern = async (pattern) => {
  if (!redis) return;
  try {
    const fullPattern = `${PREFIX}${pattern}`;
    const keys = await redis.keys(fullPattern);
    if (keys && keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (err) {
    console.error('Redis Clear Pattern Error:', err.message);
  }
};

module.exports = { redis, getCache, setCache, clearCachePattern };
