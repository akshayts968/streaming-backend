const express = require('express');
const mongoose = require('mongoose');
const { upload } = require('../utils/upload');
const { protect, authorize } = require('../middleware/auth');
const { uploadImage } = require('../utils/cloudinary');
const Series = require('../models/Series');
const Video = require('../models/Video');
const { getCache, setCache, redis, clearCachePattern } = require('../utils/redis');
const fs = require('fs');

const router = express.Router();

// @desc    Create a new series
// @route   POST /api/series
router.post('/', protect, authorize('admin'), upload.single('thumbnail'), async (req, res) => {
  try {
    const { title, description, category, language, totalEpisodes } = req.body;
    const categories = Array.isArray(category) ? category : (category ? category.split(',').map(c => c.trim()) : []);
    let thumbnailUrl = 'no-thumbnail.jpg';

    if (!title || !category || !language || !totalEpisodes) {
      return res.status(400).json({ success: false, message: 'Please provide all required fields' });
    }

    if (req.file) {
      thumbnailUrl = await uploadImage(req.file.path);
      fs.unlinkSync(req.file.path);
    }

    const series = await Series.create({
      title,
      description,
      category: categories,
      language,
      totalEpisodes: Number(totalEpisodes),
      thumbnailUrl,
      creator: req.user.id
    });
    await series.save();

    // Invalidate series list cache
    await clearCachePattern('series_list_*');

    res.status(201).json({ success: true, data: series });
  } catch (err) {
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Get all series
// @route   GET /api/series
router.get('/', async (req, res) => {
  try {
    const cacheKey = `series_list_${JSON.stringify(req.query)}`;
    const cachedResponse = await getCache(cacheKey);
    if (cachedResponse) return res.status(200).json(cachedResponse);

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    const total = await Series.countDocuments();
    const series = await Series.find()
      .populate('creator', 'username')
      .skip(skip)
      .limit(limit)
      .sort('-createdAt');

    const response = {
      success: true, 
      count: series.length, 
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit)
      },
      data: series 
    };

    await setCache(cacheKey, response, 300); // Cache for 5 minutes
    res.status(200).json(response);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Get single series with episodes
// @desc    Get single series
router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let query;

    if (mongoose.Types.ObjectId.isValid(id)) {
      query = { $or: [{ _id: id }, { slug: id }] };
    } else {
      query = { slug: id };
    }

    const series = await Series.findOne(query).populate('creator', 'username');
    if (!series) {
      return res.status(404).json({ success: false, message: 'Series not found' });
    }

    const episodes = await Video.find({ seriesId: series._id, type: 'Episode' }).sort('episodeNumber');

    res.status(200).json({ success: true, data: { series, episodes } });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Update series
// @route   PUT /api/series/:id
router.put('/:id', protect, authorize('admin'), upload.single('thumbnail'), async (req, res) => {
  try {
    let series = await Series.findById(req.params.id);
    if (!series) {
      return res.status(404).json({ success: false, message: 'Series not found' });
    }

    const { title, description, category, language, totalEpisodes } = req.body;
    let thumbnailUrl = series.thumbnailUrl;

    if (req.file) {
      thumbnailUrl = await uploadImage(req.file.path);
      fs.unlinkSync(req.file.path);
    }

    series = await Series.findByIdAndUpdate(req.params.id, {
      title: title || series.title,
      description: description !== undefined ? description : series.description,
      category: category || series.category,
      language: language || series.language,
      totalEpisodes: totalEpisodes ? Number(totalEpisodes) : series.totalEpisodes,
      thumbnailUrl
    }, { new: true, runValidators: true });

    res.status(200).json({ success: true, data: series });
  } catch (err) {
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Delete series
// @route   DELETE /api/series/:id
router.delete('/:id', protect, authorize('admin'), async (req, res) => {
  try {
    const series = await Series.findById(req.params.id);
    if (!series) {
      return res.status(404).json({ success: false, message: 'Series not found' });
    }

    // Delete all episodes associated with this series
    await Video.deleteMany({ seriesId: series._id, type: 'Episode' });

    await series.deleteOne();

    res.status(200).json({ success: true, message: 'Series and its episodes deleted' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

module.exports = router;
