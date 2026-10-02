FROM node:22-bookworm-slim AS web-build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
COPY server ./server
COPY schemas ./schemas
RUN npm run build

FROM web-build AS api-deps
RUN npm prune --omit=dev

FROM python:3.12-slim-bookworm AS api
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 zlib1g tar \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir reportlab==4.4.9 Pillow==12.3.0
ENV NODE_ENV=production REPORTING_MODE=production REPORTING_HOST=0.0.0.0 \
    REPORTING_PORT=5174 REPORTING_DATA_DIR=/data REPORTING_PDF_PYTHON=/usr/local/bin/python3
COPY --from=web-build /usr/local/bin/node /usr/local/bin/node
COPY --from=api-deps /app/node_modules ./node_modules
COPY package*.json ./
COPY server ./server
COPY src ./src
COPY schemas ./schemas
COPY examples ./examples
COPY tests/fixtures/reporting ./tests/fixtures/reporting
RUN mkdir -p /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 5174
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:5174/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "server/main.ts"]

FROM nginx:stable-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/dist/ /usr/share/nginx/html/
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
