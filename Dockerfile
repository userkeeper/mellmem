FROM node:20-slim

# Устанавливаем ffmpeg и ffprobe
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Сначала только package.json чтобы кэшировать слой с зависимостями
COPY package*.json ./
RUN npm ci --omit=dev

# Потом весь код
COPY . .

EXPOSE 3000

CMD ["node", "server/server.js"]
