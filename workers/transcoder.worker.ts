import { Worker, Job } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Redis from 'ioredis';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
if (ffprobeInstaller?.path) {
  ffmpeg.setFfprobePath(ffprobeInstaller.path);
}

export interface TranscodeJobData {
  mediaId: string;
  inputPath: string;
  outputDir: string;
  externalSubtitles?: Array<{ lang: string; label: string; filePath: string }>;
}

interface StreamInfo {
  index: number;
  codec_type: 'video' | 'audio' | 'subtitle';
  tags?: {
    language?: string;
    title?: string;
  };
}

const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  ...(process.env.REDIS_URL?.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {})
});

redisConnection.on('error', (err) => {
  console.warn('[HLS Transcoder Redis Warning]:', err.message);
});

/**
 * Probe media file to discover all video, audio, and subtitle streams
 */
export const probeMedia = (filePath: string): Promise<ffmpeg.FfprobeData> => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });
};

/**
 * BullMQ Transcoder Worker for AES-128 HLS with Multi-Audio & Subtitles
 */
export const transcoderWorker = new Worker<TranscodeJobData>(
  'media-transcode-queue',
  async (job: Job<TranscodeJobData>) => {
    const { mediaId, inputPath, outputDir, externalSubtitles = [] } = job.data;
    const mediaOutputDir = path.join(outputDir, mediaId);

    if (!fs.existsSync(mediaOutputDir)) {
      fs.mkdirSync(mediaOutputDir, { recursive: true });
    }

    await job.updateProgress(5);

    // 1. Generate AES-128 16-byte cryptographic key
    const aesKey = crypto.randomBytes(16);
    const keyPath = path.join(mediaOutputDir, 'enc.key');
    fs.writeFileSync(keyPath, aesKey);

    // 2. Persist AES-128 key in Redis for key delivery API validation
    await redisConnection.set(`hls:key:${mediaId}`, aesKey.toString('hex'), 'EX', 60 * 60 * 24 * 30); // 30 days

    // 3. Create enc.keyinfo pointing to secure key retrieval API
    // Format:
    // Line 1: Key URI (served over HTTPS with query token)
    // Line 2: Path to binary key file for FFmpeg to encrypt segments
    const keyUri = `/api/v1/stream/key/${mediaId}`;
    const keyInfoPath = path.join(mediaOutputDir, 'enc.keyinfo');
    fs.writeFileSync(keyInfoPath, `${keyUri}\n${keyPath}\n`);

    // 4. Probe input streams for audio & subtitle tracks
    const probeData = await probeMedia(inputPath);
    const audioStreams = (probeData.streams as StreamInfo[]).filter((s) => s.codec_type === 'audio');
    const subtitleStreams = (probeData.streams as StreamInfo[]).filter((s) => s.codec_type === 'subtitle');

    await job.updateProgress(20);

    // 5. Transcode with FFmpeg using -hls_key_info_file for AES-128 encryption
    const masterPlaylistPath = path.join(mediaOutputDir, 'master.m3u8');
    const hlsSegmentPrefix = path.join(mediaOutputDir, 'v_%v_seg_%04d.ts');
    const hlsPlaylistPattern = path.join(mediaOutputDir, 'v_%v.m3u8');

    await new Promise<void>((resolve, reject) => {
      const cmd = ffmpeg(inputPath);

      cmd.outputOptions([
        '-preset veryfast',
        '-g 48',
        '-sc_threshold 0',
        '-hls_time 6',
        '-hls_playlist_type vod',
        `-hls_key_info_file ${keyInfoPath}`,
        '-hls_segment_filename', hlsSegmentPrefix,
        '-master_pl_name master.m3u8'
      ]);

      // Primary video rendition
      cmd.outputOptions(['-map 0:v:0', '-c:v:0 h264', '-b:v:0 2500k', '-s:v:0 1280x720']);

      // Multi-Language Audio mapping
      const varStreamMapAudioParts: string[] = [];
      if (audioStreams.length > 0) {
        audioStreams.forEach((stream, index) => {
          const lang = stream.tags?.language || `audio${index + 1}`;
          const title = stream.tags?.title || lang.toUpperCase();
          cmd.outputOptions([
            `-map 0:${stream.index}`,
            `-c:a:${index} aac`,
            `-b:a:${index} 128k`,
            `-ac:a:${index} 2`
          ]);
          varStreamMapAudioParts.push(`a:${index},language:${lang},name:"${title}"`);
        });
      } else {
        cmd.outputOptions(['-map 0:a:0?', '-c:a aac', '-b:a 128k']);
        varStreamMapAudioParts.push('a:0,language:und,name:"Default"');
      }

      const varStreamMap = `v:0,${varStreamMapAudioParts.join(',')}`;
      cmd.outputOptions([`-var_stream_map ${varStreamMap}`]);

      cmd
        .output(hlsPlaylistPattern)
        .on('progress', (p) => {
          if (p.percent) {
            job.updateProgress(20 + Math.floor(p.percent * 0.6));
          }
        })
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });

    await job.updateProgress(85);

    // 6. Extract/Map WebVTT Subtitles & inject to master.m3u8
    const subTracksMeta: Array<{ lang: string; name: string; file: string; defaultFlag: boolean }> = [];

    // Embedded subtitle extraction
    for (let i = 0; i < subtitleStreams.length; i++) {
      const subStream = subtitleStreams[i];
      const lang = subStream.tags?.language || `sub${i + 1}`;
      const title = subStream.tags?.title || lang.toUpperCase();
      const subVttFilename = `subs_${lang}_${i}.vtt`;
      const subVttPath = path.join(mediaOutputDir, subVttFilename);

      await new Promise<void>((res) => {
        ffmpeg(inputPath)
          .outputOptions([`-map 0:${subStream.index}`, '-c:s webvtt'])
          .output(subVttPath)
          .on('end', () => {
            subTracksMeta.push({ lang, name: title, file: subVttFilename, defaultFlag: i === 0 });
            res();
          })
          .on('error', () => res())
          .run();
      });
    }

    // External Subtitles processing
    for (const ext of externalSubtitles) {
      const extFilename = `subs_${ext.lang}_ext.vtt`;
      const destPath = path.join(mediaOutputDir, extFilename);
      if (ext.filePath.endsWith('.vtt')) {
        fs.copyFileSync(ext.filePath, destPath);
      } else {
        await new Promise<void>((res) => {
          ffmpeg(ext.filePath)
            .output(destPath)
            .on('end', () => res())
            .on('error', () => res())
            .run();
        });
      }
      subTracksMeta.push({
        lang: ext.lang,
        name: ext.label,
        file: extFilename,
        defaultFlag: subTracksMeta.length === 0
      });
    }

    // Inject WebVTT Subtitle tags into master.m3u8
    if (fs.existsSync(masterPlaylistPath) && subTracksMeta.length > 0) {
      let masterContent = fs.readFileSync(masterPlaylistPath, 'utf8');
      const subTags = subTracksMeta
        .map((s) => `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${s.name}",DEFAULT=${s.defaultFlag ? 'YES' : 'NO'},AUTOSELECT=YES,LANGUAGE="${s.lang}",URI="${s.file}"`)
        .join('\n');

      masterContent = masterContent.replace(/(#EXT-X-STREAM-INF:[^\n]+)/g, `$1,SUBTITLES="subs"`);
      const lines = masterContent.split('\n');
      const insertIdx = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
      if (insertIdx !== -1) {
        lines.splice(insertIdx, 0, subTags);
        masterContent = lines.join('\n');
      } else {
        masterContent += `\n${subTags}\n`;
      }
      fs.writeFileSync(masterPlaylistPath, masterContent, 'utf8');
    }

    await job.updateProgress(100);
    return { success: true, mediaId, masterPlaylistPath };
  },
  { connection: redisConnection, concurrency: 2 }
);
