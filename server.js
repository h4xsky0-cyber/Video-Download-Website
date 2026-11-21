const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join("/tmp", "temp_videos");
const COOKIES_PATH = path.join("/tmp", "yt_cookies.txt");
const FIVE_MINUTES_MS = 5 * 60 * 1000;

const SUPABASE_URL = process.env.SUPABASE_URL || "https://chmjdkjsarlvwxiqrbvh.supabase.co";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || "sb_secret_b58Sdorny9iMGJThqhZS-Q_t9Z2d80y";
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const rateLimit = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const records = (rateLimit.get(ip) || []).filter(t => now - t < 60000);
  if (records.length >= 10) return false;
  records.push(now);
  rateLimit.set(ip, records);
  return true;
}

function syncCookiesFile() {
  try {
    const rawCookies = process.env.YTDLP_COOKIES;
    if (rawCookies && rawCookies.trim().length > 0) {
      const normalized = rawCookies.replace(/\\n/g, "\n").trim();
      fs.writeFileSync(COOKIES_PATH, normalized, "utf8");
      console.log("Cookies synced");
      return true;
    }
  } catch (err) {
    console.error("Cookie error:", err.message);
  }
  return false;
}

async function cleanupExpired() {
  const now = Date.now();
  try {
    const files = fs.readdirSync(TEMP_DIR);
    for (const file of files) {
      const fp = path.join(TEMP_DIR, file);
      try {
        if (now - fs.statSync(fp).mtimeMs >= FIVE_MINUTES_MS) fs.unlinkSync(fp);
      } catch {}
    }
    await supabase.from("downloads").delete().lt("expires_at", new Date(now).toISOString());
  } catch {}
}
setInterval(cleanupExpired, 60 * 1000);
app.use(async (req, res, next) => { await cleanupExpired(); next(); });

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Premium Video Downloader API",
    cookiesConfigured: !!(process.env.YTDLP_COOKIES && process.env.YTDLP_COOKIES.trim()),
  });
});

app.post("/api/info", (req, res) => {
  const { url } = req.body || {};
  if (!url || !url.startsWith("http")) return res.status(400).json({ error: "সঠিক লিংক দিন" });

  const hasCookies = syncCookiesFile();
  const args = ["--no-playlist", "--no-warnings", "--dump-json", "--skip-download"];
  if (hasCookies) args.push("--cookies", COOKIES_PATH);
  args.push(url);

  const proc = spawn("yt-dlp", args, { timeout: 30000 });
  let out = "";
  proc.stdout.on("data", d => (out += d));
  proc.on("close", code => {
    if (code !== 0) return res.status(500).json({ error: "মেটাডেটা পাওয়া যায়নি" });
    try {
      const info = JSON.parse(out);
      res.json({
        title: info.title || "Unknown",
        duration: info.duration || 0,
        thumbnail: info.thumbnail || "",
        uploader: info.uploader || "",
        platform: info.extractor || "unknown",
      });
    } catch {
      res.status(500).json({ error: "পার্স এরর" });
    }
  });
});

app.post("/api/prepare", async (req, res) => {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  if (!checkRateLimit(ip)) return res.status(429).json({ error: "অনেক রিকোয়েস্ট। একটু অপেক্ষা করুন।" });

  const { url, quality = "best", audio = false } = req.body || {};
  if (!url || !url.startsWith("http")) return res.status(400).json({ error: "সঠিক লিংক দিন" });

  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ext = audio ? "mp3" : "mp4";
  const fileName = `${id}.${ext}`;
  const outputPath = path.join(TEMP_DIR, fileName);

  const hasCookies = syncCookiesFile();

  let format = "best[ext=mp4][filesize<100M]/best[filesize<100M]/best";
  if (quality === "720") format = "best[height<=720][ext=mp4]/best[height<=720]/best";
  else if (quality === "480") format = "best[height<=480][ext=mp4]/best[height<=480]/best";
  else if (quality === "360") format = "best[height<=360][ext=mp4]/best[height<=360]/best";

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--extractor-args", "youtube:player_client=android,tv,web",
    "--max-filesize", "100M",
    "-o", outputPath,
  ];

  if (audio) {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else {
    args.push("-f", format);
  }

  if (hasCookies) {
    args.push("--cookies", COOKIES_PATH);
    console.log("Using cookies");
  }

  args.push(url);

  const proc = spawn("yt-dlp", args, { timeout: 150000 });
  let stderr = "";
  proc.stderr.on("data", d => (stderr += d.toString()));

  proc.on("close", async code => {
    if (code !== 0 || !fs.existsSync(outputPath)) {
      if (fs.existsSync(outputPath)) try { fs.unlinkSync(outputPath); } catch {}
      const detail = (stderr || "Unknown error").slice(-220);
      return res.status(500).json({ error: `ডাউনলোড ফেইল: ${detail}` });
    }

    const expiresAt = new Date(Date.now() + FIVE_MINUTES_MS).toISOString();
    await supabase.from("downloads").insert({
      source_url: url,
      file_name: fileName,
      status: "ready",
      expires_at: expiresAt,
    });

    res.json({
      downloadUrl: `/api/file/${fileName}`,
      expiresAt,
      type: audio ? "audio" : "video",
    });
  });
});

app.get("/api/file/:fileName", (req, res) => {
  const safe = path.basename(req.params.fileName);
  const fp = path.join(TEMP_DIR, safe);
  if (!fs.existsSync(fp)) return res.status(410).send("লিংকের মেয়াদ শেষ।");

  const stat = fs.statSync(fp);
  if (Date.now() - stat.mtimeMs >= FIVE_MINUTES_MS) {
    try { fs.unlinkSync(fp); } catch {}
    return res.status(410).send("মেয়াদ শেষ।");
  }

  const isAudio = safe.endsWith(".mp3");
  res.setHeader("Content-Type", isAudio ? "audio/mpeg" : "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${safe}"`);
  res.setHeader("Content-Length", stat.size);
  fs.createReadStream(fp).pipe(res);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  syncCookiesFile();
});