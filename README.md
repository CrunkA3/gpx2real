# gpx2real

Create 3D objects from gpx tracks.

## Production with Docker

### 1) Prepare environment files

```bash
cp .env.example .env
cp .env.production.example .env.production
```

Use `.env` for default/local Docker Compose values, and `.env.production` for production values.

### 2) Build and run

```bash
docker compose --env-file .env.production up -d --build
```

App will be available on `APP_PORT` (container serves on port `80`).

### 3) Stop

```bash
docker compose --env-file .env.production down
```
