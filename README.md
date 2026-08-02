# gpx2real

Create 3D objects from gpx tracks.

## Local development (`npm run dev`)

- Elevation requests go to `/elevation/...` and are proxied by the Vite dev server.
- By default, the proxy target is `https://api.opentopodata.org`.
- To use another upstream, set `ELEVATION_PROXY_TARGET` in your shell or `.env.local` before starting Vite.

## Production with Docker

### 1) Prepare environment files

```bash
cp .env.example .env
cp .env.production.example .env.production
```

Use `.env` for default/local Docker Compose values, and `.env.production` for production values. Keep `.env.production` out of version control (add it to `.gitignore`) and exclude it from Docker build context (add it to `.dockerignore`).

By default, the app uses `/elevation/v1/srtm90m`, which is proxied by Nginx to `https://api.opentopodata.org`.

### 2) Build and run

```bash
docker compose --env-file .env.production up -d --build
```

App will be available on `APP_PORT` (container serves on port `80`).

### 3) Stop

```bash
docker compose --env-file .env.production down
```

## Troubleshooting GPX upload errors

- Upload/parsing/elevation fetch errors are shown in the UI and logged in the browser console (`F12`).
- If you see `Failed to fetch`, verify `VITE_API_BASE_URL` points to a reachable endpoint (default: `/elevation/v1/srtm90m`) and, in local dev, verify `ELEVATION_PROXY_TARGET`.
- After changing `VITE_API_BASE_URL`, rebuild the container because it is a build-time variable:

```bash
docker compose --env-file .env.production up -d --build
```
