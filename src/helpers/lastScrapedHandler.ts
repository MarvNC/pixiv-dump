import { DEFAULT_LAST_SCRAPED, DEFAULT_OLDEST_SCRAPED } from '../constants';
import { prisma } from '..';

const dateSortToColumn: Record<
  dateSort,
  keyof typeof prisma.scrapeProgress.fields
> = {
  oldest: 'oldestScraped',
  newest: 'newestScraped',
};

/**
 * Scrapes a category of articles from Pixiv.
 */
export async function getCategoryScraped({
  category,
  sort,
}: {
  category: string;
  sort: dateSort;
}): Promise<string> {
  // Check how far the category has been scraped
  const scrapeProgress = await prisma.scrapeProgress.findUnique({
    where: { category },
  });
  if (!scrapeProgress) {
    const result = await prisma.scrapeProgress.create({
      data: {
        category,
        newestScraped: DEFAULT_LAST_SCRAPED,
        oldestScraped: DEFAULT_OLDEST_SCRAPED,
      },
    });
    return result[dateSortToColumn[sort]];
  }
  return scrapeProgress[dateSortToColumn[sort]];
}

/**
 * Updates the last scraped date for a category.
 */
export async function updateCategoryScraped({
  category,
  date,
}: {
  category: string;
  date: string;
}) {
  const newestScraped = await getCategoryScraped({ category, sort: 'newest' });
  const oldestScraped = await getCategoryScraped({ category, sort: 'oldest' });
  if (new Date(date) > new Date(newestScraped)) {
    await prisma.scrapeProgress.update({
      where: { category },
      data: { newestScraped: date },
    });
  }
  if (new Date(date) < new Date(oldestScraped)) {
    await prisma.scrapeProgress.update({
      where: { category },
      data: { oldestScraped: date },
    });
  }
}
