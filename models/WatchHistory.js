const mongoose = require('mongoose');

const watchHistorySchema = new mongoose.Schema({
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
  timestamp: {
    type: Number, // Seconds into the video
    default: 0,
  },
  lastWatched: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('WatchHistory', watchHistorySchema);
