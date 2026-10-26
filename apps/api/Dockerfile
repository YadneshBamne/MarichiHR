# MarichiHR API and worker image (build from the repository root):
#   docker build -f apps/api/Dockerfile -t marichihr-api .
# API:     node dist/server.js   (default)
# Worker:  node dist/worker.js
# Migrate: npx prisma migrate deploy --schema ../../packages/database/prisma/schema.prisma
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Payslip PDFs use the system Chromium below, so Puppeteer does not download its own
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/database/package.json packages/database/
RUN npm ci --workspace=@marichihr/api --workspace=@marichihr/database --include-workspace-root --no-audit --no-fund
COPY apps/api apps/api
COPY packages/database/prisma packages/database/prisma
# prisma is installed under apps/api/node_modules (workspace), so run it from there
RUN cd apps/api && npx prisma generate && npm run build

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-core ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=8080 PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
COPY --from=build --chown=node:node /app /app
WORKDIR /app/apps/api
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
