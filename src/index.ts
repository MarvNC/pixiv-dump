import fetchPixivPage from './fetch/fetchPixivPage';
import { PixivArticle, PrismaClient } from '@prisma/client';
import { DEFAULT_LAST_SCRAPED, PIXIV_CATEGORIES } from './constants';

const prisma = new PrismaClient();

(async () => {
  for (const category of PIXIV_CATEGORIES) {
    const newestScrapedDate = await getCategoryLastScraped(category);
    console.log(`Scraping ${category} from ${newestScrapedDate}`);
  }
  // const data = await fetchPixivPage('', 1);
  // for (const article of data.articles) {
  //   await prisma.pixivArticle.upsert({
  //     where: { tag_name: article.tag_name },
  //     update: convertToPixivArticle(article),
  //     create: convertToPixivArticle(article),
  //   });
  // }

  // const articles = await prisma.pixivArticle.findMany();
  // console.log(articles);
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
 * Scrapes a category of articles from Pixiv.
 */
async function getCategoryLastScraped(category: string): Promise<string> {
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
    related_tags: JSON.stringify(rawArticle.related_tags),
    parent: rawArticle.parent,
    lastScraped: Date.now().toString(),
    reading: null,
    header: null,
    lastScrapedReading: null,
  };
}
