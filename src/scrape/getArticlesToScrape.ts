import { prisma } from '..';

export async function getArticlesToScrape() {
  return (
    await prisma.pixivArticle.findMany({
      where: { lastScrapedArticle: null },
      select: {
        tag_name: true,
        updated_at: true,
        lastScrapedArticle: true,
      },
    })
  ).filter((article) => {
    const lastUpdatedDate = new Date(article.updated_at);
    const lastScrapedArticle = new Date(article.lastScrapedArticle || 0);
    return (
      // If the article has not been scraped or it's been updated
      // and the updated article has yet to be scraped
      article.lastScrapedArticle === null ||
      lastScrapedArticle < lastUpdatedDate
    );
  });
}
