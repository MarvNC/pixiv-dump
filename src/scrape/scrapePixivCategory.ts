import cliProgress from 'cli-progress';
import { findPageNumberAtDate } from '../helpers/findPageNumberAtDate';
import { scrapeArticleList } from './scrapeArticleList';

export async function scrapePixivCategory(
  category: string,
  lastScraped: string,
) {
  const pageNumberToStartAt = await findPageNumberAtDate(category, lastScraped);
  console.log(`${category}:Starting at page ${pageNumberToStartAt}`);
  const progressBar = new cliProgress.SingleBar(
    {
      format:
        'Progress [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} Pages',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic,
  );

  progressBar.start(pageNumberToStartAt, 0);
  for (let i = pageNumberToStartAt; i > 0; i--) {
    await scrapeArticleList(category, i);
    progressBar.update(pageNumberToStartAt - i + 1);
  }

  progressBar.stop();
}
