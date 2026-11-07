FROM node:20-bookworm-slim

# ffmpeg converts audio, yt-dlp downloads from YouTube, python3 runs yt-dlp
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
# Update yt-dlp on every start: YouTube changes often and old versions break.
CMD ["sh", "-c", "yt-dlp -U || true; node index.js"]
