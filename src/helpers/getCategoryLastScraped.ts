import { DEFAULT_LAST_SCRAPED } from '../constants';
import { prisma } from '..';

/**
 * Scrapes a category of articles from Pixiv.
 */
export async function getCategoryLastScraped(
  category: string,
): Promise<string> {
  // Check how far the category has been scraped
  const scrapeProgress = await prisma.scrapeProgress.findUnique({
    where: { category },
  });
  if (!scrapeProgress) {
    await prisma.scrapeProgress.create({
      data: { category, newestDate: DEFAULT_LAST_SCRAPED },
    });
    return DEFAULT_LAST_SCRAPED;
  }
  return scrapeProgress.newestDate;
}
