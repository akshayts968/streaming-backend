const { spawn } = require('child_process');
const { once } = require('events');
const fs = require('fs');
const path = require('path');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

const FMP4_MOVFLAGS = 'empty_moov+frag_keyframe+default_base_moof';

const buildRemuxArgs = ({ input, startSeconds = 0 }) => {
  const start = Number.isFinite(startSeconds) && startSeconds > 0 ? startSeconds : 0;
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-fflags', '+genpts+discardcorrupt',
    '-probesize', '512k',
    '-analyzeduration', '500000',
  ];

  // Seekable file/HTTP inputs can jump before demux. Piped stdin cannot.
  if (start > 0 && input !== 'pipe:0') {
    args.push('-ss', String(start));
  }

  args.push('-i', input);

  if (start > 0 && input === 'pipe:0') {
    args.push('-ss', String(start));
  }

  args.push(
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-sn',
    '-dn',
    '-f', 'mp4',
    '-movflags', FMP4_MOVFLAGS,
    '-frag_duration', '500000',
    '-flush_packets', '1',
    '-max_muxing_queue_size', '1024',
    'pipe:1'
  );

  return args;
};

const setRemuxHeaders = (res) => {
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
};

const pipeFfmpegToResponse = ({ input, startSeconds, res, req, onStdinReady }) => {
  if (req && req.socket) {
    req.socket.setTimeout(0);
  }

  if (!res.headersSent) {
    setRemuxHeaders(res);
  }

  const ffmpeg = spawn(ffmpegInstaller.path, buildRemuxArgs({ input, startSeconds }), {
    windowsHide: true,
  });

  let stderrTail = '';
  ffmpeg.stderr.on('data', (chunk) => {
    stderrTail += chunk.toString();
    if (stderrTail.length > 4000) {
      stderrTail = stderrTail.slice(-2000);
    }
  });

  ffmpeg.stdout.pipe(res, { end: true });

  const stop = () => {
    try {
      if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
        ffmpeg.stdin.destroy();
      }
    } catch (_) { /* ignore */ }
    if (!ffmpeg.killed) {
      ffmpeg.kill();
    }
  };

  res.on('close', stop);
  if (req) {
    req.on('close', stop);
    req.on('aborted', stop);
  }

  ffmpeg.on('error', (err) => {
    console.error('[Remux] Failed to spawn FFmpeg:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Remux process failed to start' });
    } else if (!res.destroyed) {
      res.end();
    }
  });

  ffmpeg.on('close', (code) => {
    if (code && code !== 0) {
      console.error('[Remux] FFmpeg exited', code, stderrTail.trim());
    }
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  });

  if (typeof onStdinReady === 'function') {
    onStdinReady(ffmpeg.stdin, { ffmpeg, stop });
  }

  return ffmpeg;
};

const remuxFileToResponse = (filePath, res, req, startSeconds = 0) => {
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Local video file not found' });
  }
  return pipeFfmpegToResponse({
    input: path.resolve(filePath),
    startSeconds,
    res,
    req,
  });
};

/**
 * Write incoming buffers into FFmpeg stdin with backpressure.
 */
const writeToFfmpegStdin = async (stdin, chunk, abortedFn) => {
  if (!stdin || stdin.destroyed || (abortedFn && abortedFn())) {
    return false;
  }
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const ok = stdin.write(buf);
  if (!ok) {
    try {
      await Promise.race([
        once(stdin, 'drain'),
        once(stdin, 'close'),
        once(stdin, 'error'),
      ]);
    } catch (_) {
      return false;
    }
  }
  return !stdin.destroyed;
};

const resolveLocalVideoPath = (videoUrl) => {
  if (!videoUrl || typeof videoUrl !== 'string') return null;
  if (/^https?:\/\//i.test(videoUrl)) return null;
  if (path.isAbsolute(videoUrl) && fs.existsSync(videoUrl)) return videoUrl;

  const cleaned = videoUrl.replace(/^\/+/, '');
  const fromBackendRoot = path.resolve(__dirname, '..', cleaned);
  if (fs.existsSync(fromBackendRoot)) return fromBackendRoot;

  const fromUploads = path.resolve(__dirname, '..', 'uploads', 'videos', path.basename(cleaned));
  if (fs.existsSync(fromUploads)) return fromUploads;

  return null;
};

module.exports = {
  FMP4_MOVFLAGS,
  buildRemuxArgs,
  pipeFfmpegToResponse,
  remuxFileToResponse,
  writeToFfmpegStdin,
  resolveLocalVideoPath,
};
