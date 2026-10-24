const { Worker } = require('bullmq');
const { redisConnection } = require('../queues/connection');
const { getTelegramClient, getTargetChatId } = require('../utils/telegram');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

const concurrency = parseInt(process.env.TRANSCODE_CONCURRENCY || '1', 10);

/**
 * Run ffprobe to extract streams information (audio tracks, subtitles, video duration)
 */
const probeMedia = (filePath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata);
    });
  });
};

/**
 * Download source video from Telegram into temp directory
 */
const downloadTelegramSource = async (messageId, destinationPath, onProgress) => {
  const client = await getTelegramClient();
  const chatId = getTargetChatId();

  const msgs = await client.getMessages(chatId, { ids: [parseInt(messageId, 10)] });
  const msg = msgs && msgs[0];

  if (!msg || !msg.media) {
    throw new Error(`Media not found for Telegram message ID ${messageId}`);
  }

  const doc = msg.media.document || msg.media.video;
  const fileSize = doc?.size ? Number(doc.size) : 0;

  const writeStream = fs.createWriteStream(destinationPath);
  let downloadedBytes = 0;

  for await (const chunk of client.iterDownload({
    file: msg.media,
    requestSize: 512 * 1024,
    workers: 4,
  })) {
    writeStream.write(chunk);
    downloadedBytes += chunk.length;
    if (fileSize > 0 && onProgress) {
      const p = Math.round((downloadedBytes / fileSize) * 100);
      onProgress(p);
    }
  }

  await new Promise((resolve, reject) => {
    writeStream.end();
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });
};

/**
 * Transcode video to Multi-Bitrate HLS with Multi-Language Audio and Subtitles
 */
