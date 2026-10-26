# syntax=docker/dockerfile:1


FROM mcr.microsoft.com/playwright:v1.56.1-jammy


WORKDIR /app


# Copy dependency manifests
COPY package.json package-lock.json* ./


# Use the Playwright browsers already installed in the base image
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1


# Install all dependencies, including @playwright/test
RUN npm ci || npm install


# Copy application source
COPY . .


# Container configuration
ENV KPI_HEADLESS=true \
    HEALTH_PORT=5174 \
    NODE_ENV=production


EXPOSE 5174


CMD ["node", "scripts/health/server.mjs", "5174"]
