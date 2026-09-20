
# OpenWA - Dockerfile
# Multi-stage build for production-ready image

# =============================================================================
# Stage 1: Builder
# =============================================================================

# Pin the builder to the BUILD host's platform.
# The builder produces:
#   - NestJS dist/
#   - dashboard/dist/
#
# The runtime stage installs architecture-specific dependencies natively.

FROM --platform=$BUILDPLATFORM docker.io/node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS builder

WORKDIR /app


# =============================================================================
# Builder Section 1: Install System Dependencies
# =============================================================================

RUN set -eux; \
    echo "===== BUILDER 1: INSTALLING SYSTEM DEPENDENCIES ====="; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++; \
    rm -rf /var/lib/apt/lists/*; \
    echo "===== BUILDER 1: COMPLETED ====="


# =============================================================================
# Builder Section 2: Copy Package Files
# =============================================================================

COPY package*.json ./

# postinstall.js must exist before npm ci.
COPY scripts/postinstall.js ./scripts/


# =============================================================================
# Builder Section 3: Install Node.js Dependencies
# =============================================================================

RUN set -eux; \
    echo "===== BUILDER 3: INSTALLING NODE.JS DEPENDENCIES ====="; \
    npm ci --include=dev; \
    echo "===== BUILDER 3: COMPLETED ====="


# =============================================================================
# Builder Section 4: Copy Application Source Code
# =============================================================================

COPY . .


# =============================================================================
# Builder Section 5: Build NestJS Backend
# =============================================================================

# Compile the NestJS application independently.
#
# If this section fails, inspect:
#   - TypeScript compilation errors.
#   - Missing backend dependencies.
#   - Incorrect imports or module references.
#   - Backend build configuration.

RUN set -eux; \
    echo "===== BUILDER 5: BUILDING NESTJS BACKEND ====="; \
    npm run build; \
    echo "===== BUILDER 5: COMPLETED ====="


# =============================================================================
# Builder Section 6: Install Dashboard Dependencies
# =============================================================================

# Install dashboard dependencies separately from the backend build.
#
# If this section fails, inspect:
#   - npm dependency conflicts.
#   - Missing packages.
#   - npm registry connectivity.
#   - Dashboard package configuration.

RUN set -eux; \
    echo "===== BUILDER 6: INSTALLING DASHBOARD DEPENDENCIES ====="; \
    npm run dashboard:ci -- --include=dev; \
    echo "===== BUILDER 6: COMPLETED ====="


# =============================================================================
# Builder Section 7: Build Dashboard
# =============================================================================

# Compile and bundle the Vite/React dashboard independently.
#
# If this section fails, inspect:
#   - Frontend TypeScript errors.
#   - Incorrect React component imports.
#   - Missing frontend dependencies.
#   - Vite configuration errors.

RUN set -eux; \
    echo "===== BUILDER 7: BUILDING DASHBOARD ====="; \
    npm run dashboard:build; \
    echo "===== BUILDER 7: COMPLETED ====="


# =============================================================================
# Builder Section 8: Clean Build Artifacts
# =============================================================================

RUN set -eux; \
    echo "===== BUILDER 8: CLEANING BUILD ARTIFACTS ====="; \
    rm -f dist/*.tsbuildinfo; \
    echo "===== BUILDER 8: COMPLETED ====="


# =============================================================================
# Stage 2: Production
# =============================================================================

FROM docker.io/node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS production

# Production runtime.
ENV NODE_ENV=production


# =============================================================================
# Section 1: Global Brave Browser Configuration
# =============================================================================

# Brave is the primary browser used by whatsapp-web.js and Puppeteer.
#
# The Brave version is deliberately fixed.
# Docker must not silently upgrade Brave when rebuilding the image.
#
# If the requested version is unavailable, the build must fail.
#
# Change this version only after compatibility testing.
#
# Default pinned version:
#   Brave 1.95.101
#
# Brave executable:
#   /usr/bin/brave
#
# ARG allows the version to be configured through Docker Compose.
# ENV makes the selected version available to subsequent build
# instructions and to processes running inside the production container.

ARG BRAVE_BROWSER_VERSION=1.95.101

ENV BRAVE_BROWSER_VERSION=${BRAVE_BROWSER_VERSION}


# =============================================================================
# Section 2: Install Essential System Utilities
# =============================================================================

# Install certificates and curl before configuring the Brave repository.

RUN set -eux; \
    echo "===== SECTION 2: INSTALLING ESSENTIAL SYSTEM UTILITIES ====="; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl; \
    rm -rf /var/lib/apt/lists/*; \
    echo "===== SECTION 2: COMPLETED ====="


# =============================================================================
# Section 3: Install Brave / Chromium System Libraries
# =============================================================================

# Install browser runtime libraries independently.
#
# Possible failures:
#   - Missing Debian package.
#   - Package dependency conflicts.
#   - APT repository connectivity issues.

RUN set -eux; \
    echo "===== SECTION 3: INSTALLING BRAVE SYSTEM LIBRARIES ====="; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
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
        libxrandr2; \
    rm -rf /var/lib/apt/lists/*; \
    echo "===== SECTION 3: COMPLETED ====="


# =============================================================================
# Section 4: Install Multimedia and Runtime Utilities
# =============================================================================

# Install application runtime tools independently from browser libraries.
#
# This section includes:
#   - FFmpeg for media processing.
#   - SQLite command-line tools.
#   - Process management utilities.
#   - Application initialization utilities.

RUN set -eux; \
    echo "===== SECTION 4: INSTALLING MULTIMEDIA AND RUNTIME UTILITIES ====="; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        xdg-utils \
        dumb-init \
        gosu \
        patch \
        procps \
        sqlite3 \
        ffmpeg; \
    rm -rf /var/lib/apt/lists/*; \
    echo "===== SECTION 4: COMPLETED ====="


# =============================================================================
# Section 5: Download Brave Repository Signing Key
# =============================================================================

# Download the Brave APT repository signing key.

RUN set -eux; \
    echo "===== SECTION 5: DOWNLOADING BRAVE SIGNING KEY ====="; \
    curl \
        --fail \
        --silent \
        --show-error \
        --location \
        --retry 3 \
        --output /usr/share/keyrings/brave-browser-archive-keyring.gpg \
        https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg; \
    test -s /usr/share/keyrings/brave-browser-archive-keyring.gpg; \
    echo "===== SECTION 5: COMPLETED ====="


# =============================================================================
# Section 6: Configure Brave APT Repository
# =============================================================================

# Download the official Brave APT repository configuration.

RUN set -eux; \
    echo "===== SECTION 6: CONFIGURING BRAVE APT REPOSITORY ====="; \
    curl \
        --fail \
        --silent \
        --show-error \
        --location \
        --retry 3 \
        --output /etc/apt/sources.list.d/brave-browser-release.sources \
        https://brave-browser-apt-release.s3.brave.com/brave-browser.sources; \
    test -s /etc/apt/sources.list.d/brave-browser-release.sources; \
    echo "===== SECTION 6: COMPLETED ====="


# =============================================================================
# Section 7: Check Available Brave Versions
# =============================================================================

# Refresh APT after configuring the Brave repository.
#
# Display available Brave package versions.
#
# This section does not install Brave or change the pinned version.

RUN set -eux; \
    echo "===== SECTION 7: CHECKING AVAILABLE BRAVE VERSIONS ====="; \
    echo "Requested Brave version: ${BRAVE_BROWSER_VERSION}"; \
    apt-get update; \
    apt-cache policy brave-browser; \
    apt-cache madison brave-browser; \
    echo "===== SECTION 7: COMPLETED ====="


# =============================================================================
# Section 8: Install Pinned Brave Browser Version
# =============================================================================

# Install only the version defined in BRAVE_BROWSER_VERSION.
#
# Do not install the latest available release as a fallback.
#
# If the requested version is unavailable or its dependencies
# cannot be resolved, the Docker build must fail.

RUN set -eux; \
    echo "===== SECTION 8: INSTALLING BRAVE BROWSER ====="; \
    echo "Installing Brave version: ${BRAVE_BROWSER_VERSION}"; \
    apt-get install -y --no-install-recommends \
        "brave-browser=${BRAVE_BROWSER_VERSION}"; \
    rm -rf /var/lib/apt/lists/*; \
    echo "===== SECTION 8: COMPLETED ====="


# =============================================================================
# Section 9: Verify Installed Brave Version
# =============================================================================

# Compare the installed Debian package version with the configured version.
#
# Fail immediately if the versions do not match.

RUN set -eux; \
    echo "===== SECTION 9: VERIFYING BRAVE VERSION ====="; \
    installed_brave_version="$(dpkg-query -W -f='${Version}' brave-browser)"; \
    echo "Requested version: ${BRAVE_BROWSER_VERSION}"; \
    echo "Installed version: ${installed_brave_version}"; \
    test "${installed_brave_version}" = "${BRAVE_BROWSER_VERSION}"; \
    brave-browser --version; \
    echo "===== SECTION 9: COMPLETED ====="


# =============================================================================
# Section 10: Configure Brave Executable Paths
# =============================================================================

# Configure the executable paths used by OpenWA,
# whatsapp-web.js, and Puppeteer.
#
# Preserve the original paths for application compatibility.

RUN set -eux; \
    echo "===== SECTION 10: CONFIGURING BRAVE EXECUTABLES ====="; \
    ln -sf /opt/brave.com/brave/brave /usr/bin/brave; \
    ln -sf /opt/brave.com/brave/brave-browser /usr/bin/brave-browser; \
    test -x /usr/bin/brave; \
    test -x /usr/bin/brave-browser; \
    /usr/bin/brave --version; \
    echo "===== SECTION 10: COMPLETED ====="


# =============================================================================
# Section 11: PostgreSQL Client
# =============================================================================

# The runtime image uses PostgreSQL client 17 for backup/restore tooling.

COPY scripts/pgdg-ACCC4CF8.asc \
    /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc

RUN set -eux; \
    echo "===== SECTION 11: INSTALLING POSTGRESQL CLIENT ====="; \
    sed -i 's/\r$//' \
        /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        postgresql-client-17; \
    rm -rf /var/lib/apt/lists/*; \
    echo "===== SECTION 11: COMPLETED ====="


# =============================================================================
# Section 12: Puppeteer Configuration
# =============================================================================

# Brave is installed explicitly above.
# Do not download Puppeteer's bundled Chromium.

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true


# =============================================================================
# Section 13: Application User
# =============================================================================

RUN groupadd -r openwa \
    && useradd -r -g openwa openwa


# =============================================================================
# Section 14: Application
# =============================================================================

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


# =============================================================================
# Section 15: npm
# =============================================================================

RUN npm install -g npm@12.0.2 \
    && npm cache clean --force


# =============================================================================
# Section 16: Built Application
# =============================================================================

COPY --from=builder /app/dist ./dist

COPY --from=builder /app/dashboard/dist ./dashboard/dist


# =============================================================================
# Section 17: Persistent Data Directories
# =============================================================================

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


# =============================================================================
# Section 18: Browser Runtime Environment
# =============================================================================

# The root filesystem is read-only in production.
# Brave/Chromium runtime state goes to writable temporary storage.

ENV HOME=/app/data

ENV XDG_CONFIG_HOME=/tmp/.config

ENV XDG_CACHE_HOME=/tmp/.cache


# =============================================================================
# Section 19: Backup / Restore Tools
# =============================================================================

COPY scripts/backup.sh \
     scripts/restore.sh \
     scripts/lib-env.sh \
     ./scripts/


# =============================================================================
# Section 20: Entrypoint
# =============================================================================

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh


# =============================================================================
# Section 21: Networking
# =============================================================================

EXPOSE 2785


# =============================================================================
# Section 22: Healthcheck
# =============================================================================

HEALTHCHECK \
    --interval=30s \
    --timeout=10s \
    --start-period=30s \
    --retries=3 \
    CMD curl -f http://localhost:2785/api/health/ready || exit 1


# =============================================================================
# Section 23: Runtime
# =============================================================================

# dumb-init runs as PID 1.
#
# docker-entrypoint.sh performs volume ownership fixes and then drops
# privileges to the openwa user through gosu.

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]

CMD ["node", "dist/main"]

