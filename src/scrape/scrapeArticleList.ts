import fetchPixivPage from '../fetch/fetchPixivPage';
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
      update: {
        tag_name: article.tag_name,
        summary: article.summary,
        updated_at: article.updated_at,
        main_illst_url: article.main_illst_url,
        view_count: article.view_count,
        illust_count: article.illust_count,
        check_count: article.check_count,
        related_tags: JSON.stringify(article.related_tags),
        parent: article.parent,
        lastScraped: Date.now().toString(),
      },
      create: {
        tag_name: article.tag_name,
        summary: article.summary,
        updated_at: article.updated_at,
        main_illst_url: article.main_illst_url,
        view_count: article.view_count,
        illust_count: article.illust_count,
        check_count: article.check_count,
        related_tags: JSON.stringify(article.related_tags),
        parent: article.parent,
        lastScraped: Date.now().toString(),
        reading: null,
        header: null,
        lastScrapedReading: null,
      },
    });
  }
  return {
    date: data.articles[0]?.updated_at,
    count: data.meta.count,
  };
}
