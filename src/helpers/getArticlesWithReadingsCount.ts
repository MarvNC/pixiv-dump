import { prisma } from '..';

export async function getArticlesScrapedCount() {
  return await prisma.pixivArticle.count({
    where: { lastScrapedArticle: { not: null } },
  });
}
