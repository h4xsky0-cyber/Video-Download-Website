'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT) || 3000;
const TEMP_DIR = path.join('/tmp', 'video-downloader-files');
const FILE_TTL_MS = 5 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 8 * 60 * 1000;
const MAX_FILE_SIZE = '100M';
const MAX_ACTIVE_DOWNLOADS = Math.max(1, Number(process.env.MAX_ACTIVE_DOWNLOADS) || 2);
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = Math.max(1, Number(process.env.RATE_LIMIT_MAX) || 5);
const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';

const ALLOWED_YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be'
]);

const activeJobs = new Map();
const availableFiles = new Map(); // filename -> expiry timestamp
const rateBuckets = new Map();

fs.mkdirSync(TEMP_DIR, { recursive: true });

// The temp directory is dedicated to this service; remove stale files left by
// a previous container process. It is not persistent storage.
try {
  for (const name of fs.readdirSync(TEMP_DIR)) {
    const target = path.join(TEMP_DIR, name);
    try {
      if (fs.statSync(target).isFile()) fs.unlinkSync(target);
    } catch (_) {}
  }
} catch (error) {
  console.error('Startup temp cleanup failed:', error.message);
}

const configuredOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // If ALLOWED_ORIGINS is set, enforce it. With no value, keep the API
    // usable by a separately hosted static frontend (public CORS).
    if (!origin || configuredOrigins.length === 0 || configuredOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('This website origin is not allowed by the API.'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  maxAge: 86400
}));
app.use(express.json({ limit: '16kb' }));

function parseYouTubeUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || !ALLOWED_YOUTUBE_HOSTS.has(host)) return null;
    if (parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function removeJobFiles(jobId) {
  try {
    for (const name of fs.readdirSync(TEMP_DIR)) {
      if (name.startsWith(`${jobId}.`)) {
        try { fs.unlinkSync(path.join(TEMP_DIR, name)); } catch (_) {}
      }
    }
  } catch (_) {}
}

function cleanupExpiredFiles() {
  const now = Date.now();
  for (const [fileName, expiry] of availableFiles.entries()) {
    if (now >= expiry) {
      try { fs.unlinkSync(path.join(TEMP_DIR, fileName)); } catch (_) {}
      availableFiles.delete(fileName);
    }
  }

  // Remove orphaned files that are not associated with an active job or a
  // currently valid download link.
  try {
    for (const name of fs.readdirSync(TEMP_DIR)) {
      if (availableFiles.has(name)) continue;
      const jobId = name.split('.')[0];
      if (activeJobs.has(jobId)) continue;
      const target = path.join(TEMP_DIR, name);
      try {
        const stat = fs.statSync(target);
        if (stat.isFile() && now - stat.mtimeMs > FILE_TTL_MS) fs.unlinkSync(target);
      } catch (_) {}
    }
  } catch (error) {
    console.error('Temp cleanup failed:', error.message);
  }

  for (const [ip, bucket] of rateBuckets.entries()) {
    if (now - bucket.startedAt > RATE_WINDOW_MS * 2) rateBuckets.delete(ip);
  }
}

const cleanupTimer = setInterval(cleanupExpiredFiles, 30 * 1000);
cleanupTimer.unref();

function downloadRateLimit(req, res, next) {
  const ip = String(req.ip || req.socket.remoteAddress || 'unknown');
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;

  if (bucket.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - bucket.startedAt)) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'অনেকবার চেষ্টা হয়েছে। এক মিনিট পর আবার চেষ্টা করুন।' });
  }
  return next();
}

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Video Downloader API',
    maxFileSize: MAX_FILE_SIZE,
    fileLinkLifetimeMinutes: FILE_TTL_MS / 60000,
    activeDownloads: activeJobs.size
  });
});

app.get('/health', (_req, res) => {
  execFile(YTDLP_BIN, ['--version'], { timeout: 10000, windowsHide: true }, (error, stdout) => {
    if (error) {
      console.error('Health check failed:', error.message);
      return res.status(503).json({ status: 'error', message: 'yt-dlp is not available' });
    }
    return res.json({
      status: 'ok',
      ytDlpVersion: String(stdout || '').trim(),
      nodeVersion: process.version,
      javascriptRuntime: 'node'
    });
  });
});

