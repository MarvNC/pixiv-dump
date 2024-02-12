import { prisma } from '..';

export async function getArticlesScraped() {
  return await prisma.pixivArticle.count({
    where: { lastScrapedArticle: { not: null } },
  });
}
