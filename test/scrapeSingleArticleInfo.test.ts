import test from 'ava';
import { scrapeSingleArticleInfo } from '../src/scrape/scrapeSingleArticleInfo';

test('scrapeSingleArticleInfo should not return null values for フリーレン', async (t) => {
  const frierenTag = 'フリーレン';
  const { reading, header, mainText } =
    await scrapeSingleArticleInfo(frierenTag);

  t.truthy(reading, 'Reading should not be null or empty');
  t.truthy(mainText, 'MainText should not be null or empty');

  t.true(Array.isArray(header), 'Header should be a valid JSON array');
  t.true(header.length > 0, 'Header array should have length greater than 0');
});
