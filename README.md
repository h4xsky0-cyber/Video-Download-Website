# YouTube Video Downloader (fixed)

A small Express + yt-dlp service. Use it only for videos you own or are explicitly allowed to download. This project does not attempt to access private, members-only, age-restricted, or otherwise restricted content.

## What was fixed

- Removed the extra slash in frontend API requests and download URLs.
- Removed hard-coded Supabase credentials and the unused Supabase integration.
- Removed the forced `android,tv,web` YouTube extractor client setting; yt-dlp now selects its normal default clients.
- Stopped forcing every output filename to `.mp4`; the actual downloaded extension is returned and served with the matching content type.
- Added HTTPS YouTube host validation, a health endpoint, a longer download timeout, and partial-file cleanup.
- Updated Docker build to fetch the latest official yt-dlp release during image build.

## Deploy on Render (Docker)

1. Push this folder to your Git repository.
2. Create or update the Render service and choose **Docker** as the runtime.
3. Set the root directory to this project folder if it is inside a monorepo.
4. Deploy the latest commit.
5. Open `https://YOUR-RENDER-SERVICE.onrender.com/health`. It should return `status: ok` and a `ytDlpVersion`.
6. In `frontend/index.html`, confirm `API_BASE` is your exact Render service URL, without a trailing slash. Publish the updated frontend.

No Supabase environment variables are required for this version.

## Important security step

The original uploaded `server.js` contained a Supabase secret key. Treat that key as exposed: revoke/rotate it in your Supabase project settings immediately. Do not put a Supabase secret/service-role key in frontend code, source control, or a public ZIP. This fixed version no longer uses Supabase.

## Notes

- Temporary downloads are stored in `/tmp` and removed after five minutes. Render instances may also clear temporary files when they restart.
- A video can still fail when YouTube does not make it available to yt-dlp, the URL is invalid, the server times out, or the selected video is restricted. This code does not bypass YouTube access restrictions.
- The frontend is a separate static page; host it where you hosted the original frontend and keep `API_BASE` pointing to the Render backend.
