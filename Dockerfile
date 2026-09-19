# ===== 构建阶段：编译 React 前端 =====
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ===== 运行阶段：Python + Flask =====
FROM python:3.12-slim
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# 安装运行依赖（flask、requests、pycryptodome、waitress）
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 拷贝后端源码与前端构建产物
COPY app.py ./
COPY hongguo.py ./
COPY store.py ./
COPY --from=build /app/dist-react ./dist-react

# 下载目录与数据目录（通过卷挂载持久化）
ENV DOWNLOAD_DIR=/downloads
ENV DATA_FILE=/app/data/data.json
VOLUME ["/downloads", "/app/data"]

EXPOSE 8080
CMD ["python", "app.py"]
