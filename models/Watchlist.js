const mongoose = require('mongoose');

const watchlistSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true,
  },
  video: {
    type: mongoose.Schema.ObjectId,
    ref: 'Video',
    required: true,
  },
  addedAt: {
    type: Date,
    default: Date.now,
  },
});

// Prevent duplicate entries for the same user and video
watchlistSchema.index({ user: 1, video: 1 }, { unique: true });

module.exports = mongoose.model('Watchlist', watchlistSchema);
