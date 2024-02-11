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
  sort,
}: {
  category: string;
  date: string;
  sort: dateSort;
}) {
  // Check if the date is newer/older than the current date
  const currentScrapeProgress = await getCategoryScraped({ category, sort });
  const isDateNewer =
    sort === 'newest' && new Date(date) > new Date(currentScrapeProgress);
  const isDateOlder =
    sort === 'oldest' && new Date(date) < new Date(currentScrapeProgress);

  // If the date is not newer or older, we don't update
  if (!isDateNewer && !isDateOlder) {
    console.log(
      `Date ${date} is not newer or older than current date ${currentScrapeProgress}`,
    );
    return;
  }
  await prisma.scrapeProgress.update({
    where: { category },
    data: {
      [dateSortToColumn[sort]]: date,
    },
  });
}
