const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const uploadImage = async (filePath) => {
  try {
    const result = await cloudinary.uploader.upload(filePath, {
      folder: 'antigravity_stream/thumbnails',
    });
    return result.secure_url;
  } catch (err) {
    console.error('Cloudinary Upload Error:', err);
    throw new Error('Failed to upload thumbnail to Cloudinary');
  }
};

const uploadVideo = async (filePath) => {
  try {
    const result = await cloudinary.uploader.upload(filePath, {
      folder: 'antigravity_stream/videos',
      resource_type: 'video',
      chunk_size: 6000000,
      eager: [
        { width: 1920, height: 1080, crop: "scale", format: "mp4" },
        { width: 1280, height: 720, crop: "scale", format: "mp4" },
        { width: 640, height: 360, crop: "scale", format: "mp4" }
      ],
      eager_async: true,
    });
    return result;
  } catch (err) {
    console.error('Cloudinary Video Upload Error:', err);
    throw new Error('Failed to upload video to Cloudinary');
  }
};

module.exports = { uploadImage, uploadVideo };
