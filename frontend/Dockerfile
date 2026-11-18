# Build Vite SPA without the backend source in the Docker context.
FROM node:22-alpine AS build
WORKDIR /workspace/frontend
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
ARG APP_VERSION=dev
ARG VITE_API_URL=""
ARG VITE_WS_URL=""
ENV APP_VERSION=${APP_VERSION} VITE_API_URL=${VITE_API_URL} VITE_WS_URL=${VITE_WS_URL}
RUN npm run build

# Frontend serves its own built assets over a private Docker network.
# It is not Nginx, and it has no backend/session/Docker-socket access.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4173
COPY --from=build --chown=node:node /workspace/frontend/dist ./dist
COPY --chown=node:node server.mjs ./server.mjs
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:4173/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server.mjs"]
