FROM node:22-bookworm-slim

# ffmpeg is kept available for media formats that need post-processing.
# Node 22 is also enabled explicitly as yt-dlp's JavaScript runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg && \
    curl -fL --retry 4 --retry-delay 2 \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp && \
    chmod 755 /usr/local/bin/yt-dlp && \
    yt-dlp --version && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
