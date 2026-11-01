> تحديث 1 نوفمبر: التنفيذ والنتائج الأحدث في [DURABLE_ENGINE_AR.md](docs/DURABLE_ENGINE_AR.md) و[VALIDATION_2026_11_01.md](docs/VALIDATION_2026_11_01.md). السجل التالي تاريخي.

# Verification — 2026-10-31

- Local runtime: Node 24.19.0; CI configured for Node 22. Python 3.12.
- Isolated local MongoDB 8.2.6 via mongodb-memory-server; generated test databases only, cleaned by tests. No Atlas or production writes.
- `AUTOMATION_TEST_MONGO_URI=<local URI> npm test --prefix backend`: 104 tests passed, zero failures, zero skips. Includes existing provider/security/coverage tests (mocked providers).
- Durable integration: 300 synthetic chapters, temporary HTTP errors, backend restart, checkpoint recovery; all 300 complete. This is not a live-source benchmark.
- Import integration: real MongoDB + simulated transactional Firestore. Failed Firestore write leaves pending receipt; redelivery resumes; duplicate deliveries keep one original; private novel checks use actual receipt/content; translated text preserved; unavailable read and empty content refuse success; same titles across sources remain separate; existing unique source identities are reused and ambiguous identities rejected.
- Lease integration: pause/resume while scraper HTTP request is pending retains lease, second worker stays idle, stale request cannot advance cursor, expiry permits recovery. Cancelled jobs stay idle.
- Worker tests: disabled dispatch, authentication, retry, successor-send failure before ack, no-progress chain suppression, configured-but-disconnected health rejection. No live Queue load generated.
- `node scripts/check-source.js`: 73 JavaScript/JSX files parsed; absent optional web directory no longer breaks this backend-only checkout.
- Scraper: `python -m unittest discover -s tests -v`: 10 passed. Includes failed readback, unavailable verification, unsafe catalog chapter domain, duplicate receipt and Flask contract. A pre-existing sys.modules test leak was fixed so both suites work together.
- Python compileall: core/main/sites/tests completed.
- Live health observations and preceding CI links are in ENGINEERING_AUDIT_AR.md. New CI run results must be checked separately after pushing.

Not measured: live scraping/AI/Firestore writes, live failover, source-specific delays, CPU and memory per real chapter, provider tokens/cost, real Queue operations, 10/50/300/1800 live chapters. No production changes, deployments or paid workers were started by this work.

First integrity revision CI passed: [Backend](https://github.com/cobrapk8ggggggg-tech/C-floww/actions/runs/41252466302), [Scraper](https://github.com/cobrapk8ggggggg-tech/Scraper-new/actions/runs/41252468708). Follow-up MongoDB connection/identity changes require their own CI run.
