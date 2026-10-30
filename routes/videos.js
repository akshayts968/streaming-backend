const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const { upload, chunkUpload } = require('../utils/upload');
const { protect, authorize, authorizeAdminEmail } = require('../middleware/auth');
const { getActiveTelegramUpload } = require('../utils/telegram');
const { streamVideo, uploadVideoToDrive, uploadVideoToCloudinary, uploadChunkToDrive, getDriveFiles, streamTelegramVideo, uploadVideoToTelegramController, getTelegramChannelVideos, linkTelegramVideo, streamTelegramThumbnail } = require('../controllers/videoController');
const { uploadImage } = require('../utils/cloudinary');
const Video = require('../models/Video');
const Series = require('../models/Series');
const { getCache, setCache, redis, clearCachePattern, checkRateLimit } = require('../utils/redis');

// IP Rate Limiting middleware for Telegram Video Streaming (60 range requests / min)
const streamRateLimiter = async (req, res, next) => {
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';
  const { allowed, remaining } = await checkRateLimit(clientIp, 180, 60);

  res.setHeader('X-RateLimit-Limit', '180');
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, remaining)));

  if (!allowed) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded for video streaming. Please wait a moment before retrying.'
    });
  }
  next();
};
const router = express.Router();

// @desc    Get public featured movies list (Hero Carousel)
// @route   GET /api/videos/featured
router.get('/featured', async (req, res) => {
  try {
    const { getRedisClient } = require('../utils/redis');
    const redis = getRedisClient();
    let featured = [];
    if (redis) {
      try {
        const raw = await redis.get('featured:movies');
        if (raw) {
          featured = JSON.parse(raw);
          if (!Array.isArray(featured)) featured = [];
        }
      } catch (redisErr) {
        console.error('Redis featured read error:', redisErr.message);
      }
    }

    if (featured.length > 0) {
      featured.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return res.status(200).json({
        success: true,
        source: 'redis',
        count: featured.length,
        data: featured
      });
    }

    // Fall back to 5 most recent videos if Redis key is empty
    const recentVideos = await Video.find({ isPublished: { $ne: false } })
      .sort({ createdAt: -1 })
      .limit(5);

    const fallbackFeatured = recentVideos.map((v, idx) => ({
      videoId: v.drive_file_id || (v.telegram_message_id ? String(v.telegram_message_id) : String(v._id)),
      title: v.title,
      bannerUrl: v.thumbnailUrl || '',
      description: v.description || '',
      ctaText: 'Watch Now',
      ctaLink: '/watch/' + (v.slug || v._id),
      order: idx + 1,
      createdAt: v.createdAt ? v.createdAt.toISOString() : new Date().toISOString()
    }));

    return res.status(200).json({
      success: true,
      source: 'fallback',
      count: fallbackFeatured.length,
      data: fallbackFeatured
    });
  } catch (err) {
    console.error('GET /api/videos/featured error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

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
router.get('/stream/:fileId', streamRateLimiter, streamVideo);

// @desc    Stream video directly from Telegram
// @route   GET /api/videos/stream-tg/:messageId
// Anti-direct download protection: block external download tools, curl, or direct address bar downloads
const antiDirectDownload = (req, res, next) => {
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  const secFetchDest = req.headers['sec-fetch-dest'];
  const secFetchMode = req.headers['sec-fetch-mode'];
  const userAgent = req.headers['user-agent'] || '';

  // Block known standalone download managers
  if (/idm|aria2|wget|jdownloader|internet download manager/i.test(userAgent)) {
    return res.status(403).json({ error: 'Direct downloads via download managers are forbidden.' });
  }

  // Block top-level document navigation (typing URL in address bar to download)
  if (secFetchDest === 'document' && secFetchMode === 'navigate') {
    return res.status(403).send('Direct downloading of media streams is forbidden. Please play from the application player.');
  }

  next();
};

router.get('/stream-tg/:messageId', antiDirectDownload, streamRateLimiter, streamTelegramVideo);

// ============================================================================
// HLS STREAMING & SUBTITLE ENDPOINTS
// ============================================================================

// @desc    Master Manifest Endpoint
// @route   GET /api/videos/hls/:videoId/master.m3u8
const handleMasterManifest = (req, res) => {
  const { videoId } = req.params;
  const masterPath = path.resolve(__dirname, '..', 'public', 'hls', videoId, 'master.m3u8');

  // Fallback behavior if HLS files do not exist yet (transcoding or not yet started)
  if (!fs.existsSync(masterPath)) {
    return res.status(202).json({
      status: 'transcoding',
      message: 'HLS stream is not yet ready or is currently transcoding',
      fallbackUrl: `/api/videos/stream-tg/${videoId}`
    });
  }

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  if (req.method === 'HEAD') {
    return res.status(200).end();
  }
  return fs.createReadStream(masterPath).pipe(res);
};

router.get('/hls/:videoId/master.m3u8', handleMasterManifest);
router.head('/hls/:videoId/master.m3u8', handleMasterManifest);

// @desc    Tracks metadata for frontend inspection (Audio tracks, Subtitles)
// @route   GET /api/videos/hls/:videoId/tracks.json
router.get('/hls/:videoId/tracks.json', async (req, res) => {
  const { videoId } = req.params;
  const tracksPath = path.resolve(__dirname, '..', 'public', 'hls', videoId, 'tracks.json');
  if (fs.existsSync(tracksPath)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return fs.createReadStream(tracksPath).pipe(res);
  }

  // Look up video to find associated IDs (messageId, drive_file_id, etc.)
  let searchIds = [videoId];
  try {
    const Video = require('../models/Video');
    const mongoose = require('mongoose');
    const or = [{ slug: videoId }, { drive_file_id: String(videoId) }];
    if (/^\d+$/.test(videoId)) or.push({ telegram_message_id: parseInt(videoId, 10) });
    if (mongoose.Types.ObjectId.isValid(videoId)) or.push({ _id: videoId });
    const video = await Video.findOne({ $or: or });
    if (video) {
      if (video.drive_file_id) searchIds.push(String(video.drive_file_id));
      if (video.telegram_message_id) searchIds.push(String(video.telegram_message_id));
      if (video._id) searchIds.push(String(video._id));
      if (video.slug) searchIds.push(video.slug);
    }
  } catch {}

  const languageMap = {
    en: 'English', eng: 'English',
    ml: 'Malayalam', mal: 'Malayalam',
    hi: 'Hindi', hin: 'Hindi',
    ta: 'Tamil', tam: 'Tamil',
    te: 'Telugu', tel: 'Telugu',
    es: 'Spanish', spa: 'Spanish',
    fr: 'French', fre: 'French',
    ar: 'Arabic', ara: 'Arabic'
  };

  let subtitles = [];
  for (const id of searchIds) {
    const subsDir = path.resolve(__dirname, '..', 'public', 'subtitles', String(id));
    if (fs.existsSync(subsDir)) {
      const files = fs.readdirSync(subsDir).filter(f => f.endsWith('.vtt'));
      files.forEach(f => {
        const lang = f.replace('.vtt', '').toLowerCase();
        const title = languageMap[lang] || lang.toUpperCase();
        if (!subtitles.some(s => s.lang === lang)) {
          subtitles.push({
            lang,
            language: lang,
            title,
            name: title,
            url: `/api/videos/subtitles/${id}/${f}`
          });
        }
      });
    }
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.json({
    success: true,
    audioTracks: [
      { id: 0, name: 'Default Audio (Original)', lang: 'original', default: true }
    ],
    subtitles
  });
});

// @desc    Variant Playlist Endpoint (480p.m3u8, 720p.m3u8, 1080p.m3u8)
// @route   GET /api/videos/hls/:videoId/:playlist.m3u8
router.get('/hls/:videoId/:playlist.m3u8', (req, res) => {
  const { videoId, playlist } = req.params;
  const playlistPath = path.resolve(__dirname, '..', 'public', 'hls', videoId, `${playlist}.m3u8`);

  if (!fs.existsSync(playlistPath)) {
    return res.status(404).json({ error: 'Variant playlist not found' });
  }

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return fs.createReadStream(playlistPath).pipe(res);
});

// @desc    HLS Transport Stream Segment Endpoint (*.ts)
// @route   GET /api/videos/hls/:videoId/:segment.ts
router.get('/hls/:videoId/:segment.ts', (req, res) => {
  const { videoId, segment } = req.params;
  const segmentPath = path.resolve(__dirname, '..', 'public', 'hls', videoId, `${segment}.ts`);

  if (!fs.existsSync(segmentPath)) {
    return res.status(404).json({ error: 'Segment not found' });
  }

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  return fs.createReadStream(segmentPath).pipe(res);
});

// @desc    Subtitle WebVTT Route
// @route   GET /api/videos/subtitles/:videoId/:lang.vtt
router.get('/subtitles/:videoId/:lang.vtt', async (req, res) => {
  const { videoId, lang } = req.params;
  let subPath = path.resolve(__dirname, '..', 'public', 'subtitles', videoId, `${lang}.vtt`);

  if (!fs.existsSync(subPath)) {
    // Try resolving by video slug, messageId, or driveFileId
    try {
      const Video = require('../models/Video');
      const mongoose = require('mongoose');
      const or = [{ slug: videoId }, { drive_file_id: String(videoId) }];
      if (/^\d+$/.test(videoId)) or.push({ telegram_message_id: parseInt(videoId, 10) });
      if (mongoose.Types.ObjectId.isValid(videoId)) or.push({ _id: videoId });
      const video = await Video.findOne({ $or: or });
      if (video) {
        const altIds = [video.drive_file_id, video.telegram_message_id, video._id, video.slug].filter(Boolean);
        for (const alt of altIds) {
          const testPath = path.resolve(__dirname, '..', 'public', 'subtitles', String(alt), `${lang}.vtt`);
          if (fs.existsSync(testPath)) {
            subPath = testPath;
            break;
          }
        }
      }
    } catch {}
  }

  if (!fs.existsSync(subPath)) {
    return res.status(404).send('WEBVTT\n\nNOTE Subtitle not found');
  }

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return fs.createReadStream(subPath).pipe(res);
});

// ============================================================================
// STORYBOARD PREVIEW THUMBNAIL SPRITE SHEET ROUTES
// ============================================================================

// @desc    Serve Storyboard WebVTT Manifest
// @route   GET /api/videos/storyboard/:videoId/storyboard.vtt
router.get('/storyboard/:videoId/storyboard.vtt', (req, res) => {
  const { videoId } = req.params;
  const vttPath = path.resolve(__dirname, '..', 'public', 'storyboards', videoId, 'storyboard.vtt');

  if (!fs.existsSync(vttPath)) {
    return res.status(404).send('WEBVTT\n\nNOTE Storyboard not found');
  }

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return fs.createReadStream(vttPath).pipe(res);
});

// @desc    Serve Storyboard Sprite Sheet Image Tiles
// @route   GET /api/videos/storyboard/:videoId/:spriteImage
router.get('/storyboard/:videoId/:spriteImage', (req, res) => {
  const { videoId, spriteImage } = req.params;
  const spritePath = path.resolve(__dirname, '..', 'public', 'storyboards', videoId, spriteImage);

  if (!fs.existsSync(spritePath)) {
    return res.status(404).json({ error: 'Sprite image not found' });
  }

  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  return fs.createReadStream(spritePath).pipe(res);
});

// @desc    Test Producer: Asynchronously enqueue a mock video transcoding job
// @route   POST /api/videos/test-queue
router.post('/test-queue', async (req, res) => {
  try {
    const { videoId = '27', telegramFileId = 'tg_sample_file' } = req.body || {};
    const { addTranscodeJob } = require('../queues/transcodeQueue');

    const job = await addTranscodeJob({
      videoId,
      telegramFileId,
      queuedAt: new Date().toISOString()
    });

    return res.status(202).json({
      success: true,
      status: 'queued',
      message: 'Video transcode job has been asynchronously enqueued',
      jobId: job.id,
      data: { videoId, telegramFileId }
    });
  } catch (err) {
    console.error('Queue producer error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

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

    // Check if the provided ID is a valid MongoDB ObjectId or telegram message id or drive file id or slug
    const queries = [{ slug: id }];
    if (mongoose.Types.ObjectId.isValid(id)) {
      queries.push({ _id: id });
    }
    queries.push({ drive_file_id: String(id) });
    const num = parseInt(id, 10);
    if (!isNaN(num)) {
      queries.push({ telegram_message_id: num });
    }
    query = { $or: queries };

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
