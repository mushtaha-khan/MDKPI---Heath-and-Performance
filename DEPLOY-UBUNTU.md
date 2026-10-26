# Running the tester on an Ubuntu server

This tool drives a real Chromium browser via Playwright and serves a dashboard/extension UI
plus the Health + Performance crawl servers on **port 5174**. On a server it runs **headless**
(no display needed).

You can run it two ways: in Docker (recommended) or natively.

---

## Option 1 — Docker (recommended)

The image is based on Microsoft's official Playwright image (Ubuntu 22.04 "jammy") with
Chromium + all system libraries + Node 20 baked in, pinned to the project's Playwright
version (1.56.1).

```bash
# 1. Build
docker build -t mdkpi-tester .

# 2. Create a .env on the server (NOT committed) with at least:
#    KPI_USERNAME=...   KPI_PASSWORD=...   HEALTH_BASE_URL=https://am-gyh.mydealerkpi.com
#    KPI_HEADLESS=true
#    (optional) HEALTH_GCHAT_WEBHOOK=...

# 3. Run — pass .env at runtime, expose the port, persist artifacts via a volume.
docker run -d --name mdkpi-tester \
  -p 5174:5174 \
  --env-file .env \
  -v "$PWD/artifacts:/app/artifacts" \
  mdkpi-tester
```

Then browse to `http://<server-ip>:5174`. Set the dealer/credentials in the **Settings** tab,
or via `.env`. Start Health / Performance runs from the UI.

Notes:
- Chromium runs with `--no-sandbox` inside the container (standard for headless Docker). The
  app adds this automatically on Linux, so you do **not** need `--cap-add=SYS_ADMIN`.
- If you see `/dev/shm` out-of-memory crashes under heavy crawls, add `--shm-size=1g` to the
  `docker run` command (the app already passes `--disable-dev-shm-usage` which usually covers it).
- To persist the Settings-tab values and API history across container restarts, also mount:
  `-v "$PWD/.kpi-settings.json:/app/.kpi-settings.json"` (create the file first, or let the
  Settings tab create it, then mount).

---

## Option 2 — Native on Ubuntu (no Docker)

```bash
# Node 20+ required
sudo apt-get update
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# From the project directory:
npm ci --omit=dev
npx playwright install --with-deps chromium   # installs Chromium + OS libraries

# Create .env (KPI_USERNAME, KPI_PASSWORD, HEALTH_BASE_URL, KPI_HEADLESS=true, ...)

# Start the server (serves UI + health + performance on 5174)
node scripts/health/server.mjs 5174
```

Keep it running with a process manager, e.g. systemd or pm2:

```bash
# pm2 example
sudo npm i -g pm2
KPI_HEADLESS=true pm2 start scripts/health/server.mjs --name mdkpi-tester -- 5174
pm2 save
```

---

## Headless behaviour

- On a Linux server with no `DISPLAY`, the browser is forced headless automatically, so a
  run can never hang waiting for a window that can't open.
- `KPI_HEADLESS=true` is the correct setting for any server. Headed mode (watching the
  browser) is a local-desktop convenience only.

## Security reminders
- Never bake `.env` or `.kpi-settings.json` into the image (both are in `.dockerignore`).
- Port 5174 has no auth; keep it behind your firewall / VPN / reverse-proxy, not public.
