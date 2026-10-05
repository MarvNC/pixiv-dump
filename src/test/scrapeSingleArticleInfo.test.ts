import { afterAll, test, expect } from 'bun:test';
import { closeSession } from '../fetch/fetchURL';
import { scrapeSingleArticleInfo } from '../scrape/scrapeSingleArticleInfo';

// Allow the existing 120-second browser readiness wait and article requests.
const ARTICLE_SCRAPE_TIMEOUT_MS = 5 * 60_000;

afterAll(closeSession, 15_000);

test(
  'scrapeSingleArticleInfo should not return null values for フリーレン',
  async () => {
    const frierenTag = 'フリーレン';
    const { reading, header, mainText } =
      await scrapeSingleArticleInfo(frierenTag);

    // Log results for verification in GitHub Actions
    console.log('=== Article Scrape Results ===');
    console.log(`Tag: ${frierenTag}`);
    console.log(`Reading: ${reading}`);
    console.log(`Headers (${header.length}):`, header);
    console.log(
      `Main Text (length: ${mainText.length}):`,
      mainText.substring(0, 200) + '...',
    );
    console.log('==============================');

    expect(reading).toBeTruthy();
    expect(mainText).toBeTruthy();
    expect(Array.isArray(header)).toBe(true);
    expect(header.length).toBeGreaterThan(0);
  },
  ARTICLE_SCRAPE_TIMEOUT_MS,
);