const transcodeToHls = async ({ inputPath, outputDir, videoId, probeData, job }) => {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const streams = probeData.streams || [];
  const audioStreams = streams.filter(s => s.codec_type === 'audio');
  const subtitleStreams = streams.filter(s => s.codec_type === 'subtitle');
  const duration = parseFloat(probeData.format?.duration || 0);

  console.log(`[Worker] Detected ${audioStreams.length} audio tracks and ${subtitleStreams.length} subtitle tracks for video ${videoId}`);

  // Subtitles extraction: convert embedded subtitles to .vtt files
  const subtitleEntries = [];
  const subsDir = path.join(__dirname, '..', 'public', 'subtitles', String(videoId));
  if (subtitleStreams.length > 0) {
    if (!fs.existsSync(subsDir)) fs.mkdirSync(subsDir, { recursive: true });

    for (let i = 0; i < subtitleStreams.length; i++) {
      const sub = subtitleStreams[i];
      const lang = (sub.tags?.language || sub.tags?.lang || `sub_${i}`).toLowerCase();
      const title = sub.tags?.title || lang.toUpperCase();
      const vttFileName = `${lang}.vtt`;
      const vttFilePath = path.join(subsDir, vttFileName);

      // Extract subtitle stream using ffmpeg CLI
      await new Promise((res) => {
        const proc = spawn(ffmpegInstaller.path, [
          '-y',
          '-i', inputPath,
          '-map', `0:s:${i}`,
          vttFilePath
        ]);
        proc.on('close', () => res());
        proc.on('error', () => res());
      });

      if (fs.existsSync(vttFilePath)) {
        subtitleEntries.push({
          lang,
          title,
          url: `/api/videos/subtitles/${videoId}/${vttFileName}`,
        });
      }
    }
  }

  // Multi-Bitrate HLS variants: 1080p, 720p, 480p
  // Spec:
  // 1080p: 1920x1080, 5000k video, 192k audio
  // 720p: 1280x720, 2800k video, 128k audio
  // 480p: 854x480, 1400k video, 96k audio
  const variants = [
    { name: '1080p', width: 1920, height: 1080, vBitrate: '5000k', aBitrate: '192k', bandwidth: 5500000 },
    { name: '720p', width: 1280, height: 720, vBitrate: '2800k', aBitrate: '128k', bandwidth: 3000000 },
    { name: '480p', width: 854, height: 480, vBitrate: '1400k', aBitrate: '96k', bandwidth: 1550000 },
  ];

  for (let idx = 0; idx < variants.length; idx++) {
    const v = variants[idx];
    const playlistFile = path.join(outputDir, `${v.name}.m3u8`);
    const segmentPattern = path.join(outputDir, `${v.name}_segment_%03d.ts`);

    await new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-i', inputPath,
        '-vf', `scale=w=${v.width}:h=${v.height}:force_original_aspect_ratio=decrease,pad=${v.width}:${v.height}:(ow-iw)/2:(oh-ih)/2`,
        '-c:v', 'libx264',
        '-b:v', v.vBitrate,
        '-maxrate', v.vBitrate,
        '-bufsize', '10000k',
        '-c:a', 'aac',
        '-b:a', v.aBitrate,
        '-threads', '2', // Resource protection so streaming is not choked
        '-hls_time', '4',
        '-hls_playlist_type', 'vod',
        '-hls_segment_filename', segmentPattern,
        playlistFile
      ];

      const proc = spawn(ffmpegInstaller.path, args);

      proc.stderr.on('data', (data) => {
        const text = data.toString();
        const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (timeMatch && duration > 0) {
          const currentSec = parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60 + parseFloat(timeMatch[3]);
          const variantProgress = currentSec / duration;
          const totalProgress = Math.min(95, Math.round(30 + ((idx + variantProgress) / variants.length) * 65));
          job.updateProgress(totalProgress).catch(() => {});
        }
      });

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg exited with code ${code} for variant ${v.name}`));
      });

      proc.on('error', reject);
    });
  }

  // Generate top-level master.m3u8 manifest with variants, multi-audio & subtitles
  let masterContent = '#EXTM3U\n#EXT-X-VERSION:4\n\n';

  // Audio groups if multi-language
  if (audioStreams.length > 0) {
    audioStreams.forEach((audio, aIdx) => {
      const lang = (audio.tags?.language || audio.tags?.lang || (aIdx === 0 ? 'eng' : `aud_${aIdx}`)).toLowerCase();
      const name = audio.tags?.title || (lang === 'eng' ? 'English' : lang.toUpperCase());
      const isDefault = aIdx === 0 ? 'YES' : 'NO';
      masterContent += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${name}",DEFAULT=${isDefault},AUTOSELECT=YES,LANGUAGE="${lang}"\n`;
    });
    masterContent += '\n';
  }

  // Subtitle groups
  if (subtitleEntries.length > 0) {
    subtitleEntries.forEach((sub, sIdx) => {
      const isDefault = sIdx === 0 ? 'YES' : 'NO';
      masterContent += `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${sub.title}",DEFAULT=${isDefault},AUTOSELECT=YES,LANGUAGE="${sub.lang}",URI="${sub.url}"\n`;
    });
    masterContent += '\n';
  }

  // Variant Streams
  for (const v of variants) {
    let streamInf = `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.width}x${v.height},CODECS="avc1.640028,mp4a.40.2"`;
    if (audioStreams.length > 0) streamInf += ',AUDIO="audio"';
    if (subtitleEntries.length > 0) streamInf += ',SUBTITLES="subs"';
    masterContent += `${streamInf}\n${v.name}.m3u8\n\n`;
  }

  const masterPath = path.join(outputDir, 'master.m3u8');
  fs.writeFileSync(masterPath, masterContent, 'utf8');

  // Save metadata json for frontend inspection
  const metaJsonPath = path.join(outputDir, 'tracks.json');
  fs.writeFileSync(metaJsonPath, JSON.stringify({
    audioTracks: audioStreams.map((a, i) => ({
      index: i,
      language: a.tags?.language || (i === 0 ? 'en' : `aud_${i}`),
      name: a.tags?.title || (a.tags?.language === 'eng' ? 'English' : 'Audio Track ' + (i + 1))
    })),
    subtitles: subtitleEntries
  }, null, 2));

  console.log(`[Worker] Generated master.m3u8 and HLS variants for video ${videoId} at ${outputDir}`);
};

/**
 * Generate Storyboard Tile Sprite Sheet & WebVTT Manifest
 * - Extract 1 frame every 5 seconds (fps=1/5)
 * - 160x90 per thumbnail
 * - 10x10 grid sprite sheet (1600x900px total)
 */
