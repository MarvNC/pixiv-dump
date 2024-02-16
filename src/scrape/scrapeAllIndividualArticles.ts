import cliProgress from 'cli-progress';
import { prisma } from '..';
import { scrapeSingleArticleInfo } from './scrapeSingleArticleInfo';

/**
 * Scrape all readings for articles that have not been scraped yet
 */
export async function scrapeAllIndividualArticles() {
  const articles = await prisma.pixivArticle.findMany({
    where: { lastScrapedArticle: null },
    select: {
      tag_name: true,
    },
  });
  console.log(`Scraping ${articles.length} individual articles`);

  const progressBar = new cliProgress.SingleBar(
    {
      format:
        'Progress [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} Articles',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic,
  );
  progressBar.start(articles.length, 0);

  let i = 0;
  for (const { tag_name } of articles) {
    try {
      await scrapeSingleArticleInfo(tag_name);
    } catch (error) {
      console.error(`Error scraping article ${tag_name}: ${error}`);
    }
    i++;
    progressBar.update(i);
  }
  progressBar.stop();
}
