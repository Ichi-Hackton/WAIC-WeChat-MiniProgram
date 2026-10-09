# MicroMate 雲托管容器 — 真實渠道版
# 2026-10 新增運行時依賴：mysql2（訂單落庫）与 12306-mcp（真實餘票子進程）
# 微信雲托管要求：服務監聽 PORT 環境變數指定的埠（預設 80）
FROM node:20-alpine

WORKDIR /app

# 先複製依賴聲明再 install，利用 Docker 層緩存（devDependencies + dependencies）
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund --registry=https://registry.npmmirror.com

# 12306-mcp 站名表快取補丁（構建期應用；版本變更定位失敗僅警告不阻斷）
COPY scripts ./scripts
RUN MCP_PATCH_TARGET=/app/node_modules/12306-mcp/build/index.js node scripts/mcp-patch.mjs || true

# 編譯 TypeScript 並保留產物
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# MVP 從簡採單階段鏡像；正式版可改 multi-stage 僅攜帶 dist/ 以縮小體積
ENV PORT=80
EXPOSE 80
CMD ["node", "dist/server.js"]
