const Redis = require('ioredis');
const dotenv = require('dotenv');

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const isTls = redisUrl.startsWith('rediss://');

// Dedicated Redis connection configuration for BullMQ
const redisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,   // Crucial BullMQ requirement for blocking operations
  enableReadyCheck: false,      // Crucial BullMQ requirement
  ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
});

redisConnection.on('error', (err) => {
  // Suppress unhandled crash if Redis is unavailable
  console.warn('[BullMQ Redis Warning]:', err.message);
});

redisConnection.on('connect', () => {
  console.log('✅ BullMQ Redis connection established');
});

module.exports = {
  redisConnection,
};
