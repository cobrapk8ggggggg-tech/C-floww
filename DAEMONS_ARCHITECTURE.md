# ZEUS: Vercel Daemons + Cloudflare + GitHub Actions

Status (2026-10-31): **design and deployment prerequisites only**. Daemon has **not** been created or started. Existing Cloudflare Queue/Cron and bounded Vercel Functions remain the default, disabled for live jobs until end-to-end verification.

## Intended result

C-flow UI can request 300-1800+ chapters of either scraping, pure translation, or smart translation + terminology extraction. Jobs can run while the tablet/browser is closed; MongoDB is authoritative for claims, completion, retry delays, and recovery. All chapter contents remain in the existing persistence pipeline (MongoDB/Firestore).

## Three layers

1. **Cloudflare Queue + Cron**: lightweight, always-on coordination/wake-up/retry; keeps expensive processes off while idle.
2. **Vercel Functions** (already prototyped): API/UI, short bounded steps, job status. For a truly long scraper session, optional **Vercel Daemon** can pull work from MongoDB/queue and run the Python site adapters without being limited to a 300-second HTTP Function request. Do **not** spin up a Daemon just to poll an empty queue.
3. **GitHub Actions** (future backup): optional manually or API-triggered batch worker when jobs become too large for Daemon free quotas or need a different runtime. It reads the **same** durable MongoDB job documents and respects the same leases. Runners have bounded lifetime and quotas, not a permanent server.

## IMPORTANT: Daemons differ from Functions

- As of 2026-10-31, Daemons are public beta, **production-only** with fixed instance counts, not preview-autoscaling. They are built as Docker/OCI containers and automatically restarted if processes crash.
- A daemon cannot serve inbound HTTP. It must pull from the queue or database. No durable local filesystem; chapter state/content must persist externally.
- Before deployment, implement a **direct MongoDB leasing loop** for the scraper adapter and a graceful SIGTERM shutdown; do not wrap an infinite scrape loop inside an HTTP request. Keep a hard guard requiring `ZEUS_DAEMON_ENABLED=true`.
- Deploy with **zero instances** until isolated staging DB + test credentials are available; only scale to one instance for a bounded test, and scale back to zero after draining. Production-only means the name “staging” on an independent Vercel project can be used, but that project's production target still runs the daemon.
- Securely connect to C-flow via private service bindings if backend and Daemon are deployed in one Vercel Services project (supported since October 30, 2026). Otherwise use a scoped token/secret over HTTPS.
- Source: https://vercel.com/changelog/vercel-daemons-is-now-in-public-beta and https://vercel.com/changelog/vercel-daemons-can-now-call-services-with-bindings

## Free quota and safeguards

Published Vercel Daemons Hobby inclusion: approximately **5 active CPU hours + 420 GB-hours provisioned memory/month** as shown on the public pricing page. A 2-GB worker running continuously for 30 days occupies about 1440 GB-hours, over that allowance, even when CPU is mostly idle. Thus keep zero instances while idle and use Cloudflare as the inexpensive dispatcher.

The agent must not automatically turn on paid resources, upgrade plans, or continuously run Daemons. Record CPU/memory used after each trial.

## MongoDB already verified

An isolated **Vercel Preview** was deployed from `C-floww` into existing Vercel project `c-flow-backend`, borrowing its stored Preview `MONGODB_URI` without revealing credentials. The development branch explicitly overrides Mongoose's database name to `zeus_automation_staging`, so it never writes to the normal novel database. Health endpoint returned `databaseConfigured:true`, `databaseConnected:true`, and `databaseIsolated:true`.

The separate deployment `zeus-cfloww-staging.vercel.app` still has no MongoDB URI configured; this is not the same as the verified original-project Preview.

## Rollout gates

- Phase A: finish sandbox MongoDB job + fake scraper test (300 chapters already passes on GitHub Actions).
- Phase B: verify real 1-chapter scrape and storage in isolated database, using a permitted public source and authorized credentials; confirm idempotency and Firestore isolation.
- Phase C: verify real single-chapter smart + pure translation using user-configured providers, timeouts, glossary, and correct chapter save.
- Phase D: soak test 10, then 50, then 300+ chapters; measure wall time, CPU/memory, queue operations and failure recovery.
- Phase E: implement Dockerized direct pull worker and GitHub Actions overflow; enable Daemon **only** if Functions prove insufficient, with idle scale-to-zero automation and quota guard.

**No production deployment/promotion or background worker activation without passing the relevant tests.**
