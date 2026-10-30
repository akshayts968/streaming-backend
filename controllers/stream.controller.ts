import { Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  connectTimeout: 2000,
  enableOfflineQueue: false,
  ...(process.env.REDIS_URL?.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {})
});

redis.on('error', (err) => {
  // Suppress uncaught redis log noise
});

const STREAM_SECRET = process.env.HLS_STREAM_SECRET || 'antigravity-secure-hls-secret-key-32b';
const STORAGE_ROOT = path.resolve(process.env.HLS_STORAGE_ROOT || path.join(__dirname, '..', 'public', 'hls'));

/**
 * Generate a cryptographically signed short-lived stream token (60 seconds)
 */
export const generateStreamToken = (mediaId: string, userId: string = 'anon'): string => {
  const expires = Math.floor(Date.now() / 1000) + 60; // 60 seconds TTL
  const payload = `${mediaId}:${userId}:${expires}`;
  const signature = crypto.createHmac('sha256', STREAM_SECRET).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ mediaId, userId, expires, sig: signature })).toString('base64url');
};

/**
 * Validate incoming stream token
 */
export const verifyStreamToken = (token: string, expectedMediaId: string): boolean => {
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
 * Delivers master and variant playlists rewritten with short-lived access tokens
 */
export const getStreamManifest = async (req: Request, res: Response): Promise<void> => {
  try {
    const { mediaId } = req.params;
    const incomingToken = req.query.token as string;
    const user = (req as any).user;

    // Validate token or user authorization
    if (!incomingToken && !user) {
      res.status(401).json({ success: false, message: 'Authentication required for media stream' });
      return;
    }

    if (incomingToken && !verifyStreamToken(incomingToken, mediaId)) {
      res.status(403).json({ success: false, message: 'Invalid or expired stream token' });
      return;
    }

    const playlistFile = (req.query.file as string) || 'master.m3u8';
    const filePath = path.join(STORAGE_ROOT, mediaId, path.basename(playlistFile));

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ success: false, message: 'Playlist variant not found' });
      return;
    }

    // Refresh valid stream token for downstream sub-manifests and keys
    const currentToken = incomingToken || generateStreamToken(mediaId, user?._id?.toString() || user?.id || 'auth-user');
    let playlistContent = fs.readFileSync(filePath, 'utf8');

    // 1. Rewrite key URL with token: URI="/api/v1/stream/key/:mediaId" -> URI="/api/v1/stream/key/:mediaId?token=..."
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
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/v1/stream/key/:mediaId
 * Delivers the raw 16-byte AES-128 key for fragment decryption
 */
export const getStreamKey = async (req: Request, res: Response): Promise<void> => {
  try {
    const { mediaId } = req.params;
    const token = req.query.token as string;

    if (!token || !verifyStreamToken(token, mediaId)) {
      res.status(403).send('Forbidden: Invalid Key Token');
      return;
    }

    // 1. Check Redis cache
    let hexKey = null;
    try {
      hexKey = await redis.get(`hls:key:${mediaId}`);
    } catch {}

    let keyBuffer: Buffer;

    if (hexKey) {
      keyBuffer = Buffer.from(hexKey, 'hex');
    } else {
      // 2. Fallback to storage enc.key file
      const localKeyFile = path.join(STORAGE_ROOT, mediaId, 'enc.key');
      if (!fs.existsSync(localKeyFile)) {
        res.status(404).send('Key not found');
        return;
      }
      keyBuffer = fs.readFileSync(localKeyFile);
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store, private');
    res.send(keyBuffer);
  } catch (err: any) {
    res.status(500).send('Error delivering encryption key');
  }
};

/**
 * GET /api/v1/stream/token/:mediaId
 * Generates and returns a signed stream token for authorized clients
 */
export const getStreamTokenEndpoint = async (req: Request, res: Response): Promise<void> => {
  try {
    const { mediaId } = req.params;
    const user = (req as any).user;
    const token = generateStreamToken(mediaId, user?._id?.toString() || user?.id || 'client');
    res.json({
      success: true,
      token,
      manifestUrl: `/api/v1/stream/manifest/${mediaId}?token=${token}`
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};
