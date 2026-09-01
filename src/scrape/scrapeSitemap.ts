import { prisma } from '..';
import { SITEMAP_INDEX_URL, SITEMAP_PROGRESS_CATEGORY } from '../constants';
import { fetchURL } from '../fetch/fetchURL';
import {
  getCategoryScraped,
  updateCategoryScraped,
} from '../helpers/lastScrapedHandler';
import {
  isJapaneseSitemapPart,
  lastmodToEpochMs,
  lastmodToUpdatedAt,
  parseSitemapIndex,
  parseUrlset,
  tagNameFromArticleUrl,
  type SitemapEntry,
} from '../helpers/sitemap';

const UPSERT_BATCH_SIZE = 50;

export async function scrapeSitemap() {
  const indexResponse = await fetchURL(SITEMAP_INDEX_URL);
  if (typeof indexResponse.data !== 'string') {
    throw new Error('Sitemap index was not XML text');
  }

  const parts = parseSitemapIndex(indexResponse.data)
    .filter((part) => isJapaneseSitemapPart(part.loc))
    .sort((a, b) => lastmodToEpochMs(b.lastmod) - lastmodToEpochMs(a.lastmod));

  const lastScrape = await getCategoryScraped({
    category: SITEMAP_PROGRESS_CATEGORY,
    sort: 'newest',
  });
  const lastScrapeMs = new Date(lastScrape).getTime();
  const dueParts = parts.filter(
    (part) => lastmodToEpochMs(part.lastmod) > lastScrapeMs,
  );

  console.log(`Sitemap: ${dueParts.length}/${parts.length} parts to scrape`);

  let partIndex = 0;
  for (const part of dueParts) {
    partIndex++;
    const upserted = await scrapeSitemapPart(part);
    console.log(
      `Sitemap: ${part.loc} ${partIndex}/${dueParts.length} (${upserted} upserted)`,
    );
  }

  if (parts.length > 0) {
    await updateCategoryScraped({
      category: SITEMAP_PROGRESS_CATEGORY,
      date: parts[0].lastmod,
      sort: 'newest',
    });
  }
}

async function scrapeSitemapPart(part: SitemapEntry): Promise<number> {
  const response = await fetchURL(part.loc);
  if (typeof response.data !== 'string') {
    throw new Error(`Sitemap part was not XML text: ${part.loc}`);
  }

  const articles: {
    tag_name: string;
    updated_at: string;
    lastScraped: string;
  }[] = [];
  for (const url of parseUrlset(response.data)) {
    const tag_name = tagNameFromArticleUrl(url.loc);
    if (!tag_name) {
      continue;
    }
    articles.push({
      tag_name,
      updated_at: lastmodToUpdatedAt(url.lastmod),
      lastScraped: lastmodToEpochMs(url.lastmod).toString(),
    });
  }

  for (const batch of chunk(articles, UPSERT_BATCH_SIZE)) {
    await upsertArticleBatch(batch);
  }
  return articles.length;
}

async function upsertArticleBatch(
  batch: { tag_name: string; updated_at: string; lastScraped: string }[],
) {
  if (batch.length === 0) {
    return;
  }
  const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
  const values = batch.flatMap((article) => [
    article.tag_name,
    '',
    article.updated_at,
    '',
    0,
    0,
    0,
    '[]',
    article.lastScraped,
  ]);
  await prisma.$executeRawUnsafe(
    `INSERT INTO PixivArticle (tag_name, summary, updated_at, main_illst_url, view_count, illust_count, check_count, related_tags, lastScraped)
     VALUES ${placeholders}
     ON CONFLICT(tag_name) DO UPDATE SET
       updated_at = excluded.updated_at,
       lastScraped = excluded.lastScraped
     WHERE PixivArticle.lastScrapedArticle IS NULL
        OR CAST(PixivArticle.lastScrapedArticle AS INTEGER) < CAST(excluded.lastScraped AS INTEGER)`,
    ...values,
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}
