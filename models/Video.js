const mongoose = require('mongoose');

const videoSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Please add a title'],
    trim: true,
    maxlength: [100, 'Title cannot be more than 100 characters'],
  },
  description: {
    type: String,
    default: '',
    maxlength: [1000, 'Description cannot be more than 1000 characters'],
  },
  thumbnailUrl: {
    type: String,
    default: 'no-thumbnail.jpg',
  },
  videoUrl: {
    type: String,
    required: [true, 'Please add a video URL'],
  },
  drive_file_id: {
    type: String,
  },
  creator: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true,
  },
  duration: {
    type: String,
  },
  views: {
    type: Number,
    default: 0,
  },
  category: {
    type: String,
    required: [true, 'Please add a category'],
    enum: ['Action', 'Drama', 'Thriller', 'Comedy', 'Documentary', 'Regional', 'Other'],
  },
  tags: [String],
  isPublished: {
    type: Boolean,
    default: true,
  },
  isHero: {
    type: Boolean,
    default: false,
  },
  useIframe: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Video', videoSchema);
