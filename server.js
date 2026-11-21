const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT) || 3000;
const TEMP_DIR = path.join("/tmp", "temp_videos");
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const MAX_FILE_SIZE = "100M";
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

const ALLOWED_YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

fs.mkdirSync(TEMP_DIR, { recursive: true });

function parseYouTubeUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();

    if (parsed.protocol !== "https:" || !ALLOWED_YOUTUBE_HOSTS.has(host)) {
      return null;
    }

    return parsed;
  } catch (_) {
    return null;
  }
}

function removeExpiredFiles() {
  const now = Date.now();

  try {
    for (const fileName of fs.readdirSync(TEMP_DIR)) {
      const filePath = path.join(TEMP_DIR, fileName);
      try {
        const stats = fs.statSync(filePath);
        if (stats.isFile() && now - stats.mtimeMs >= FIVE_MINUTES_MS) {
          fs.unlinkSync(filePath);
        }
      } catch (_) {
        // A file may have been removed by another request.
      }
    }
  } catch (error) {
    console.error("Temporary-file cleanup failed:", error.message);
  }
}

const cleanupTimer = setInterval(removeExpiredFiles, 60 * 1000);
cleanupTimer.unref();

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    message: "Video Downloader API is running",
    downloader: "yt-dlp",
  });
});

app.get("/health", (_req, res) => {
  execFile("yt-dlp", ["--version"], { timeout: 10000 }, (error, stdout) => {
    if (error) {
      return res.status(503).json({ status: "error", message: "yt-dlp is not available" });
    }
    return res.json({ status: "ok", ytDlpVersion: stdout.trim() });
  });
});

app.post("/api/prepare", (req, res) => {
  const inputUrl = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  const parsedUrl = parseYouTubeUrl(inputUrl);

  if (!parsedUrl) {
    return res.status(400).json({
      error: "একটি সঠিক HTTPS YouTube ভিডিও লিংক দিন।",
    });
  }

  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const outputTemplate = path.join(TEMP_DIR, `${id}.%(ext)s`);

  // Use yt-dlp's default YouTube clients. Hard-coding android/tv/web can
  // force clients that may require additional YouTube-issued verification data.
  // The output extension is selected by yt-dlp rather than being forced to .mp4.
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--max-filesize",
    MAX_FILE_SIZE,
    "-f",
    `best[filesize<${MAX_FILE_SIZE}]/best`,
    "-o",
    outputTemplate,
    "--print",
    "after_move:filepath",
    parsedUrl.toString(),
  ];

  execFile(
    "yt-dlp",
    args,
    {
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    },
    (error, stdout, stderr) => {
      const printedPath = String(stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .pop();

      const outputPath = printedPath ? path.resolve(printedPath) : "";
      const isInsideTempDir =
        outputPath && path.dirname(outputPath) === path.resolve(TEMP_DIR);
      const exists = isInsideTempDir && fs.existsSync(outputPath);

      if (error || !exists) {
        // Remove partial files created by this request.
        try {
          for (const fileName of fs.readdirSync(TEMP_DIR)) {
            if (fileName.startsWith(`${id}.`)) {
              fs.unlinkSync(path.join(TEMP_DIR, fileName));
            }
          }
        } catch (_) {}

        const detail = String(stderr || error?.message || "Unknown yt-dlp error")
          .trim()
          .slice(-700);

        console.error("yt-dlp failed:", detail);
        return res.status(error?.killed ? 504 : 500).json({
          error: error?.killed
            ? "ডাউনলোডে বেশি সময় লাগছে। পরে আবার চেষ্টা করুন।"
            : `ভিডিও প্রস্তুত করা যায়নি: ${detail || "yt-dlp কোনো ফাইল তৈরি করেনি।"}`,
        });
      }

      const fileName = path.basename(outputPath);
      const expiresAt = new Date(Date.now() + FIVE_MINUTES_MS).toISOString();
      return res.json({
        downloadUrl: `/api/file/${encodeURIComponent(fileName)}`,
        expiresAt,
        fileName,
      });
    }
  );
});

app.get("/api/file/:fileName", (req, res) => {
  const safeName = path.basename(req.params.fileName);
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9]{2,5}$/.test(safeName)) {
    return res.status(400).send("ফাইলের নাম সঠিক নয়।");
  }

  const filePath = path.join(TEMP_DIR, safeName);
  let stat;

  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return res.status(410).send("ডাউনলোড লিংকের মেয়াদ শেষ হয়েছে বা ফাইল পাওয়া যায়নি।");
  }

  if (!stat.isFile() || Date.now() - stat.mtimeMs >= FIVE_MINUTES_MS) {
    try {
      fs.unlinkSync(filePath);
    } catch (_) {}
    return res.status(410).send("ডাউনলোড লিংকের মেয়াদ (৫ মিনিট) শেষ হয়েছে।");
  }

  const extension = path.extname(safeName).slice(1).toLowerCase();
  const contentTypes = {
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    flv: "video/x-flv",
    "3gp": "video/3gpp",
  };

  res.setHeader("Content-Type", contentTypes[extension] || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  res.setHeader("Content-Length", stat.size);

  const stream = fs.createReadStream(filePath);
  stream.on("error", (streamError) => {
    console.error("File stream failed:", streamError.message);
    if (!res.headersSent) {
      res.status(500).send("ফাইল পাঠাতে সমস্যা হয়েছে।");
    } else {
      res.destroy(streamError);
    }
  });
  stream.pipe(res);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
