import { prisma } from '..';

export async function getArticlesToScrape() {
  return await prisma.pixivArticle.findMany({
    where: { lastScrapedArticle: null },
    select: {
      tag_name: true,
    },
  });
}
