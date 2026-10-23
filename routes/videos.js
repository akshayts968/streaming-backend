const express = require('express');
const mongoose = require('mongoose');
const { upload, chunkUpload } = require('../utils/upload');
const { protect, authorize, authorizeAdminEmail } = require('../middleware/auth');
const { getActiveTelegramUpload } = require('../utils/telegram');
const { streamVideo, uploadVideoToDrive, uploadVideoToCloudinary, uploadChunkToDrive, getDriveFiles, streamTelegramVideo, uploadVideoToTelegramController, getTelegramChannelVideos, linkTelegramVideo, streamTelegramThumbnail } = require('../controllers/videoController');
const { uploadImage } = require('../utils/cloudinary');
const Video = require('../models/Video');
const Series = require('../models/Series');
const { getCache, setCache, redis, clearCachePattern } = require('../utils/redis');
const router = express.Router();
const fs = require('fs');

const uploadFields = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 }
]);

// @desc    Get files from Google Drive folder
// @route   GET /api/videos/drive-files
router.get('/drive-files', protect, authorize('admin'), getDriveFiles);

// @desc    Search videos
// @route   GET /api/videos/search
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ success: false, message: 'Please provide a search query' });
    const [videos, series] = await Promise.all([
      Video.find({
        seriesId: null,
        $or: [
          { title: { $regex: q, $options: 'i' } },
          { tags: { $in: [new RegExp(q, 'i')] } },
          { category: { $in: [new RegExp(q, 'i')] } }
        ]
      }).populate('creator', 'username').limit(10),
      Series.find({
        $or: [
          { title: { $regex: q, $options: 'i' } },
          { category: { $in: [new RegExp(q, 'i')] } }
        ]
      }).limit(5)
    ]);

    const results = [
      ...videos.map(v => ({ ...v.toObject(), resultType: 'video' })),
      ...series.map(s => ({ ...s.toObject(), resultType: 'series' }))
    ];

    res.status(200).json({ success: true, count: results.length, data: results });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Stream video from Google Drive or Telegram
// @route   GET /api/videos/stream/:fileId
router.get('/stream/:fileId', streamVideo);

// @desc    Stream video directly from Telegram
// @route   GET /api/videos/stream-tg/:messageId
router.get('/stream-tg/:messageId', streamTelegramVideo);

// @desc    Get live status of Telegram uploads
// @route   GET /api/videos/telegram-upload-status
router.get('/telegram-upload-status', protect, authorizeAdminEmail(), (req, res) => {
  res.json({ success: true, data: getActiveTelegramUpload() });
});

