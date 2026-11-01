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

## Request pacing and challenge diagnostics

Serialized requests leave a one-second quiet interval after the preceding
request completes. Retries retain the shared five-minute budget. A persistent
browser response challenge backs off for at least 60 seconds, even when the
browser's current page title is normal; a longer existing challenge-wait
cooldown wins. This reduces request bursts; it does not guarantee access or
bypass a challenge.

HTTP and browser responses use the same challenge detector. The documented
`cf-mitigated: challenge` response header is authoritative. Headerless fallbacks
inspect HTML interstitials, not JSON article text or nonblocking JavaScript
Detection scripts injected into successful pages. Genuine challenges still stop
the scrape and withhold releases after bounded retries.

Retry/failure logs and smoke JSON now include a sanitized `request` diagnostic
(the log field is named `diagnostic`): endpoint category (`article`,
`breadcrumbs`, `article-info`, `sitemap`, or `other`), transport, and where
available HTTP status, content-type category and challenge detection reason
(`header`, `title`, or `body`). No tag names, URLs, query values, raw headers,
bodies or cookies are included. Endpoint categories distinguish which of the
three article requests failed; a successful homepage/session is not proof that
every API is accessible.

The October 31 incident logs show browser readiness and successful sitemap
requests, followed by article-request challenges. They do not contain response
metadata sufficient to prove the exact endpoint or the site's blocking rule.
These changes fix known classification/backoff defects and reduce bursts; a
successful authorized live smoke is still required to confirm recovery. If the
site continues denying access, stop and seek an approved data-access path rather
than increasing retries, changing identities or weakening the release guard.

## Full workflow validation without publication

Run **Scrape All** manually on the candidate branch with `publish_release=false`
and `require_complete=true` (both are the manual defaults). It downloads and
integrity-checks a copy of the latest released database, discovers the full
sitemap, and processes the entire normal pending/new/updated article queue. It
does not re-fetch every unchanged historical article. Valid DB and outcome
artifacts are retained even if validation fails.

The final validation step requires a valid finalized `complete` outcome, all
selected entries accounted for, zero failed articles, successful scraper/backup
steps and nonempty database counts. A healthy empty queue (0/0), or a queue
containing only benign missing/ignored entries, passes validation without
publishing a duplicate release. Publication separately requires at least one
successful article write. A clean timed partial run or a blocked run still fails
full-run validation; malformed reports, failed setup/process/checkpoint steps,
and cleanup errors cannot be hidden by an empty queue.

Release publication is restricted to the default branch. Manual runs
additionally require explicit `publish_release=true`; scheduled default-branch
runs retain the existing complete-or-clean-timed-partial release policy. The
scrape job has read-only repository permissions; only the separately gated
release job can write release assets. Full validation is not itself permission
to publish.

A shared workflow concurrency group prevents candidate/default-branch full runs
using this workflow version from overlapping and never cancels a running scrape.
This replaces the racy previous-run array-index polling. Before validating an
unmerged version, also check for active older production runs: the old workflow
does not participate in the new concurrency group.

### Browser navigation responses

Browser session readiness is not proof that a requested endpoint is accessible.
The readiness log explicitly leaves the target response unverified; every target
response still passes status, content-type, and challenge-header/body checks.
When a challenged in-page request falls back to navigation, the scraper uses the
latest response for that exact target's main-frame navigation (including a
challenge reload), rather than discarding a successful document and immediately
making another in-page request. Unrelated redirects, subresources, stale bodies,
and rendered DOM content are not accepted as substitutes. Navigation body reads
share the request deadline, and response listeners are removed on every exit.
Persistent upstream challenges still fail with the existing cooldown and release
guards; this change does not promise access when the upstream service blocks the
runner.