app.post('/api/prepare', downloadRateLimit, (req, res) => {
  const inputUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  const parsedUrl = parseYouTubeUrl(inputUrl);

  if (!parsedUrl) {
    return res.status(400).json({ error: 'একটি সঠিক HTTPS YouTube ভিডিও লিংক দিন।' });
  }

  if (activeJobs.size >= MAX_ACTIVE_DOWNLOADS) {
    return res.status(503).json({ error: 'সার্ভারে এখন অনেক ডাউনলোড চলছে। একটু পর আবার চেষ্টা করুন।' });
  }

  const jobId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const outputTemplate = path.join(TEMP_DIR, `${jobId}.%(ext)s`);

  // Node 22 is present in this Docker image. EJS from the official yt-dlp
  // GitHub component source is enabled for current YouTube JS challenges.
  // This does not bypass private/restricted content or account checks.
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--js-runtimes', 'node',
    '--remote-components', 'ejs:github',
    '--socket-timeout', '30',
    '--retries', '3',
    '--fragment-retries', '3',
    '--max-filesize', MAX_FILE_SIZE,
    '-f', `best[filesize<${MAX_FILE_SIZE}]/best[filesize_approx<${MAX_FILE_SIZE}]/best`,
    '-o', outputTemplate,
    '--print', 'after_move:filepath',
    parsedUrl.toString()
  ];

  let responded = false;
  const child = execFile(YTDLP_BIN, args, {
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true
  }, (error, stdout, stderr) => {
    activeJobs.delete(jobId);

    const printedPath = String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop();

    const outputPath = printedPath ? path.resolve(printedPath) : '';
    const expectedDirectory = path.resolve(TEMP_DIR);
    const isInsideTemp = Boolean(outputPath) && path.dirname(outputPath) === expectedDirectory;
    const exists = isInsideTemp && fs.existsSync(outputPath) && fs.statSync(outputPath).isFile();

    if (error || !exists) {
      removeJobFiles(jobId);
      const detail = String(stderr || error?.message || 'yt-dlp did not create an output file')
        .trim()
        .slice(-900);
      console.error('yt-dlp failed:', detail);

      if (!res.destroyed && !res.headersSent && !responded) {
        responded = true;
        const timedOut = Boolean(error && (error.killed || error.signal === 'SIGTERM'));
        return res.status(timedOut ? 504 : 500).json({
          error: timedOut
            ? 'ডাউনলোডে বেশি সময় লাগছে। পরে আবার চেষ্টা করুন।'
            : `ভিডিও প্রস্তুত করা যায়নি: ${detail || 'yt-dlp কোনো ফাইল তৈরি করেনি।'}`
        });
      }
      return;
    }

    const fileName = path.basename(outputPath);
    const expiresAtMs = Date.now() + FILE_TTL_MS;
    availableFiles.set(fileName, expiresAtMs);

    if (!res.destroyed && !res.headersSent && !responded) {
      responded = true;
      return res.json({
        downloadUrl: `/api/file/${encodeURIComponent(fileName)}`,
        fileName,
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresInSeconds: FILE_TTL_MS / 1000
      });
    }

    // Client left before the link was returned; do not leave an orphan file.
    try { fs.unlinkSync(outputPath); } catch (_) {}
    availableFiles.delete(fileName);
  });

  activeJobs.set(jobId, child);

  res.on('close', () => {
    if (!res.writableEnded && activeJobs.has(jobId)) {
      const running = activeJobs.get(jobId);
      try { running.kill('SIGTERM'); } catch (_) {}
    }
  });
});

const contentTypes = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  '3gp': 'video/3gpp'
};

app.get('/api/file/:fileName', (req, res) => {
  let safeName;
  try {
    safeName = decodeURIComponent(req.params.fileName);
  } catch (_) {
    return res.status(400).send('ফাইলের নাম সঠিক নয়।');
  }

  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9]{2,5}$/.test(safeName) || path.basename(safeName) !== safeName) {
    return res.status(400).send('ফাইলের নাম সঠিক নয়।');
  }

  const expiry = availableFiles.get(safeName);
  if (!expiry || Date.now() >= expiry) {
    availableFiles.delete(safeName);
    try { fs.unlinkSync(path.join(TEMP_DIR, safeName)); } catch (_) {}
    return res.status(410).send('ডাউনলোড লিংকের মেয়াদ শেষ হয়েছে বা ফাইল পাওয়া যায়নি।');
  }

  const filePath = path.join(TEMP_DIR, safeName);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    availableFiles.delete(safeName);
    return res.status(410).send('ডাউনলোড ফাইল পাওয়া যায়নি। আবার নতুন লিংক তৈরি করুন।');
  }

  if (!stat.isFile()) return res.status(404).send('ফাইল পাওয়া যায়নি।');

  const extension = path.extname(safeName).slice(1).toLowerCase();
  res.setHeader('Content-Type', contentTypes[extension] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const stream = fs.createReadStream(filePath);
  stream.on('error', (error) => {
    console.error('File stream failed:', error.message);
    if (!res.headersSent) res.status(500).send('ফাইল পাঠাতে সমস্যা হয়েছে।');
    else res.destroy(error);
  });
  stream.pipe(res);
});

app.use((error, _req, res, _next) => {
  console.error('Request error:', error.message);
  if (res.headersSent) return res.end();
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'Request body সঠিক JSON নয়।' });
  }
  if (error.message && error.message.includes('origin is not allowed')) {
    return res.status(403).json({ error: 'এই website origin অনুমোদিত নয়।' });
  }
  return res.status(500).json({ error: 'সার্ভারে সমস্যা হয়েছে। Render Logs পরীক্ষা করুন।' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Video Downloader API listening on port ${PORT}`);
  console.log(`Maximum active downloads: ${MAX_ACTIVE_DOWNLOADS}`);
});

function shutdown(signal) {
  console.log(`${signal} received; stopping server...`);
  clearInterval(cleanupTimer);
  for (const child of activeJobs.values()) {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
