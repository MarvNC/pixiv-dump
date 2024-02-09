import cliProgress from 'cli-progress';
import { JSDOM } from 'jsdom';
import { PIXIV_BASE_URL } from '../constants';
import { fetchURL } from '../fetch/fetchURL';
import { prisma } from '..';

const pixivArticleURL = (tag_name: string) =>
  `${PIXIV_BASE_URL}a/${encodeURIComponent(tag_name)}`;
/**
 * Scrape all readings for articles that have not been scraped yet
 */
export async function scrapeAllReadings() {
  const articles = await prisma.pixivArticle.findMany({
    where: { lastScrapedReading: null },
    select: {
      tag_name: true,
    },
  });

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
    await scrapeSingleArticleInfo(tag_name);
    i++;
    progressBar.update(i);
  }
  progressBar.stop();
}

async function scrapeSingleArticleInfo(tag_name: string) {
  // Fetch the page
  const url = pixivArticleURL(tag_name);
  const response = await fetchURL(url);
  const dom = new JSDOM(response.data);
  // Get the reading
  const reading = dom.window.document.querySelector('p.subscript')?.textContent;
  // Get headers
  const breadcrumbs = dom.window.document.getElementById('breadcrumbs');
  const header = breadcrumbs
    ? [...breadcrumbs.children].map((child) => child.textContent)
    : [];

  // Update the article
  await prisma.pixivArticle.update({
    where: { tag_name },
    data: {
      lastScrapedReading: Date.now().toString(),
      reading,
      header: JSON.stringify(header),
    },
  });
}
