FROM node:20-slim

# Устанавливаем ffmpeg и ffprobe
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Копируем package.json и ставим зависимости
COPY package*.json ./
RUN npm install --omit=dev

# Потом весь остальной код
COPY . .

EXPOSE 3000

CMD ["node", "server/server.js"]
