# ===== 构建阶段：编译 React 前端 =====
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ===== 运行阶段：仅保留运行所需文件 =====
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# 安装运行依赖（express、axios）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 拷贝后端源码与前端构建产物
COPY server.js ./
COPY src/native ./src/native
COPY src/store.js ./src/store.js
COPY --from=build /app/dist-react ./dist-react

# 下载目录与数据目录（通过卷挂载持久化）
ENV DOWNLOAD_DIR=/downloads
ENV DATA_FILE=/app/data/data.json
VOLUME ["/downloads", "/app/data"]

EXPOSE 8080
CMD ["node", "server.js"]
