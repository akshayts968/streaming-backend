const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  connectTimeout: 2000,
  enableOfflineQueue: false,
  ...(process.env.REDIS_URL?.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {})
});

redis.on('error', () => {});

const STREAM_SECRET = process.env.HLS_STREAM_SECRET || 'antigravity-secure-hls-secret-key-32b';
const STORAGE_ROOT = path.resolve(process.env.HLS_STORAGE_ROOT || path.join(__dirname, '..', 'public', 'hls'));

/**
 * Generate a cryptographically signed short-lived stream token (60 seconds)
 */
const generateStreamToken = (mediaId, userId = 'anon') => {
  const expires = Math.floor(Date.now() / 1000) + 60;
  const payload = `${mediaId}:${userId}:${expires}`;
  const signature = crypto.createHmac('sha256', STREAM_SECRET).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ mediaId, userId, expires, sig: signature })).toString('base64url');
};

/**
 * Validate incoming stream token
 */
const verifyStreamToken = (token, expectedMediaId) => {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const { mediaId, userId, expires, sig } = JSON.parse(raw);

    if (mediaId !== expectedMediaId) return false;
    if (Math.floor(Date.now() / 1000) > expires) return false;

    const expectedPayload = `${mediaId}:${userId}:${expires}`;
    const expectedSig = crypto.createHmac('sha256', STREAM_SECRET).update(expectedPayload).digest('hex');

    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
  } catch {
    return false;
  }
};

/**
 * GET /api/v1/stream/manifest/:mediaId
 */
const getStreamManifest = async (req, res) => {
  try {
    const { mediaId } = req.params;
    const incomingToken = req.query.token;
    const user = req.user;

    if (!incomingToken && !user) {
      return res.status(401).json({ success: false, message: 'Authentication required for media stream' });
    }

    if (incomingToken && !verifyStreamToken(incomingToken, mediaId)) {
      return res.status(403).json({ success: false, message: 'Invalid or expired stream token' });
    }

    const playlistFile = req.query.file || 'master.m3u8';
    const filePath = path.join(STORAGE_ROOT, mediaId, path.basename(playlistFile));

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'Playlist variant not found' });
    }

    const currentToken = incomingToken || generateStreamToken(mediaId, user?._id?.toString() || user?.id || 'auth-user');
    let playlistContent = fs.readFileSync(filePath, 'utf8');

    // 1. Rewrite key URL with token
    playlistContent = playlistContent.replace(
      new RegExp(`URI="(/api/v1/stream/key/${mediaId})"`, 'g'),
      `URI="$1?token=${currentToken}"`
    );

    // 2. Append token to sub-playlists (.m3u8) and subtitle tracks (.vtt)
    playlistContent = playlistContent.replace(
      /^(?!#)(.+\.(m3u8|vtt))$/gm,
      (match) => `/api/v1/stream/manifest/${mediaId}?file=${encodeURIComponent(match)}&token=${currentToken}`
    );

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.send(playlistContent);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/v1/stream/key/:mediaId
 */
const getStreamKey = async (req, res) => {
  try {
    const { mediaId } = req.params;
    const token = req.query.token;

    if (!token || !verifyStreamToken(token, mediaId)) {
      return res.status(403).send('Forbidden: Invalid Key Token');
    }

    let hexKey = null;
    try {
      hexKey = await redis.get(`hls:key:${mediaId}`);
    } catch {}

    let keyBuffer;
    if (hexKey) {
      keyBuffer = Buffer.from(hexKey, 'hex');
    } else {
      const localKeyFile = path.join(STORAGE_ROOT, mediaId, 'enc.key');
      if (!fs.existsSync(localKeyFile)) {
        return res.status(404).send('Key not found');
      }
      keyBuffer = fs.readFileSync(localKeyFile);
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store, private');
    res.send(keyBuffer);
  } catch (err) {
    res.status(500).send('Error delivering encryption key');
  }
};

/**
 * GET /api/v1/stream/token/:mediaId
 */
const getStreamTokenEndpoint = async (req, res) => {
  try {
    const { mediaId } = req.params;
    const user = req.user;
    const token = generateStreamToken(mediaId, user?._id?.toString() || user?.id || 'client');
    res.json({
      success: true,
      token,
      manifestUrl: `/api/v1/stream/manifest/${mediaId}?token=${token}`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  generateStreamToken,
  verifyStreamToken,
  getStreamManifest,
  getStreamKey,
  getStreamTokenEndpoint
};
