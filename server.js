const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join("/tmp", "temp_videos");
const COOKIES_PATH = path.join("/tmp", "yt_cookies.txt");
const FIVE_MINUTES_MS = 5 * 60 * 1000;

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://chmjdkjsarlvwxiqrbvh.supabase.co";
const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY || "sb_secret_b58Sdorny9iMGJThqhZS-Q_t9Z2d80y";

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function syncCookiesFile() {
  try {
    const rawCookies = process.env.YTDLP_COOKIES;
    if (rawCookies && rawCookies.trim().length > 0) {
      const normalized = rawCookies.replace(/\\n/g, "\n");
      fs.writeFileSync(COOKIES_PATH, normalized, "utf8");
      return fs.existsSync(COOKIES_PATH);
    }
  } catch (err) {
    console.error("Cookie write error:", err.message);
  }
  return false;
}

async function cleanupExpired() {
  const now = Date.now();
  try {
    const files = fs.readdirSync(TEMP_DIR);
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs >= FIVE_MINUTES_MS) {
          fs.unlinkSync(filePath);
        }
      } catch (_) {}
    }

    await supabase
      .from("downloads")
      .delete()
      .lt("expires_at", new Date(now).toISOString());
  } catch (err) {
    console.error("Cleanup error:", err.message);
  }
}

setInterval(cleanupExpired, 60 * 1000);

app.use(async (req, res, next) => {
  await cleanupExpired();
  next();
});

app.get("/", (req, res) => {
  const hasCookies = Boolean(
    process.env.YTDLP_COOKIES && process.env.YTDLP_COOKIES.trim()
  );
  res.json({
    status: "ok",
    message: "Video Downloader API is running",
    cookiesConfigured: hasCookies,
  });
});

app.post("/api/prepare", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      return res.status(400).json({ error: "সঠিক http/https ভিডিও লিংক দিন।" });
    }

    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const fileName = `${id}.mp4`;
    const outputPath = path.join(TEMP_DIR, fileName);

    const hasCookies = syncCookiesFile();

    const args = [
      "--no-playlist",
      "--no-warnings",
      "--extractor-args",
      "youtube:player_client=android,tv,web",
      "-f",
      "best[ext=mp4][filesize<100M]/best[filesize<100M]/best",
      "--max-filesize",
      "100M",
    ];

    if (hasCookies) {
      args.push("--cookies", COOKIES_PATH);
    }

    args.push("-o", outputPath, url);

    execFile("yt-dlp", args, { timeout: 120000 }, async (error, stdout, stderr) => {
      try {
        if (error || !fs.existsSync(outputPath)) {
          if (fs.existsSync(outputPath)) {
            try {
              fs.unlinkSync(outputPath);
            } catch (_) {}
          }

          const detail = (stderr || error?.message || "Unknown yt-dlp error")
            .toString()
            .trim()
            .slice(-240);

          return res.status(500).json({
            error: `ভিডিও প্রসেস করা যায়নি: ${detail}`,
          });
        }

        const expiresAt = new Date(Date.now() + FIVE_MINUTES_MS).toISOString();

        await supabase.from("downloads").insert({
          source_url: url,
          file_name: fileName,
          status: "ready",
          expires_at: expiresAt,
        });

        return res.json({
          downloadUrl: `/api/file/${fileName}`,
          expiresAt,
        });
      } catch (innerErr) {
        return res.status(500).json({
          error: `সার্ভার রেসপন্স এরর: ${innerErr.message}`,
        });
      }
    });
  } catch (err) {
    return res.status(500).json({
      error: `রিকোয়েস্ট প্রসেস করা যায়নি: ${err.message}`,
    });
  }
});

// সঠিকভাবে ফাইল ডাউনলোড করার রাউট (৫ মিনিটের মধ্যে)
app.get("/api/file/:fileName", (req, res) => {
  const safeName = path.basename(req.params.fileName);
  const filePath = path.join(TEMP_DIR, safeName);

  if (!fs.existsSync(filePath)) {
    return res
      .status(410)
      .send("এই লিংকের মেয়াদ (৫ মিনিট) শেষ হয়ে গেছে বা ফাইল ডিলিট হয়ে গেছে।");
  }

  const stat = fs.statSync(filePath);
  if (Date.now() - stat.mtimeMs >= FIVE_MINUTES_MS) {
    try {
      fs.unlinkSync(filePath);
    } catch (_) {}
    return res.status(410).send("লিংকের মেয়াদ (৫ মিনিট) শেষ হয়ে গেছে।");
  }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  res.setHeader("Content-Length", stat.size);

  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).send("ফাইল পাঠাতে সমস্যা হয়েছে।");
    }
  });
  stream.pipe(res);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