// @desc    Publish a pending Telegram video directly from Admin Dashboard
// @route   POST /api/videos/publish-telegram-pending
router.post('/publish-telegram-pending', protect, authorizeAdminEmail(), async (req, res) => {
  try {
    const {
      messageId,
      title,
      category,
      description,
      type,
      seriesId,
      seriesTitle,
      seasonNumber,
      episodeNumber,
      thumbnailUrl
    } = req.body;

    if (!messageId) {
      return res.status(400).json({ success: false, message: 'messageId is required' });
    }
    const { publishPendingTelegramVideo } = require('../utils/telegram');
    const result = await publishPendingTelegramVideo({
      messageId,
      title,
      category,
      description,
      type,
      seriesId,
      seriesTitle,
      seasonNumber,
      episodeNumber,
      thumbnailUrl
    });
    res.status(200).json({ success: true, data: result.video || result });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Get files from Telegram channel
// @route   GET /api/videos/telegram-files
router.get('/telegram-files', protect, authorize('admin'), getTelegramChannelVideos);

// @desc    Upload a video to Telegram Channel
// @route   POST /api/videos/upload-telegram
router.post('/upload-telegram', protect, authorizeAdminEmail(), uploadFields, async (req, res) => {
  if (req.files && req.files.video) {
    req.file = req.files.video[0];
  }
  if (req.files && req.files.thumbnail) {
    req.thumbnailFile = req.files.thumbnail[0];
  }
  await uploadVideoToTelegramController(req, res);
});

// @desc    Stream thumbnail from Telegram
// @route   GET /api/videos/thumbnail-tg/:messageId
router.get('/thumbnail-tg/:messageId', streamTelegramThumbnail);

// @desc    Link an existing Telegram video
// @route   POST /api/videos/link-telegram
router.post('/link-telegram', protect, authorizeAdminEmail(), upload.single('thumbnail'), linkTelegramVideo);

// @desc    Upload a video to Google Drive (Single Request - Legacy)
router.post('/upload-drive', protect, authorizeAdminEmail(), uploadFields, async (req, res) => {
  try {
    if (!req.files || !req.files.video) {
      return res.status(400).json({ success: false, message: 'Please upload a video file' });
    }

    // Handle thumbnail upload to Cloudinary
    let thumbnailUrl = 'no-thumbnail.jpg';
    if (req.files.thumbnail) {
      thumbnailUrl = await uploadImage(req.files.thumbnail[0].path);
      fs.unlinkSync(req.files.thumbnail[0].path); // Clean up temp file
    }

    // Pass the modified req to the controller
    req.file = req.files.video[0];
    req.body.thumbnailUrl = thumbnailUrl;
    
    await uploadVideoToDrive(req, res);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

const chunkFields = chunkUpload.fields([
  { name: 'chunk', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 }
]);

// @desc    Upload a video chunk
router.post('/upload-chunk', protect, authorizeAdminEmail(), chunkFields, async (req, res) => {
  try {
    if (!req.files || !req.files.chunk) {
      return res.status(400).json({ success: false, message: 'Missing chunk data' });
    }

    let thumbnailUrl = null;
    if (req.files.thumbnail) {
      thumbnailUrl = await uploadImage(req.files.thumbnail[0].path);
      fs.unlinkSync(req.files.thumbnail[0].path);
    }
    
    if (thumbnailUrl) {
      req.body.thumbnailUrl = thumbnailUrl;
    }
    
    req.file = req.files.chunk[0];
    await uploadChunkToDrive(req, res);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Upload a video to Cloudinary
router.post('/upload-cloudinary', protect, authorizeAdminEmail(), uploadFields, async (req, res) => {
  try {
    if (!req.files || !req.files.video) {
      return res.status(400).json({ success: false, message: 'Please upload a video file' });
    }

    let thumbnailUrl = 'no-thumbnail.jpg';
    if (req.files.thumbnail) {
      thumbnailUrl = await uploadImage(req.files.thumbnail[0].path);
      fs.unlinkSync(req.files.thumbnail[0].path);
    }

    req.file = req.files.video[0];
    req.body.thumbnailUrl = thumbnailUrl;
    
    await uploadVideoToCloudinary(req, res);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Upload a video (S3/Local)
router.post('/upload', protect, authorizeAdminEmail(), uploadFields, async (req, res) => {
  try {
    if (!req.files || !req.files.video) {
      return res.status(400).json({ success: false, message: 'Please upload a video file' });
    }

    // Handle thumbnail upload to Cloudinary
    let thumbnailUrl = 'no-thumbnail.jpg';
    if (req.files.thumbnail) {
      thumbnailUrl = await uploadImage(req.files.thumbnail[0].path);
      fs.unlinkSync(req.files.thumbnail[0].path);
    }

    const { title, description, category, tags } = req.body;
    const categories = Array.isArray(category) ? category : (category ? category.split(',').map(c => c.trim()) : []);
    const videoFile = req.files.video[0];

    let videoUrl = videoFile.location; 
    if (!videoUrl) {
      videoUrl = `/uploads/videos/${videoFile.filename}`;
    }

    const video = await Video.create({
      title,
      description,
      category: categories,
      tags: tags ? tags.split(',') : [],
      videoUrl,
      creator: req.user.id,
      thumbnailUrl
    });

    // Invalidate video list cache
    await clearCachePattern('videos_list_*');

    res.status(201).json({ success: true, data: video });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Get all videos
router.get('/', async (req, res) => {
  try {
    const cacheKey = `videos_list_${JSON.stringify(req.query)}`;
    const cachedResponse = await getCache(cacheKey);
    if (cachedResponse) return res.status(200).json(cachedResponse);

    const query = {};
    if (req.query.isHero === 'true') {
      query.isHero = true;
    }
    
    // Default to only showing Movies in the main list
    if (req.query.type) {
      query.type = req.query.type;
    } else {
      query.type = { $ne: 'Episode' }; 
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    const total = await Video.countDocuments(query);
    const videos = await Video.find(query)
      .populate('creator', 'username')
      .skip(skip)
      .limit(limit)
      .sort('-createdAt');

    const response = {
      success: true, 
      count: videos.length, 
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit)
      },
      data: videos 
    };

    await setCache(cacheKey, response, 300); // Cache for 5 minutes
    res.status(200).json(response);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Get single video
router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let query;

    // Check if the provided ID is a valid MongoDB ObjectId
    if (mongoose.Types.ObjectId.isValid(id)) {
      query = { $or: [{ _id: id }, { slug: id }] };
    } else {
      query = { slug: id };
    }

    const video = await Video.findOne(query).populate('creator', 'username');
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });

    let nextEpisodeId = null;
    let prevEpisodeId = null;
    let nextEpisodeSlug = null;
    let prevEpisodeSlug = null;

    if (video.type === 'Episode' && video.seriesId) {
      // Find all episodes in this series, sorted by season and episode number
      const episodes = await Video.find({ seriesId: video.seriesId, type: 'Episode' })
        .sort({ seasonNumber: 1, episodeNumber: 1 })
        .select('_id slug');
      
      const currentIndex = episodes.findIndex(ep => ep._id.toString() === video._id.toString());
      
      if (currentIndex !== -1) {
        if (currentIndex > 0) {
          prevEpisodeId = episodes[currentIndex - 1]._id;
          prevEpisodeSlug = episodes[currentIndex - 1].slug;
        }
        if (currentIndex < episodes.length - 1) {
          nextEpisodeId = episodes[currentIndex + 1]._id;
          nextEpisodeSlug = episodes[currentIndex + 1].slug;
        }
      }
    }

    res.status(200).json({ 
      success: true, 
      data: { 
        ...video.toObject(), 
        nextEpisodeId, 
        prevEpisodeId,
        nextEpisodeSlug,
        prevEpisodeSlug
      } 
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Toggle Hero status
// @route   PUT /api/videos/:id/hero
router.put('/:id/hero', protect, authorize('admin'), async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    
    // Optional: Limit total number of hero videos to 5
    if (!video.isHero) {
      const heroCount = await Video.countDocuments({ isHero: true });
      if (heroCount >= 5) {
        return res.status(400).json({ success: false, message: 'Maximum 5 hero videos allowed. Please un-feature another video first.' });
      }
    }

    video.isHero = !video.isHero;
    await video.save();

    await clearCachePattern('videos_list_*');

    res.status(200).json({ success: true, data: video });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Link an existing Google Drive video
// @route   POST /api/videos/link-drive
router.post('/link-drive', protect, authorizeAdminEmail(), upload.single('thumbnail'), async (req, res) => {
  try {
    const { title, description, category, drive_file_id, duration, useIframe, type, seriesId, episodeNumber, seasonNumber } = req.body;
    const categories = Array.isArray(category) ? category : (category ? category.split(',').map(c => c.trim()) : []);
    let thumbnailUrl = req.body.thumbnailUrl;

    if (!title || !category || !drive_file_id) {
      return res.status(400).json({ success: false, message: 'Please provide title, category, and drive_file_id' });
    }

    if (req.file) {
      thumbnailUrl = await uploadImage(req.file.path);
      fs.unlinkSync(req.file.path);
    }

    const video = await Video.create({
      type: type || 'Movie',
      seriesId: seriesId || null,
      seasonNumber: seasonNumber ? Number(seasonNumber) : 1,
      episodeNumber: episodeNumber ? Number(episodeNumber) : null,
      title,
      description,
      category: categories,
      videoUrl: `/api/videos/stream/${drive_file_id}`,
      drive_file_id,
      thumbnailUrl: thumbnailUrl || 'no-thumbnail.jpg',
      duration: duration || '00:00',
      useIframe: useIframe === 'true' || useIframe === true,
      creator: req.user.id
    });

    res.status(201).json({ success: true, data: video });
  } catch (err) {
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Update video details
// @route   PUT /api/videos/:id
router.put('/:id', protect, authorize('admin', 'creator'), async (req, res) => {
  try {
    let video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    
    // Check if user is the creator or an admin
    if (video.creator.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized to update this video' });
    }

    video = await Video.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true
    });

    res.status(200).json({ success: true, data: video });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Delete video
// @route   DELETE /api/videos/:id
router.delete('/:id', protect, authorize('admin', 'creator'), async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    
    // Check if user is the creator or an admin
    if (video.creator.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized to delete this video' });
    }

    await video.deleteOne();

    res.status(200).json({ success: true, data: {} });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

module.exports = router;
