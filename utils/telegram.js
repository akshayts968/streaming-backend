const { getVideoMetadataCache, setVideoMetadataCache, getVideoChunkCache, setVideoChunkCache, acquireChunkLock, releaseChunkLock } = require('./redis');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const bigInt = require('big-integer');
const dotenv = require('dotenv');

dotenv.config();

let clientInstance = null;
let isConnecting = false;
let isListenerActive = false;

// In-memory tracker for interactive chat prompts:
// key: messageId -> { messageId, fileId, fileName, rawFileName, sizeMB, size, isForward, senderChatId, timestamp, step, details, thumbnailUrl }
const pendingUploads = new Map();
const lastPendingBySender = new Map(); // senderChatId -> messageId
const recentPhotosBySender = new Map(); // senderChatId -> { messageId, timestamp }

const fs = require('fs');
const path = require('path');
const { fetchVideoMetadata } = require('./metadataFetcher');

const downloadMediaSafe = async (client, mediaOrMsg) => {
  try {
    const res = await client.downloadMedia(mediaOrMsg);
    if (!res) return null;
    if (Buffer.isBuffer(res)) return res;
    if (Array.isArray(res)) return Buffer.concat(res.map(b => Buffer.isBuffer(b) ? b : Buffer.from(b)));
    return Buffer.from(res);
  } catch (err) {
    console.error('[Telegram Download Media Error]:', err.message);
    return null;
  }
};

const getTelegramClient = async () => {
  if (clientInstance && clientInstance.connected) {
    return clientInstance;
  }

  if (isConnecting) {
    while (isConnecting) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (clientInstance && clientInstance.connected) return clientInstance;
  }

  const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const sessionStr = process.env.TELEGRAM_SESSION || '';

  if (!apiId || !apiHash || !botToken) {
    throw new Error('Telegram credentials (API_ID, API_HASH, BOT_TOKEN) are missing in .env');
  }

  try {
    isConnecting = true;
    const session = new StringSession(sessionStr);
    clientInstance = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
      autoReconnect: true,
      useIPV6: false,
    });

    await clientInstance.start({ botAuthToken: botToken });
    console.log('✅ Telegram GramJS Client Connected Successfully');
    isConnecting = false;
    return clientInstance;
  } catch (err) {
    isConnecting = false;
    console.error('❌ Failed to initialize Telegram client:', err.message);
    throw err;
  }
};

const getTargetChatId = () => {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID is not configured');
  if (/^-?\d+$/.test(chatId)) {
    return chatId.length > 10 ? bigInt(chatId) : parseInt(chatId, 10);
  }
  return chatId;
};

// Global active upload state for live dashboard monitoring
let activeTelegramUpload = {
  isUploading: false,
  isProcessing: false,
  fileName: '',
  progress: 0,
  uploadedMB: '0.0',
  totalMB: '0.0',
  speed: '0 MB/s',
  status: 'Idle',
  startedAt: null,
  updatedAt: null,
  messageId: null,
  videoId: null,
  source: 'Telegram'
};

// History of recent Telegram forwards/uploads for Admin Dashboard
const recentTelegramActivity = [];
let isDbLoaded = false;

const loadRecentTelegramActivityFromDb = async () => {
  if (isDbLoaded) return;
  try {
    const Video = require('../models/Video');
    const dbVideos = await Video.find({
      telegram_message_id: { $exists: true, $ne: null }
    })
      .populate('seriesId', 'title')
      .sort({ createdAt: -1 })
      .limit(15)
      .lean();

    if (dbVideos && dbVideos.length > 0) {
      isDbLoaded = true;
      for (const v of dbVideos) {
        if (!recentTelegramActivity.some(a => String(a.id) === String(v.telegram_message_id))) {
          recentTelegramActivity.push({
            id: String(v.telegram_message_id),
            title: v.title,
            rawFileName: v.title,
            sizeMB: v.telegram_file_id ? 'Cloud' : 'N/A',
            source: 'Telegram Video',
            status: 'Published',
            category: Array.isArray(v.category) ? v.category : [v.category],
            videoId: v._id.toString(),
            type: v.type || 'Movie',
            seriesId: v.seriesId ? (v.seriesId._id ? v.seriesId._id.toString() : v.seriesId.toString()) : null,
            seriesTitle: v.seriesId?.title || null,
            seasonNumber: v.seasonNumber || 1,
            episodeNumber: v.episodeNumber || null,
            date: v.createdAt ? new Date(v.createdAt).toISOString() : new Date().toISOString()
          });
        }
      }
    }
  } catch (err) {
    console.warn('[Telegram] Could not pre-load DB videos for activity list:', err.message);
  }
};

const recordTelegramActivity = (item) => {
  const existingIdx = recentTelegramActivity.findIndex(a => String(a.id) === String(item.id));
  if (existingIdx !== -1) {
    recentTelegramActivity[existingIdx] = { ...recentTelegramActivity[existingIdx], ...item };
  } else {
    recentTelegramActivity.unshift(item);
  }
  if (recentTelegramActivity.length > 30) {
    recentTelegramActivity.pop();
  }
};

const updateTelegramActivity = (id, updates) => {
  const item = recentTelegramActivity.find(a => String(a.id) === String(id));
  if (item) {
    Object.assign(item, updates);
  } else {
    recordTelegramActivity({ id, ...updates });
  }
};

const getActiveTelegramUpload = () => {
  if (recentTelegramActivity.length === 0) {
    loadRecentTelegramActivityFromDb().catch(() => {});
  }
  return {
    ...activeTelegramUpload,
    botUsername: 'MR_Mist_bot',
    isBotActive: isListenerActive,
    recentActivity: recentTelegramActivity.slice(0, 15),
    pendingCount: pendingUploads.size,
    pendingItems: Array.from(pendingUploads.values()).map(p => ({
      messageId: p.messageId,
      fileName: p.fileName,
      rawFileName: p.rawFileName,
      sizeMB: p.sizeMB,
      isForward: p.isForward,
      isEpisode: p.isEpisode || false,
      seriesTitle: p.seriesTitle || '',
      seasonNumber: p.seasonNumber || 1,
      episodeNumber: p.episodeNumber || 1,
      episodeTitle: p.episodeTitle || '',
      date: p.timestamp || new Date().toISOString()
    }))
  };
};

/**
 * Upload a video file to Telegram private channel or group
 */
