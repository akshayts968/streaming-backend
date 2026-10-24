const { Queue } = require('bullmq');
const { redisConnection } = require('./connection');

// Instantiate BullMQ Queue named 'video-transcode'
const transcodeQueue = new Queue('video-transcode', {
  connection: redisConnection,
});

/**
 * Enqueue a video transcoding job with exponential backoff & auto cleanup
 * @param {Object} jobData - { videoId, telegramFileId, targetResolutions, ... }
 */
const addTranscodeJob = async (jobData) => {
  const job = await transcodeQueue.add('transcode-task', jobData, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  });

  return job;
};

module.exports = {
  transcodeQueue,
  addTranscodeJob,
};
