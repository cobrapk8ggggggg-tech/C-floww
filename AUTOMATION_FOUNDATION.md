# ZEUS Durable Scraping Foundation

Development branch only. Existing production C-flow backend and all legacy routes are unchanged.

## Architecture
- **C-floww** stores chapter jobs persistently in MongoDB and exposes admin-only job management endpoints.
- **Scraper-new** processes one chapter per request, reuses existing source adapters and sends it to C-flow via the existing `/api/scraper/receive` endpoint.
- **Cloudflare coordinator** invokes one job step per cron tick (configured every 2 minutes), and is intentionally disabled by default.

## Backend routes
- `POST /api/automation/jobs` — admin JWT, body `{sourceUrl, chapters:[1,2,3]}` or `{sourceUrl,startChapter:1,endChapter:300}`
- `GET /api/automation/jobs`
- `GET /api/automation/jobs/:id`
- `POST /api/automation/jobs/:id/pause`
- `POST /api/automation/jobs/:id/resume`
- `POST /api/automation/worker/tick` — internal, `x-automation-secret` only.

## Before enabling
1. Deploy the **development branches** to preview environments and verify that both services boot.
2. C-flow backend secrets: `AUTOMATION_SECRET` (new separate coordinator secret), `SCRAPER_SERVICE_URL` and `SCRAPER_API_SECRET` (must equal scraper's **existing** `API_SECRET`). Do not change legacy credentials.
3. Scraper preview env: keep its existing `API_SECRET`; set `NODE_BACKEND_URL` to the preview backend.
4. Cloudflare `AUTOMATION_SECRET` as Worker secret (same coordinator value as C-flow); `BACKEND_URL` to the backend environment. Only set `AUTOMATION_ENABLED=true` after end-to-end tests.
5. Prove pause/resume and crash recovery using a single authorized chapter first, then gradually increase batch size. Respect source terms and rights.
6. Existing translation/glossary jobs remain separate and are **not** yet durable.

## Caveats
- Job steps process **at most one chapter each cron**. A 300-chapter job may take 10+ hours at 2-minute cadence.
- Some source plugins require special adapter arguments and may not work with generic one-chapter handling.
- Ensure the backend `/api/scraper/receive` returns success only after durable writes.
- Source code upstream includes legacy inline secrets/cookies; review and rotate them in a separate change before production use.
- Avoid turning on legacy long-running `/scrape` worker threads on Vercel.

## Validation
See `.github/workflows/automation-foundation.yml`; both validation workflows must pass. No automated production deployment is set up in this branch.
