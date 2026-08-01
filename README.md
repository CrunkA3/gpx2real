# gpx2real

Create 3D objects from gpx tracks.

## Production with Docker

### 1) Prepare environment files

```bash
cp .env.example .env
cp .env.production.example .env.production
```

Use `.env` for default/local Docker Compose values, and `.env.production` for production values. Keep `.env.production` out of version control (add it to `.gitignore`) and exclude it from Docker build context (add it to `.dockerignore`).

### 2) Build and run

```bash
docker compose --env-file .env.production up -d --build
```

App will be available on `APP_PORT` (container serves on port `80`).

### 3) Stop

```bash
docker compose --env-file .env.production down
```
