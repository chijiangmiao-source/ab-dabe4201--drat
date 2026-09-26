FROM node:20-alpine

WORKDIR /app

# 零运行时依赖：先复制清单以利用层缓存，再复制源码。
COPY package.json ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
COPY test ./test
COPY server.js ./server.js

RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
