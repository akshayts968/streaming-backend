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

const seriesSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Please add a series title'],
    trim: true,
    maxlength: [100, 'Title cannot be more than 100 characters'],
  },
  slug: {
    type: String,
    unique: true
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
  language: {
    type: String,
    required: [true, 'Please add a language'],
  },
  category: [{
    type: String,
    required: [true, 'Please add a category'],
    enum: ['Action', 'Drama', 'Thriller', 'Comedy', 'Documentary', 'Regional', 'Other'],
  }],
  totalEpisodes: {
    type: Number,
    required: [true, 'Please specify total episodes'],
  },
  creator: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Generate slug before saving
seriesSchema.pre('save', async function() {
  if (this.isModified('title') || !this.slug) {
    let baseSlug = slugify(this.title);
    let slug = baseSlug;
    let count = 1;
    
    // Ensure uniqueness
    while (await mongoose.models.Series.findOne({ slug, _id: { $ne: this._id } })) {
      slug = `${baseSlug}-${count++}`;
    }
    this.slug = slug;
  }
});

module.exports = mongoose.model('Series', seriesSchema);
