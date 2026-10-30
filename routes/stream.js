const express = require('express');
const router = express.Router();
const { 
  getStreamManifest, 
  getStreamKey, 
  getStreamTokenEndpoint 
} = require('../controllers/streamController');

// Optional auth: allows token in query or Authorization header
const optionalAuth = (req, res, next) => {
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    const token = req.headers.authorization.split(' ')[1];
    try {
      const jwt = require('jsonwebtoken');
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch {}
  }
  next();
};

// @route   GET /api/v1/stream/manifest/:mediaId
router.get('/manifest/:mediaId', optionalAuth, getStreamManifest);

// @route   GET /api/v1/stream/key/:mediaId
router.get('/key/:mediaId', getStreamKey);

// @route   GET /api/v1/stream/token/:mediaId
router.get('/token/:mediaId', optionalAuth, getStreamTokenEndpoint);

module.exports = router;
