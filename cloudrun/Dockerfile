# MicroMate 雲托管容器 — 零運行時依賴（僅 Node 內建模組：http / fetch）
# 微信雲托管要求：服務監聽 PORT 環境變數指定的埠（預設 80）
FROM node:20-alpine

WORKDIR /app

# 先複製依賴聲明再 install，利用 Docker 層緩存（僅 devDependencies：typescript / @types/node）
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund --registry=https://registry.npmmirror.com

# 編譯 TypeScript 並保留產物
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# MVP 從簡採單階段鏡像；正式版可改 multi-stage 僅攜帶 dist/ 以縮小體積
ENV PORT=80
EXPOSE 80
CMD ["node", "dist/server.js"]
