import { prisma } from '..';

export async function getArticlesWithReadingsCount() {
  return await prisma.pixivArticle.count({
    where: { lastScrapedReading: { not: null } },
  });
}
