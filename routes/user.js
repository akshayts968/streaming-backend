const express = require('express');
const { protect } = require('../middleware/auth');
const WatchHistory = require('../models/WatchHistory');
const Watchlist = require('../models/Watchlist');
const router = express.Router();

// @desc    Get user's watch history (Continue Watching)
// @route   GET /api/user/history
router.get('/history', protect, async (req, res) => {
  try {
    const history = await WatchHistory.find({ user: req.user.id })
      .populate('video')
      .sort('-lastWatched')
      .limit(10);

    res.status(200).json({ success: true, data: history });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Update watch history timestamp
// @route   POST /api/user/history
router.post('/history', protect, async (req, res) => {
  try {
    const { videoId, timestamp } = req.body;

    let history = await WatchHistory.findOne({ user: req.user.id, video: videoId });

    if (history) {
      history.timestamp = timestamp;
      history.lastWatched = Date.now();
      await history.save();
    } else {
      history = await WatchHistory.create({
        user: req.user.id,
        video: videoId,
        timestamp
      });
    }

    res.status(200).json({ success: true, data: history });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Get user's watchlist
// @route   GET /api/user/watchlist
router.get('/watchlist', protect, async (req, res) => {
  try {
    const list = await Watchlist.find({ user: req.user.id }).populate('video');
    res.status(200).json({ success: true, data: list });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Add to/Remove from watchlist
// @route   POST /api/user/watchlist
router.post('/watchlist', protect, async (req, res) => {
  try {
    const { videoId } = req.body;

    const existing = await Watchlist.findOne({ user: req.user.id, video: videoId });

    if (existing) {
      await existing.deleteOne();
      return res.status(200).json({ success: true, message: 'Removed from watchlist' });
    }

    const item = await Watchlist.create({
      user: req.user.id,
      video: videoId
    });

    res.status(201).json({ success: true, data: item });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Get current watch time consumed
// @route   GET /api/user/watch-time
router.get('/watch-time', protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      return res.status(200).json({ success: true, consumed: 0, isAdmin: true });
    }
    res.status(200).json({ success: true, consumed: req.user.watchTimeConsumed || 0, isAdmin: false });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Track watch time for paywall
// @route   POST /api/user/track-time
router.post('/track-time', protect, async (req, res) => {
  try {
    const { secondsWatched } = req.body;
    
    if (req.user.role === 'admin') {
      return res.status(200).json({ success: true, allowed: true, message: 'Admin bypass' });
    }

    if (!secondsWatched || isNaN(secondsWatched)) {
      return res.status(400).json({ success: false, message: 'Invalid secondsWatched' });
    }

    req.user.watchTimeConsumed += Number(secondsWatched);
    await req.user.save();

    const LIMIT_SECONDS = 300; // 5 minutes

    if (req.user.watchTimeConsumed >= LIMIT_SECONDS) {
      return res.status(403).json({ success: true, allowed: false, consumed: req.user.watchTimeConsumed });
    }

    res.status(200).json({ success: true, allowed: true, consumed: req.user.watchTimeConsumed });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// @desc    Mock payment to reset watch time
// @route   POST /api/user/reset-time
router.post('/reset-time', protect, async (req, res) => {
  try {
    req.user.watchTimeConsumed = 0;
    await req.user.save();
    res.status(200).json({ success: true, message: 'Time reset successfully. Thank you for your purchase!' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

module.exports = router;
