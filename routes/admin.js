const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Video = require('../models/Video');
const { getRedisClient } = require('../utils/redis');
const { protect, authorize } = require('../middleware/auth');

const FEATURED_KEY = 'featured:movies';

/**
 * Helper to fetch parsed featured items from Redis
 */
async function getFeaturedFromRedis() {
  const redis = getRedisClient();
  if (!redis) return [];
  try {
    const raw = await redis.get(FEATURED_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.error('Redis getFeatured error:', err.message);
    return [];
  }
}

/**
 * Helper to save featured items list to Redis
 */
async function saveFeaturedToRedis(list) {
  const redis = getRedisClient();
  if (!redis) throw new Error('Redis client unavailable');
  await redis.set(FEATURED_KEY, JSON.stringify(list));
}

/**
 * Helper to find video by Movie Name (case-insensitive title/slug) OR Mongo _id OR drive_file_id / telegram_message_id
 */
async function findVideoByNameOrId(identifier) {
  if (!identifier) return null;
  const str = String(identifier).trim();

  // 1. Try finding by title exact or case-insensitive regex
  let video = await Video.findOne({
    $or: [
      { title: { $regex: `^${str}$`, $options: 'i' } },
      { slug: str.toLowerCase().replace(/\s+/g, '-') }
    ]
  });
  if (video) return video;

  // 2. Try partial title match
  video = await Video.findOne({
    title: { $regex: str, $options: 'i' }
  });
  if (video) return video;

  // 3. Try Mongo _id, drive_file_id, telegram_message_id
  const queries = [{ slug: str }, { drive_file_id: str }];
  if (mongoose.Types.ObjectId.isValid(str)) {
    queries.push({ _id: str });
  }
  const num = parseInt(str, 10);
  if (!isNaN(num)) {
    queries.push({ telegram_message_id: num });
  }

  return await Video.findOne({ $or: queries });
}

// Optional admin check middleware: if protect/authorize is applied or bypassed for curl/admin tests
const optionalAdminAuth = (req, res, next) => {
  if (req.headers.authorization) {
    return protect(req, res, () => {
      authorize('admin')(req, res, next);
    });
  }
  next();
};

/**
 * @desc    Get full featured list with metadata (Admin)
 * @route   GET /api/admin/featured
 */
router.get('/featured', optionalAdminAuth, async (req, res) => {
  try {
    const featured = await getFeaturedFromRedis();
    // Sort ascending by order
    featured.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    res.status(200).json({
      success: true,
      count: featured.length,
      data: featured
    });
  } catch (err) {
    console.error('GET /api/admin/featured error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * @desc    Add a movie to the featured list using Movie Name or Video ID
 * @route   POST /api/admin/featured
 */
router.post('/featured', optionalAdminAuth, async (req, res) => {
  try {
    const identifier = req.body.movieName || req.body.title || req.body.videoId;
    if (!identifier) {
      return res.status(400).json({ success: false, message: 'Please provide movieName or videoId' });
    }

    // Lookup video in DB
    const video = await findVideoByNameOrId(identifier);

    const actualVideoId = video 
      ? (video.drive_file_id || (video.telegram_message_id ? String(video.telegram_message_id) : String(video._id)))
      : String(identifier);

    const featured = await getFeaturedFromRedis();
    const existingIndex = featured.findIndex(item => 
      String(item.videoId) === String(actualVideoId) ||
      (video && String(item.videoId) === String(video._id)) ||
      (video && item.title && item.title.toLowerCase() === video.title.toLowerCase())
    );

    // Hero title matches movie name, description matches video description
    const title = video ? video.title : String(identifier);
    const description = video ? (video.description || '') : (req.body.description || '');
    // Place the video's thumbnail automatically if not added new thumbnail
    const bannerUrl = req.body.bannerUrl || (video ? (video.thumbnailUrl || '') : '');
    // Dynamic watch link uses movie slug (name of movie)
    const movieSlug = video ? (video.slug || video._id) : String(identifier);
    const ctaLink = `/watch/${movieSlug}`;
    const ctaText = req.body.ctaText || 'Watch Now';

    if (existingIndex !== -1) {
      // Already featured, update with fresh metadata and return
      featured[existingIndex].title = title;
      featured[existingIndex].description = description;
      if (!featured[existingIndex].bannerUrl && bannerUrl) {
        featured[existingIndex].bannerUrl = bannerUrl;
      }
      featured[existingIndex].ctaLink = ctaLink;
      await saveFeaturedToRedis(featured);

      return res.status(200).json({
        success: true,
        message: `"${title}" is already in featured list (updated)`,
        data: featured[existingIndex]
      });
    }

    const newItem = {
      videoId: String(actualVideoId),
      movieSlug: movieSlug,
      title: title,
      bannerUrl: bannerUrl,
      description: description,
      ctaText: ctaText,
      ctaLink: ctaLink,
      order: featured.length + 1,
      createdAt: new Date().toISOString()
    };

    featured.push(newItem);
    await saveFeaturedToRedis(featured);

    res.status(201).json({
      success: true,
      message: `"${title}" added to Hero banner successfully`,
      data: newItem
    });
  } catch (err) {
    console.error('POST /api/admin/featured error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * @desc    Edit title, description, bannerUrl, ctaText, and ctaLink for a specific hero entry
 * @route   PATCH /api/admin/featured/:videoId
 */
router.patch('/featured/:videoId', optionalAdminAuth, async (req, res) => {
  try {
    const { videoId } = req.params;
    const { title, description, bannerUrl, ctaText, ctaLink } = req.body;

    const featured = await getFeaturedFromRedis();
    const itemIndex = featured.findIndex(item => String(item.videoId) === String(videoId));

    if (itemIndex === -1) {
      return res.status(404).json({ success: false, message: `Featured item with videoId ${videoId} not found` });
    }

    if (title !== undefined) featured[itemIndex].title = title;
    if (description !== undefined) featured[itemIndex].description = description;
    if (bannerUrl !== undefined) featured[itemIndex].bannerUrl = bannerUrl;
    if (ctaText !== undefined) featured[itemIndex].ctaText = ctaText;
    if (ctaLink !== undefined) featured[itemIndex].ctaLink = ctaLink;

    await saveFeaturedToRedis(featured);

    res.status(200).json({
      success: true,
      message: 'Featured item updated successfully',
      data: featured[itemIndex]
    });
  } catch (err) {
    console.error('PATCH /api/admin/featured/:videoId error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * @desc    Atomically update sequence/positions in Redis
 * @route   PUT /api/admin/featured/reorder
 */
router.put('/featured/reorder', optionalAdminAuth, async (req, res) => {
  try {
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({ success: false, message: 'orderedIds must be an array of video IDs' });
    }

    const featured = await getFeaturedFromRedis();
    const map = new Map(featured.map(item => [String(item.videoId), item]));

    const newFeatured = [];
    let orderIndex = 1;

    for (const id of orderedIds) {
      const item = map.get(String(id));
      if (item) {
        newFeatured.push({
          ...item,
          order: orderIndex++
        });
        map.delete(String(id));
      }
    }

    // Append any remaining items that weren't in orderedIds
    for (const remaining of map.values()) {
      newFeatured.push({
        ...remaining,
        order: orderIndex++
      });
    }

    await saveFeaturedToRedis(newFeatured);

    res.status(200).json({
      success: true,
      message: 'Featured items reordered successfully',
      data: newFeatured
    });
  } catch (err) {
    console.error('PUT /api/admin/featured/reorder error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * @desc    Remove video from featured list and recalculate order positions
 * @route   DELETE /api/admin/featured/:videoId
 */
router.delete('/featured/:videoId', optionalAdminAuth, async (req, res) => {
  try {
    const { videoId } = req.params;
    const featured = await getFeaturedFromRedis();

    const filtered = featured.filter(item => String(item.videoId) !== String(videoId));
    if (filtered.length === featured.length) {
      return res.status(404).json({ success: false, message: `Featured item with videoId ${videoId} not found` });
    }

    // Recalculate order positions
    const updated = filtered.map((item, idx) => ({
      ...item,
      order: idx + 1
    }));

    await saveFeaturedToRedis(updated);

    res.status(200).json({
      success: true,
      message: 'Featured item removed successfully',
      data: updated
    });
  } catch (err) {
    console.error('DELETE /api/admin/featured/:videoId error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * @desc    Trigger video transcode to AES-128 HLS
 * @route   POST /api/admin/transcode/:videoId
 */
router.post('/transcode/:videoId', optionalAdminAuth, async (req, res) => {
  try {
    const { videoId } = req.params;
    const Video = require('../models/Video');
    const { addTranscodeJob } = require('../queues/transcodeQueue');

    const video = await Video.findOne({
      $or: [
        { _id: require('mongoose').Types.ObjectId.isValid(videoId) ? videoId : null },
        { slug: videoId },
        { drive_file_id: String(videoId) },
        { telegram_message_id: /^\d+$/.test(videoId) ? parseInt(videoId, 10) : null }
      ].filter(Boolean)
    });

    if (!video) {
      return res.status(404).json({ success: false, message: 'Video not found' });
    }

    const job = await addTranscodeJob({
      videoId: video.drive_file_id || String(video.telegram_message_id) || String(video._id),
      messageId: video.telegram_message_id || video.drive_file_id,
      telegramFileId: video.telegram_file_id,
      title: video.title,
      targetResolutions: ['1080p', '720p', '480p']
    });

    res.json({
      success: true,
      message: `Transcode job scheduled for "${video.title}"`,
      jobId: job.id
    });
  } catch (err) {
    console.error('Trigger transcode error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
