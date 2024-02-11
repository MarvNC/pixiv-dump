import fetchPixivPage from '../fetch/fetchPixivPage';
import { convertRawArticleToPixivArticle } from '../helpers/convertRawArticleToPixivArticle';
import { prisma } from '..';

export async function scrapeArticleList(category: string, pageNumber: number) {
  let data;
  try {
    data = await fetchPixivPage(category, pageNumber);
  } catch (error) {
    console.error(`Error fetching Pixiv page: ${error}`);
    return { date: '', count: 0 };
  }
  for (const article of data.articles) {
    await prisma.pixivArticle.upsert({
      where: { tag_name: article.tag_name },
      update: convertRawArticleToPixivArticle(article),
      create: convertRawArticleToPixivArticle(article),
    });
  }
  return {
    date: data.articles[0]?.updated_at,
    count: data.meta.count,
  };
}
