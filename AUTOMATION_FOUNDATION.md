# Current implementation

See [the V2 implementation](docs/DURABLE_ENGINE_AR.md) and [current validation](docs/VALIDATION_2026_11_01.md). The earlier foundation notes below describe V1 and are historical.

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

## Cloudflare Queue acceleration

The free `zeus-chapter-automation` Queue is now provisioned, with
`zeus-automation-coordinator` as the consumer and `AUTOMATION_QUEUE` as the producer binding.

- **Queue message**: `{kind: 'scrape'|'pure'|'smart'}`; contains no chapter text, JWT or API key.
- **Cron watchdog**: every 2 minutes, submits a wake-up message for each kind only when `AUTOMATION_ENABLED=true`.
- **Consumer**: calls the respective authenticated C-flow tick, acknowledges a successful HTTP response, and schedules the next message after 5 seconds if work made progress.
- **Retry behavior**: network errors are retried by Cloudflare after 60 seconds. MongoDB leases and checkpoints remain the authoritative state; queue messages are merely wake-ups. The worker does not dispatch anything while disabled.
- **Concurrency**: queue consumer capped at three, single-message batches; per-job MongoDB leases are required for safety.
- **Free usage**: Cloudflare Queues supports a limited free operations allowance; review actual traffic and limits before higher load.
- **Not yet verified**: 300 live novel chapters, Firebase writes, any actual AI provider, consumer wake-up timing under production load, or permission to fetch from each source.

## Current isolated staging deployments
- C-floww: https://zeus-cfloww-staging.vercel.app/api/automation/health
- Scraper-new: https://zeus-scraper-staging.vercel.app/health
- Cloudflare: https://zeus-automation-coordinator.cobrapk8ggg.workers.dev/health
- The staging MongoDB URI, Firebase credentials and actual AI providers are intentionally **not configured**. Health can return 200 while job endpoints return 503. Do not mistake successful deployment for completed end-to-end processing.
- Only a synthetic MongoDB + fake scraper integration test runs in GitHub Actions today.
- Never copy production database passwords or cookies into a public repo or build logs.

## Integrity revision (2026-10-31)

The new synchronous scraper now uses `/api/automation/chapters/check` and
`/api/automation/chapters/import`, authenticated with the configured existing
`SCRAPER_API_SECRET`. Deploy backend and scraper together to staging before use;
there is intentionally no fallback to the legacy success acknowledgement.
Firestore selects `zeus-automation-staging` (override only with another isolated
`AUTOMATION_FIRESTORE_DATABASE`). Create/authorize that named database first.
See `ENGINEERING_AUDIT_AR.md` and `TEST_RESULTS.md` for the current acceptance gates.
Older implementation descriptions above do not establish live verification.