const generateStoryboard = async ({ inputPath, videoId, duration }) => {
  const storyboardDir = path.join(__dirname, '..', 'public', 'storyboards', String(videoId));
  if (!fs.existsSync(storyboardDir)) {
    fs.mkdirSync(storyboardDir, { recursive: true });
  }

  const spritePattern = path.join(storyboardDir, 'sprite_%03d.jpg');

  console.log(`[Worker] Generating Storyboard Sprite Sheet for video ${videoId} (duration: ${duration}s)...`);

  await new Promise((resolve, reject) => {
    // 1 frame every 5 seconds, scale each to 160x90, tile in 10x10 layout
    const proc = spawn(ffmpegInstaller.path, [
      '-y',
      '-i', inputPath,
      '-vf', 'fps=1/5,scale=160:90,tile=10x10',
      '-q:v', '3',
      spritePattern
    ]);

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg storyboard generation exited with code ${code}`));
    });

    proc.on('error', reject);
  });

  // Generate matching WebVTT manifest
  const pad = (num, size = 2) => String(Math.floor(num)).padStart(size, '0');
  const formatVttTime = (totalSeconds) => {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const ms = Math.floor((totalSeconds % 1) * 1000);
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(ms, 3)}`;
  };

  const interval = 5;
  const cols = 10;
  const rows = 10;
  const tileW = 160;
  const tileH = 90;
  const tilesPerSheet = cols * rows;
  const totalTiles = Math.max(1, Math.ceil(duration / interval));

  let vtt = 'WEBVTT\n\n';
  for (let i = 0; i < totalTiles; i++) {
    const startTime = i * interval;
    const endTime = Math.min((i + 1) * interval, duration || (startTime + interval));
    const sheetIndex = Math.floor(i / tilesPerSheet) + 1;
    const sheetName = `sprite_${String(sheetIndex).padStart(3, '0')}.jpg`;
    const indexInSheet = i % tilesPerSheet;
    const col = indexInSheet % cols;
    const row = Math.floor(indexInSheet / cols);
    const x = col * tileW;
    const y = row * tileH;

    vtt += `${formatVttTime(startTime)} --> ${formatVttTime(endTime)}\n`;
    vtt += `${sheetName}#xywh=${x},${y},${tileW},${tileH}\n\n`;
  }

  const vttFilePath = path.join(storyboardDir, 'storyboard.vtt');
  fs.writeFileSync(vttFilePath, vtt, 'utf8');
  console.log(`[Worker] Storyboard WebVTT written successfully at ${vttFilePath}`);
};

// BullMQ Worker processing transcode jobs
const transcodeWorker = new Worker(
  'video-transcode',
  async (job) => {
    const { videoId, telegramFileId } = job.data;
    const msgId = String(videoId || telegramFileId).replace(/^tg_/, '');
    console.log(`[Worker] Starting HLS Transcode job #${job.id} for messageId: ${msgId}`);

    const tempDir = path.join(__dirname, '..', 'tmp', 'transcode', String(msgId));
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const rawInputPath = path.join(tempDir, 'input.mp4');

    const hlsOutputDir = path.join(__dirname, '..', 'public', 'hls', String(msgId));

    try {
      // Step 1: Download from Telegram to temporary working file
      await job.updateProgress(5);
      console.log(`[Worker] Downloading source video from Telegram for job #${job.id}...`);

      await downloadTelegramSource(msgId, rawInputPath, (percent) => {
        const mapped = Math.round(5 + (percent * 0.20)); // 5% -> 25%
        job.updateProgress(mapped).catch(() => {});
      });

      await job.updateProgress(25);
      console.log(`[Worker] Download complete. Probing media streams...`);

      // Step 2: Probe streams (Audio tracks, Subtitles, Video info)
      const probeData = await probeMedia(rawInputPath);

      // Step 3: Run FFmpeg Multi-Bitrate HLS Transcoding
      await job.updateProgress(30);
      await transcodeToHls({
        inputPath: rawInputPath,
        outputDir: hlsOutputDir,
        videoId: msgId,
        probeData,
        job,
      });

      // Step 4: Run FFmpeg Storyboard Sprite Sheet & WebVTT Generator
      await job.updateProgress(90);
      const videoDuration = parseFloat(probeData.format?.duration || 0);
      await generateStoryboard({
        inputPath: rawInputPath,
        videoId: msgId,
        duration: videoDuration,
      });

      // Step 5: Transcoding Complete -> 100%
      await job.updateProgress(100);

      // Step 6: Clean up temporary raw input.mp4 file
      if (fs.existsSync(rawInputPath)) {
        fs.unlinkSync(rawInputPath);
      }
      if (fs.existsSync(tempDir)) {
        fs.rmdirSync(tempDir);
      }
      console.log(`[Worker] Cleaned up temporary files for job #${job.id}`);

      return {
        status: 'completed',
        videoId: msgId,
        masterPlaylist: `/api/videos/hls/${msgId}/master.m3u8`,
        processedAt: new Date().toISOString(),
      };
    } catch (err) {
      // Clean temp file on failure
      if (fs.existsSync(rawInputPath)) {
        try { fs.unlinkSync(rawInputPath); } catch (e) {}
      }
      throw err;
    }
  },
  {
    connection: redisConnection,
    concurrency,
  }
);

transcodeWorker.on('completed', (job, returnvalue) => {
  console.log(`✅ [Worker] HLS Transcode Job #${job.id} COMPLETED for video ${job.data?.videoId}:`, returnvalue);
});

transcodeWorker.on('failed', (job, err) => {
  console.error(`❌ [Worker] HLS Transcode Job #${job?.id} FAILED:`, err.message);
});

transcodeWorker.on('progress', (job, progress) => {
  console.log(`⏳ [Worker] Job #${job.id} progress: ${progress}%`);
});

module.exports = {
  transcodeWorker,
};
