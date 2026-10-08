# Scrape outcomes and safe releases

`bun src/index.ts --timeout=60000` writes `scrape-outcome.json` at startup,
after every terminal article, and after finalization. The atomic JSON snapshot
is the source of truth; `total.txt` remains a local completion marker only and
is removed at startup.

## Status and counts

- `complete`: sitemap discovery and the article queue finished without failures.
  An empty queue can be complete, but cannot produce a release.
- `blocked`: a typed Cloudflare challenge or HTTP 429 stopped the run after the
  fetch layer exhausted its bounded retries. Already committed progress remains.
- `partial`: any other unfinished run, including time budget, interruption,
  transient network exhaustion, parser/database failures, or cleanup failure.
  Check `stopReason` and the exit code, not status alone.

Article counters describe the queue selected after sitemap discovery:

- `total`: selected queue entries, including known ignored WAF tags
- `processed`: `successful + failed + notFound + skipped`
- `successful`: article fetch/parse and database update both succeeded
- `failed`: a terminal article fetch, parse, update, or deletion failed
- `notFound`: a confirmed article 404 was successfully removed from the database
- `skipped`: a known ignored WAF tag excluded from the selected queue

`total - processed` entries remain pending. Retry attempts do not increase
counters. An in-flight article interrupted before a completed write remains
pending, not successful. Not-found and ignored entries are benign; they do not
count as successful new/updated article data. Ignored sitemap entries filtered
before selecting the article queue and sitemap batches are not article counts. A
run stopped during sitemap discovery therefore has zero article counts;
`stoppedPhase` identifies that stage. `database.before/after` count all DB rows.

Unknown parser, setup, or database errors stop immediately and exit nonzero.
Recognized availability failures keep their typed reason and may exit zero, but
never satisfy the release guard. There are no extra article-level retries on top
of the fetch layer's shared budget. Reports contain sanitized failure categories
and cleanup operation names, not response bodies, URLs or credentials.

## Timeout, interruption and finalization

The configured timeout requests cooperative shutdown. SIGINT/SIGTERM do the same
and exit 130/143. The article scraper checks cancellation before every write,
and sitemap discovery checks between fetches/batches and before advancing its
progress watermark. An already-issued DB operation may finish; successful
article writes are counted when it resolves. A single finalizer then attempts DB
count, WAL checkpoint, Prisma disconnect and fetch-session close, even when an
earlier cleanup fails. Cleanup or report-publication failure exits nonzero.

A 30-second grace bounds shutdown and finalization. If a fetch/driver is still
stuck, the process exits nonzero with `finalized: false`; the workflow performs
the SQLite backup and integrity check after the process exits. Repeated signals
do not start concurrent finalizers. Forced termination, missing/malformed JSON,
and unexpected process failures cannot masquerade as complete runs.

## Workflow artifacts and release guard

The scheduled workflow requires a previous release database and checks its
integrity before scraping. It never bootstraps a replacement empty database. Bun
is pinned to 1.4.2 and dependencies use the frozen lockfile.

Regardless of scraper success, an always-run step checkpoints SQLite, creates a
`.backup`, and integrity-checks the backup. Only a successful backup is uploaded
as the `db` artifact. This retains valid partial progress even after parser,
network, migration, or cleanup failures. A missing/corrupt database is never
uploaded as a valid snapshot.

A separate always-run, Python-stdlib reporter publishes a workflow summary and
`scrape-outcome` artifact (file: `scrape-outcome.json`). It creates an explicit
fallback report if setup prevented scraping or the runtime report is absent,
invalid, or unfinished. The workflow adds its step outcomes and
`workflow.releaseEligible` to the report. Runner loss or force-cancellation can
prevent any remaining workflow steps from executing; no completed report or
release is promised in that case.

A release requires all of:

1. A validated existing database, successful scraper process and successful
   checkpoint/backup/integrity check
2. A valid, finalized, internally consistent report without an error or cleanup
   failures
3. At least one successful article write, zero failed articles, and nonempty
   database counts before and after the run
4. Either complete scraping or a clean, time-budget-limited partial run

Thus a clean timed partial run can advance the published archive. No-progress,
Cloudflare/429, transient failures, fatal errors, signal interruptions, and
unfinished shutdowns retain artifacts without publishing a release. Releases
include their JSON outcome and say whether scraping completed or timed out.

## Offline verification

`bun test` covers outcome accounting, finalization failures, the real workflow
publisher/release guard, and isolated entrypoint processes with mocked clients.
Those subprocess tests exercise fatal article/database errors, benign 404s,
ignored tags, blocked fetches, timeout, repeated signals, and forced shutdown
without contacting Pixiv or launching a browser.
