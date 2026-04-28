const { S3Client } = require('@aws-sdk/client-s3');
const multer = require('multer');
const multerS3 = require('multer-s3');
const path = require('path');
const fs = require('fs');

// Initialize S3 Client
const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'minioadmin',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'minioadmin',
  },
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT, // For local testing with MinIO or similar
  forcePathStyle: !!process.env.S3_ENDPOINT,
});

// Configure Multer for S3
const uploadS3 = multer({
  storage: multerS3({
    s3: s3,
    bucket: process.env.S3_BUCKET_NAME || 'antigravity-stream',
    acl: 'public-read',
    metadata: function (req, file, cb) {
      cb(null, { fieldName: file.fieldname });
    },
    key: function (req, file, cb) {
      cb(null, `videos/${Date.now().toString()}-${file.originalname}`);
    }
  }),
  fileFilter: function (req, file, cb) {
    const filetypes = /mp4|mkv|mov|avi/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb('Error: Videos Only!');
    }
  }
});

// Fallback for Local Storage (for development without AWS)
const localStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = './uploads/videos';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    cb(null, `video-${Date.now()}${path.extname(file.originalname)}`);
  }
});

const uploadLocal = multer({ storage: localStorage });

// Flexible storage for chunks
const chunkStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = './uploads/temp';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const chunkUpload = multer({ storage: chunkStorage });

// Export the appropriate upload middleware
const upload = process.env.AWS_ACCESS_KEY_ID ? uploadS3 : uploadLocal;

module.exports = { s3, upload, chunkUpload };
