FROM node:22-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 curl ca-certificates ffmpeg && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# প্রতিবার চালুর সময় yt-dlp আপডেট (Facebook/YouTube প্রায়ই বদলায়)
CMD ["sh", "-c", "yt-dlp -U || true; node server.js"]
