# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Dealership Health + API Performance testing tool
#
# Based on Microsoft's official Playwright image, which ships Chromium plus ALL of its
# Linux system libraries and a matching Node 20 — pinned to the SAME Playwright version
# the project uses (1.56.1 in package.json). This avoids the long tail of "missing .so"
# errors you hit when installing Chromium onto a plain node image.
#
# The tool serves its dashboard/extension UI + crawl servers on port 5174.
#
# Build:   docker build -t mdkpi-tester .
# Run:     docker run --rm -p 5174:5174 --env-file .env mdkpi-tester
#          then open http://localhost:5174
#
# Notes:
#  - Credentials/target come from .env (via --env-file) or the in-app Settings tab.
#    Do NOT bake .env into the image; pass it at run time.
#  - The browser runs HEADLESS in a container (no display). Set KPI_HEADLESS=true in your
#    env; "watch the browser" headed mode is a local-only convenience, not for containers.
#  - To persist run artifacts/history/settings across runs, mount a volume at /app/artifacts
#    (and optionally /app/.kpi-settings.json).
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# Install dependencies first (better layer caching). Copy only manifests, then install.
COPY package.json package-lock.json* ./

# Use a clean, reproducible install. Browsers already exist in the base image, so skip the
# Playwright browser download during npm install to keep the image lean and the build fast.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev || npm install --omit=dev

# Copy the rest of the application source.
COPY . .

# Container runs headless (no X display available). This is the default inside the image;
# it can still be overridden at run time via --env.
ENV KPI_HEADLESS=true \
    HEALTH_PORT=5174 \
    NODE_ENV=production

EXPOSE 5174

# The health server also hosts the performance endpoints and serves the panel UI.
CMD ["node", "scripts/health/server.mjs", "5174"]
