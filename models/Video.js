const mongoose = require('mongoose');

const slugify = (text) => {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')     // Replace spaces with -
    .replace(/[^\w-]+/g, '')  // Remove all non-word chars
    .replace(/--+/g, '-');    // Replace multiple - with single -
};

const videoSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['Movie', 'Episode'],
    default: 'Movie'
  },
  seriesId: {
    type: mongoose.Schema.ObjectId,
    ref: 'Series',
  },
  seasonNumber: {
    type: Number,
    default: 1,
  },
  episodeNumber: {
    type: Number,
  },
  title: {
    type: String,
    required: [true, 'Please add a title'],
    trim: true,
    maxlength: [300, 'Title cannot be more than 300 characters'],
  },
  slug: {
    type: String,
    unique: true
  },
  description: {
    type: String,
    default: '',
    maxlength: [3000, 'Description cannot be more than 3000 characters'],
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
  telegram_message_id: {
    type: Number,
  },
  telegram_file_id: {
    type: String,
  },
  storageProvider: {
    type: String,
    enum: ['drive', 'telegram', 'local', 'cloudinary'],
    default: 'telegram',
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
  category: [{
    type: String,
    required: [true, 'Please add a category'],
    enum: ['Action', 'Drama', 'Thriller', 'Comedy', 'Sci-Fi', 'Adventure', 'Horror', 'Romance', 'Animation', 'Documentary', 'Regional', 'Fantasy', 'Mystery', 'Crime', 'Other'],
  }],
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

videoSchema.pre('save', async function() {
  if (this.type === 'Episode' && this.seriesId && (!this.thumbnailUrl || this.thumbnailUrl === 'no-thumbnail.jpg')) {
    try {
      const Series = mongoose.model('Series');
      const series = await Series.findById(this.seriesId);
      if (series && series.thumbnailUrl && series.thumbnailUrl !== 'no-thumbnail.jpg') {
        this.thumbnailUrl = series.thumbnailUrl;
      }
    } catch (err) {
      console.error('Error fetching series thumbnail in Video pre-save:', err);
    }
  }
});

// Generate slug before saving
videoSchema.pre('save', async function() {
  if (this.isModified('title') || !this.slug) {
    let baseSlug = slugify(this.title);
    let slug = baseSlug;
    let count = 1;
    
    // Ensure uniqueness
    while (await mongoose.models.Video.findOne({ slug, _id: { $ne: this._id } })) {
      slug = `${baseSlug}-${count++}`;
    }
    this.slug = slug;
  }
});

module.exports = mongoose.model('Video', videoSchema);
