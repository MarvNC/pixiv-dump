import { test, expect } from 'bun:test';
import { scrapeSingleArticleInfo } from '../scrape/scrapeSingleArticleInfo';

test('scrapeSingleArticleInfo should not return null values for フリーレン', async () => {
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
}, 90_000);
