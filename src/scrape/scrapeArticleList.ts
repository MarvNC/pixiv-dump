import { updateCategoryLastScraped } from '../helpers/lastScrapedHandler';
import fetchPixivPage from '../fetch/fetchPixivPage';
import { convertRawArticleToPixivArticle } from '../helpers/convertRawArticleToPixivArticle';
import { prisma } from '..';

export async function scrapeArticleList(category: string, pageNumber: number) {
  const data = await fetchPixivPage(category, pageNumber);
  for (const article of data.articles) {
    await prisma.pixivArticle.upsert({
      where: { tag_name: article.tag_name },
      update: convertRawArticleToPixivArticle(article),
      create: convertRawArticleToPixivArticle(article),
    });
  }
  if (data.articles.length > 0) {
    updateCategoryLastScraped(category, data.articles[0].updated_at);
  }
}
