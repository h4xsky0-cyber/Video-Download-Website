const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join("/tmp", "temp_videos");
const COOKIES_PATH = path.join("/tmp", "yt_cookies.txt");
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const MAX_PARALLEL_JOBS = 2; // ফ্রি সার্ভার যেন বসে না যায়
let activeJobs = 0;

fs.mkdirSync(TEMP_DIR, { recursive: true });

// ---------- Supabase (ঐচ্ছিক) ----------
// SUPABASE_URL ও SUPABASE_SECRET_KEY Render-এর Environment এ দিন। কোডে কখনো কী লিখবেন না।
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) {
  try {
    const { createClient } = require("@supabase/supabase-js");
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
  } catch (err) {
    console.error("Supabase init error:", err.message);
  }
}

// ---------- Cookies (Facebook/Instagram এর জন্য দরকার) ----------
// অপশন ১: Render Secret File নাম cookies.txt  -> /etc/secrets/cookies.txt
// অপশন ২: Environment variable YTDLP_COOKIES (নতুন লাইনের জায়গায় \n)
function setupCookies() {
  try {
    let content = null;
    const secretFile = "/etc/secrets/cookies.txt";
    if (fs.existsSync(secretFile)) {
      content = fs.readFileSync(secretFile, "utf8");
    } else if (process.env.YTDLP_COOKIES && process.env.YTDLP_COOKIES.trim()) {
      content = process.env.YTDLP_COOKIES.replace(/\\n/g, "\n");
    }
    if (!content) return false;
    fs.writeFileSync(COOKIES_PATH, content, { mode: 0o600 });
    return true;
  } catch (err) {
    console.error("Cookie setup error:", err.message);
    return false;
  }
}
const COOKIES_READY = setupCookies();

// ---------- Helpers ----------
function isSafeUrl(input) {
  try {
    const u = new URL(input);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (h.startsWith("[")) return false; // IPv6
    if (/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function friendlyError(stderr) {
  const s = String(stderr || "");
  if (/login|log in|log-in|cookies|checkpoint|authentication|registered users|private/i.test(s)) {
    return "এই ভিডিও দেখতে লগইন লাগে (প্রাইভেট বা Facebook ব্লক)। সার্ভারে cookies যোগ করুন, অথবা পাবলিক ভিডিও লিংক দিন।";
  }
  if (/unsupported url/i.test(s)) return "এই লিংক সাপোর্টেড নয়। ভিডিওর সরাসরি লিংক দিন।";
  if (/larger than max-filesize|max-filesize/i.test(s)) return "ভিডিওটি ১০০MB এর বেশি বড়।";
  if (/not available|removed|unavailable|deleted/i.test(s)) return "ভিডিওটি পাওয়া যায়নি বা মুছে ফেলা হয়েছে।";
  if (/cannot parse data|unable to extract/i.test(s)) {
    return "ভিডিও পড়া যায়নি। লিংকটি পাবলিক কিনা দেখুন, অথবা কিছুক্ষণ পর আবার চেষ্টা করুন।";
  }
  const line = s.split("\n").reverse().find((l) => l.includes("ERROR")) || s.slice(-160);
  return "ভিডিও প্রসেস করা যায়নি: " + line.replace(/https?:\/\/\S+/g, "").trim().slice(0, 160);
}

async function cleanupExpired() {
  const now = Date.now();
  try {
    for (const file of fs.readdirSync(TEMP_DIR)) {
      const filePath = path.join(TEMP_DIR, file);
      try {
        if (now - fs.statSync(filePath).mtimeMs >= FIVE_MINUTES_MS) fs.unlinkSync(filePath);
      } catch (_) {}
    }
    if (supabase) {
      await supabase.from("downloads").delete().lt("expires_at", new Date(now).toISOString());
    }
  } catch (err) {
    console.error("Cleanup error:", err.message);
  }
}
setInterval(cleanupExpired, 60 * 1000);

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Premium Video Downloader API",
    cookiesConfigured: COOKIES_READY,
  });
});

app.post("/api/prepare", (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string" || !isSafeUrl(url.trim())) {
    return res.status(400).json({ error: "সঠিক http/https ভিডিও লিংক দিন।" });
  }
  if (activeJobs >= MAX_PARALLEL_JOBS) {
    return res.status(429).json({ error: "সার্ভার এখন ব্যস্ত, ১০–২০ সেকেন্ড পর আবার চেষ্টা করুন।" });
  }

  const cleanUrl = url.trim();
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outputTemplate = path.join(TEMP_DIR, `${id}.%(ext)s`);

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--no-mtime", // ফাইলের সময় যেন পুরোনো না হয়, নইলে সাথে সাথে ডিলিট হয়ে যাবে
    "--restrict-filenames",
    "-f", "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
    "--merge-output-format", "mp4",
    "--max-filesize", "100M",
  ];
  if (COOKIES_READY) args.push("--cookies", COOKIES_PATH);
  args.push("-o", outputTemplate, cleanUrl);

  activeJobs++;
  execFile("yt-dlp", args, { timeout: 150000, maxBuffer: 5 * 1024 * 1024 }, async (error, stdout, stderr) => {
    activeJobs--;
    try {
      const fileName = fs.readdirSync(TEMP_DIR).find((f) => f.startsWith(id + ".") && !f.endsWith(".part"));

      if (error || !fileName) {
        // অসম্পূর্ণ ফাইল মুছে ফেলি
        for (const f of fs.readdirSync(TEMP_DIR)) {
          if (f.startsWith(id)) { try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch (_) {} }
        }
        console.error("yt-dlp failed:", String(stderr).slice(-500));
        return res.status(500).json({ error: friendlyError(stderr || (error && error.message)) });
      }

      const expiresAt = new Date(Date.now() + FIVE_MINUTES_MS).toISOString();

      if (supabase) {
        try {
          await supabase.from("downloads").insert({
            source_url: cleanUrl,
            file_name: fileName,
            status: "ready",
            expires_at: expiresAt,
          });
        } catch (_) {} // লগ সেভ না হলেও ডাউনলোড চলবে
      }

      return res.json({ downloadUrl: `/api/file/${fileName}`, expiresAt });
    } catch (err) {
      return res.status(500).json({ error: `সার্ভার এরর: ${err.message}` });
    }
  });
});

app.get("/api/file/:fileName", (req, res) => {
  const safeName = path.basename(req.params.fileName);
  if (!/^[\w.-]+$/.test(safeName)) return res.status(400).send("ভুল ফাইলের নাম।");
  const filePath = path.join(TEMP_DIR, safeName);

  if (!fs.existsSync(filePath)) {
    return res.status(410).send("এই লিংকের মেয়াদ (৫ মিনিট) শেষ হয়ে গেছে বা ফাইল ডিলিট হয়ে গেছে।");
  }
  const stat = fs.statSync(filePath);
  if (Date.now() - stat.mtimeMs >= FIVE_MINUTES_MS) {
    try { fs.unlinkSync(filePath); } catch (_) {}
    return res.status(410).send("লিংকের মেয়াদ (৫ মিনিট) শেষ হয়ে গেছে।");
  }

  const isMp4 = safeName.endsWith(".mp4");
  res.setHeader("Content-Type", isMp4 ? "video/mp4" : "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  res.setHeader("Content-Length", stat.size);

  const stream = fs.createReadStream(filePath);
  stream.on("error", () => { if (!res.headersSent) res.status(500).send("ফাইল পাঠাতে সমস্যা হয়েছে।"); });
  stream.pipe(res);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT} | cookies: ${COOKIES_READY} | supabase: ${Boolean(supabase)}`);
});