const uploadVideoToTelegram = async (filePath, options = {}) => {
  const client = await getTelegramClient();
  const chatId = getTargetChatId();

  const fs = require('fs');
  const path = require('path');
  const stats = fs.existsSync(filePath) ? fs.statSync(filePath) : { size: 0 };
  const totalMB = (stats.size / (1024 * 1024)).toFixed(1);
  const displayTitle = options.title || path.basename(filePath);

  let lastTime = Date.now();
  let lastBytes = 0;

  activeTelegramUpload = {
    isUploading: true,
    fileName: displayTitle,
    progress: 0,
    uploadedMB: '0.0',
    totalMB,
    speed: '0 MB/s',
    status: 'Uploading to Telegram...',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageId: null
  };

  try {
    const sentMessage = await client.sendFile(chatId, {
      file: filePath,
      caption: options.caption || options.title || '',
      workers: 4,
      progressCallback: (progress) => {
        const now = Date.now();
        const percent = Math.min(Math.round(progress * 100), 100);
        const uploadedBytes = Math.round(progress * stats.size);
        const uploadedMB = (uploadedBytes / (1024 * 1024)).toFixed(1);

        const timeDiff = (now - lastTime) / 1000;
        let speedStr = activeTelegramUpload.speed;
        if (timeDiff >= 0.5) {
          const speedBytes = (uploadedBytes - lastBytes) / timeDiff;
          speedStr = `${(speedBytes / (1024 * 1024)).toFixed(2)} MB/s`;
          lastTime = now;
          lastBytes = uploadedBytes;
        }

        activeTelegramUpload = {
          ...activeTelegramUpload,
          progress: percent,
          uploadedMB,
          speed: speedStr,
          status: percent >= 100 ? 'Finalizing Telegram upload...' : 'Uploading to Telegram...',
          updatedAt: new Date().toISOString()
        };

        if (options.onProgress) options.onProgress(progress);
      }
    });

    activeTelegramUpload = {
      isUploading: false,
      isProcessing: false,
      fileName: displayTitle,
      progress: 100,
      uploadedMB: totalMB,
      totalMB,
      speed: '0 MB/s',
      status: 'Upload Completed Successfully',
      startedAt: activeTelegramUpload.startedAt,
      updatedAt: new Date().toISOString(),
      messageId: sentMessage.id,
      source: 'Browser Upload'
    };

    const doc = sentMessage.media?.document;
    return {
      messageId: sentMessage.id,
      fileId: doc?.id ? doc.id.toString() : String(sentMessage.id),
      size: doc?.size ? Number(doc.size) : 0,
      mimeType: doc?.mimeType || 'video/mp4'
    };
  } catch (err) {
    activeTelegramUpload = {
      isUploading: false,
      fileName: displayTitle,
      progress: 0,
      uploadedMB: '0.0',
      totalMB,
      speed: '0 MB/s',
      status: `Failed: ${err.message}`,
      startedAt: activeTelegramUpload.startedAt,
      updatedAt: new Date().toISOString(),
      messageId: null
    };
    throw err;
  }
};

/**
 * Stream video chunks with HTTP Range support
 */
const streamVideoFromTelegram = async (messageId, rangeHeader, res, req = null) => {
  // If no Range header is sent (e.g. initial browser probe or direct download), default to initial chunk
  if (!rangeHeader) {
    rangeHeader = 'bytes=0-';
  }

  // 1. Check Redis for cached video metadata (fileSize, mimeType)
  let metadata = await getVideoMetadataCache(messageId);
  let client = null;
  let msg = null;
  let doc = null;

  if (!metadata) {
    client = await getTelegramClient();
    const chatId = getTargetChatId();
    const msgs = await client.getMessages(chatId, { ids: [parseInt(messageId, 10)] });
    msg = msgs && msgs[0];

    if (!msg || !msg.media) {
      return res.status(404).json({ error: 'Video media not found on Telegram for this message ID' });
    }

    doc = msg.media.document || msg.media.video;
    const docSize = doc?.size ? Number(doc.size) : null;

    if (!docSize) {
      return res.status(400).json({ error: 'Could not determine Telegram file size' });
    }

    metadata = {
      fileSize: docSize,
      mimeType: doc.mimeType || 'video/mp4'
    };

    // Cache metadata in Redis (7 days TTL)
    await setVideoMetadataCache(messageId, metadata);
  }

  const fileSize = metadata.fileSize;
  const mimeType = metadata.mimeType;

  // Validate and parse requested byte range
  const parts = rangeHeader.replace(/bytes=/, '').split('-');
  const start = parseInt(parts[0], 10);
  if (isNaN(start) || start < 0 || start >= fileSize) {
    res.setHeader('Content-Range', `bytes */${fileSize}`);
    return res.status(416).json({ error: 'Requested range not satisfiable' });
  }

  // Cap non-initial chunk size up to 5MB
  const MAX_CHUNK_SIZE = 5 * 1024 * 1024;
  let end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + MAX_CHUNK_SIZE - 1, fileSize - 1);
  if (isNaN(end) || end >= fileSize) {
    end = fileSize - 1;
  }
  if (end < start) {
    end = start;
  }

  const chunkSize = end - start + 1;
  const rangeStr = `${start}-${end}`;

  // 2. Check if this is an initial header chunk (0-1MB or 0-2MB) eligible for Redis chunk caching
  const isInitialChunk = start === 0 && (chunkSize <= 2 * 1024 * 1024);

  if (isInitialChunk) {
    const cachedChunk = await getVideoChunkCache(messageId, rangeStr);
    if (cachedChunk) {
      // CACHE HIT: Serve directly from Redis memory in < 20ms
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': cachedChunk.length,
        'Content-Type': (mimeType === 'video/x-matroska' || !mimeType) ? 'video/mp4' : mimeType,
        'Cache-Control': 'no-cache',
        'X-Cache': 'HIT',
      });
      return res.end(cachedChunk);
    }
  }

  // 3. Request Coalescing / Mutex Lock for initial chunks
  let lockAcquired = false;
  if (isInitialChunk) {
    lockAcquired = await acquireChunkLock(messageId, rangeStr, 5000);
    if (!lockAcquired) {
      // Another concurrent request is already fetching this chunk!
      // Wait briefly (up to 2 seconds) and check cache
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(r => setTimeout(r, 200));
        const chunkAfterWait = await getVideoChunkCache(messageId, rangeStr);
        if (chunkAfterWait) {
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkAfterWait.length,
            'Content-Type': (mimeType === 'video/x-matroska' || !mimeType) ? 'video/mp4' : mimeType,
            'Cache-Control': 'no-cache',
            'X-Cache': 'HIT',
          });
          return res.end(chunkAfterWait);
        }
      }
    }
  }

  // Cache MISS - Fetch chunk from Telegram via GramJS
  if (!client || !msg) {
    client = await getTelegramClient();
    const chatId = getTargetChatId();
    const msgs = await client.getMessages(chatId, { ids: [parseInt(messageId, 10)] });
    msg = msgs && msgs[0];
    if (!msg || !msg.media) {
      if (lockAcquired) await releaseChunkLock(messageId, rangeStr);
      return res.status(404).json({ error: 'Video media not found on Telegram' });
    }
  }

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize,
    'Content-Type': (mimeType === 'video/x-matroska' || !mimeType) ? 'video/mp4' : mimeType,
    'Cache-Control': 'no-cache',
    'X-Cache': 'MISS',
  });

  let aborted = false;
  const cleanup = () => {
    aborted = true;
  };

  res.on('close', cleanup);
  if (req) {
    req.on('close', cleanup);
    req.on('aborted', cleanup);
  }

  const chunkBuffers = isInitialChunk ? [] : null;

  try {
    for await (const chunk of client.iterDownload({
      file: msg.media,
      offset: bigInt(start),
      limit: chunkSize,
      requestSize: 512 * 1024,
      workers: 4,
    })) {
      if (aborted) break;

      const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (isInitialChunk) {
        chunkBuffers.push(bufChunk);
      }

      // Handle backpressure
      if (!res.destroyed && !aborted) {
        const canContinue = res.write(bufChunk);
        if (!canContinue) {
          await new Promise((resolve) => {
            res.once('drain', resolve);
            res.once('close', resolve);
          });
        }
      }
    }

    if (!res.destroyed) {
      res.end();
    }
    // Store complete initial chunk buffer in Redis cache (24 hours TTL)
    if (isInitialChunk && chunkBuffers && chunkBuffers.length > 0) {
      const fullBuffer = Buffer.concat(chunkBuffers).subarray(0, chunkSize);
      await setVideoChunkCache(messageId, rangeStr, fullBuffer);
    }
  } catch (err) {
    if (!aborted && !res.headersSent) {
      console.error('Telegram streaming error:', err.message);
      res.status(500).end();
    }
  } finally {
    if (lockAcquired) {
      await releaseChunkLock(messageId, rangeStr);
    }
  }
};

