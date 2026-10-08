"""Always-run reporting and fail-closed release guard (stdlib only)."""
import json
import os
from pathlib import Path


COUNT_KEYS = ('total', 'processed', 'successful', 'failed', 'notFound', 'skipped')
REASONS = {
    'running', 'completed', 'cloudflare', 'rate-limit', 'network-error',
    'fatal-error', 'timeout', 'sigint', 'sigterm', 'cleanup-failed',
}


def valid_report(report):
    if not isinstance(report, dict):
        return False
    counts = report.get('counts', {})
    database = report.get('database', {})
    return (
        type(report.get('schemaVersion')) is int and report['schemaVersion'] == 1
        and report.get('status') in ('complete', 'partial', 'blocked')
        and isinstance(report.get('stopReason'), str)
        and report['stopReason'] in REASONS
        and type(report.get('finalized')) is bool
        and isinstance(report.get('cleanupErrors'), list)
        and isinstance(counts, dict)
        and all(type(counts.get(key)) is int and counts[key] >= 0 for key in COUNT_KEYS)
        and counts['processed'] == sum(counts[key] for key in COUNT_KEYS[2:])
        and counts['processed'] <= counts['total']
        and (report['status'] != 'complete' or (
            report['stopReason'] == 'completed' and counts['failed'] == 0
            and counts['processed'] == counts['total']))
        and (report['status'] != 'blocked' or report['stopReason'] in ('cloudflare', 'rate-limit'))
        and (report['stopReason'] != 'completed' or report['status'] == 'complete')
        and (not report['finalized'] or report['stopReason'] != 'running')
        and isinstance(database, dict)
        and all(key in database and (database[key] is None or type(database[key]) is int
                and database[key] >= 0) for key in ('before', 'after'))
    )


def evaluate(report, scrape, checkpoint, previous, budget):
    valid = valid_report(report)
    if not valid:
        report = {
            'schemaVersion': 1, 'status': 'partial', 'finalized': False,
            'stopReason': 'missing-or-invalid-report',
            'counts': dict.fromkeys(COUNT_KEYS, 0),
            'database': {'before': None, 'after': None}, 'cleanupErrors': [],
        }
    if scrape == 'skipped':
        report['status'] = 'partial'
        report['stopReason'] = 'insufficient-budget' if budget == 'false' else 'setup-failed'
        report['finalized'] = False
    elif not report['finalized']:
        report['status'] = 'partial'
        if valid and report['stopReason'] == 'running':
            report['stopReason'] = 'interrupted'
    elif scrape != 'success':
        report['status'] = 'partial'
        if report['stopReason'] == 'completed':
            report['stopReason'] = 'process-failed'

    counts = report['counts']
    complete = (
        report['status'] == 'complete'
        and report['stopReason'] == 'completed'
        and counts['processed'] == counts['total']
    )
    timed_partial = report['status'] == 'partial' and report['stopReason'] == 'timeout'
    eligible = bool(
        valid and scrape == 'success' and previous == 'success'
        and checkpoint == 'success' and report['finalized']
        and 'error' not in report and not report['cleanupErrors'] and counts['successful'] > 0
        and counts['failed'] == 0 and (complete or timed_partial)
        and (report['database']['before'] or 0) > 0
        and (report['database']['after'] or 0) > 0
    )
    report['workflow'] = {
        'scrape': scrape, 'checkpoint': checkpoint, 'previousDatabase': previous,
        'reportValid': valid, 'releaseEligible': eligible,
    }
    return report


def main():
    path = Path('scrape-outcome.json')
    try:
        report = json.loads(path.read_text())
    except (OSError, ValueError):
        report = None
    report = evaluate(
        report, os.getenv('SCRAPE_RESULT', 'skipped'),
        os.getenv('CHECKPOINT_RESULT', 'skipped'),
        os.getenv('PREVIOUS_DB_RESULT', 'skipped'), os.getenv('BUDGET_ENOUGH', ''),
    )
    path.write_text(json.dumps(report, indent=2) + '\n')
    eligible = str(report['workflow']['releaseEligible']).lower()
    counts = report['counts']
    summary = (
        f"## Scrape outcome: {report['status']}\n\n"
        f"Stop reason: {report['stopReason']}\n\n"
        f"Processed: {counts['processed']}/{counts['total']}; "
        f"successful: {counts['successful']}; failed: {counts['failed']}; "
        f"not found: {counts['notFound']}; skipped: {counts['skipped']}.\n\n"
        f"Finalized: {report['finalized']}; "
        f"SQLite backup/integrity check: {report['workflow']['checkpoint']}.\n\n"
        f"Release eligible: **{eligible}**. Valid database snapshots are retained "
        "as the db artifact even when a release is withheld.\n"
    )
    print(summary)
    if os.getenv('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as handle:
            handle.write(summary)
    if os.getenv('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as handle:
            handle.write(f'release_eligible={eligible}\n')


if __name__ == '__main__':
    main()
