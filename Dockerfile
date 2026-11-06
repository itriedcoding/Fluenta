# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN node scripts/generate-icons.mjs && npm run build:web

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    FLUENTA_DATA_DIR=/data
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/src apps/server/src
COPY --from=build /app/apps/server/public apps/server/public
COPY --from=build /app/node_modules node_modules
RUN mkdir -p /data && addgroup -S fluenta && adduser -S fluenta -G fluenta && chown -R fluenta:fluenta /data /app
USER fluenta
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "apps/server/src/index.ts"]