/**
 * Upload thumbnail image to Telegram
 */
const uploadThumbnailToTelegram = async (thumbFilePath, title = '') => {
  const client = await getTelegramClient();
  const chatId = getTargetChatId();

  const sentMessage = await client.sendFile(chatId, {
    file: thumbFilePath,
    caption: title ? `🖼️ Thumbnail: ${title}` : '🖼️ Video Thumbnail',
    workers: 2,
  });

  return {
    messageId: sentMessage.id,
  };
};

/**
 * Stream/Serve thumbnail image from Telegram
 */
const streamThumbnailFromTelegram = async (messageId, res) => {
  try {
    const client = await getTelegramClient();
    const chatId = getTargetChatId();

    const fs = require('fs');
    const path = require('path');
    const cacheDir = path.join(__dirname, '..', 'uploads', 'thumbnails');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    const cacheFile = path.join(cacheDir, `thumb_${messageId}.jpg`);
    if (fs.existsSync(cacheFile)) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return fs.createReadStream(cacheFile).pipe(res);
    }

    const msgs = await client.getMessages(chatId, { ids: [parseInt(messageId, 10)] });
    const msg = msgs && msgs[0];
    if (!msg || !msg.media) {
      return res.status(404).json({ error: 'Thumbnail not found on Telegram' });
    }

    const buffer = await client.downloadMedia(msg.media);
    if (buffer) {
      fs.writeFileSync(cacheFile, buffer);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.end(buffer);
    } else {
      return res.status(404).json({ error: 'Failed to download thumbnail buffer' });
    }
  } catch (err) {
    console.error('Telegram Thumbnail Error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
};

/**
 * Fetch existing videos from the Telegram channel/chat
 */
const listChannelVideos = async (limit = 30) => {
  try {
    const client = await getTelegramClient();
    const chatId = getTargetChatId();

    const msgs = await client.getMessages(chatId, { limit });
    const videos = [];

    for (const m of msgs) {
      if (m.media && (m.media.document || m.media.video)) {
        const doc = m.media.document || m.media.video;
        const mime = doc.mimeType || '';
        if (mime.startsWith('video/') || !mime) {
          videos.push({
            id: String(m.id),
            name: m.message ? m.message.split('\n')[0].slice(0, 60) : `Telegram Video #${m.id}`,
            messageId: m.id,
            fileId: doc.id ? doc.id.toString() : String(m.id),
            size: Number(doc.size || 0),
            caption: m.message || `Telegram Video #${m.id}`,
            date: m.date,
            mimeType: mime || 'video/mp4'
          });
        }
      }
    }

    return videos;
  } catch (err) {
    console.warn('[Telegram] Could not fetch chat history directly:', err.message);
    try {
      const Video = require('../models/Video');
      const dbVideos = await Video.find({ telegram_message_id: { $exists: true, $ne: null } }).limit(limit);
      return dbVideos.map(v => ({
        id: String(v.telegram_message_id),
        name: v.title,
        messageId: v.telegram_message_id,
        fileId: v.telegram_file_id || String(v.telegram_message_id),
        size: 0,
        caption: v.title,
        mimeType: 'video/mp4'
      }));
    } catch (e) {
      return [];
    }
  }
};

/**
 * Detects whether a filename or text refers to a TV Series episode
 * e.g. "Breaking Bad S01E03.mp4", "Stranger Things 1x02", "Loki Season 1 Episode 2"
 */
const parseEpisodeInfo = (fileName = '', text = '') => {
  const combined = `${fileName} ${text || ''}`;

  const sPattern = /[\. _\-\(\[]S(?<season>\d{1,2})[\. _\-]?(?:E|EP)(?<episode>\d{1,3})/i;
  const xPattern = /[\. _\-\(\[](?:Season\s*)?(?<season>\d{1,2})x(?<episode>\d{1,3})/i;
  const sePattern = /(?:Season|S)[\. _-]*(?<season>\d{1,2})[\. _-]*(?:Episode|Ep|E)[\. _-]*(?<episode>\d{1,3})/i;
  const epOnlyPattern = /[\. _\-\(\[](?:Episode|Ep)\s*[\. _\-#]?(?<episode>\d{1,3})/i;

  let match = combined.match(sPattern) || combined.match(xPattern) || combined.match(sePattern);
  let seasonNumber = 1;
  let episodeNumber = null;
  let seriesTitle = '';
  let isEpisode = false;

  if (match && match.groups) {
    isEpisode = true;
    seasonNumber = parseInt(match.groups.season, 10);
    episodeNumber = parseInt(match.groups.episode, 10);
  } else {
    const epMatch = combined.match(epOnlyPattern);
    if (epMatch && epMatch.groups) {
      isEpisode = true;
      seasonNumber = 1;
      episodeNumber = parseInt(epMatch.groups.episode, 10);
    }
  }

  // Check explicit lines in text caption
  if (text) {
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^(?:series|show)\s*[:=-]\s*(.+)/i.test(trimmed)) {
        seriesTitle = trimmed.replace(/^(?:series|show)\s*[:=-]\s*/i, '').trim();
        isEpisode = true;
      } else if (/^season\s*[:=-]\s*(\d+)/i.test(trimmed)) {
        seasonNumber = parseInt(trimmed.replace(/^season\s*[:=-]\s*/i, '').trim(), 10);
        isEpisode = true;
      } else if (/^episode\s*[:=-]\s*(\d+)/i.test(trimmed)) {
        episodeNumber = parseInt(trimmed.replace(/^episode\s*[:=-]\s*/i, '').trim(), 10);
        isEpisode = true;
      }
    }
  }

  // If no explicit series title from text, extract from fileName
  if (isEpisode && !seriesTitle && fileName) {
    let matchIdx = -1;
    for (const pat of [sPattern, xPattern, sePattern, epOnlyPattern]) {
      const idx = fileName.search(pat);
      if (idx !== -1) {
        matchIdx = idx;
        break;
      }
    }
    if (matchIdx > 0) {
      seriesTitle = fileName.substring(0, matchIdx)
        .replace(/[\._]/g, ' ')
        .replace(/[-–—]+$/, '')
        .trim();
    }
  }

  return {
    isEpisode,
    seriesTitle: seriesTitle || '',
    seasonNumber: isNaN(seasonNumber) ? 1 : seasonNumber,
    episodeNumber: isNaN(episodeNumber) ? 1 : episodeNumber
  };
};

/**
 * Parse caption or text for structured metadata (Title, Category, Description, Series, Episode)
 */
const parseCaption = (text) => {
  if (!text) return { title: '', category: 'Action', description: '', type: 'Movie', seriesTitle: '', seasonNumber: 1, episodeNumber: null, hasCustomTitle: false };

  let title = '';
  let category = 'Action';
  let description = '';
  let type = 'Movie';
  let seriesTitle = '';
  let seasonNumber = 1;
  let episodeNumber = null;
  let totalEpisodes = null;
  let hasCustomTitle = false;

  const lines = text.split('\n');
  const descLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^(?:series|show)\s*[:=-]\s*(.+)/i.test(trimmed)) {
      seriesTitle = trimmed.replace(/^(?:series|show)\s*[:=-]\s*/i, '').trim();
      type = 'Episode';
    } else if (/^season\s*[:=-]\s*(\d+)/i.test(trimmed)) {
      seasonNumber = parseInt(trimmed.replace(/^season\s*[:=-]\s*/i, '').trim(), 10);
      type = 'Episode';
    } else if (/^episode\s*[:=-]\s*(\d+)/i.test(trimmed)) {
      const epMatch = trimmed.match(/^episode\s*[:=-]\s*(\d+)/i);
      episodeNumber = epMatch ? parseInt(epMatch[1], 10) : 1;
      type = 'Episode';
      const totMatch = trimmed.match(/(?:total|has)\s*(\d+)\s*episodes?/i);
      if (totMatch) {
        totalEpisodes = parseInt(totMatch[1], 10);
      }
    } else if (/^title\s*[:=-]\s*(.+)/i.test(trimmed)) {
      title = trimmed.replace(/^title\s*[:=-]\s*/i, '').trim();
      // Sanitize AI boilerplate explanations (e.g. ChatGPT "I couldn't find individual episode titles...")
      if (title.length > 70 || /couldn'?t find|placeholder|don'?t know|fill it in/i.test(title)) {
        const quoted = title.match(/["“']([^"“']+)["”']/);
        if (quoted && quoted[1].length < 60) {
          title = quoted[1].trim();
        } else {
          title = episodeNumber ? `Episode ${episodeNumber}` : '';
        }
      }
      hasCustomTitle = Boolean(title);
    } else if (/^category\s*[:=-]\s*(.+)/i.test(trimmed)) {
      category = trimmed.replace(/^category\s*[:=-]\s*/i, '').trim();
    } else if (/^type\s*[:=-]\s*(.+)/i.test(trimmed)) {
      type = trimmed.replace(/^type\s*[:=-]\s*/i, '').trim();
    } else if (/^description\s*[:=-]\s*(.+)/i.test(trimmed)) {
      description = trimmed.replace(/^description\s*[:=-]\s*/i, '').trim();
    } else {
      descLines.push(trimmed);
    }
  }

  // Check pipe format: "Breaking Bad | S01E03 | Cancer Man" or "Inception | Sci-Fi | Synopsis"
  if (!hasCustomTitle && lines.length > 0) {
    const first = lines[0].trim();
    if (first.includes('|')) {
      const parts = first.split('|').map(p => p.trim());
      if (parts.length >= 3 && /S\d+E\d+/i.test(parts[1])) {
        seriesTitle = parts[0];
        type = 'Episode';
        const sMatch = parts[1].match(/S(\d+)E(\d+)/i);
        if (sMatch) {
          seasonNumber = parseInt(sMatch[1], 10);
          episodeNumber = parseInt(sMatch[2], 10);
        }
        title = parts[2];
        hasCustomTitle = true;
      } else {
        title = parts[0];
        if (parts[1]) category = parts[1];
        if (parts[2]) description = parts[2];
        hasCustomTitle = true;
      }
    } else if (first.length > 0 && !seriesTitle) {
      title = first;
      if (descLines.length > 1) {
        description = descLines.slice(1).join('\n');
      }
    }
  }

  if (seriesTitle || episodeNumber !== null) {
    type = 'Episode';
  }

  return { title, category, description, type, seriesTitle, seasonNumber, episodeNumber, totalEpisodes, hasCustomTitle };
};

/**
 * Save video or episode to MongoDB
 */
const publishVideoToDb = async ({
  title,
  category,
  description,
  messageId,
  fileId,
  type = 'Movie',
  thumbnailUrl,
  seriesId = null,
  seriesTitle = null,
  seasonNumber = 1,
  episodeNumber = null
}) => {
  const Video = require('../models/Video');
  const Series = require('../models/Series');
  const User = require('../models/User');

  let admin = await User.findOne({ role: 'admin' });
  if (!admin) admin = await User.findOne({});
  if (!admin) {
    admin = await User.create({
      username: 'Admin User',
      email: 'admin@example.com',
      password: 'password123',
      role: 'admin'
    });
  }

  const validEnums = [
    'Action', 'Drama', 'Thriller', 'Comedy', 'Sci-Fi', 'Adventure', 
    'Horror', 'Romance', 'Animation', 'Documentary', 'Regional', 'Fantasy', 'Mystery', 'Crime', 'Other'
  ];

  let rawList = Array.isArray(category)
    ? category
    : (category ? category.split(',') : ['Action']);

  const cleanCategory = rawList
    .map(c => {
      const trimmed = c.trim();
      const match = validEnums.find(v => v.toLowerCase() === trimmed.toLowerCase().replace(/\s+/g, '-')) ||
                    validEnums.find(v => v.toLowerCase() === trimmed.toLowerCase());
      return match || 'Other';
    })
    .filter(Boolean);

  if (cleanCategory.length === 0) cleanCategory.push('Action');

  const defaultThumbnail = 'https://images.unsplash.com/photo-1485846234645-a62644f84728?auto=format&fit=crop&q=80&w=800';

  // Series Episode resolution: Only treat as Episode if explicitly type === 'Episode'
  const isEpisode = type === 'Episode';
  let finalSeriesId = null;
  let finalSeasonNumber = 1;
  let finalEpisodeNumber = null;
  let resolvedSeries = null;

  if (isEpisode) {
    finalSeasonNumber = seasonNumber ? parseInt(seasonNumber, 10) : 1;
    finalEpisodeNumber = episodeNumber ? parseInt(episodeNumber, 10) : 1;
    if (seriesId) {
      resolvedSeries = await Series.findById(seriesId);
    } else if (seriesTitle) {
      resolvedSeries = await Series.findOne({
        title: new RegExp('^' + seriesTitle.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')
      });
      if (!resolvedSeries) {
        resolvedSeries = await Series.create({
          title: seriesTitle.trim(),
          description: description || `TV Series: ${seriesTitle.trim()}`,
          category: cleanCategory,
          language: 'English',
          totalEpisodes: Math.max(finalEpisodeNumber || 1, 1),
          thumbnailUrl: thumbnailUrl || defaultThumbnail,
          creator: admin._id
        });
      }
    }

    if (resolvedSeries) {
      finalSeriesId = resolvedSeries._id;
      const seriesUpdates = {};
      if (finalEpisodeNumber && finalEpisodeNumber > (resolvedSeries.totalEpisodes || 0)) {
        seriesUpdates.totalEpisodes = finalEpisodeNumber;
      }
      if (thumbnailUrl && (!resolvedSeries.thumbnailUrl || resolvedSeries.thumbnailUrl === 'no-thumbnail.jpg' || resolvedSeries.thumbnailUrl.includes('unsplash'))) {
        seriesUpdates.thumbnailUrl = thumbnailUrl;
      }
      if (Object.keys(seriesUpdates).length > 0) {
        resolvedSeries = await Series.findByIdAndUpdate(resolvedSeries._id, seriesUpdates, { new: true });
      }
    }
  }

  let displayTitle = title;
  if (!displayTitle) {
    if (isEpisode) {
      displayTitle = resolvedSeries 
        ? `${resolvedSeries.title} S${String(finalSeasonNumber).padStart(2, '0')}E${String(finalEpisodeNumber).padStart(2, '0')}`
        : `Episode ${finalEpisodeNumber || 1}`;
    } else {
      displayTitle = `Telegram Video #${messageId}`;
    }
  }

  // Ensure title never exceeds limits
  if (displayTitle && displayTitle.length > 200) {
    displayTitle = displayTitle.slice(0, 197) + '...';
  }
  let cleanDesc = description || '';
  if (cleanDesc.length > 2500) {
    cleanDesc = cleanDesc.slice(0, 2490) + '...';
  }

  const video = await Video.create({
    title: displayTitle,
    description: cleanDesc,
    category: cleanCategory,
    videoUrl: `/api/videos/stream-tg/${messageId}`,
    drive_file_id: String(messageId),
    telegram_message_id: messageId,
    telegram_file_id: fileId,
    storageProvider: 'telegram',
    thumbnailUrl: thumbnailUrl || defaultThumbnail,
    type: isEpisode ? 'Episode' : 'Movie',
    seriesId: finalSeriesId,
    seasonNumber: finalSeasonNumber,
    episodeNumber: finalEpisodeNumber,
    creator: admin._id
  });

  try {
    const { clearCachePattern } = require('./redis');
    await clearCachePattern('videos_list_*');
    if (finalSeriesId) {
      await clearCachePattern('series_list_*');
      await clearCachePattern(`series_${finalSeriesId}*`);
    }
  } catch (e) {}

  video.series = resolvedSeries;
  return { video, series: resolvedSeries };
};

/**
 * Initialize interactive Telegram listener:
 * Listens for forwarded or uploaded videos in the bot chat or channel,
 * prompts the user for title/category, and auto-publishes to the website!
 */
const initTelegramListener = async () => {
  if (isListenerActive) return;

  try {
    const client = await getTelegramClient();
    isListenerActive = true;

    // Preload recent activity from DB
    await loadRecentTelegramActivityFromDb();

    client.addEventHandler(async (event) => {
      try {
        const message = event.message;
        if (!message) return;

        const senderChatId = message.chatId ? message.chatId.toString() : '';
        const text = message.message ? message.message.trim() : '';

        // 1. Detect if this message has a video file
        const doc = message.media?.document || message.media?.video;
        const isVideo = doc && (
          doc.mimeType?.startsWith('video/') ||
          doc.attributes?.some(a => a.className === 'DocumentAttributeVideo') ||
          doc.attributes?.some(a => a.className === 'DocumentAttributeFilename' && /\.(mp4|mkv|avi|mov|webm|flv|wmv|m4v)$/i.test(a.fileName))
        );

        // 2. Detect if this message has a photo or image
        const isPhoto = Boolean(
          message.media?.photo ||
          (message.media?.document && message.media.document.mimeType?.startsWith('image/'))
        );

        // Helper to find pending item for this message or sender
        const getPendingItem = () => {
          const replyToId = message.replyTo?.replyToMsgId || message.replyToMsgId;
          if (replyToId && (pendingUploads.has(replyToId) || pendingUploads.has(String(replyToId)))) {
            return pendingUploads.get(replyToId) || pendingUploads.get(String(replyToId));
          }
          if (senderChatId && lastPendingBySender.has(senderChatId)) {
            const lastMsgId = lastPendingBySender.get(senderChatId);
            return pendingUploads.get(lastMsgId) || pendingUploads.get(String(lastMsgId));
          }
          // Fallback: If only 1 pending item in memory, match it directly!
          if (pendingUploads.size > 0) {
            return pendingUploads.values().next().value;
          }
          return null;
        };

        // ----------------------------------------------------
        // A. HANDLE INCOMING PHOTO / POSTER
        // ----------------------------------------------------
        if (isPhoto && !isVideo) {
          let thumbUrl = null;
          try {
            const buffer = await downloadMediaSafe(client, message.media);
            if (buffer) {
              const cacheDir = path.join(__dirname, '..', 'uploads', 'thumbnails');
              if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
              const cacheFile = path.join(cacheDir, `thumb_${message.id}.jpg`);
              fs.writeFileSync(cacheFile, buffer);
              thumbUrl = `/api/videos/thumbnail-tg/${message.id}`;
            }
          } catch (dlErr) {
            console.error('[Telegram Photo Download Error]:', dlErr.message);
          }

          const pending = getPendingItem();

          if (!pending) {
            if (senderChatId && thumbUrl) {
              recentPhotosBySender.set(senderChatId, {
                messageId: message.id,
                timestamp: Date.now()
              });
              await client.sendMessage(message.chatId, {
                replyTo: message.id,
                message:
                  `📸 **Poster image saved!**\n\n` +
                  `Now upload or forward your **Video or TV Series Episode**, and this poster will be automatically attached! 🎬`
              });
            }
            return;
          }

          // Found a pending video! Attach poster and publish
          const photoCaption = text;
          const parsedCaption = photoCaption ? parseCaption(photoCaption) : null;

          const isEpisode = (pending.details?.type === 'Episode') ||
                            (pending.isEpisode && pending.details?.type !== 'Movie') ||
                            (parsedCaption?.type === 'Episode');
          const finalSeriesTitle = isEpisode ? (parsedCaption?.seriesTitle || pending.details?.seriesTitle || pending.seriesTitle || '') : null;
          const finalSeasonNumber = isEpisode ? (parsedCaption?.seasonNumber || pending.details?.seasonNumber || pending.seasonNumber || 1) : 1;
          const finalEpisodeNumber = isEpisode ? (parsedCaption?.episodeNumber || pending.details?.episodeNumber || pending.episodeNumber || 1) : null;

          let finalTitle = parsedCaption?.title || pending.details?.title;
          if (!finalTitle) {
            if (isEpisode) {
              finalTitle = finalSeriesTitle
                ? `${finalSeriesTitle} S${String(finalSeasonNumber).padStart(2, '0')}E${String(finalEpisodeNumber).padStart(2, '0')}`
                : `Episode ${finalEpisodeNumber || 1}`;
            } else {
              finalTitle = pending.fileName;
            }
          }

          const finalCategory = parsedCaption?.category || pending.details?.category || 'Action';
          const finalDescription = parsedCaption?.description || pending.details?.description || '';

          try {
            const { video, series } = await publishVideoToDb({
              title: finalTitle,
              category: finalCategory,
              description: finalDescription,
              type: isEpisode ? 'Episode' : 'Movie',
              seriesTitle: finalSeriesTitle,
              seasonNumber: finalSeasonNumber,
              episodeNumber: finalEpisodeNumber,
              thumbnailUrl: thumbUrl,
              messageId: pending.messageId,
              fileId: pending.fileId
            });

            pendingUploads.delete(pending.messageId);
            pendingUploads.delete(String(pending.messageId));
            if (senderChatId) lastPendingBySender.delete(senderChatId);

            updateTelegramActivity(pending.messageId, {
              title: video.title,
              category: video.category,
              status: 'Published',
              videoId: video._id.toString(),
              type: video.type,
              seriesId: series?._id?.toString() || null,
              seriesTitle: series?.title || null,
              seasonNumber: video.seasonNumber,
              episodeNumber: video.episodeNumber,
              date: new Date().toISOString()
            });

            activeTelegramUpload = {
              isUploading: false,
              isProcessing: false,
              fileName: video.title,
              progress: 100,
              uploadedMB: pending.sizeMB,
              totalMB: pending.sizeMB,
              speed: 'Completed',
              status: isEpisode
                ? `🎉 Published Episode with Poster: ${video.title}`
                : `🎉 Published Movie with Poster: ${video.title}`,
              startedAt: activeTelegramUpload.startedAt || new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              messageId: pending.messageId,
              videoId: video._id.toString(),
              source: pending.isForward ? 'Telegram Forward' : 'Telegram Bot'
            };

            const webUrl = (process.env.FRONTEND_URL || 'http://localhost:3000') + `/watch/${video._id}`;
            const seriesUrl = series ? (process.env.FRONTEND_URL || 'http://localhost:3000') + `/series/${series._id}` : null;

            let replyMsg = `🎉 **${isEpisode ? 'Series Episode' : 'Movie'} Published with Poster!**\n\n`;
            if (isEpisode) {
              if (series) replyMsg += `📺 **Series:** ${series.title}\n`;
              replyMsg += `🔢 **Season:** ${video.seasonNumber}, **Episode:** ${video.episodeNumber}\n`;
            }
            replyMsg += `🎬 **Title:** ${video.title}\n`;
            replyMsg += `🏷 **Category:** ${video.category.join(', ')}\n`;
            replyMsg += `🖼 **Poster:** Custom poster attached!\n`;
            replyMsg += `🍿 **Watch Link:** ${webUrl}\n`;
            if (isEpisode && seriesUrl) replyMsg += `📁 **Series Page:** ${seriesUrl}\n`;

            await client.sendMessage(message.chatId, {
              replyTo: message.id,
              message: replyMsg
            });
            return;
          } catch (pubErr) {
            console.error('[Publish with Poster Error]:', pubErr);
            await client.sendMessage(message.chatId, {
              replyTo: message.id,
              message: `⚠️ **Publishing Failed:** ${pubErr.message}\nReply **"yes"** to retry, or publish directly from the Admin Dashboard.`
            });
            return;
          }
        }

        // ----------------------------------------------------
        // B. HANDLE INCOMING VIDEO FILE
        // ----------------------------------------------------
        if (isVideo) {
          const fileSizeMB = doc.size ? (Number(doc.size) / (1024 * 1024)).toFixed(1) : 'Unknown';
          const fileAttr = doc.attributes?.find(a => a.fileName);
          const rawFileName = fileAttr?.fileName || `Video_${message.id}.mp4`;
          const cleanFileName = rawFileName.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ');
          const isForward = Boolean(message.fwdFrom);
          const sourceLabel = isForward ? 'Telegram Forward' : 'Telegram Direct Send';

          // Detect Series Episode from filename or text
          const epInfo = parseEpisodeInfo(rawFileName, text);
          const parsed = parseCaption(text);

          // Check if user uploaded a recent photo within the last 10 minutes
          let existingThumbUrl = null;
          const recentPhoto = senderChatId ? recentPhotosBySender.get(senderChatId) : null;
          if (recentPhoto && (Date.now() - recentPhoto.timestamp < 10 * 60 * 1000)) {
            existingThumbUrl = `/api/videos/thumbnail-tg/${recentPhoto.messageId}`;
            recentPhotosBySender.delete(senderChatId);
          }

          // 🌐 AUTOMATICALLY FETCH METADATA FROM INTERNET (TVMaze / OMDb)
          let internetData = null;
          try {
            internetData = await fetchVideoMetadata({
              rawFileName,
              text,
              isEpisode: epInfo.isEpisode || parsed.type === 'Episode',
              seriesTitle: epInfo.seriesTitle || parsed.seriesTitle,
              seasonNumber: epInfo.seasonNumber || parsed.seasonNumber || 1,
              episodeNumber: epInfo.episodeNumber || parsed.episodeNumber || 1
            });
          } catch (fetchErr) {
            console.warn('[Metadata Fetcher Warning]:', fetchErr.message);
          }

          const hasInternetMatch = Boolean(internetData && internetData.found);
          const isEpisode = hasInternetMatch
            ? (internetData.type === 'Episode')
            : (epInfo.isEpisode || parsed.type === 'Episode');

          const finalSeriesTitle = isEpisode
            ? (parsed.seriesTitle || (hasInternetMatch ? internetData.seriesTitle : epInfo.seriesTitle) || '')
            : null;
          const finalSeasonNumber = isEpisode
            ? (parsed.seasonNumber || (hasInternetMatch ? internetData.seasonNumber : epInfo.seasonNumber) || 1)
            : 1;
          const finalEpisodeNumber = isEpisode
            ? (parsed.episodeNumber || (hasInternetMatch ? internetData.episodeNumber : epInfo.episodeNumber) || 1)
            : null;

          let resolvedTitle = parsed.title;
          if (!resolvedTitle) {
            if (hasInternetMatch) {
              resolvedTitle = internetData.title;
            } else if (isEpisode) {
              resolvedTitle = finalSeriesTitle
                ? `${finalSeriesTitle} S${String(finalSeasonNumber).padStart(2, '0')}E${String(finalEpisodeNumber).padStart(2, '0')}`
                : `Episode ${finalEpisodeNumber}`;
            } else {
              resolvedTitle = cleanFileName;
            }
          }

          const finalCategories = (parsed.category && parsed.category !== 'Action')
            ? parsed.category
            : (hasInternetMatch && internetData.category?.length ? internetData.category : ['Drama', 'Action']);

          const finalDescription = parsed.description || (hasInternetMatch ? internetData.description : '');
          const finalThumbUrl = existingThumbUrl || (hasInternetMatch ? internetData.posterUrl : null);

          const pendingItem = {
            messageId: message.id,
            fileId: doc.id ? doc.id.toString() : String(message.id),
            fileName: cleanFileName,
            rawFileName,
            sizeMB: fileSizeMB,
            size: doc.size ? Number(doc.size) : 0,
            isForward,
            isEpisode,
            seriesTitle: finalSeriesTitle,
            seasonNumber: finalSeasonNumber,
            episodeNumber: finalEpisodeNumber,
            totalEpisodes: (hasInternetMatch ? internetData.totalEpisodes : null) || parsed.totalEpisodes || null,
            senderChatId,
            timestamp: new Date().toISOString(),
            thumbnailUrl: finalThumbUrl,
            step: 'awaiting_confirmation_or_thumbnail',
            details: {
              title: resolvedTitle,
              category: finalCategories,
              description: finalDescription,
              type: isEpisode ? 'Episode' : 'Movie',
              seriesTitle: finalSeriesTitle,
              seasonNumber: finalSeasonNumber,
              episodeNumber: finalEpisodeNumber,
              totalEpisodes: (hasInternetMatch ? internetData.totalEpisodes : null) || parsed.totalEpisodes || null
            }
          };

          pendingUploads.set(message.id, pendingItem);
          pendingUploads.set(String(message.id), pendingItem);
          if (senderChatId) {
            lastPendingBySender.set(senderChatId, message.id);
          }

          recordTelegramActivity({
            id: String(message.id),
            title: resolvedTitle,
            rawFileName,
            sizeMB: fileSizeMB,
            source: sourceLabel,
            status: 'Awaiting Details in Telegram',
            category: Array.isArray(finalCategories) ? finalCategories : [finalCategories],
            videoId: null,
            type: isEpisode ? 'Episode' : 'Movie',
            seriesTitle: finalSeriesTitle || null,
            seasonNumber: finalSeasonNumber,
            episodeNumber: finalEpisodeNumber,
            date: new Date().toISOString()
          });

          activeTelegramUpload = {
            isUploading: false,
            isProcessing: true,
            fileName: resolvedTitle,
            progress: 60,
            uploadedMB: fileSizeMB,
            totalMB: fileSizeMB,
            speed: 'Telegram Cloud',
            status: hasInternetMatch
              ? `🌐 Found on Internet (${internetData.source}): ${resolvedTitle}. Awaiting confirmation...`
              : `📥 ${sourceLabel} received: ${resolvedTitle}. Awaiting details...`,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messageId: message.id,
            videoId: null,
            source: sourceLabel
          };

          const catDisplay = Array.isArray(finalCategories) ? finalCategories.join(', ') : finalCategories;

          let promptMsg = '';
          if (hasInternetMatch) {
            promptMsg =
              `🌐 **Found on Internet (${internetData.source})!**\n\n` +
              `🎬 **Title:** ${resolvedTitle}${internetData.year ? ` (${internetData.year})` : ''}\n` +
              (isEpisode
                ? `📺 **Series:** ${finalSeriesTitle}\n🔢 **Season ${finalSeasonNumber}, Episode ${finalEpisodeNumber}:** "${internetData.episodeTitle || resolvedTitle}"\n`
                : '') +
              `🏷 **Category:** ${catDisplay}\n` +
              (internetData.actors ? `👥 **Cast:** ${internetData.actors}\n` : '') +
              (finalDescription ? `📝 **Synopsis:** ${finalDescription.length > 200 ? finalDescription.slice(0, 197) + '...' : finalDescription}\n` : '') +
              (finalThumbUrl ? `🖼 **Poster:** Official poster found & attached!\n` : '') +
              `📁 **File:** \`${rawFileName}\` (${fileSizeMB} MB)\n\n` +
              `✍️ **Please choose an option:**\n` +
              `1️⃣ **Take It** ➔ Reply **"take it"**, **"yes"**, or **"ok"** to publish with these details!\n` +
              `2️⃣ **Update** ➔ Reply with edits (e.g. \`Title: <New Title>\`, \`Category: Drama\`, or reply **"update"**)\n` +
              `3️⃣ **Add New** ➔ Reply **"add new"** to enter custom details, or send a photo to replace the poster!\n` +
              `⏩ Or reply **"skip"** to publish with default poster.\n\n` +
              `💡 _(You can also publish directly from the Admin Dashboard!)_`;
          } else {
            if (isEpisode) {
              promptMsg =
                `📺 **Series Episode Detected!**\n` +
                `📁 **File:** \`${rawFileName}\` (${fileSizeMB} MB)\n` +
                `🎬 **Series:** ${finalSeriesTitle || 'TV Series'}\n` +
                `🔢 **Season:** ${finalSeasonNumber}, **Episode:** ${finalEpisodeNumber}\n\n` +
                `✍️ **Reply to confirm or customize:**\n` +
                `• Reply **"yes"** or **"ok"** to publish as **${finalSeriesTitle || 'Series'} S${finalSeasonNumber}E${finalEpisodeNumber}**!\n` +
                `• Or reply with details (e.g. \`Series: Name\`, \`Season: 1\`, \`Episode: 1\`, \`Title: Episode Title\`, \`Category: Action, Drama\`)\n` +
                `• 📸 You can also send a poster thumbnail photo!\n\n` +
                `💡 _Or publish directly from the Admin Dashboard!_`;
            } else {
              promptMsg =
                `🎬 **Video Received!**\n` +
                `📁 **File:** \`${rawFileName}\` (${fileSizeMB} MB)\n\n` +
                `✍️ **Reply with details:**\n` +
                `• \`Title: <Your Title>\`\n` +
                `• \`Category: Action, Sci-Fi\`\n` +
                `• \`Description: <Short description>\`\n\n` +
                `💡 _Or simply reply with the **Movie Title** directly!_\n` +
                `📸 _(You can also send a poster photo next or right now!)_`;
            }
          }

          await client.sendMessage(message.chatId, {
            replyTo: message.id,
            message: promptMsg
          });
          return;
        }

        // ----------------------------------------------------
        // C. HANDLE TEXT REPLIES TO PENDING VIDEOS
        // ----------------------------------------------------
        const pending = getPendingItem();

        if (pending && text) {
          const isSkip = /^(skip|no|none|default|skip thumbnail|nah|n|pass|cancel)$/i.test(text.trim());
          const isConfirm = /^(take\s*it|take|yes|ok|yep|confirm|y|done|publish|good|sure|accept)$/i.test(text.trim());
          const isUpdate = /^(update|edit|modify)$/i.test(text.trim());
          const isAddNew = /^(add\s*new|new|custom)$/i.test(text.trim());
          const isImageUrl = /^https?:\/\/.+/i.test(text.trim());

          if (isUpdate) {
            await client.sendMessage(message.chatId, {
              replyTo: message.id,
              message:
                `✏️ **Reply with the fields you would like to update:**\n\n` +
                `• \`Title: <New Title>\`\n` +
                `• \`Category: Drama, Thriller\` _(Separate with commas)_\n` +
                (pending.isEpisode ? `• \`Season: <Number>\`, \`Episode: <Number>\`\n• \`Series: <Series Name>\`\n` : '') +
                `• \`Description: <Synopsis>\`\n` +
                `• 📸 Or send a photo/image to replace the poster thumbnail!`
            });
            return;
          }

          if (isAddNew) {
            await client.sendMessage(message.chatId, {
              replyTo: message.id,
              message:
                `🆕 **Enter your custom details from scratch:**\n\n` +
                `• \`Title: <Your Title>\`\n` +
                `• \`Category: Action, Sci-Fi\`\n` +
                (pending.isEpisode ? `• \`Series: <Series Name>\`, \`Season: 1\`, \`Episode: 1\`\n` : '') +
                `• \`Description: <Synopsis>\`\n` +
                `• 📸 Send a poster photo anytime!`
            });
            return;
          }

          const parsed = isConfirm ? {} : parseCaption(text);

          const isEpisode = (pending.details?.type === 'Episode') ||
                            (pending.isEpisode && pending.details?.type !== 'Movie') ||
                            (parsed.type === 'Episode');

          const finalSeriesTitle = isEpisode ? (parsed.seriesTitle || pending.details?.seriesTitle || pending.seriesTitle || '') : null;
          const finalSeasonNumber = isEpisode ? (parsed.seasonNumber || pending.details?.seasonNumber || pending.seasonNumber || 1) : 1;
          const finalEpisodeNumber = isEpisode ? (parsed.episodeNumber || pending.details?.episodeNumber || pending.episodeNumber || 1) : null;

          let titleToUse = parsed.title || pending.details?.title;
          if (!titleToUse) {
            if (isEpisode) {
              titleToUse = finalSeriesTitle 
                ? `${finalSeriesTitle} S${String(finalSeasonNumber).padStart(2, '0')}E${String(finalEpisodeNumber).padStart(2, '0')}`
                : `Episode ${finalEpisodeNumber || 1}`;
            } else {
              titleToUse = isConfirm ? pending.fileName : (text.split('\n')[0].trim() || pending.fileName);
            }
          }

          const finalCategory = parsed.category || pending.details?.category || 'Action';
          const finalDescription = parsed.description || pending.details?.description || '';
          const finalThumbUrl = isSkip ? null : (isImageUrl ? text.trim() : (pending.thumbnailUrl || null));

          try {
            const { video, series } = await publishVideoToDb({
              title: titleToUse,
              category: finalCategory,
              description: finalDescription,
              type: isEpisode ? 'Episode' : 'Movie',
              seriesTitle: finalSeriesTitle,
              seasonNumber: finalSeasonNumber,
              episodeNumber: finalEpisodeNumber,
              thumbnailUrl: finalThumbUrl,
              messageId: pending.messageId,
              fileId: pending.fileId
            });

            pendingUploads.delete(pending.messageId);
            pendingUploads.delete(String(pending.messageId));
            if (senderChatId) lastPendingBySender.delete(senderChatId);

            updateTelegramActivity(pending.messageId, {
              title: video.title,
              category: video.category,
              status: 'Published',
              videoId: video._id.toString(),
              type: video.type,
              seriesId: series?._id?.toString() || null,
              seriesTitle: series?.title || null,
              seasonNumber: video.seasonNumber,
              episodeNumber: video.episodeNumber,
              date: new Date().toISOString()
            });

            activeTelegramUpload = {
              isUploading: false,
              isProcessing: false,
              fileName: video.title,
              progress: 100,
              uploadedMB: pending.sizeMB,
              totalMB: pending.sizeMB,
              speed: 'Completed',
              status: isEpisode
                ? `🎉 Published Episode: ${video.title}`
                : `🎉 Published Movie: ${video.title}`,
              startedAt: activeTelegramUpload.startedAt || new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              messageId: pending.messageId,
              videoId: video._id.toString(),
              source: pending.isForward ? 'Telegram Forward' : 'Telegram Bot'
            };

            const webUrl = (process.env.FRONTEND_URL || 'http://localhost:3000') + `/watch/${video._id}`;
            const seriesUrl = series ? (process.env.FRONTEND_URL || 'http://localhost:3000') + `/series/${series._id}` : null;

            let replyMsg = `🎉 **${isEpisode ? 'Series Episode' : 'Movie'} Published to Antigravity Stream!**\n\n`;
            if (isEpisode) {
              if (series) replyMsg += `📺 **Series:** ${series.title}\n`;
              replyMsg += `🔢 **Season:** ${video.seasonNumber}, **Episode:** ${video.episodeNumber}\n`;
            }
            replyMsg += `🎬 **Title:** ${video.title}\n`;
            replyMsg += `🏷 **Category:** ${video.category.join(', ')}\n`;
            if (finalThumbUrl) replyMsg += `🖼 **Poster:** Attached!\n`;
            replyMsg += `🍿 **Watch Link:** ${webUrl}\n`;
            if (isEpisode && seriesUrl) replyMsg += `📁 **Series Page:** ${seriesUrl}\n`;

            await client.sendMessage(message.chatId, {
              replyTo: message.id,
              message: replyMsg
            });
            return;
          } catch (pubErr) {
            console.error('[Publish to DB Error]:', pubErr);
            await client.sendMessage(message.chatId, {
              replyTo: message.id,
              message: `⚠️ **Upload Error:** ${pubErr.message}\n\nPlease reply with \`Title: <Short Title>\` or publish directly from the Admin Dashboard!`
            });
            return;
          }
        }

      } catch (innerErr) {
        console.error('[Telegram Listener Event Error]:', innerErr.message);
      }
    }, new NewMessage({}));

    console.log('✅ Telegram Interactive Listener Active: Listening for video uploads/forwards...');
  } catch (err) {
    isListenerActive = false;
    console.error('❌ Failed to start Telegram listener:', err.message);
  }
};

/**
 * Publish a pending Telegram video directly (e.g. from the Admin Dashboard)
 */
const publishPendingTelegramVideo = async ({
  messageId,
  title,
  category,
  description,
  type,
  seriesId,
  seriesTitle,
  seasonNumber,
  episodeNumber,
  thumbnailUrl
}) => {
  const targetId = parseInt(messageId, 10);
  let pending = pendingUploads.get(targetId) || pendingUploads.get(String(messageId));

  if (!pending) {
    for (const p of pendingUploads.values()) {
      if (String(p.messageId) === String(messageId)) {
        pending = p;
        break;
      }
    }
  }

  if (!pending) {
    throw new Error(`No pending upload found with message ID: ${messageId}`);
  }

  const { video, series } = await publishVideoToDb({
    title: title || pending.details?.title || pending.fileName,
    category: category || pending.details?.category || 'Action',
    description: description || pending.details?.description || '',
    type: type || pending.details?.type || (pending.isEpisode ? 'Episode' : 'Movie'),
    seriesId: seriesId || null,
    seriesTitle: seriesTitle || pending.details?.seriesTitle || pending.seriesTitle || null,
    seasonNumber: seasonNumber || pending.details?.seasonNumber || pending.seasonNumber || 1,
    episodeNumber: episodeNumber || pending.details?.episodeNumber || pending.episodeNumber || null,
    thumbnailUrl: thumbnailUrl || pending.thumbnailUrl || null,
    messageId: pending.messageId,
    fileId: pending.fileId
  });

  pendingUploads.delete(pending.messageId);
  pendingUploads.delete(String(pending.messageId));
  if (pending.senderChatId && lastPendingBySender.get(pending.senderChatId) === pending.messageId) {
    lastPendingBySender.delete(pending.senderChatId);
  }

  updateTelegramActivity(pending.messageId, {
    title: video.title,
    category: video.category,
    status: 'Published',
    videoId: video._id.toString(),
    type: video.type,
    seriesId: series?._id?.toString() || null,
    seriesTitle: series?.title || null,
    seasonNumber: video.seasonNumber,
    episodeNumber: video.episodeNumber,
    date: new Date().toISOString()
  });

  activeTelegramUpload = {
    isUploading: false,
    isProcessing: false,
    fileName: video.title,
    progress: 100,
    uploadedMB: pending.sizeMB || 'Cloud',
    totalMB: pending.sizeMB || 'Cloud',
    speed: 'Done',
    status: video.type === 'Episode'
      ? `🎉 Published Episode: ${video.title}`
      : `🎉 Published to Web: ${video.title}`,
    startedAt: activeTelegramUpload.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageId: pending.messageId,
    videoId: video._id.toString(),
    source: pending.isForward ? 'Telegram Forward' : 'Telegram Bot'
  };

  try {
    const client = await getTelegramClient();
    const webUrl = (process.env.FRONTEND_URL || 'http://localhost:3000') + `/watch/${video._id}`;
    const seriesUrl = series ? (process.env.FRONTEND_URL || 'http://localhost:3000') + `/series/${series._id}` : null;

    let replyMsg = `🎉 **${video.type === 'Episode' ? 'Series Episode' : 'Video'} Published via Admin Dashboard!**\n\n`;
    if (video.type === 'Episode') {
      if (series) replyMsg += `📺 **Series:** ${series.title}\n`;
      replyMsg += `🔢 **Season:** ${video.seasonNumber}, **Episode:** ${video.episodeNumber}\n`;
    }
    replyMsg += `🎬 **Title:** ${video.title}\n`;
    replyMsg += `🏷 **Category:** ${video.category.join(', ')}\n`;
    replyMsg += `🍿 **Watch Link:** ${webUrl}\n`;
    if (seriesUrl) replyMsg += `📁 **Series Page:** ${seriesUrl}\n`;

    if (pending.senderChatId) {
      await client.sendMessage(pending.senderChatId, {
        replyTo: pending.messageId,
        message: replyMsg
      });
    }
  } catch (tgErr) {
    console.warn('Could not send notification to Telegram chat:', tgErr.message);
  }

  return { video, series };
};

module.exports = {
  getTelegramClient,
  uploadVideoToTelegram,
  streamVideoFromTelegram,
  listChannelVideos,
  initTelegramListener,
  publishVideoToDb,
  getActiveTelegramUpload,
  uploadThumbnailToTelegram,
  streamThumbnailFromTelegram,
  recordTelegramActivity,
  updateTelegramActivity,
  publishPendingTelegramVideo
};
