# OpenWA - Dockerfile
# Multi-stage build for production-ready image

# =============================================================================
# Stage 1: Builder
# =============================================================================

# Pin the builder to the BUILD host's platform.
# The builder only produces architecture-independent artifacts:
#   - NestJS dist/
#   - dashboard/dist/
#
# The runtime stage installs architecture-specific dependencies natively.
FROM --platform=$BUILDPLATFORM docker.io/node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS builder

WORKDIR /app

# Install build dependencies.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files.
COPY package*.json ./

# postinstall.js must exist before npm ci.
COPY scripts/postinstall.js ./scripts/

# Install dependencies including devDependencies.
RUN npm ci --include=dev

# Copy source code.
COPY . .

# Build API and dashboard.
RUN npm run build \
    && npm run dashboard:ci -- --include=dev \
    && npm run dashboard:build \
    && rm -f dist/*.tsbuildinfo


# =============================================================================
# Stage 2: Production
# =============================================================================

FROM docker.io/node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS production

# Production runtime.
ENV NODE_ENV=production

# -----------------------------------------------------------------------------
# Browser + runtime dependencies
# -----------------------------------------------------------------------------
#
# Brave is the primary browser used by whatsapp-web.js + Puppeteer.
#
# Official Brave installation method for Debian:
#   /usr/share/keyrings/brave-browser-archive-keyring.gpg
#   /etc/apt/sources.list.d/brave-browser-release.sources
#
# Brave executable:
#   /usr/bin/brave
#
# Brave officially supports amd64 and arm64.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        fonts-liberation \
        libappindicator3-1 \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        xdg-utils \
        dumb-init \
        gosu \
        patch \
        procps \
        sqlite3 \
        ffmpeg \
    && curl -fsSLo \
        /usr/share/keyrings/brave-browser-archive-keyring.gpg \
        https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg \
    && curl -fsSLo \
        /etc/apt/sources.list.d/brave-browser-release.sources \
        https://brave-browser-apt-release.s3.brave.com/brave-browser.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends brave-browser \
    && ln -sf /opt/brave.com/brave/brave /usr/bin/brave \
    && ln -sf /opt/brave.com/brave/brave-browser /usr/bin/brave-browser \
    && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# PostgreSQL client
# -----------------------------------------------------------------------------

# The runtime image uses PostgreSQL client 17 for backup/restore tooling.
COPY scripts/pgdg-ACCC4CF8.asc \
    /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc

RUN sed -i 's/\r$//' \
        /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/*


# -----------------------------------------------------------------------------
# Puppeteer configuration
# -----------------------------------------------------------------------------

# Brave is installed explicitly above.
# Do not download Puppeteer's bundled Chromium.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true


# -----------------------------------------------------------------------------
# Application user
# -----------------------------------------------------------------------------

RUN groupadd -r openwa \
    && useradd -r -g openwa openwa


# -----------------------------------------------------------------------------
# Application
# -----------------------------------------------------------------------------

WORKDIR /app

# Copy package files.
COPY package*.json ./

# Copy patching scripts.
COPY \
    scripts/postinstall.js \
    scripts/patch-wwebjs-201832.js \
    scripts/wwebjs-201832.patch \
    scripts/patch-wwebjs-newsletter-preview.js \
    scripts/patch-wwebjs-status.js \
    scripts/patch-wwebjs-ready-sync.js \
    scripts/patch-wwebjs-participant-arity.js \
    scripts/patch-wwebjs-block.js \
    scripts/patch-baileys-appstate.js \
    scripts/patch-baileys-newsletter-create.js \
    ./scripts/

# Install production dependencies only and apply backports.
RUN npm ci --omit=dev --ignore-scripts \
    && node scripts/patch-wwebjs-201832.js \
    && node scripts/patch-wwebjs-newsletter-preview.js \
    && node scripts/patch-wwebjs-status.js \
    && node scripts/patch-wwebjs-ready-sync.js \
    && node scripts/patch-wwebjs-participant-arity.js \
    && node scripts/patch-wwebjs-block.js \
    && node scripts/patch-baileys-appstate.js \
    && node scripts/patch-baileys-newsletter-create.js \
    && npm cache clean --force


# -----------------------------------------------------------------------------
# npm
# -----------------------------------------------------------------------------

RUN npm install -g npm@12.0.2 \
    && npm cache clean --force


# -----------------------------------------------------------------------------
# Built application
# -----------------------------------------------------------------------------

COPY --from=builder /app/dist ./dist

COPY --from=builder /app/dashboard/dist ./dashboard/dist


# -----------------------------------------------------------------------------
# Persistent data directories
# -----------------------------------------------------------------------------
#
# Brave profiles are stored under:
#
#   /app/data/brave-profiles/<sessionId>
#
# The entire /app/data tree is persisted by docker-compose.yml.
RUN mkdir -p \
        ./data/sessions \
        ./data/media \
        ./data/plugins \
        ./data/brave-profiles \
    && chown -R openwa:openwa ./data


# -----------------------------------------------------------------------------
# Browser runtime environment
# -----------------------------------------------------------------------------

# The root filesystem is read-only in production.
# Brave/Chromium runtime state goes to writable temporary storage.
ENV HOME=/app/data
ENV XDG_CONFIG_HOME=/tmp/.config
ENV XDG_CACHE_HOME=/tmp/.cache


# -----------------------------------------------------------------------------
# Backup / restore tools
# -----------------------------------------------------------------------------

COPY scripts/backup.sh \
     scripts/restore.sh \
     scripts/lib-env.sh \
     ./scripts/


# -----------------------------------------------------------------------------
# Entrypoint
# -----------------------------------------------------------------------------

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh


# -----------------------------------------------------------------------------
# Networking
# -----------------------------------------------------------------------------

EXPOSE 2785


# -----------------------------------------------------------------------------
# Healthcheck
# -----------------------------------------------------------------------------

HEALTHCHECK \
    --interval=30s \
    --timeout=10s \
    --start-period=30s \
    --retries=3 \
    CMD curl -f http://localhost:2785/api/health/ready || exit 1


# -----------------------------------------------------------------------------
# Runtime
# -----------------------------------------------------------------------------
#
# dumb-init runs as PID 1.
# docker-entrypoint.sh performs volume ownership fixes and then drops
# privileges to the openwa user through gosu.

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]

CMD ["node", "dist/main"]