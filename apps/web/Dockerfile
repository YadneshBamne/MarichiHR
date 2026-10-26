# MarichiHR web app image (build from the repository root). The API address is baked in at build time:
#   docker build -f apps/web/Dockerfile --build-arg MARICHI_API_URL=https://api.example.com/api/v1 -t marichihr-web .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/database/package.json packages/database/
RUN npm ci --workspace=web --include-workspace-root --no-audit --no-fund
COPY apps/web apps/web
ARG MARICHI_API_URL
ENV MARICHI_API_URL=$MARICHI_API_URL
RUN test -n "$MARICHI_API_URL" || (echo "MARICHI_API_URL build arg is required" && exit 1)
RUN npm run build -w web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
