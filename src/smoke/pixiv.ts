import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { closeSession } from '../fetch/fetchURL';
import { scrapeSingleArticleInfo } from '../scrape/scrapeSingleArticleInfo';
import { sanitizedSmokeError } from './diagnostics';

const DIAGNOSTIC_PATH = 'diagnostics/live-smoke.json';
const startedAt = Date.now();
let stage: 'article' | 'validation' = 'article';
let diagnostic: Record<string, unknown> = {
  schemaVersion: 1,
  startedAt: new Date(startedAt).toISOString(),
  bunVersion: Bun.version,
  probe: 'japanese-article',
  outcome: 'running',
  stage,
};

async function saveDiagnostic() {
  await mkdir('diagnostics', { recursive: true, mode: 0o700 });
  await writeFile(
    DIAGNOSTIC_PATH,
    `${JSON.stringify({ ...diagnostic, durationMs: Date.now() - startedAt }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

await saveDiagnostic();

try {
  const article = await scrapeSingleArticleInfo('フリーレン');
  stage = 'validation';
  assert(article.reading.length > 0, 'Missing article reading');
  assert(article.mainText.length > 0, 'Missing article text');
  assert(article.header.length > 0, 'Missing article headers');
  diagnostic = {
    ...diagnostic,
    outcome: 'success',
    stage,
    readingLength: article.reading.length,
    mainTextLength: article.mainText.length,
    headerCount: article.header.length,
  };
} catch (error) {
  diagnostic = {
    ...diagnostic,
    outcome: 'failure',
    stage,
    error: sanitizedSmokeError(error),
  };
  process.exitCode = 1;
}

// Write before cleanup as well so a stuck client still leaves useful evidence.
await saveDiagnostic();
const cleanupTimeout = setTimeout(() => {
  diagnostic = {
    ...diagnostic,
    outcome: 'failure',
    cleanupError: { category: 'timeout' },
    durationMs: Date.now() - startedAt,
  };
  try {
    writeFileSync(DIAGNOSTIC_PATH, `${JSON.stringify(diagnostic, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch {
    console.error('Could not update the sanitized cleanup diagnostic.');
  }
  console.error('Pixiv live smoke cleanup exceeded 15 seconds.');
  process.exit(1);
}, 15_000);
try {
  await closeSession();
} catch (error) {
  diagnostic = {
    ...diagnostic,
    outcome: 'failure',
    cleanupError: sanitizedSmokeError(error),
  };
  process.exitCode = 1;
} finally {
  clearTimeout(cleanupTimeout);
  await saveDiagnostic();
}

if (process.exitCode) {
  console.error(
    'Pixiv live smoke failed. Inspect the sanitized diagnostic artifact.',
  );
} else {
  console.log('Pixiv live smoke passed.');
}
