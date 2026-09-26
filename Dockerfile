# syntax=docker/dockerfile:1
# 深空推进器联锁规程审查台 —— 全零运行时依赖镜像。

FROM node:22-alpine AS base
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests

# 一次性验收服务：代码测试 → 生产构建 → 关联证明场景的 HTTP 冒烟，随后自行退出。
FROM base AS verify
ENV SMOKE_BASE_URL=http://web:8080
CMD ["npm", "run", "verify"]

# 生产构建阶段。
FROM base AS build
RUN npm run build

# 站点运行镜像。
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY package.json ./
COPY server ./server
COPY --from=build /app/dist ./dist
EXPOSE 8080
USER node
CMD ["node", "server/index.js"]
