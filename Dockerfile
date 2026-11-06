FROM node:20-alpine

WORKDIR /app

# Install dependencies dulu (memanfaatkan Docker layer cache)
COPY package*.json ./
RUN npm install --omit=dev

# Baru copy semua source code
COPY . .

# Folder uploads harus ada supaya volume mount tidak gagal
RUN mkdir -p uploads

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
