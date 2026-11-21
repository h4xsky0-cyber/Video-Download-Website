# YouTube Video Downloader — Fixed v1.2.0

A small Express + yt-dlp Docker service for videos you own or are explicitly authorized to download. This project does not attempt to access private, paid, age-restricted, members-only, or otherwise restricted content, and it does not bypass YouTube account or access checks.

## Main fixes

- Explicitly enables Node 22 as yt-dlp's JavaScript runtime.
- Enables the official yt-dlp EJS remote component source, which current YouTube extraction may require.
- Removes the hard-coded Supabase secret and unused Supabase dependency.
- Fixes the frontend API URL construction so a trailing slash cannot create a double slash.
- Lets yt-dlp choose the actual output extension instead of falsely naming every file `.mp4`.
- Adds a health endpoint, 8-minute backend timeout, 9-minute frontend timeout, and clearer error messages.
- Adds temporary-file expiry tracking, partial-file cleanup, request-rate limiting, and a small concurrent-download limit.
- Validates incoming URLs against YouTube hostnames and validates file paths before serving them.

## Deploy on Render (Docker)

1. Upload/push the contents of this folder to your GitHub repository (the `Dockerfile` must be at the Render service's configured Root Directory).
2. In Render, use a **Docker** web service.
3. Make sure the Root Directory points to this folder if the project is inside a larger repository.
4. Deploy the latest commit. If the old image is cached, choose **Clear build cache & deploy** once.
5. Open `https://YOUR-RENDER-SERVICE.onrender.com/health`. A successful result contains `"status":"ok"`, a `ytDlpVersion`, and `"javascriptRuntime":"node"`.
6. Host `frontend/index.html` as your static website. In that file, update `API_BASE` to the exact Render service URL, with no trailing slash.

## Optional Render environment variables

- `MAX_ACTIVE_DOWNLOADS=2` — simultaneous downloads allowed per instance.
- `RATE_LIMIT_MAX=5` — prepare requests allowed per IP in each 60-second window.
- `ALLOWED_ORIGINS=https://your-frontend.example,https://www.your-frontend.example` — optional comma-separated browser origins. Leave unset if you need the API to accept requests from any static frontend origin.

No Supabase environment variables are needed for this version.

## Limits and troubleshooting

- The selected download is limited to about 100 MB. A video may fail when YouTube does not expose a suitable format under that limit.
- Temporary files are kept for 5 minutes after creation. Render restarts can remove them sooner because `/tmp` is not persistent storage.
- If `/health` fails, inspect Render build/runtime logs. If `/health` works but a particular video fails, inspect the `yt-dlp failed:` entry in the Render logs.
- Some videos may be unavailable to server-side yt-dlp because of YouTube restrictions, regional availability, or anti-bot checks. This project does not bypass those restrictions.
- This is a best-effort code fix; a real Render deployment and video-by-video test still need to be performed from your account.

## Important security note

The original uploaded `server.js` included a Supabase secret key. Treat that key as exposed: revoke/rotate it in your Supabase project settings. Never put a Supabase secret/service-role key in frontend code, GitHub, or a public ZIP.
