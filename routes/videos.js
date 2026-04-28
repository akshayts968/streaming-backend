const express = require('express');
const { upload, chunkUpload } = require('../utils/upload');
const { protect, authorize } = require('../middleware/auth');
const { streamVideo, uploadVideoToDrive, uploadVideoToCloudinary, uploadChunkToDrive } = require('../controllers/videoController');
const { uploadImage } = require('../utils/cloudinary');
const Video = require('../models/Video');
const router = express.Router();
const fs = require('fs');

// @desc    Search videos
// @route   GET /api/videos/search
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ success: false, message: 'Please provide a search query' });
    const videos = await Video.find({
      $or: [
        { title: { $regex: q, $options: 'i' } },
        { tags: { $in: [new RegExp(q, 'i')] } },
        { category: { $regex: q, $options: 'i' } }
      ]
    }).populate('creator', 'username');
    res.status(200).json({ success: true, count: videos.length, data: videos });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Stream video from Google Drive
router.get('/stream/:fileId', streamVideo);

// Configuration for multiple fields
const uploadFields = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 }
]);

// @desc    Upload a video to Google Drive (Single Request - Legacy)
router.post('/upload-drive', protect, authorize('viewer', 'creator', 'admin'), uploadFields, async (req, res) => {
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
router.post('/upload-chunk', protect, authorize('viewer', 'creator', 'admin'), chunkFields, async (req, res) => {
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
router.post('/upload-cloudinary', protect, authorize('viewer', 'creator', 'admin'), uploadFields, async (req, res) => {
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
router.post('/upload', protect, authorize('viewer', 'creator', 'admin'), uploadFields, async (req, res) => {
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
    const videoFile = req.files.video[0];

    let videoUrl = videoFile.location; 
    if (!videoUrl) {
      videoUrl = `/uploads/videos/${videoFile.filename}`;
    }

    const video = await Video.create({
      title,
      description,
      category,
      tags: tags ? tags.split(',') : [],
      videoUrl,
      creator: req.user.id,
      thumbnailUrl
    });

    res.status(201).json({ success: true, data: video });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Get all videos
router.get('/', async (req, res) => {
  try {
    const query = {};
    if (req.query.isHero === 'true') {
      query.isHero = true;
    }
    const videos = await Video.find(query).populate('creator', 'username');
    res.status(200).json({ success: true, count: videos.length, data: videos });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Get single video
router.get('/:id', async (req, res) => {
  try {
    const video = await Video.findById(req.params.id).populate('creator', 'username');
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    res.status(200).json({ success: true, data: video });
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

    res.status(200).json({ success: true, data: video });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Link an existing Google Drive video
// @route   POST /api/videos/link-drive
router.post('/link-drive', protect, authorize('admin'), async (req, res) => {
  try {
    const { title, description, category, drive_file_id, thumbnailUrl, duration } = req.body;

    if (!title || !category || !drive_file_id) {
      return res.status(400).json({ success: false, message: 'Please provide title, category, and drive_file_id' });
    }

    const video = await Video.create({
      title,
      description,
      category,
      videoUrl: `/api/videos/stream/${drive_file_id}`,
      drive_file_id,
      thumbnailUrl: thumbnailUrl || 'no-thumbnail.jpg',
      duration: duration || '00:00',
      creator: req.user.id
    });

    res.status(201).json({ success: true, data: video });
  } catch (err) {
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
