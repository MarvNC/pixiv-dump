import fetchPixivPage from './fetch/fetchPixivPage';
import { PixivArticle, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

(async () => {
  const data = await fetchPixivPage('', 1);
  for (const article of data.articles) {
    await prisma.pixivArticle.upsert({
      where: { tag_name: article.tag_name },
      update: convertToPixivArticle(article),
      create: convertToPixivArticle(article),
    });
  }

  const articles = await prisma.pixivArticle.findMany();
  console.log(articles);
})()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

/**
 * Converts a raw article object to a PixivArticle object.
 */
function convertToPixivArticle(rawArticle: RawArticle): PixivArticle {
  return {
    tag_name: rawArticle.tag_name,
    summary: rawArticle.summary,
    updated_at: rawArticle.updated_at,
    main_illst_url: rawArticle.main_illst_url,
    view_count: rawArticle.view_count,
    illust_count: rawArticle.illust_count,
    check_count: rawArticle.check_count,
    related_tags: rawArticle.related_tags.join(','),
    parent: rawArticle.parent,
    lastScraped: Date.now().toString(),
  };
}
