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

## Opt-in translation paths
- Set `DURABLE_SMART_TRANSLATION=true` on C-flow to queue **new** smart translation tasks with glossary extraction instead of launching long-lived in-process loops.
- Set `DURABLE_PURE_TRANSLATION=true` to queue **new** pure translation tasks separately.
- Both modes are disabled by default and require the private coordinator secret to run their respective `/api/automation/worker/smart-translate-tick` and `/api/automation/worker/translate-tick` endpoints.
- Provider retries can still exceed Vercel execution duration; lease expiry allows a retry, but live AI-provider + Firebase testing is required before production activation.
- Smart translator no longer marks jobs completed while chapter targets remain.

## Before enabling
1. Deploy the **development branches** to preview environments and verify that both services boot.
2. C-flow backend secrets: `AUTOMATION_SECRET` (new separate coordinator secret), `SCRAPER_SERVICE_URL` and `SCRAPER_API_SECRET` (must equal scraper's **existing** `API_SECRET`). Do not change legacy credentials.
3. Scraper preview env: keep its existing `API_SECRET`; set `NODE_BACKEND_URL` to the preview backend.
4. Cloudflare `AUTOMATION_SECRET` as Worker secret (same coordinator value as C-flow); `BACKEND_URL` to the backend environment. Only set `AUTOMATION_ENABLED=true` after end-to-end tests.
5. Prove pause/resume and crash recovery using a single authorized chapter first, then gradually increase batch size. Respect source terms and rights.
6. Current translation/glossary UI is unchanged in the staging environment. Enable the respective opt-in flags only after configuring and validating AI/Firestore and MongoDB in isolated staging.

## Caveats
- Each pipeline processes **at most one chapter per cron invocation**, subject to provider duration. A 300-chapter job may take 10+ hours at 2-minute cadence (less with a more frequent or batched scheduler after load testing).
- Some source plugins require special adapter arguments and may not work with generic one-chapter handling.
- Ensure the backend `/api/scraper/receive` returns success only after durable writes.
- Source code upstream includes legacy inline secrets/cookies; review and rotate them in a separate change before production use.
- Avoid turning on legacy long-running `/scrape` worker threads on Vercel.

## Validation
See `.github/workflows/automation-foundation.yml`; both validation workflows must pass. No automated production deployment is set up in this branch.

## Current isolated staging deployments
- C-floww: https://zeus-cfloww-staging.vercel.app/api/automation/health
- Scraper-new: https://zeus-scraper-staging.vercel.app/health
- Cloudflare: https://zeus-automation-coordinator.cobrapk8ggg.workers.dev/health
- The staging MongoDB URI, Firebase credentials and actual AI providers are intentionally **not configured**. Health can return 200 while job endpoints return 503. Do not mistake successful deployment for completed end-to-end processing.
- Only a synthetic MongoDB + fake scraper integration test runs in GitHub Actions today.
- Never copy production database passwords or cookies into a public repo or build logs.
