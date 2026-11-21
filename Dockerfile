FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg && \
    curl -fL --retry 3 --retry-delay 2 \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp && \
    chmod 755 /usr/local/bin/yt-dlp && \
    yt-dlp --version && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
